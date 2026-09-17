# SFAB remote SOS button + repeater — micro:bit V1, MicroPython v1.1.1.
#
# สองทาง:
#   กด A  -> ยิง SOS ให้ตู้ -> ตู้ร้องออด + Pi ยิง LINE ถึงครู
#   ตู้ร้อง -> ตู้ยิง beacon ทุก BEACON_MS -> รีโมตร้องตาม และดับพร้อมกัน
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
BUZZ_ON = 'SFAB1:B1'
BUZZ_OFF = 'SFAB1:B0'

BURST = 5           # วิทยุหายได้ ยิงซ้ำให้ตู้ได้ยินอย่างน้อยหนึ่งครั้ง
BURST_GAP_MS = 60
HOLD_MS = 1500      # ไม่ได้ยิน beacon นานเท่านี้ = ตู้เลิกร้องแล้ว (หรือคุยกันไม่ได้แล้ว)
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


def send_sos():
    global seq, last_sent
    seq = (seq + 1) % 1000
    last_sent = running_time()
    for _ in range(BURST):
        radio.send(SOS_PREFIX + str(seq))
        sleep(BURST_GAP_MS)


def follow_cabinet():
    global last_beacon
    message = radio.receive()
    if message == BUZZ_ON:
        last_beacon = running_time()
        set_buzzer(True)
    elif message == BUZZ_OFF:
        set_buzzer(False)
    elif buzzing and running_time() - last_beacon > HOLD_MS:
        set_buzzer(False)


display.off()                   # คืน P3 จากจอมาให้ออด — ต้องมาก่อนแตะ pin3
pin3.write_digital(0)
radio.config(group=RADIO_GROUP, length=16, queue=2)
radio.on()
while True:
    follow_cabinet()
    if button_a.was_pressed() and running_time() - last_sent >= COOLDOWN_MS:
        send_sos()
    sleep(20)
