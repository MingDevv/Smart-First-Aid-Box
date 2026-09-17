# ตู้ยา micro:bit V1.5 ต่อ USB เข้า Pi · เกิน 8188 ไบต์ไม่ได้ · เต็มใน README
# ขา: ช่อง1 P12-P15 · ช่อง2 P0,P1,P2,P8 · ออด P16 · เซนเซอร์ TRIG P10 ECHO P9
# ห้ามใช้ P5,P11 (ปุ่ม A/B) · P9,P10 เป็นขาจอ ต้อง display.off() ก่อน
# ปุ่มบนบอร์ดไม่จ่ายยา เพราะจะข้ามการตรวจสิทธิ์ที่อยู่ฝั่ง Pi ทั้งหมด
from microbit import uart, display, sleep, running_time, pin16
from microbit import pin0, pin1, pin2, pin8, pin9, pin10, pin12, pin13, pin14, pin15
from machine import time_pulse_us
import music
import radio

DISPENSE_STEPS = 200
STEP_MS = 5
HEARTBEAT_MS = 500
ID_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-'
BUZZ_MAX_MS = 5000          # ออดดับเอง เผื่อ Pi ดับกลางคัน

# ตรงกับ remote.py · SFAB1: กันบอร์ดทีมอื่นสั่งออดเราดัง
RADIO_GROUP = 91
RADIO_PREFIX = 'SFAB1:SOS:'
SOS_ACK = 'SFAB1:OK'
BUZZ_ON = 'SFAB1:B1'
BUZZ_OFF = 'SFAB1:B0'
BEACON_MS = 400             # บอกรีโมตว่ายังร้อง ขาดไปรีโมตดับเอง

# ของตกผ่านลำคลื่น ~8 ms · ยิงรอบละ 2.3 ms จึงเห็นอย่างน้อย 3 ครั้ง
WATCH_MS = 1500             # เฝ้าต่อหลังมอเตอร์หยุด เผื่อของค้างเกลียว
BLOCK_MM = 40               # ใกล้กว่าถาดว่างเท่านี้ = มีของบัง
ECHO_US = 3000
FAR_MM = 9999

# เรียง IN1 IN3 IN2 IN4 · motor_run เดินย้อนลำดับ
MOTORS = {1: [pin12, pin14, pin13, pin15], 2: [pin0, pin2, pin1, pin8]}

busy = False
ready_epoch = 1
last_heartbeat = 0
buzz_until = 0
last_beacon = 0
last_sos_seq = ''
line = b''
overflow = False
empty_mm = 0
near_mm = FAR_MM
hits = 0


def coils_off():
    for pins in MOTORS.values():
        for p in pins:
            p.write_digital(0)


def ping_mm():
    pin10.write_digital(0)
    pin10.write_digital(1)
    pin10.write_digital(0)
    echo = time_pulse_us(pin9, 1, ECHO_US)
    return FAR_MM if echo < 0 else echo * 343 // 2000   # ไปกลับ หาร 2000


def watch():
    global near_mm, hits
    d = ping_mm()
    if d < near_mm:
        near_mm = d
    if empty_mm and d < empty_mm - BLOCK_MM:
        hits += 1


def start_buzzer():
    global buzz_until, last_beacon
    music.pitch(880, -1, pin=pin16, wait=False)
    buzz_until = running_time() + BUZZ_MAX_MS
    last_beacon = 0             # ส่งทันที รีโมตจะร้องพร้อมกัน


def stop_buzzer():
    global buzz_until
    buzz_until = 0
    music.stop(pin16)
    for _ in range(3):
        radio.send(BUZZ_OFF)


def check_radio():
    global last_sos_seq
    message = radio.receive()
    if message is None or not message.startswith(RADIO_PREFIX):
        return
    seq = message[len(RADIO_PREFIX):]
    if seq == last_sos_seq:      # รีโมตส่งซ้ำ กันออดเริ่มใหม่รัวๆ
        return
    last_sos_seq = seq
    radio.send(SOS_ACK)
    start_buzzer()
    uart.write('REMOTE_SOS:rsos-' + seq + '-' + str(running_time()) + '\n')


def service_buzzer():
    # เรียกตอนมอเตอร์หมุนด้วย ไม่งั้นไม่มีใครมาดับออด
    global last_beacon
    if not buzz_until:
        return
    now = running_time()
    if now >= buzz_until:
        stop_buzzer()
    elif now - last_beacon >= BEACON_MS:
        last_beacon = now
        radio.send(BUZZ_ON)


def report_hardware_state():
    # เรียกตอนมอเตอร์หมุนด้วย Pi จะเห็นว่ายัง BUSY
    global last_heartbeat
    now = running_time()
    if now - last_heartbeat < HEARTBEAT_MS:
        return
    last_heartbeat = now
    if busy:
        uart.write('BUSY\n')
    else:
        uart.write('READY:' + str(ready_epoch) + '\n')


def motor_run(pins, steps, delay_ms):
    try:
        for i in range(steps):
            if i % 32 == 0:
                check_serial_commands()
                report_hardware_state()
                service_buzzer()
            active = (-i) % 4
            for j in range(4):
                pins[j].write_digital(1 if j == active else 0)
            watch()             # ยิงแทนนอนรอ จังหวะสเต็ปเท่าเดิม
            sleep(delay_ms - 2)
    finally:
        for p in pins:
            p.write_digital(0)


def dispense(drawer, command_id):
    # เปลี่ยน epoch ก่อน คำสั่งเก่าที่ค้างในสายจะถูกปฏิเสธ
    global busy, ready_epoch, near_mm, hits
    ready_epoch += 1
    busy = True
    near_mm = FAR_MM
    hits = 0
    uart.write('BUSY\n')
    try:
        motor_run(MOTORS[drawer], DISPENSE_STEPS, STEP_MS)
        deadline = running_time() + WATCH_MS
        while running_time() < deadline:
            watch()
            report_hardware_state()
            service_buzzer()
    finally:
        busy = False
    # แยกเฟรม DONE จึงไม่เปลี่ยนรูป หายได้โดยไม่พังอะไร
    uart.write('DROP:' + command_id + ':' + str(near_mm) + ':' + str(hits) + '\n')
    # ตอบหลังมอเตอร์จบเท่านั้น ห้ามตอบตอนเพิ่งรับคำสั่ง
    uart.write('DONE' + str(drawer) + ':' + command_id + '\n')


def valid_id(command_id):
    if len(command_id) < 8 or len(command_id) > 64:
        return False
    for ch in command_id:
        if ID_CHARS.find(ch) < 0:
            return False
    return True


def handle_serial_frame(frame):
    global empty_mm
    parts = frame.split(':')
    if len(parts) < 2 or len(parts) > 3:
        return
    command_id = parts[1]
    if not valid_id(command_id):
        return
    if len(parts) == 2 and parts[0] == 'BASE':
        empty_mm = ping_mm()    # วัดสด ของค้างรอบก่อนจะไม่หลอก
        uart.write('BASE:' + command_id + ':' + str(empty_mm) + '\n')
        return
    if len(parts) == 2 and parts[0] in ('BUZZ1', 'BUZZ0'):
        if parts[0] == 'BUZZ1':
            start_buzzer()
        else:
            stop_buzzer()
        uart.write('BUZZ_DONE' + parts[0][4] + ':' + command_id + '\n')
        return
    if len(parts) != 3 or parts[0] not in ('OPEN1', 'OPEN2'):
        return
    if busy or parts[2] != str(ready_epoch):
        uart.write('REJECT:' + command_id + '\n')
        return
    dispense(1 if parts[0] == 'OPEN1' else 2, command_id)


def check_serial_commands():
    global line, overflow
    data = uart.read(64)
    if not data:
        return
    for ch in data:
        if ch == 13:
            continue
        if ch == 10:
            frame = line
            was_overflow = overflow
            line = b''
            overflow = False
            if not was_overflow:
                handle_serial_frame(str(frame, 'ascii'))
        elif not overflow:
            if len(line) >= 128:
                overflow = True
                line = b''
            else:
                line += bytes([ch])


uart.init(baudrate=115200)
display.off()                   # P9 P10 เป็นขาจอ ปิดก่อนจึงใช้เซนเซอร์ได้
pin9.read_digital()
radio.config(group=RADIO_GROUP, length=16, queue=2, power=7, data_rate=radio.RATE_250KBIT)
radio.on()
coils_off()
music.stop(pin16)
while True:
    check_serial_commands()
    check_radio()
    report_hardware_state()
    service_buzzer()
    sleep(10)
