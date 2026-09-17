# ปุ่มเรียกครูไร้สาย ใช้คู่กับตู้ยา
# กด A = ตู้ร้องออด + ส่ง LINE ถึงครู
# ตู้ร้องเมื่อไหร่ ตัวนี้ร้องตาม ดับพร้อมกัน
#
# เสียงตอบกลับตอนกด
#   ตี๊ดเดียว        กำลังส่ง
#   ตี๊ดสูง 2 ครั้ง   ตู้รับแล้ว
#   ตี๊ดต่ำ 3 ครั้ง   ตู้ไม่ตอบ อาจอยู่ไกลเกิน
from microbit import button_a, display, sleep, running_time, pin3
import radio
import music

# ค่าพวกนี้ต้องตรงกับ main.py ฝั่งตู้
RADIO_GROUP = 91
SOS_PREFIX = 'SFAB1:SOS:'
SOS_ACK = 'SFAB1:OK'
BUZZ_ON = 'SFAB1:B1'
BUZZ_OFF = 'SFAB1:B0'

BURST = 5            # ส่งซ้ำ กันสัญญาณหาย
BURST_GAP_MS = 60
ACK_WAIT_MS = 1200
HOLD_MS = 1500       # เงียบเกินนี้ = ตู้เลิกร้อง หรือคุยกันไม่ได้แล้ว
COOLDOWN_MS = 10000  # กันกดโดนในกระเป๋า ครูจะได้ไม่โดน LINE รัว

seq = 0
last_sent = -COOLDOWN_MS
buzzing = False
last_beacon = 0


def set_buzzer(on):
    global buzzing
    if on == buzzing:
        return
    buzzing = on
    if on:
        music.pitch(880, -1, pin=pin3, wait=False)
    else:
        music.stop(pin3)
        pin3.write_digital(0)


def beep(freq, ms):
    music.pitch(freq, ms, pin=pin3, wait=True)
    pin3.write_digital(0)


def handle(message):
    global last_beacon
    if message is None:
        return False
    print(message)
    if message == SOS_ACK:
        return True
    if message == BUZZ_ON:
        last_beacon = running_time()
        set_buzzer(True)
    elif message == BUZZ_OFF:
        set_buzzer(False)
    return False


def follow_cabinet():
    # ตู้ส่งสัญญาณบอกว่ายังร้องอยู่เรื่อยๆ ถ้าขาดไปก็ดับเอง จะได้ไม่ค้างร้อง
    if not handle(radio.receive()) and buzzing and running_time() - last_beacon > HOLD_MS:
        set_buzzer(False)


def send_sos():
    global seq, last_sent
    seq = (seq + 1) % 1000
    last_sent = running_time()
    for _ in range(BURST):
        radio.send(SOS_PREFIX + str(seq))
        sleep(BURST_GAP_MS)
    print('sent', seq)
    deadline = running_time() + ACK_WAIT_MS
    while running_time() < deadline:
        if handle(radio.receive()):
            print('ack')
            beep(1800, 90)
            sleep(80)
            beep(1800, 90)
            return
        sleep(20)
    print('no-ack')
    for _ in range(3):
        beep(400, 220)
        sleep(120)


# ห้ามลบ display.off() ออด P3 ใช้ขาเดียวกับจอ ถ้าจอเปิดไว้ออดจะร้องเองไม่หยุด
display.off()
pin3.write_digital(0)
radio.config(group=RADIO_GROUP, length=16, queue=2, power=7, data_rate=radio.RATE_250KBIT)
radio.on()
print('SFAB remote ready')
while True:
    follow_cabinet()
    if button_a.was_pressed() and running_time() - last_sent >= COOLDOWN_MS:
        print('press')
        beep(1400, 120)
        send_sos()
    sleep(20)
