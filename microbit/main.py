"""
============================================================
SMART FIRST AID BOX — FULL STATE MACHINE FIRMWARE (MICRO:BIT V2)
============================================================
Hardware Connections:
- ปุ่ม START (ปลุก / เริ่ม)       : P0 (หรือ ปุ่ม A)
- ปุ่ม แผลถลอก (ช่อง 1)          : P8
- ปุ่ม แมลงกัด (ช่อง 2)           : P12
- มอเตอร์ 1 (แมลงกัด / ช่อง 2)     : P4, P5, P6, P7
- มอเตอร์ 2 (แผลถลอก   / ช่อง 1)     : P11, P13, P14, P15
- Serial UART (P0=TX, P1=RX)      : เชื่อมต่อ ESP32 (115200 baud)
============================================================
"""

# ---------- PIN CONFIG ----------
PIN_START = DigitalPin.P0
PIN_ABRASION = DigitalPin.P8
PIN_INSECT = DigitalPin.P12

# มอเตอร์ 1 : Insect Bite (แมลงกัด / ช่อง 2)
MOTOR1_PINS = [DigitalPin.P4, DigitalPin.P5, DigitalPin.P6, DigitalPin.P7]
# มอเตอร์ 2 : Abrasion (แผลถลอก / ช่อง 1)
MOTOR2_PINS = [DigitalPin.P11, DigitalPin.P13, DigitalPin.P14, DigitalPin.P15]

# ---------- STATE CONSTANTS ----------
STATE_SLEEP = -1
STATE_WELCOME = 0
STATE_MENU = 1
STATE_ABRASION = 2
STATE_INSECT = 3

# ---------- MOTOR & TIMEOUT CONFIG ----------
DISPENSE_STEPS = 2048        # 1 รอบเพลาสเต็ปเปอร์ 28BYJ-48
STEP_DELAY_MS = 2            # ความเร็วหมุน (ms)
STEP_SEQUENCE = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]
SLEEP_TIMEOUT = 30000        # เข้าสู่ Sleep Mode เมื่อไม่มีการกดปุ่ม 30 วินาที

# ---------- GLOBAL VARIABLES ----------
state = STATE_WELCOME
lastAction = 0

startPrev = False
abrasionPrev = False
insectPrev = False

startEdge = False
abrasionEdge = False
insectEdge = False


# ---------- BUTTON EDGE DETECTORS ----------
def start_pressed() -> bool:
    global startPrev
    # เช็กทั้งพิน P0 และปุ่ม A บนบอร์ด micro:bit
    curr = pins.digital_read_pin(PIN_START) == 1 or input.button_is_pressed(Button.A)
    edge = curr and not startPrev
    startPrev = curr
    if edge:
        update_last_action()
    return edge


def abrasion_pressed() -> bool:
    global abrasionPrev
    curr = pins.digital_read_pin(PIN_ABRASION) == 1
    edge = curr and not abrasionPrev
    abrasionPrev = curr
    if edge:
        update_last_action()
    return edge


def insect_pressed() -> bool:
    global insectPrev
    curr = pins.digital_read_pin(PIN_INSECT) == 1
    edge = curr and not insectPrev
    insectPrev = curr
    if edge:
        update_last_action()
    return edge


def update_last_action():
    global lastAction
    lastAction = input.running_time()


# ---------- MOTOR CONTROL ----------
def motor_run(motor_pins: any, steps: number, delay_ms: number):
    seq_len = len(STEP_SEQUENCE)
    for i in range(steps):
        pattern = STEP_SEQUENCE[i % seq_len]
        for j in range(4):
            pins.digital_write_pin(motor_pins[j], pattern[j])
        basic.pause(delay_ms)
    motor_stop(motor_pins)


def motor_stop(motor_pins: any):
    for p in motor_pins:
        pins.digital_write_pin(p, 0)


# ---------- DISPLAY & LED UPDATES ----------
def update_display():
    if state == STATE_SLEEP:
        basic.clear_screen()
    elif state == STATE_WELCOME:
        basic.show_icon(IconNames.HEART)
    elif state == STATE_MENU:
        basic.show_icon(IconNames.HAPPY)
    elif state == STATE_ABRASION:
        basic.show_number(1)
    elif state == STATE_INSECT:
        basic.show_number(2)


def update_leds():
    pass


def reset_to_welcome():
    go_to_state(STATE_WELCOME)


# ---------- STATE TRANSITION & DISPENSE ----------
def go_to_state(new_state: number):
    global state
    state = new_state
    update_last_action()
    update_display()

    if state == STATE_ABRASION:
        serial.write_line("OK1")
        motor_run(MOTOR2_PINS, DISPENSE_STEPS, STEP_DELAY_MS)
        basic.show_icon(IconNames.YES)
        basic.pause(1000)
        go_to_state(STATE_WELCOME)

    elif state == STATE_INSECT:
        serial.write_line("OK2")
        motor_run(MOTOR1_PINS, DISPENSE_STEPS, STEP_DELAY_MS)
        basic.show_icon(IconNames.YES)
        basic.pause(1000)
        go_to_state(STATE_WELCOME)


# ---------- UART SERIAL CONFIG (P0=TX, P1=RX) ----------
serial.redirect(SerialPin.P0, SerialPin.P1, BaudRate.BAUD_RATE115200)


def check_serial_commands():
    cmd = serial.read_line()
    if len(cmd) > 0:
        update_last_action()
        if "OPEN1" in cmd or "ABRASION" in cmd:
            go_to_state(STATE_ABRASION)
        elif "OPEN2" in cmd or "INSECT" in cmd:
            go_to_state(STATE_INSECT)


# ---------- INITIALIZATION ----------
motor_stop(MOTOR1_PINS)
motor_stop(MOTOR2_PINS)
update_last_action()
go_to_state(STATE_WELCOME)


# ---------- MAIN LOOP (Edge-Triggered State Machine) ----------
def on_forever():
    global startEdge, abrasionEdge, insectEdge

    # 1. ตรวจสอบคำสั่งส่งมาจากหน้าเว็บ/ESP32 ผ่าน UART
    check_serial_commands()

    # 2. อ่านปุ่มกดปุ่มปุ่มหน้าตู้ทุกตัวแบบ Edge-Triggered
    startEdge = start_pressed()
    abrasionEdge = abrasion_pressed()
    insectEdge = insect_pressed()

    # ----- ตรวจสอบ Sleep Mode : ไม่มีการกดปุ่ม/สั่งงานเกิน SLEEP_TIMEOUT -----
    if state != STATE_SLEEP:
        if input.running_time() - lastAction >= SLEEP_TIMEOUT:
            go_to_state(STATE_SLEEP)
            basic.pause(20)
            return

    # ----- STATE 0 : Welcome -----
    if state == STATE_WELCOME:
        if abrasionEdge:
            go_to_state(STATE_ABRASION)
        elif insectEdge:
            go_to_state(STATE_INSECT)
        elif startEdge:
            go_to_state(STATE_MENU)

    # ----- STATE 1 : Menu (เลือกชนิดบาดแผล) -----
    elif state == STATE_MENU:
        if abrasionEdge:
            go_to_state(STATE_ABRASION)
        elif insectEdge:
            go_to_state(STATE_INSECT)

    # ----- Sleep Mode : ปลุกด้วยปุ่ม START หรือปุ่มกดหน้าตู้ -----
    elif state == STATE_SLEEP:
        if startEdge or abrasionEdge or insectEdge:
            reset_to_welcome()

    basic.pause(20)


basic.forever(on_forever)
