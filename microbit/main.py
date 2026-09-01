"""
============================================================
SMART FIRST AID BOX - Final Complete Version (5-Step Sync Web & OLED)
============================================================
Hardware: micro:bit V2 + INEX Activity:Bit + KittenBot OLED 128x64

ปุ่มหน้าตู้ & ปุ่มสำรองบนบอร์ด:
- P16 หรือ ปุ่ม A บน micro:bit = START/RESET
- P8  หรือ ปุ่ม A บน micro:bit = Abrasion (แผลถลอก) / กดถัดไป
- P12 หรือ ปุ่ม B บน micro:bit = Insect Bite (แมลงกัด) / กดถัดไป

LED:
- P0 = Green LED (แผลถลอก)
- P1 = Red LED (แมลงกัด)

OLED:
- I2C (P19/P20 auto)

Serial Communication (เชื่อมต่อ ESP32 / Web):
- Default Serial (Baud rate 115200) - ไม่ต้องใช้ serial.redirect ให้พินชน
- คำสั่ง: OPEN1, OPEN2, NEXT, FINISH

มอเตอร์สเต็ปเปอร์ 4 สาย (28BYJ-48 style):
- มอเตอร์ 1 (Insect Bite / แดง) : P4, P5, P6, P7    + 5V, GND
- มอเตอร์ 2 (Abrasion   / เขียว): P11, P13, P14, P15 + 5V, GND
============================================================
"""

# ---------- STATE CONSTANTS ----------
STATE_WELCOME = 0
STATE_MENU = 1
STATE_ABRASION = 2
STATE_INSECT = 3
STATE_SLEEP = 4

# ---------- PIN CONFIG ----------
PIN_START = DigitalPin.P16
PIN_ABRASION = DigitalPin.P8
PIN_INSECT = DigitalPin.P12
PIN_LED_GREEN = DigitalPin.P0
PIN_LED_RED = DigitalPin.P1

# มอเตอร์ 1 : Insect Bite (แดง)
MOTOR1_PINS = [DigitalPin.P4, DigitalPin.P5, DigitalPin.P6, DigitalPin.P7]
# มอเตอร์ 2 : Abrasion (เขียว)
MOTOR2_PINS = [DigitalPin.P11, DigitalPin.P13, DigitalPin.P14, DigitalPin.P15]

# ---------- MOTOR / TIMING CONFIG ----------
DISPENSE_STEPS = 2048        # ~1 รอบเพลาส่งออกของสเต็ปเปอร์ 28BYJ-48
STEP_DELAY_MS = 2            # ความเร็วหมุน (ms)
SYMPTOM_DISPLAY_MS = 2000    # เวลาโชว์หน้าอาการก่อนหมุนมอเตอร์
CARE_DONE_MS = 2500          # เวลาโชว์ข้อความ "Completed!" ก่อนกลับ Welcome
RESET_DELAY_MS = 300         # หน่วงเวลารีเซ็ต
SLEEP_TIMEOUT = 15000        # 15 วินาที ไม่มีการกดปุ่ม -> เข้า Sleep Mode
BOUNCE_DELAY = 50            # หน่วงกันปุ่มกระพือ

# ลำดับ Full-Step มาตรฐานของสเต็ปเปอร์ 4 สาย
STEP_SEQUENCE = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]

# ---------- GLOBAL VARIABLES ----------
state = STATE_WELCOME   # สถานะปัจจุบันของระบบ
lastState = -1           # สถานะก่อนหน้า
lastAction = 0            # เวลาล่าสุดที่มีการเคลื่อนไหว
careStep = 1              # ขั้นตอนดูแลแผลปัจจุบัน (1-5)

startPrev = False
abrasionPrev = False
insectPrev = False

current = False
edge = False
current2 = False
edge2 = False
current3 = False
edge3 = False

startEdge = False
abrasionEdge = False
insectEdge = False


# ---------- ฟังก์ชันตรวจจับ "ขอบขาขึ้น" ของปุ่ม ----------
def start_pressed():
    global current, edge, startPrev
    current = pins.digital_read_pin(PIN_START) == 1 or input.button_is_pressed(Button.A)
    edge = current and not (startPrev)
    startPrev = current
    if edge:
        basic.pause(BOUNCE_DELAY)
    return edge


def abrasion_pressed():
    global current2, edge2, abrasionPrev
    current2 = pins.digital_read_pin(PIN_ABRASION) == 1 or input.button_is_pressed(Button.A)
    edge2 = current2 and not (abrasionPrev)
    abrasionPrev = current2
    if edge2:
        basic.pause(BOUNCE_DELAY)
    return edge2


def insect_pressed():
    global current3, edge3, insectPrev
    current3 = pins.digital_read_pin(PIN_INSECT) == 1 or input.button_is_pressed(Button.B)
    edge3 = current3 and not (insectPrev)
    insectPrev = current3
    if edge3:
        basic.pause(BOUNCE_DELAY)
    return edge3


# ---------- ฟังก์ชันควบคุม LED ----------
def leds_off():
    pins.digital_write_pin(PIN_LED_GREEN, 0)
    pins.digital_write_pin(PIN_LED_RED, 0)


def leds_menu():
    pins.digital_write_pin(PIN_LED_GREEN, 1)
    pins.digital_write_pin(PIN_LED_RED, 1)


def leds_abrasion():
    pins.digital_write_pin(PIN_LED_GREEN, 1)
    pins.digital_write_pin(PIN_LED_RED, 0)


def leds_insect():
    pins.digital_write_pin(PIN_LED_GREEN, 0)
    pins.digital_write_pin(PIN_LED_RED, 1)


def update_leds():
    if state == STATE_WELCOME:
        leds_off()
    elif state == STATE_MENU:
        leds_menu()
    elif state == STATE_ABRASION:
        leds_abrasion()
    elif state == STATE_INSECT:
        leds_insect()
    elif state == STATE_SLEEP:
        leds_off()


# ---------- ฟังก์ชันแสดงผล OLED ของแต่ละ STATE ----------
def show_welcome():
    OLED12864_I2C.clear()
    OLED12864_I2C.show_string(0, 0, "Welcome", 1)
    OLED12864_I2C.show_string(0, 2, "Press START", 1)


def show_menu():
    OLED12864_I2C.clear()
    OLED12864_I2C.show_string(0, 0, "Select Wound:", 1)
    OLED12864_I2C.show_string(0, 2, "P8 / A: Abrasion", 1)
    OLED12864_I2C.show_string(0, 4, "P12/ B: Insect", 1)


def show_abrasion():
    OLED12864_I2C.clear()
    OLED12864_I2C.show_string(0, 0, "Abrasion", 1)
    OLED12864_I2C.show_string(0, 2, "Green LED ON", 1)


def show_insect():
    OLED12864_I2C.clear()
    OLED12864_I2C.show_string(0, 0, "Insect Bite", 1)
    OLED12864_I2C.show_string(0, 2, "Red LED ON", 1)


def show_running():
    OLED12864_I2C.clear()
    OLED12864_I2C.show_string(0, 0, "System is", 1)
    OLED12864_I2C.show_string(0, 2, "running...", 1)


def show_sleep():
    OLED12864_I2C.clear()


# ---------- ฟังก์ชันแสดงวิธีปฐมพยาบาล 5 ขั้นตอน (Abrasion & Insect) ----------
def show_abrasion_step(step: number):
    OLED12864_I2C.clear()
    if step == 1:
        OLED12864_I2C.show_string(0, 0, "Step 1/5: Wash", 1)
        OLED12864_I2C.show_string(0, 2, "Wash hands with", 1)
        OLED12864_I2C.show_string(0, 3, "soap and water", 1)
        OLED12864_I2C.show_string(0, 6, ">> Press P8/Web", 1)
    elif step == 2:
        OLED12864_I2C.show_string(0, 0, "Step 2/5: Rinse", 1)
        OLED12864_I2C.show_string(0, 2, "Rinse wound with", 1)
        OLED12864_I2C.show_string(0, 3, "saline solution", 1)
        OLED12864_I2C.show_string(0, 6, ">> Press P8/Web", 1)
    elif step == 3:
        OLED12864_I2C.show_string(0, 0, "Step 3/5: Dry", 1)
        OLED12864_I2C.show_string(0, 2, "Pat wound dry", 1)
        OLED12864_I2C.show_string(0, 3, "with gauze pad", 1)
        OLED12864_I2C.show_string(0, 6, ">> Press P8/Web", 1)
    elif step == 4:
        OLED12864_I2C.show_string(0, 0, "Step 4/5: Apply", 1)
        OLED12864_I2C.show_string(0, 2, "Apply antiseptic", 1)
        OLED12864_I2C.show_string(0, 3, "around wound", 1)
        OLED12864_I2C.show_string(0, 6, ">> Press P8/Web", 1)
    elif step == 5:
        OLED12864_I2C.show_string(0, 0, "Step 5/5: Cover", 1)
        OLED12864_I2C.show_string(0, 2, "Cover wound with", 1)
        OLED12864_I2C.show_string(0, 3, "plaster or gauze", 1)
        OLED12864_I2C.show_string(0, 6, ">> Press P8/Web", 1)


def show_insect_step(step: number):
    OLED12864_I2C.clear()
    if step == 1:
        OLED12864_I2C.show_string(0, 0, "Step 1/5: Wash", 1)
        OLED12864_I2C.show_string(0, 2, "Wash hands with", 1)
        OLED12864_I2C.show_string(0, 3, "soap and water", 1)
        OLED12864_I2C.show_string(0, 6, ">> Press P12/Web", 1)
    elif step == 2:
        OLED12864_I2C.show_string(0, 0, "Step 2/5: Clean", 1)
        OLED12864_I2C.show_string(0, 2, "Wash bite area", 1)
        OLED12864_I2C.show_string(0, 3, "with mild soap", 1)
        OLED12864_I2C.show_string(0, 6, ">> Press P12/Web", 1)
    elif step == 3:
        OLED12864_I2C.show_string(0, 0, "Step 3/5: Ice", 1)
        OLED12864_I2C.show_string(0, 2, "Apply ice pack", 1)
        OLED12864_I2C.show_string(0, 3, "for 5-10 mins", 1)
        OLED12864_I2C.show_string(0, 6, ">> Press P12/Web", 1)
    elif step == 4:
        OLED12864_I2C.show_string(0, 0, "Step 4/5: Apply", 1)
        OLED12864_I2C.show_string(0, 2, "Apply calamine", 1)
        OLED12864_I2C.show_string(0, 3, "or soothing gel", 1)
        OLED12864_I2C.show_string(0, 6, ">> Press P12/Web", 1)
    elif step == 5:
        OLED12864_I2C.show_string(0, 0, "Step 5/5: Advice", 1)
        OLED12864_I2C.show_string(0, 2, "Avoid scratching", 1)
        OLED12864_I2C.show_string(0, 3, "prevent infection", 1)
        OLED12864_I2C.show_string(0, 6, ">> Press P12/Web", 1)


def show_care_done():
    OLED12864_I2C.clear()
    OLED12864_I2C.show_string(0, 0, "Wound Care", 1)
    OLED12864_I2C.show_string(0, 2, "Completed!", 1)
    OLED12864_I2C.show_string(0, 4, "Stay safe :)", 1)


def update_display():
    global lastState
    if state == lastState:
        return
    if state == STATE_WELCOME:
        show_welcome()
    elif state == STATE_MENU:
        show_menu()
    elif state == STATE_ABRASION:
        show_abrasion()
    elif state == STATE_INSECT:
        show_insect()
    elif state == STATE_SLEEP:
        show_sleep()
    lastState = state


# ---------- ฟังก์ชันควบคุมมอเตอร์ ----------
def motor_run(motor_pins2: any, steps: number, delay_ms: number):
    seq_len = len(STEP_SEQUENCE)
    for i in range(steps):
        pattern = STEP_SEQUENCE[i % seq_len]
        for j in range(4):
            pins.digital_write_pin(motor_pins2[j], pattern[j])
        basic.pause(delay_ms)
    motor_stop(motor_pins2)


def motor_stop(motor_pins: List[number]):
    for p in motor_pins:
        pins.digital_write_pin(p, 0)


# ---------- ฟังก์ชันรอกดปุ่มเดิมซ้ำ หรือรอสัญญาณ NEXT/FINISH จากเว็บ ----------
def wait_for_care_step_advance(pin: DigitalPin, current_s: number):
    # หน่วง 500ms
    basic.pause(500)
    confirmed = False
    while not (confirmed):
        # 1. เช็คคำสั่งสั่งเปลี่ยนหน้าจากเว็บ (NEXT / FINISH)
        cmd = serial.read_string()
        if len(cmd) > 0:
            if "NEXT" in cmd or "FINISH" in cmd:
                break
        # 2. เช็คปุ่มกดที่หน้าตู้
        if pins.digital_read_pin(pin) == 1 or input.button_is_pressed(Button.A) or input.button_is_pressed(Button.B):
            basic.pause(BOUNCE_DELAY)
            break
        basic.pause(20)


def finish_care_session():
    show_care_done()
    basic.pause(CARE_DONE_MS)
    reset_to_welcome()


# ---------- ฟังก์ชันจ่ายยา/สเปรย์ และทำแผล 5 ขั้นตอน ----------
def dispense_abrasion():
    global careStep
    serial.write_string("OK1\n")  # ตอบกลับ ACK แจ้ง ESP32/Web ทันที
    basic.pause(SYMPTOM_DISPLAY_MS)
    show_running()
    motor_run(MOTOR2_PINS, DISPENSE_STEPS, STEP_DELAY_MS)

    # ทำแผล 5 ขั้นตอน
    for s in range(1, 6):
        careStep = s
        show_abrasion_step(s)
        wait_for_care_step_advance(PIN_ABRASION, s)

    finish_care_session()


def dispense_insect():
    global careStep
    serial.write_string("OK2\n")  # ตอบกลับ ACK แจ้ง ESP32/Web ทันที
    basic.pause(SYMPTOM_DISPLAY_MS)
    show_running()
    motor_run(MOTOR1_PINS, DISPENSE_STEPS, STEP_DELAY_MS)

    # ทำแผล 5 ขั้นตอน
    for s in range(1, 6):
        careStep = s
        show_insect_step(s)
        wait_for_care_step_advance(PIN_INSECT, s)

    finish_care_session()


# ---------- ฟังก์ชันเปลี่ยน STATE ----------
def go_to_state(new_state: number):
    global state, lastAction
    state = new_state
    lastAction = input.running_time()
    update_leds()
    update_display()
    if new_state == STATE_ABRASION:
        dispense_abrasion()
    elif new_state == STATE_INSECT:
        dispense_insect()


def reset_to_welcome():
    global lastState, state, lastAction
    pins.digital_write_pin(PIN_LED_GREEN, 0)
    pins.digital_write_pin(PIN_LED_RED, 0)
    motor_stop(MOTOR1_PINS)
    motor_stop(MOTOR2_PINS)
    basic.pause(RESET_DELAY_MS)
    lastState = -1
    state = STATE_WELCOME
    lastAction = input.running_time()
    update_display()


# ---------- SERIAL COMMAND HANDLER (รับคำสั่ง OPEN1, OPEN2, NEXT, FINISH) ----------
def check_serial_commands():
    cmd = serial.read_string()
    if len(cmd) > 0:
        global lastAction
        lastAction = input.running_time()
        if "OPEN1" in cmd or "ABRASION" in cmd:
            serial.write_string("OK1\n")
            go_to_state(STATE_ABRASION)
        elif "OPEN2" in cmd or "INSECT" in cmd:
            serial.write_string("OK2\n")
            go_to_state(STATE_INSECT)


# ---------- SETUP ----------
OLED12864_I2C.init(60)
leds_off()
motor_stop(MOTOR1_PINS)
motor_stop(MOTOR2_PINS)

lastAction = input.running_time()
startPrev = pins.digital_read_pin(PIN_START) == 1 or input.button_is_pressed(Button.A)
abrasionPrev = pins.digital_read_pin(PIN_ABRASION) == 1
insectPrev = pins.digital_read_pin(PIN_INSECT) == 1
update_display()
update_leds()


# ---------- MAIN LOOP ----------
def on_forever():
    global startEdge, abrasionEdge, insectEdge

    # 1. ตรวจสอบคำสั่งจาก ESP32/Web
    check_serial_commands()

    # 2. อ่านปุ่มกด
    startEdge = start_pressed()
    abrasionEdge = abrasion_pressed()
    insectEdge = insect_pressed()

    # ----- ตรวจสอบ Sleep Mode -----
    if state != STATE_SLEEP:
        if input.running_time() - lastAction >= SLEEP_TIMEOUT:
            go_to_state(STATE_SLEEP)
            basic.pause(20)
            return

    # ----- STATE 0 : Welcome -----
    if state == STATE_WELCOME:
        if startEdge:
            go_to_state(STATE_MENU)

    # ----- STATE 1 : Menu (เลือกชนิดบาดแผล) -----
    elif state == STATE_MENU:
        if abrasionEdge:
            go_to_state(STATE_ABRASION)
        elif insectEdge:
            go_to_state(STATE_INSECT)

    # ----- Sleep Mode : ปลุกด้วยปุ่ม START -----
    elif state == STATE_SLEEP:
        if startEdge:
            reset_to_welcome()

    basic.pause(20)


basic.forever(on_forever)
