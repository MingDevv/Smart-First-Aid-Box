# SFAB remote SOS button + repeater — micro:bit V1, MicroPython v1.1.1.
#
#   กด A     -> ยิง SOS ให้ตู้ -> ตู้ร้องออด + Pi ยิง LINE ถึงครู
#   ตู้ร้อง   -> ตู้ยิง beacon ทุก BEACON_MS -> รีโมตร้องตาม และดับพร้อมกัน
#
# เสียงตอบกลับตอนกด = เครื่องมือวัดระยะในตัว ไม่ต้องมีใครยืนดูอีกฝั่ง
#   ตี๊ด ตี๊ด (สูง สั้น สองครั้ง) = ตู้ได้ยินแล้ว
#   ตี๊————ด (ต่ำ ยาว)          = ส่งออกไปแล้วแต่ตู้ไม่ตอบ = ไกลเกินไป/ตู้ไม่ทำงาน
#   เงียบสนิท                    = ปุ่มหรือบอร์ดมีปัญหา ไม่ใช่เรื่องระยะ
#
# beacon ไม่ใช่ "สั่งเปิด/สั่งปิด" แต่เป็น "ตู้ยังร้องอยู่นะ" ⇒ ถ้าแพ็กเก็ตปิดหาย หรือตู้ดับ
# หรือเดินออกนอกระยะ รีโมตก็เงียบเองใน HOLD_MS ไม่มีทางค้างร้อง
#
# ⚠️ ออดอยู่ P3 ซึ่งเป็นขาสแกนจอ LED ⇒ ต้อง display.off() ถาวร ไม่งั้นการสแกนจอทำให้ออด
# ร้องตลอดเวลาโดยไม่ต้องมีใครสั่ง (เจอกับตัว 2026-09-17) · ย้ายไป P0/P1/P2 จะได้จอคืนมา
from microbit import button_a, display, sleep, running_time, pin3
import radio
import music

# ต้องตรงกับ main.py ฝั่งตู้
RADIO_GROUP = 91
SOS_PREFIX = 'SFAB1:SOS:'
SOS_ACK = 'SFAB1:OK'
BUZZ_ON = 'SFAB1:B1'
BUZZ_OFF = 'SFAB1:B0'

BURST = 5            # วิทยุหายได้ ยิงซ้ำให้ตู้ได้ยินอย่างน้อยหนึ่งครั้ง
BURST_GAP_MS = 60
ACK_WAIT_MS = 1200   # รอตู้ตอบนานเท่านี้ก่อนสรุปว่าไม่ถึง
HOLD_MS = 1500       # ไม่ได้ยิน beacon นานเท่านี้ = ตู้เลิกร้องแล้ว (หรือคุยกันไม่ได้แล้ว)
COOLDOWN_MS = 10000  # กันกดโดนในกระเป๋า ครูไม่ควรได้ LINE รัวๆ

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
    # คืน True ถ้าเป็น ACK ของการกดครั้งล่าสุด ให้ผู้เรียกรู้ว่าตู้ได้ยินแล้ว
    global last_beacon
    if message is None:
        return False
    print(message)              # ออก USB serial — ใช้ไล่ปัญหาตอนเสียบกับคอม
    if message == SOS_ACK:
        return True
    if message == BUZZ_ON:
        last_beacon = running_time()
        set_buzzer(True)
    elif message == BUZZ_OFF:
        set_buzzer(False)
    return False


def follow_cabinet():
    if not handle(radio.receive()) and buzzing and running_time() - last_beacon > HOLD_MS:
        set_buzzer(False)       # ขาดการติดต่อ = เงียบเอง ห้ามค้างร้อง


def send_sos():
    global seq, last_sent
    seq = (seq + 1) % 1000
    last_sent = running_time()
    for _ in range(BURST):
        radio.send(SOS_PREFIX + str(seq))
        sleep(BURST_GAP_MS)
    deadline = running_time() + ACK_WAIT_MS
    while running_time() < deadline:
        if handle(radio.receive()):
            beep(1800, 90)      # ตู้ได้ยินแล้ว
            sleep(80)
            beep(1800, 90)
            return
        sleep(20)
    beep(300, 700)              # ส่งแล้วแต่ไม่มีใครตอบ = ไกลเกินไป หรือตู้ไม่ทำงาน


display.off()                   # คืน P3 จากจอมาให้ออด — ต้องมาก่อนแตะ pin3
pin3.write_digital(0)
radio.config(group=RADIO_GROUP, length=16, queue=2, power=7, data_rate=radio.RATE_250KBIT)
radio.on()
print('SFAB remote ready')
while True:
    follow_cabinet()
    if button_a.was_pressed() and running_time() - last_sent >= COOLDOWN_MS:
        beep(1400, 120)         # ยืนยันว่าปุ่มทำงานและกำลังส่ง — ดังก่อนรู้ผลเสมอ
        send_sos()
    sleep(20)
