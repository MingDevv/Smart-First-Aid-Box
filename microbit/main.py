# SFAB cabinet firmware — micro:bit V1.5, MicroPython v1.1.1, USB serial to the Raspberry Pi.
# Rationale and history: microbit/README.md. Script must stay under 8188 bytes (V1 limit).
#
#   board -> Pi : READY:<epoch> | BUSY            every 500 ms, unsolicited
#                 DONE<drawer>:<id>               after the motor finished
#                 REJECT:<id>                     busy, or the epoch in the frame is stale
#                 BUZZ_DONE1:<id> | BUZZ_DONE0:<id>
#                 REMOTE_SOS:<id>                 radio button pressed, not a reply to the Pi
#   Pi -> board : OPEN1:<id>:<epoch> | OPEN2:<id>:<epoch> | BUZZ1:<id> | BUZZ0:<id>
#
# Hardware, measured on the cabinet (wiki smart-first-aid-box §7):
#   two NEMA-17 steppers on two L298N modules, one-hot wave drive, 200 steps = one revolution.
#   drawer 1 (cut/abrasion) = bottom motor P12 P13 P14 P15, rotating order P12 P15 P13 P14
#   drawer 2 (insect)       = top motor    P0  P1  P2  P8,  rotating order P0  P8  P1  P2
#   buzzer on P16 — `music` defaults to P0, which is now a motor coil; P16 is the last free pin.
#     P5/P11 are wired to buttons A/B in hardware and can never drive it (silent ACK trap).
# Physical buttons never dispense: an ungated button bypasses every safety in the Pi.
from microbit import uart, display, sleep, running_time, Image, pin16
from microbit import pin0, pin1, pin2, pin8, pin12, pin13, pin14, pin15
import music
import radio

DISPENSE_STEPS = 200
STEP_MS = 5
HEARTBEAT_MS = 500
ID_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-'

# ตัวจับเวลาอยู่ที่บอร์ด ไม่ใช่ที่ Pi — Pi ดับกลางคันออดต้องยังดับเอง (README)
BUZZ_MAX_MS = 5000

# วิทยุ — ต้องตรงกับ remote.py · group กันคลื่นชนกัน, prefix กัน micro:bit ทีมอื่นในงานแข่ง
# ที่บังเอิญตั้ง group ตรงกัน ไม่ให้สั่งออดของเราดังได้
RADIO_GROUP = 91
RADIO_PREFIX = 'SFAB1:SOS:'
BUZZ_ON = 'SFAB1:B1'
BUZZ_OFF = 'SFAB1:B0'
# beacon = "ยังร้องอยู่" ไม่ใช่ "สั่งเปิด" ⇒ รีโมตดับเองถ้าขาดการติดต่อ ไม่ค้างร้าง
BEACON_MS = 400

# drawer -> coil phase map (IN1, IN3, IN2, IN4); motor_run traverses it in reverse.
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
    last_beacon = 0             # ให้ beacon ตัวแรกออกทันที รีโมตจะได้ดังพร้อมกัน


def stop_buzzer():
    global buzz_until
    buzz_until = 0
    music.stop(pin16)
    for _ in range(3):          # แพ็กเก็ตปิดหายได้ ยิงซ้ำ (รีโมตมี HOLD_MS กันค้างอีกชั้น)
        radio.send(BUZZ_OFF)


def check_radio():
    # ปุ่มยิงซ้ำหลายครั้งกันแพ็กเก็ตหาย ⇒ กันซ้ำด้วย seq ไม่งั้นออดจะถูกสั่งเริ่มใหม่รัวๆ
    global last_sos_seq
    message = radio.receive()
    if message is None or not message.startswith(RADIO_PREFIX):
        return
    seq = message[len(RADIO_PREFIX):]
    if seq == last_sos_seq:
        return
    last_sos_seq = seq
    start_buzzer()
    display.show(Image.SKULL)
    # id ต้องผ่าน ID regex ฝั่ง Pi (8-64 ตัว) และห้ามซ้ำข้ามการรีบูต จึงพ่วง running_time
    uart.write('REMOTE_SOS:rsos-' + seq + '-' + str(running_time()) + '\n')


def service_buzzer():
    # Called from the main loop AND the motor loop: a dispense must not hold the buzzer on.
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
    # Called from the main loop AND from inside the motor loop, so the Pi keeps seeing BUSY
    # (and can still stop the buzzer) while a drawer is moving.
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
    # Bump the epoch FIRST: any OPEN frame queued during the previous idle period carries the
    # old epoch and is refused. Same rule as the MakeCode go_to_state().
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
    # ACK only after the motor loop returned — never before, never on the way in.
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
        # ACK means "command received", never "sound finished" (README).
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


uart.init(baudrate=115200)      # USB CDC; nothing is redirected to edge pins any more
radio.config(group=RADIO_GROUP, length=16, queue=2)
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
