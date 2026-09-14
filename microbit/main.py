# SFAB cabinet firmware — micro:bit V1.5, MicroPython v1.1.1, USB serial to the Raspberry Pi.
#
# Replaces the MakeCode program (last MakeCode revision: git 2a1de19; the students' 2026-09-12
# build is preserved as a raw dump, harness-audits/sfab-nema-v1-20260912/live-20260912-*.bin).
# Why the rewrite, decided by Bank 2026-09-12: the ESP32 is gone, the Pi drives the board over
# USB, and MicroPython is what we can build, flash and verify from the Pi end to end.
#
# Frame contract is UNCHANGED from the MakeCode/ESP32 era, so edge/controller.mjs keeps its
# journal, hold and ACK semantics; only the transport moved from ESP32-HTTP to Pi-USB-serial.
#   board -> Pi : READY:<epoch> | BUSY            every 500 ms, unsolicited
#                 DONE<drawer>:<id>               after the motor finished, remote commands only
#                 REJECT:<id>                     busy, or the epoch in the frame is stale
#                 BUZZ_DONE1:<id> | BUZZ_DONE0:<id>
#   Pi -> board : OPEN1:<id>:<epoch> | OPEN2:<id>:<epoch> | BUZZ1:<id> | BUZZ0:<id>
#
# Hardware, measured on the cabinet 2026-09-12 (Bank watched every run; wiki smart-first-aid-box §7):
#   two NEMA-17 steppers on two L298N modules, one-hot wave drive, 200 steps = one revolution.
#   drawer 1 (cut/abrasion) = bottom motor P12 P13 P14 P15, rotating order P12 P14 P13 P15
#   drawer 2 (insect)       = top motor    P0  P1  P2  P8,  rotating order P0  P2  P1  P8
#   buzzer on P16 — `music` defaults to P0, which is now a motor coil; P16 is the last free pin.
#     P5/P11 are wired to buttons A/B in hardware and can never drive it (silent ACK trap, 2026-09-14).
#     The board stops the buzzer itself after BUZZ_MAX_MS; BUZZ0 still stops it at once.
# Physical buttons no longer dispense: an ungated button bypassed every safety in the Pi
# (handoff 2026-09-12 §6.1), and Bank/Nai agreed the board must not start a dispense on its own.
from microbit import uart, display, sleep, running_time, Image, pin16
from microbit import pin0, pin1, pin2, pin8, pin12, pin13, pin14, pin15
import music

DISPENSE_STEPS = 200
STEP_MS = 5
HEARTBEAT_MS = 500
ID_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-'

# ออดดับตัวเองหลังเท่านี้ ไม่ต้องรอใครสั่ง (Bank เคาะ 5 วินาที 2026-09-14)
#
# ของเดิม BUZZ1 เล่น music.pitch(..., -1) = ดังไปเรื่อยๆ และปุ่มปิดมีที่เดียวคือหน้าครูบน Vercel
# ซึ่งต้องล็อกอิน ⇒ วันที่เทส ไม่มีใครในโรงเรียนปิดออดได้เลย ต้องยิงคำสั่งจากนอกให้
# ตัวจับเวลาอยู่ที่บอร์ด ไม่ใช่ที่ Pi เพราะถ้า Pi ดับหรือ service ตายกลางคัน ออดต้องยังดับเอง
# BUZZ0 ยังหยุดได้ทันทีเหมือนเดิม และ BUZZ1 ใหม่เริ่มนับใหม่
BUZZ_MAX_MS = 5000

# drawer -> coil pins in the order that rotates cleanly (IN1, IN3, IN2, IN4 of each L298N)
MOTORS = {1: [pin12, pin14, pin13, pin15], 2: [pin0, pin2, pin1, pin8]}

busy = False
ready_epoch = 1
last_heartbeat = 0
buzz_until = 0
line = b''
overflow = False


def coils_off():
    for pins in MOTORS.values():
        for p in pins:
            p.write_digital(0)


def service_buzzer():
    # เรียกจากลูปหลัก และจากในลูปมอเตอร์ด้วย ไม่งั้นระหว่างจ่ายยา 1 วินาทีจะไม่มีใครมาดับให้
    global buzz_until
    if buzz_until and running_time() >= buzz_until:
        buzz_until = 0
        music.stop(pin16)


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
            active = i % 4
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
        global buzz_until
        if parts[0] == 'BUZZ1':
            music.pitch(880, -1, pin=pin16, wait=False)
            buzz_until = running_time() + BUZZ_MAX_MS
        else:
            buzz_until = 0
            music.stop(pin16)
        # ACK ทันทีเหมือนเดิม = "รับคำสั่งแล้ว" ไม่ใช่ "เสียงจบแล้ว" · การดับเองตอนครบเวลา
        # ไม่ส่งอะไรกลับ เพราะมันไม่มี command id และฝั่ง Pi ไม่ได้เก็บสถานะออดไว้เทียบอยู่แล้ว
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
coils_off()
music.stop(pin16)
display.show(Image.YES)
while True:
    check_serial_commands()
    report_hardware_state()
    service_buzzer()
    sleep(10)
