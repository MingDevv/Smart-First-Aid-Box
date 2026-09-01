"""
============================================================
SMART FIRST AID BOX - Final Complete Version (+ ESP32 Web Bridge & Care Steps)
============================================================
Hardware: micro:bit V2 + INEX Activity:Bit + KittenBot OLED 128x64

ปุ่ม:
P16 = START/RESET | P8 = Abrasion | P12 = Insect Bite (Active HIGH)

LED:
P0 = Green LED | P1 = Red LED

OLED:
I2C (P19/P20 auto - ห้ามใช้พินนี้กับอุปกรณ์อื่น)

UART Serial (เชื่อมต่อ ESP32):
P2 = TX, P3 = RX (หรือ P2=TX, P10=RX) (Baud rate 115200)

มอเตอร์สเต็ปเปอร์ 4 สาย (28BYJ-48 style):
มอเตอร์ 1 (Insect Bite / แดง) : P4, P5, P6, P7    + 5V, GND
มอเตอร์ 2 (Abrasion   / เขียว): P11, P13, P14, P15 + 5V, GND

Flow ของระบบ:
1. ปุ่มเป็น Edge-Triggered (กันไฟกระพริบ / กดครั้งเดียว = ทำงานครั้งเดียว)
2. สั่งงานได้ทั้งจากปุ่มกดหน้าตู้ และคำสั่งจากหน้าเว็บผ่าน ESP32 UART (OPEN1/OPEN2)
3. เลือกอาการ -> โชว์อาการ + LED ค้าง ~2.5 วิ -> เคลียร์จอ -> "System is running..."
   -> หมุนมอเตอร์ครบ 1 รอบ (DISPENSE_STEPS = 2048) และส่ง OK1/OK2 แจ้งเว็บ
4. หมุนเสร็จ -> โชว์วิธีล้างแผล/ดูแลแผล วิธีที่ 1 ค้างไว้ (ไม่มีจับเวลา)
   -> กดปุ่มเดิม (P8 = Abrasion / P12 = Insect Bite) เพียงครั้งเดียว -> ไปวิธีที่ 2 ทันที
   -> กดปุ่มเดิมอีกครั้งเดียว -> โชว์ข้อความ "Complete!" ค้างไว้สักครู่ -> ดับ LED -> ดับมอเตอร์
   -> หน่วง 300ms -> กลับ Welcome เองอัตโนมัติ (ไม่ต้องรอกด START)
5. อยู่หน้า Welcome -> นับเวลาใหม่ตามปกติ -> ถ้าไม่กดอะไรครบ 10 วิ (ค่าทดสอบ) -> Sleep Mode
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
DISPENSE_STEPS = 2048        # ~1 รอบเพลาส่งออกของสเต็ปเปอร์ 28BYJ-48 ในโหมด Full-Step
STEP_DELAY_MS = 2            # ความเร็วหมุน (ยิ่งน้อย = ยิ่งเร็ว) ลองเริ่มที่ 2-4ms
SYMPTOM_DISPLAY_MS = 2500    # เวลาที่โชว์หน้าอาการ + LED ก่อนมอเตอร์เริ่มหมุน (2-3 วิ ตามที่ต้องการ)
CARE_DONE_MS = 3000          # เวลาที่โชว์ข้อความ "Complete!" ค้างไว้ก่อนกลับ Welcome
RESET_DELAY_MS = 300         # หน่วงเวลาก่อนกลับ Welcome หลังมอเตอร์หมุนเสร็จ
SLEEP_TIMEOUT = 10000        # 10 วินาที (ms) ไม่มีการกดปุ่ม -> เข้า Sleep (ค่าทดสอบ ของจริงแนะนำ 30000+)
BOUNCE_DELAY = 50            # ms หน่วงกันสัญญาณกระเพื่อมของปุ่ม (contact bounce)

# ลำดับ Full-Step มาตรฐานของสเต็ปเปอร์ 4 สาย
STEP_SEQUENCE = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]

# ---------- GLOBAL VARIABLES ----------
state = STATE_WELCOME   # สถานะปัจจุบันของระบบ
lastState = -1           # สถานะก่อนหน้า ใช้เช็คว่าต้อง Refresh OLED หรือไม่
lastAction = 0            # เวลาล่าสุดที่มีการกดปุ่ม ใช้จับเวลา Sleep (ดู SLEEP_TIMEOUT)

# เก็บสถานะปุ่มของรอบก่อนหน้า ใช้เช็คขอบขาขึ้น (0 -> 1 = เพิ่งถูกกด)
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


# ---------- ฟังก์ชันตรวจจับ "ขอบขาขึ้น" ของปุ่ม (กดครั้งเดียว = ทำงานครั้งเดียว) ----------
def start_pressed():
    global current, edge, startPrev
    current = pins.digital_read_pin(PIN_START) == 1
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
    current3 = pins.digital_read_pin(PIN_INSECT) == 1
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
    # หน้ารอเลือกอาการบาดเจ็บ ไฟเขียว-แดงติดพร้อมกันเพื่อบอกว่ารอผู้ใช้เลือก
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
    OLED12864_I2C.show_string(0, 0, "Welcome", 1)
    OLED12864_I2C.show_string(0, 2, "What wound", 1)
    OLED12864_I2C.show_string(0, 3, "do you have?", 1)
    OLED12864_I2C.show_string(0, 5, "P8  Abrasion", 1)
    OLED12864_I2C.show_string(0, 6, "P12 Insect Bite", 1)


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
    OLED12864_I2C.clear()  # Sleep Mode : ล้างหน้าจอ OLED ทั้งหมด


# ---------- ฟังก์ชันแสดงวิธีล้าง/ดูแลแผล (ภาษาอังกฤษ, ทีละวิธี หน้าละ 1 วิธี) ----------
def show_abrasion_care1():
    OLED12864_I2C.clear()
    OLED12864_I2C.show_string(0, 0, "Rinse wound with", 1)
    OLED12864_I2C.show_string(0, 1, "clean running", 1)
    OLED12864_I2C.show_string(0, 2, "water for", 1)
    OLED12864_I2C.show_string(0, 3, "5-10 minutes", 1)
    OLED12864_I2C.show_string(0, 6, ">> Press P8", 1)


def show_abrasion_care2():
    OLED12864_I2C.clear()
    OLED12864_I2C.show_string(0, 0, "Pat dry, apply", 1)
    OLED12864_I2C.show_string(0, 1, "antiseptic then", 1)
    OLED12864_I2C.show_string(0, 2, "cover wound with", 1)
    OLED12864_I2C.show_string(0, 3, "clean gauze", 1)
    OLED12864_I2C.show_string(0, 6, ">> Press P8", 1)


def show_insect_care1():
    OLED12864_I2C.clear()
    OLED12864_I2C.show_string(0, 0, "Wash bite area", 1)
    OLED12864_I2C.show_string(0, 1, "with soap and", 1)
    OLED12864_I2C.show_string(0, 2, "water", 1)
    OLED12864_I2C.show_string(0, 6, ">> Press P12", 1)


def show_insect_care2():
    OLED12864_I2C.clear()
    OLED12864_I2C.show_string(0, 0, "Apply the gel/", 1)
    OLED12864_I2C.show_string(0, 1, "spray. Avoid", 1)
    OLED12864_I2C.show_string(0, 2, "scratching the", 1)
    OLED12864_I2C.show_string(0, 3, "bite area", 1)
    OLED12864_I2C.show_string(0, 6, ">> Press P12", 1)


def show_care_done():
    OLED12864_I2C.clear()
    OLED12864_I2C.show_string(0, 0, "Wound Care", 1)
    OLED12864_I2C.show_string(0, 2, "Complete!", 1)
    OLED12864_I2C.show_string(0, 4, "Stay safe :)", 1)


def update_display():
    global lastState
    # Refresh OLED เฉพาะตอนที่ state เปลี่ยนเท่านั้น เพื่อไม่ให้จอกระพริบ
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
    # หมุนสเต็ปเปอร์ตามจำนวน step ที่กำหนด แล้วดับคอยล์ทั้งหมดเมื่อจบ
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


# ---------- ฟังก์ชันรอกดปุ่มเดิมซ้ำ เพื่อไปวิธีล้างแผลถัดไป ----------
def wait_for_button_again(pin: DigitalPin):
    while pins.digital_read_pin(pin) == 1:
        basic.pause(10)
    confirmed = False
    while not (confirmed):
        if pins.digital_read_pin(pin) == 1:
            basic.pause(BOUNCE_DELAY)
            confirmed = pins.digital_read_pin(pin) == 1
        else:
            basic.pause(10)


# ---------- ฟังก์ชันจ่ายยา/สเปรย์ ----------
def dispense_abrasion():
    serial.write_line("OK1")  # ตอบกลับสัญญาณ ACK ไปยัง ESP32 และหน้าเว็บทันที
    basic.pause(SYMPTOM_DISPLAY_MS)
    show_running()
    motor_run(MOTOR2_PINS, DISPENSE_STEPS, STEP_DELAY_MS)
    show_abrasion_care1()
    wait_for_button_again(PIN_ABRASION)
    show_abrasion_care2()
    wait_for_button_again(PIN_ABRASION)
    show_care_done()
    basic.pause(CARE_DONE_MS)
    reset_to_welcome()


def dispense_insect():
    serial.write_line("OK2")  # ตอบกลับสัญญาณ ACK ไปยัง ESP32 และหน้าเว็บทันที
    basic.pause(SYMPTOM_DISPLAY_MS)
    show_running()
    motor_run(MOTOR1_PINS, DISPENSE_STEPS, STEP_DELAY_MS)
    show_insect_care1()
    wait_for_button_again(PIN_INSECT)
    show_insect_care2()
    wait_for_button_again(PIN_INSECT)
    show_care_done()
    basic.pause(CARE_DONE_MS)
    reset_to_welcome()


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


# ---------- UART SERIAL CONFIG & HANDLER (เชื่อมต่อ ESP32: P2=TX, P16=RX) ----------
serial.redirect(SerialPin.P2, SerialPin.P16, BaudRate.BAUD_RATE115200)


def check_serial_commands():
    cmd = serial.read_line()
    if len(cmd) > 0:
        global lastAction
        lastAction = input.running_time()
        if "OPEN1" in cmd or "ABRASION" in cmd:
            go_to_state(STATE_ABRASION)
        elif "OPEN2" in cmd or "INSECT" in cmd:
            go_to_state(STATE_INSECT)


# ---------- SETUP ----------
OLED12864_I2C.init(60)
leds_off()
motor_stop(MOTOR1_PINS)
motor_stop(MOTOR2_PINS)
lastAction = input.running_time()
startPrev = pins.digital_read_pin(PIN_START) == 1
abrasionPrev = pins.digital_read_pin(PIN_ABRASION) == 1
insectPrev = pins.digital_read_pin(PIN_INSECT) == 1
update_display()
update_leds()


# ---------- MAIN LOOP (Edge-Triggered, ไม่ใช้ while รอปล่อยปุ่ม) ----------
def on_forever():
    global startEdge, abrasionEdge, insectEdge

    # 1. ตรวจสอบคำสั่งส่งมาจากหน้าเว็บ/ESP32 ผ่าน UART
    check_serial_commands()

    # 2. อ่านปุ่มกดปุ่มหน้าตู้ทุกตัว
    startEdge = start_pressed()
    abrasionEdge = abrasion_pressed()
    insectEdge = insect_pressed()

    # ----- ตรวจสอบ Sleep Mode : ไม่มีการกดปุ่มเกิน SLEEP_TIMEOUT -----
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
            go_to_state(STATE_ABRASION)   # จบใน go_to_state() แล้วกลับ Welcome เองอัตโนมัติ
        elif insectEdge:
            go_to_state(STATE_INSECT)     # จบใน go_to_state() แล้วกลับ Welcome เองอัตโนมัติ

    # ----- Sleep Mode : ปลุกด้วยปุ่ม START -----
    elif state == STATE_SLEEP:
        if startEdge:
            reset_to_welcome()

    basic.pause(20)


basic.forever(on_forever)
