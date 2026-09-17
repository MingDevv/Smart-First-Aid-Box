# โปรแกรมในตู้ยา micro:bit V1.5 ต่อ USB เข้า Raspberry Pi
# ไฟล์นี้ยาวเกิน 8188 ไบต์ไม่ได้ บอร์ด V1 รับไม่ไหว คำอธิบายเต็มอยู่ใน README
#
# การต่อสาย (วัดจากตู้จริง) มอเตอร์ NEMA-17 ผ่าน L298N หมุนครบรอบ 200 สเต็ป
#   ช่อง 1 แผลถลอก ตัวล่าง P12 P13 P14 P15   ช่อง 2 แมลงกัด ตัวบน P0 P1 P2 P8
#   ออด P16 ห้ามย้ายไป P5 หรือ P11 สองขานั้นต่อกับปุ่ม A/B อยู่ ย้ายไปแล้วจะเงียบ
#
# ปุ่มบนบอร์ดไม่จ่ายยา เพราะจะข้ามการตรวจสิทธิ์ที่อยู่ฝั่ง Pi ทั้งหมด
from microbit import uart, display, sleep, running_time, Image, pin16
from microbit import pin0, pin1, pin2, pin8, pin12, pin13, pin14, pin15
import music
import radio

DISPENSE_STEPS = 200
STEP_MS = 5
HEARTBEAT_MS = 500
ID_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-'

# ออดดับเองหลังเวลานี้ ให้บอร์ดนับเอง เผื่อ Pi ดับกลางคัน
BUZZ_MAX_MS = 5000

# ต้องตรงกับ remote.py · ที่ต้องมี SFAB1: นำหน้า เพราะในงานแข่งมีบอร์ดทีมอื่นเยอะ
# ถ้าดูแต่ group สัญญาณคนอื่นสั่งออดเราดังได้
RADIO_GROUP = 91
RADIO_PREFIX = 'SFAB1:SOS:'
SOS_ACK = 'SFAB1:OK'
BUZZ_ON = 'SFAB1:B1'
BUZZ_OFF = 'SFAB1:B0'
# ระหว่างร้อง ตู้บอกรีโมตเรื่อยๆ ว่ายังร้องอยู่ ขาดไปรีโมตจะดับเอง
BEACON_MS = 400

# ขาคอยล์ของแต่ละช่อง เรียง IN1 IN3 IN2 IN4 · motor_run เดินย้อนลำดับนี้
MOTORS = {1: [pin12, pin14, pin13, pin15], 2: [pin0, pin2, pin1, pin8]}

busy = False
ready_epoch = 1
last_heartbeat = 0
buzz_until = 0
last_beacon = 0
last_sos_seq = ''
line = b''
overflow = False


def coils_off():
    for pins in MOTORS.values():
        for p in pins:
            p.write_digital(0)


def start_buzzer():
    global buzz_until, last_beacon
    music.pitch(880, -1, pin=pin16, wait=False)
    buzz_until = running_time() + BUZZ_MAX_MS
    last_beacon = 0             # ให้ส่งสัญญาณทันที รีโมตจะได้ร้องพร้อมกัน


def stop_buzzer():
    global buzz_until
    buzz_until = 0
    music.stop(pin16)
    for _ in range(3):          # ส่งซ้ำ กันสัญญาณหาย
        radio.send(BUZZ_OFF)


def check_radio():
    # รีโมตส่งซ้ำหลายครั้ง ต้องกันซ้ำด้วย seq ไม่งั้นออดจะถูกสั่งเริ่มใหม่รัวๆ
    global last_sos_seq
    message = radio.receive()
    if message is None or not message.startswith(RADIO_PREFIX):
        return
    seq = message[len(RADIO_PREFIX):]
    if seq == last_sos_seq:
        return
    last_sos_seq = seq
    radio.send(SOS_ACK)         # ตอบรีโมตก่อน จะได้รู้เร็วว่าสัญญาณถึง
    start_buzzer()
    display.show(Image.SKULL)
    # ต่อเวลาท้าย id กันซ้ำ และให้ยาวพอผ่านการตรวจฝั่ง Pi (8-64 ตัว)
    uart.write('REMOTE_SOS:rsos-' + seq + '-' + str(running_time()) + '\n')


def service_buzzer():
    # เรียกตอนมอเตอร์หมุนด้วย ไม่งั้นระหว่างจ่ายยาไม่มีใครมาดับออด
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
    # ต้องเรียกตอนมอเตอร์หมุนด้วย Pi จะได้เห็นว่ายัง BUSY อยู่
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
            sleep(delay_ms)
    finally:
        for p in pins:
            p.write_digital(0)


def dispense(drawer, command_id):
    # เปลี่ยน epoch ก่อนเสมอ คำสั่งเก่าที่ค้างอยู่ในสายจะได้ถูกปฏิเสธ
    global busy, ready_epoch
    ready_epoch += 1
    busy = True
    uart.write('BUSY\n')
    display.show(Image.ARROW_S if drawer == 1 else Image.ARROW_N)
    try:
        motor_run(MOTORS[drawer], DISPENSE_STEPS, STEP_MS)
    finally:
        busy = False
        display.show(Image.YES)
    # ตอบหลังมอเตอร์หมุนจบเท่านั้น ห้ามตอบตอนเพิ่งรับคำสั่ง
    uart.write('DONE' + str(drawer) + ':' + command_id + '\n')


def valid_id(command_id):
    if len(command_id) < 8 or len(command_id) > 64:
        return False
    for ch in command_id:
        if ID_CHARS.find(ch) < 0:
            return False
    return True


def handle_serial_frame(frame):
    parts = frame.split(':')
    if len(parts) < 2 or len(parts) > 3:
        return
    command_id = parts[1]
    if not valid_id(command_id):
        return
    if len(parts) == 2 and parts[0] in ('BUZZ1', 'BUZZ0'):
        if parts[0] == 'BUZZ1':
            start_buzzer()
        else:
            stop_buzzer()
        # ตอบว่ารับคำสั่งแล้ว ไม่ได้แปลว่าเสียงจบแล้ว
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
# power=7 คือแรงสุด ส่วน 250 kbit ทำให้ฝั่งรับไวขึ้น ช่วยเรื่องระยะคนละแบบกัน
radio.config(group=RADIO_GROUP, length=16, queue=2, power=7, data_rate=radio.RATE_250KBIT)
radio.on()
coils_off()
music.stop(pin16)
display.show(Image.YES)
while True:
    check_serial_commands()
    check_radio()
    report_hardware_state()
    service_buzzer()
    sleep(10)
