"""
============================================================
SMART FIRST AID BOX - Synchronized 5-Step Firmware (v3.0)
============================================================
Hardware: micro:bit V2 + INEX Activity:Bit + KittenBot OLED 128x64

ปุ่ม:
P16 = START/RESET | P8 = Abrasion | P12 = Insect Bite (Active HIGH)

LED:
P0 = Green LED | P1 = Red LED

OLED:
I2C (P19/P20 auto - ห้ามใช้พินนี้กับอุปกรณ์อื่น)

UART Serial (เชื่อมต่อ ESP32):
P2 = TX, P2 = RX (Baud rate 115200)

มอเตอร์สเต็ปเปอร์ 4 สาย (28BYJ-48 style):
มอเตอร์ 1 (Insect Bite / แดง) : P4, P5, P6, P7    + 5V, GND
มอเตอร์ 2 (Abrasion   / เขียว): P11, P13, P14, P15 + 5V, GND

Flow ระบบซิงค์ 5 ขั้นตอน (Web & Physical Buttons):
1. ปุ่มเป็น Edge-Triggered (กดครั้งเดียว = ทำงานครั้งเดียว)
2. สั่งงานได้ทั้งจากปุ่มกดหน้าตู้ และคำสั่งจากหน้าเว็บผ่าน ESP32 UART (OPEN1/OPEN2)
3. เลือกอาการ -> โชว์อาการ + LED ค้าง ~2.5 วิ -> "System is running..."
   -> หมุนมอเตอร์ส่งยา (DISPENSE_STEPS = 2048) และส่ง OK1/OK2 แจ้งเว็บ
4. แสดงวิธีทำแผล 5 ขั้นตอนบนจอ OLED:
   - กดปุ่มหน้าตู้ (P8/P12/P16) หรือกด "ขั้นตอนถัดไป" บนเว็บ (ยิง NEXT) -> เปลี่ยนหน้า OLED
   - กด "เสร็จสิ้น" บนเว็บ (ยิง FINISH) หรือทำครบ 5 ขั้นตอน -> โชว์ "Complete!" -> ดับ LED -> กลับ Welcome
5. อยู่หน้า Welcome -> นับเวลาครบ SLEEP_TIMEOUT (15s) -> เข้า Sleep Mode
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
SYMPTOM_DISPLAY_MS = 2500    # เวลาโชว์หน้าอาการก่อนหมุนมอเตอร์
CARE_DONE_MS = 2500          # เวลาโชว์ข้อความ "Complete!" ค้างไว้ก่อนกลับ Welcome
RESET_DELAY_MS = 300         # หน่วงเวลาก่อนกลับ Welcome
SLEEP_TIMEOUT = 15000        # 15 วินาที ไม่มีการกดปุ่ม -> เข้า Sleep Mode
BOUNCE_DELAY = 50            # หน่วงกันปุ่มกระพือ

STEP_SEQUENCE = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]

# ---------- GLOBAL VARIABLES ----------
state = STATE_WELCOME
lastState = -1
lastAction = 0
careStep = 1

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


# ---------- BUTTON SENSING (Edge-Triggered) ----------
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
    current2 = pins.digital_read_pin(PIN_ABRASION) == 1
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


# ---------- LED CONTROL ----------
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
    if state == STATE_WELCOME or state == STATE_SLEEP:
        leds_off()
    elif state == STATE_MENU:
        leds_menu()
    elif state == STATE_ABRASION:
        leds_abrasion()
    elif state == STATE_INSECT:
        leds_insect()


# ---------- OLED DISPLAY ----------
def show_welcome():
    OLED12864_I2C.clear()
    OLED12864_I2C.show_string(0, 0, "Welcome", 1)
    OLED12864_I2C.show_string(0, 2, "Press START", 1)


def show_menu():
    OLED12864_I2C.clear()
    OLED12864_I2C.show_string(0, 0, "Select Wound:", 1)
    OLED12864_I2C.show_string(0, 2, "P8 / A: Abrasion", 1)
    OLED12864_I2C.show_string(0, 4, "P12/ B: Insect", 1)


def show_sleep():
    OLED12864_I2C.clear()


def show_running():
    OLED12864_I2C.clear()
    OLED12864_I2C.show_string(0, 0, "System is", 1)
    OLED12864_I2C.show_string(0, 2, "running...", 1)


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


def update_care_display():
    if state == STATE_ABRASION:
        show_abrasion_step(careStep)
    elif state == STATE_INSECT:
        show_insect_step(careStep)


def update_display():
    global lastState
    if state == lastState:
        return
    if state == STATE_WELCOME:
        show_welcome()
    elif state == STATE_MENU:
        show_menu()
    elif state == STATE_SLEEP:
        show_sleep()
    lastState = state


# ---------- MOTOR CONTROL ----------
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


# ---------- CARE FLOW & STATE TRANSITION ----------
def reset_to_welcome():
    global lastState, state, lastAction, careStep
    leds_off()
    motor_stop(MOTOR1_PINS)
    motor_stop(MOTOR2_PINS)
    basic.pause(RESET_DELAY_MS)
    careStep = 1
    lastState = -1
    state = STATE_WELCOME
    lastAction = input.running_time()
    show_welcome()


def finish_care_session():
    show_care_done()
    basic.pause(CARE_DONE_MS)
    reset_to_welcome()


def start_abrasion_dispense():
    global state, careStep, lastAction
    for i in range(3):
        serial.write_line("OK1")
        basic.pause(50)

    state = STATE_ABRASION
    careStep = 1
    lastAction = input.running_time()
    update_leds()

    OLED12864_I2C.clear()
    OLED12864_I2C.show_string(0, 0, "Abrasion Care", 1)
    OLED12864_I2C.show_string(0, 2, "Green LED ON", 1)
    basic.pause(SYMPTOM_DISPLAY_MS)

    show_running()
    motor_run(MOTOR2_PINS, DISPENSE_STEPS, STEP_DELAY_MS)
    show_abrasion_step(1)


def start_insect_dispense():
    global state, careStep, lastAction
    for i in range(3):
        serial.write_line("OK2")
        basic.pause(50)

    state = STATE_INSECT
    careStep = 1
    lastAction = input.running_time()
    update_leds()

    OLED12864_I2C.clear()
    OLED12864_I2C.show_string(0, 0, "Insect Care", 1)
    OLED12864_I2C.show_string(0, 2, "Red LED ON", 1)
    basic.pause(SYMPTOM_DISPLAY_MS)

    show_running()
    motor_run(MOTOR1_PINS, DISPENSE_STEPS, STEP_DELAY_MS)
    show_insect_step(1)


def advance_step():
    global careStep, lastAction
    lastAction = input.running_time()
    if state == STATE_ABRASION or state == STATE_INSECT:
        if careStep < 5:
            careStep += 1
            update_care_display()
        else:
            finish_care_session()


# ---------- UART SERIAL CONFIG & HANDLER ----------
serial.redirect(SerialPin.P2, SerialPin.P2, BaudRate.BAUD_RATE115200)


def check_serial_commands():
    cmd = serial.read_string()
    if len(cmd) > 0:
        global lastAction
        lastAction = input.running_time()
        if "OPEN1" in cmd or "ABRASION" in cmd:
            if state != STATE_ABRASION:
                start_abrasion_dispense()
        elif "OPEN2" in cmd or "INSECT" in cmd:
            if state != STATE_INSECT:
                start_insect_dispense()
        elif "NEXT" in cmd:
            advance_step()
        elif "FINISH" in cmd:
            finish_care_session()


# ---------- SETUP ----------
OLED12864_I2C.init(60)
leds_off()
motor_stop(MOTOR1_PINS)
motor_stop(MOTOR2_PINS)
lastAction = input.running_time()
startPrev = pins.digital_read_pin(PIN_START) == 1 or input.button_is_pressed(Button.A)
abrasionPrev = pins.digital_read_pin(PIN_ABRASION) == 1
insectPrev = pins.digital_read_pin(PIN_INSECT) == 1 or input.button_is_pressed(Button.B)
show_welcome()
update_leds()


# ---------- MAIN LOOP (100% Non-Blocking State Machine) ----------
def on_forever():
    global state, lastAction, startEdge, abrasionEdge, insectEdge

    # 1. อ่านคำสั่ง Serial จากเว็บ/ESP32 (แบบ Non-Blocking)
    check_serial_commands()

    # 2. อ่านปุ่มกดหน้าตู้ทุกปุ่ม
    startEdge = start_pressed()
    abrasionEdge = abrasion_pressed()
    insectEdge = insect_pressed()

    # ----- ตรวจสอบ Sleep Timeout (15 วินาทีไม่มีการกดอะไร) -----
    if state != STATE_SLEEP:
        if input.running_time() - lastAction >= SLEEP_TIMEOUT:
            if state == STATE_ABRASION or state == STATE_INSECT:
                finish_care_session()
            else:
                state = STATE_SLEEP
                leds_off()
                show_sleep()
            basic.pause(20)
            return

    # ----- STATE 0 : Welcome -----
    if state == STATE_WELCOME:
        if startEdge:
            state = STATE_MENU
            lastAction = input.running_time()
            update_leds()
            show_menu()

    # ----- STATE 1 : Menu (เลือกชนิดบาดแผล) -----
    elif state == STATE_MENU:
        if abrasionEdge:
            start_abrasion_dispense()
        elif insectEdge:
            start_insect_dispense()

    # ----- STATE 2 & 3 : Care Steps (กำลังทำแผล 5 ขั้นตอน) -----
    elif state == STATE_ABRASION:
        if abrasionEdge or startEdge:
            advance_step()

    elif state == STATE_INSECT:
        if insectEdge or startEdge:
            advance_step()

    # ----- SLEEP MODE (ปลุกด้วยปุ่มใดก็ได้) -----
    elif state == STATE_SLEEP:
        if startEdge or abrasionEdge or insectEdge:
            reset_to_welcome()

    basic.pause(20)


basic.forever(on_forever)
