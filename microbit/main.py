# ==============================================================================
# MICRO:BIT V2 FIRMWARE — SMART FIRST AID BOX (micro:bit Thailand Challenge 2026)
# ==============================================================================
# Hardware Connections:
# - Pin P0 : Reed Switch Sensor (Door Sensor - Pull Up, Low when door opened)
# - Pin P1 : Servo Motor 1 (Compartment #1: Cut / Abrasion - 0° closed, 90° open)
# - Pin P2 : Servo Motor 2 (Compartment #2: Insect Bite / Rash - 0° closed, 90° open)
# - Pin P14: UART RX (Connected to ESP32 TX2)
# - Pin P15: UART TX (Connected to ESP32 RX2)
# - Built-in Speaker / Music: SOS Emergency Siren
# ==============================================================================

from microbit import *
import music

# Initialize Serial UART Communication at 115200 baud
uart.init(baudrate=115200, tx=pin15, rx=pin14)

# Set initial servo positions to 0 degrees (closed)
pin1.set_analog_period(20)
pin2.set_analog_period(20)

def set_servo_angle(pin, angle):
    # Convert angle 0-180 to duty cycle (approx 2.5% to 12.5% of 20ms)
    duty = int(25 + (angle / 180.0) * 100)
    pin.write_analog(duty)

set_servo_angle(pin1, 0)
set_servo_angle(pin2, 0)

# System State Variables
last_door_state = 1
display.show(Image.HAPPY)

def play_sos_siren():
    display.show(Image.SKULL)
    for _ in range(3):
        music.play(["C5:2", "G5:2", "C5:2", "G5:2"])
    display.show(Image.HAPPY)

def open_compartment(num):
    display.show(str(num))
    target_pin = pin1 if num == 1 else pin2
    
    # Open servo to 90 degrees
    set_servo_angle(target_pin, 90)
    sleep(3000) # Keep open for 3 seconds
    
    # Close servo back to 0 degrees
    set_servo_angle(target_pin, 0)
    display.show(Image.YES)
    sleep(1000)
    display.show(Image.HAPPY)
    
    # Send confirmation back to ESP32
    uart.write("OK" + str(num) + "\n")

# Main Hardware Loop
while True:
    # 1. Read Reed Switch Sensor (Door Sensor on Pin 0)
    door_state = pin0.read_digital()
    if door_state == 0 and last_door_state == 1:
        # Door opened! Send event to ESP32
        uart.write("DOOR_OPEN\n")
        display.show(Image.SURPRISED)
        sleep(1000)
        display.show(Image.HAPPY)
    last_door_state = door_state

    # 2. Check Button A / B for Kiosk User Confirmation
    if button_a.was_pressed():
        uart.write("CONFIRM_A\n")
        display.show(Image.YES)
        sleep(500)
        display.show(Image.HAPPY)
        
    if button_b.was_pressed():
        uart.write("CANCEL_B\n")
        display.show(Image.NO)
        sleep(500)
        display.show(Image.HAPPY)

    # 3. Read incoming UART commands from ESP32
    if uart.any():
        command = str(uart.read(), 'utf-8').strip()
        
        if command == "OPEN1":
            open_compartment(1)
        elif command == "OPEN2":
            open_compartment(2)
        elif command == "BUZZ1":
            play_sos_siren()
        elif command == "BUZZ0":
            music.stop()
            display.show(Image.HAPPY)

    sleep(100)
