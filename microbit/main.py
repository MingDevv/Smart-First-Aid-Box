"""
============================================================
SMART FIRST AID BOX - COMPLETE MICRO:BIT V2 FIRMWARE
============================================================
Hardware Connections:
- มอเตอร์ 1 (แมลงกัด / ช่อง 2) : P4, P5, P6, P7
- มอเตอร์ 2 (แผลถลอก   / ช่อง 1) : P11, P13, P14, P15
- ปุ่มกดหน้าตู้ P8              : แผลถลอก -> หมุนมอเตอร์ 2 (ช่อง 1)
- ปุ่มกดหน้าตู้ P12             : แมลงกัด -> หมุนมอเตอร์ 1 (ช่อง 2)
- ปุ่ม A บนบอร์ด micro:bit       : ส่ง CONFIRM_A (ยืนยัน) หา ESP32 / LINE
- ปุ่ม B บนบอร์ด micro:bit       : ส่ง CANCEL_B (ยกเลิก) หา ESP32 / LINE
- Serial UART (P0=TX, P1=RX)  : เชื่อมต่อ ESP32 (115200 baud)
============================================================
"""

# ---------- PIN CONFIG ----------
PIN_ABRASION = DigitalPin.P8
PIN_INSECT = DigitalPin.P12

# มอเตอร์ 1 : Insect Bite (แมลงกัด / ช่อง 2)
MOTOR1_PINS = [DigitalPin.P4, DigitalPin.P5, DigitalPin.P6, DigitalPin.P7]
# มอเตอร์ 2 : Abrasion (แผลถลอก / ช่อง 1)
MOTOR2_PINS = [DigitalPin.P11, DigitalPin.P13, DigitalPin.P14, DigitalPin.P15]

# ---------- MOTOR CONFIG ----------
DISPENSE_STEPS = 2048        # 1 รอบเพลาสเต็ปเปอร์ 28BYJ-48
STEP_DELAY_MS = 2            # ความเร็วหมุน (ms)
STEP_SEQUENCE = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]

abrasionPrev = False
insectPrev = False


# ---------- ฟังก์ชันสั่งหมุนสเต็ปเปอร์มอเตอร์ ----------
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


# ---------- ฟังก์ชันสั่งจ่ายยา ----------
def dispense_compartment(num: number):
    if num == 1:
        # ช่อง 1 (แผลถลอก / มอเตอร์ 2)
        basic.show_number(1)
        serial.write_line("OK1")
        motor_run(MOTOR2_PINS, DISPENSE_STEPS, STEP_DELAY_MS)
        basic.show_icon(IconNames.YES)
        basic.pause(800)
        basic.show_icon(IconNames.HEART)
    elif num == 2:
        # ช่อง 2 (แมลงกัด / มอเตอร์ 1)
        basic.show_number(2)
        serial.write_line("OK2")
        motor_run(MOTOR1_PINS, DISPENSE_STEPS, STEP_DELAY_MS)
        basic.show_icon(IconNames.YES)
        basic.pause(800)
        basic.show_icon(IconNames.HEART)


# ---------- UART SERIAL CONFIG (P0=TX, P1=RX) ----------
serial.redirect(SerialPin.P0, SerialPin.P1, BaudRate.BAUD_RATE115200)


def check_serial_commands():
    cmd = serial.read_line()
    if len(cmd) > 0:
        if "OPEN1" in cmd or "ABRASION" in cmd:
            dispense_compartment(1)
        elif "OPEN2" in cmd or "INSECT" in cmd:
            dispense_compartment(2)


def check_buttons():
    global abrasionPrev, insectPrev

    # ปุ่ม P8 : สั่งเปิดช่อง 1 (แผลถลอก) หน้าตู้
    curr_ab = pins.digital_read_pin(PIN_ABRASION) == 1
    if curr_ab and not (abrasionPrev):
        basic.pause(50)
        dispense_compartment(1)
    abrasionPrev = curr_ab

    # ปุ่ม P12 : สั่งเปิดช่อง 2 (แมลงกัด) หน้าตู้
    curr_in = pins.digital_read_pin(PIN_INSECT) == 1
    if curr_in and not (insectPrev):
        basic.pause(50)
        dispense_compartment(2)
    insectPrev = curr_in


# ---------- EVENT BUTTONS A & B ON MICRO:BIT ----------
def on_button_pressed_a():
    basic.show_string("A")
    serial.write_line("CONFIRM_A")
    basic.pause(500)
    basic.show_icon(IconNames.HEART)


def on_button_pressed_b():
    basic.show_string("B")
    serial.write_line("CANCEL_B")
    basic.pause(500)
    basic.show_icon(IconNames.HEART)


input.on_button_pressed(Button.A, on_button_pressed_a)
input.on_button_pressed(Button.B, on_button_pressed_b)

# สั่งหยุดมอเตอร์และแสดงไอคอนเริ่มต้น
motor_stop(MOTOR1_PINS)
motor_stop(MOTOR2_PINS)
basic.show_icon(IconNames.HEART)


# ---------- MAIN LOOP ----------
def on_forever():
    # ตรวจสอบคำสั่งจากหน้าเว็บ/ESP32
    check_serial_commands()
    # ตรวจสอบการกดปุ่มสั่งมือที่หน้าตู้ยา (P8 & P12)
    check_buttons()
    basic.pause(20)


basic.forever(on_forever)
