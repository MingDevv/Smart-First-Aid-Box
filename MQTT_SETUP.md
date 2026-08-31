# การตั้งค่า MQTT — Smart First Aid Box

เอกสารนี้อธิบายวิธีต่อหน้าเว็บกับตู้ยาผ่าน MQTT ตั้งแต่ศูนย์

## ทำไมต้องใช้ MQTT

เดิมหน้าเว็บยิง `http://192.168.1.100/open` ตรงไปที่ ESP32 ซึ่งใช้ได้เฉพาะตอนเปิดหน้าเว็บ
ในวง LAN เดียวกัน เพราะเว็บที่ deploy บน Vercel เป็น `https://` แล้วเบราว์เซอร์จะบล็อก
การเรียก `http://` จากหน้า `https://` (เรียกว่า mixed content) โดยไม่แจ้งอะไรให้เห็นเลย

MQTT แก้สองเรื่องพร้อมกัน

1. ESP32 เป็นฝ่ายต่อ **ออกไป** หา broker เอง ไม่มีใครต้องยิงเข้ามาหามัน จึงไม่ติด mixed content
   และไม่ต้องเปิดพอร์ตที่เราเตอร์
2. มี **ทางกลับ** ให้ตู้ยาส่งเหตุการณ์ขึ้นมาเอง (ประตูเปิด กดปุ่มยืนยัน ลิ้นชักเปิดสำเร็จ)
   ซึ่งเป็นข้อมูลที่โครงงานต้องใช้เป็นหลักฐานเชิงประจักษ์

## ภาพรวมเส้นทาง

```
                 สั่งเปิดลิ้นชัก (ขาลง)
  เบราว์เซอร์ ──POST /api/command──▶ Vercel ──publish──▶ broker ──▶ ESP32 ──UART──▶ micro:bit
                                   (ถือรหัส publish)

                 สถานะ + เหตุการณ์ (ขาขึ้น)
  เบราว์เซอร์ ◀──subscribe wss://──── broker ◀──publish── ESP32 ◀──UART──── micro:bit
  (ถือรหัส subscribe เท่านั้น)
```

**ทำไมขาลงต้องอ้อมผ่านเซิร์ฟเวอร์** — JavaScript ในเบราว์เซอร์เปิดอ่านได้หมด ถ้าเอารหัสที่
publish ได้ไปใส่ในหน้าเว็บ ใครกด View Source ก็สั่งเปิดตู้ยาได้จากที่ไหนก็ได้ในโลก
รหัสที่ publish ได้จึงอยู่ใน environment variable ของ Vercel เท่านั้น

## หัวข้อ (Topic) ที่ระบบใช้

Base topic เริ่มต้นคือ `crms6/firstaidbox/box1` — ตั้งให้ตรงกันทั้งสามที่เสมอ

| Topic | ใครส่ง | Retained | เนื้อหา |
|---|---|---|---|
| `<base>/cmd` | Vercel | **ไม่** | `{"action":"open","drawer":1,"id":"...","ts":...}` |
| `<base>/evt` | ESP32 | ไม่ | `{"event":"drawer_opened","drawer":1,"id":"...","ts":...}` |
| `<base>/status` | ESP32 | **ใช่** | `{"online":true,"ip":"...","ts":...}` |

`<base>/status` ตั้ง retained ไว้เพื่อให้หน้าเว็บที่เพิ่งเปิดรู้สถานะทันทีโดยไม่ต้องรอ และ ESP32
ตั้ง LWT (Last Will and Testament) ไว้กับหัวข้อเดียวกัน แปลว่าถ้าบอร์ดดับหรือเน็ตหลุด broker
จะประกาศ `{"online":false}` แทนให้เอง หน้าเว็บจึงรู้ว่ากล่องดับภายในไม่กี่วินาที
โดยที่เราไม่ต้องเขียนโค้ด poll อะไรเลย

> ⚠️ **ห้าม publish หัวข้อ `cmd` แบบ retained เด็ดขาด** ข้อความ retained จะถูกส่งซ้ำให้ทุกคน
> ที่ subscribe ใหม่ ถ้าเผลอ retain คำสั่ง "เปิดลิ้นชัก 1" ไว้ ตู้ยาจะเปิดเองทุกครั้งที่ ESP32
> รีบูตหรือเน็ตกลับมา โค้ดฝั่งเซิร์ฟเวอร์บังคับ `retain: false` ไว้แล้ว และฝั่ง ESP32
> มีด่านกันอีกสองชั้น (ทิ้งข้อความใหม่ที่เข้ามาใน 500 ms แรกหลัง subscribe และบังคับให้ `ts`
> เป็นตัวเลข UTC ที่ไม่อยู่ในอนาคตและมีอายุไม่เกิน 30 วินาที) พร้อมจำ 8 command id ล่าสุดไม่ให้เปิดซ้ำ

## ขั้นตอนที่ 1 — สร้าง broker

ใช้ HiveMQ Cloud แผน Serverless Free ได้ (100 connections, 10 GB/เดือน รองรับ WebSocket
และตั้ง topic permission ต่อ credential ได้)

1. สมัครที่ https://console.hivemq.cloud แล้วสร้าง cluster
2. จดค่า **Cluster URL** ไว้ เช่น `abc123def.s1.eu.hivemq.cloud`
3. ไปที่แท็บ **Access Management** สร้าง credential **สามชุด แยกสิทธิ์กัน**

| ชื่อผู้ใช้ | สิทธิ์ | ใครใช้ |
|---|---|---|
| `esp32-box1` | publish + subscribe บน `crms6/firstaidbox/box1/#` | เฟิร์มแวร์ ESP32 |
| `vercel-publisher` | publish `.../cmd` + subscribe `.../evt` | Vercel (`api/command.js`) |
| `web-viewer` | **subscribe อย่างเดียว** บน `crms6/firstaidbox/box1/#` | หน้าเว็บในเบราว์เซอร์ |

การแยกสามชุดคือหัวใจ ถ้าใช้ชุดเดียวกันหมด รหัสที่หลุดจากหน้าเว็บจะสั่งเปิดตู้ยาได้ทันที

> HiveMQ แคชสิทธิ์ไว้ช่วงหนึ่ง แก้ permission แล้วอาจไม่มีผลทันที อย่าเพิ่งสรุปว่าตั้งผิด

## ขั้นตอนที่ 2 — ตั้งค่า Vercel

ใส่ environment variables ใน Project Settings (ดูรายการเต็มใน `.env.example`)

```
MQTT_URL=mqtts://abc123def.s1.eu.hivemq.cloud:8883
MQTT_USERNAME=vercel-publisher
MQTT_PASSWORD=<รหัสของ vercel-publisher>
MQTT_BASE_TOPIC=crms6/firstaidbox/box1
```

โปรเจ็กต์นี้เพิ่ง dependency ตัวแรกเข้ามา (`mqtt`) — Vercel จะ `npm install` ให้อัตโนมัติ
ตอน deploy ถ้าพัฒนาในเครื่องให้รัน `npm install` เองหนึ่งครั้ง

## ขั้นตอนที่ 3 — ตั้งค่าเฟิร์มแวร์ ESP32

ติดตั้งไลบรารีใน Arduino IDE ที่ Library Manager

- **PubSubClient** (Nick O'Leary)
- **ArduinoJson** (Benoit Blanchon) เวอร์ชัน 7 ขึ้นไป

แล้วแก้ค่าที่หัวไฟล์ `firmware/esp32_smart_box.ino`

```cpp
const char* MQTT_HOST = "abc123def.s1.eu.hivemq.cloud";
const char* MQTT_USER = "esp32-box1";
const char* MQTT_PASS = "<รหัสของ esp32-box1>";
const char* BASE_TOPIC = "crms6/firstaidbox/box1";
```

ปล่อย `MQTT_HOST` เป็นค่าว่างไว้ = ปิด MQTT ใช้เฉพาะเส้น LAN แบบเดิม

## ขั้นตอนที่ 4 — ตั้งค่าหน้าเว็บ

เข้า Dashboard ครู → จัดการเวชภัณฑ์ → หัวข้อ "การเชื่อมต่อ MQTT"

```
MQTT WebSocket URL : wss://abc123def.s1.eu.hivemq.cloud:8884/mqtt
ชื่อผู้ใช้           : web-viewer
รหัสผ่าน            : <รหัสของ web-viewer>
Base Topic         : crms6/firstaidbox/box1
```

ต้องเป็น `wss://` เท่านั้น `ws://` จะถูกเบราว์เซอร์บล็อกด้วยเหตุผลเดียวกับ `http://`
(ฟอร์มดักไว้ให้แล้ว) และอย่าลืม `/mqtt` ต่อท้าย เพราะเป็น path ของ WebSocket listener
ค่านี้ใช้ฟังสถานะ/event โดยตรงเท่านั้น ขาลงจะลอง `/api/command` ทุกครั้งแม้ browser
เครื่องใหม่ยังไม่มีค่าใน localStorage และให้ server เป็นผู้รายงานว่า MQTT ถูกตั้งไว้หรือไม่

## ขั้นตอนที่ 5 — ทดสอบทีละชั้น

อย่าเพิ่งประกอบทุกอย่างแล้วเปิดพร้อมกัน ถ้าพังจะแยกไม่ออกว่าพังที่ broker, WiFi, TLS หรือโค้ด

1. เปิด MQTTX สองหน้าต่าง ให้คุยกันเองผ่าน broker ให้ได้ก่อน
2. เปิด Dashboard แล้วดู Console ว่าขึ้น `[MqttBridge] เชื่อมต่อ broker สำเร็จ`
3. ใช้ MQTTX publish `{"online":true}` ไปที่ `<base>/status` → ตัวเลขสถานะฮาร์ดแวร์บน
   Dashboard ต้องเปลี่ยนเป็น Online เอง
4. ใช้ MQTTX publish `{"event":"door_open"}` ไปที่ `<base>/evt` → ต้องมี toast เด้ง
5. เสียบ ESP32 (ยังไม่ต้องต่อเซอร์โว) ดูว่ามันขึ้นออนไลน์เองไหม
6. ค่อยต่อ micro:bit และเซอร์โวเป็นขั้นสุดท้าย

## เส้นสำรองวันแข่ง

เฟิร์มแวร์ยังเปิด HTTP endpoint ไว้ครบ (`/status`, `/open?drawer=1&id=...`,
`/command-status?id=...`, `/buzzer?state=1&id=...`) และหน้าเว็บจะ
ลองเส้น MQTT ก่อน ถ้าไม่สำเร็จจะตกลงมาใช้เส้น LAN ให้อัตโนมัติ **ห้ามลบเส้นนี้ทิ้ง**
วันแข่งถ้าเน็ตล่ม MQTT ตายทันที แต่ตู้ยายังต้องเปิดได้

`PubSubClient::connect` เป็น synchronous จึงยังหยุด loop ชั่วคราวหนึ่งครั้งต่อความพยายาม
โค้ดจำกัด socket timeout ไว้ 2 วินาที เว้นอย่างน้อย 5 วินาทีระหว่างครั้ง และข้ามทันทีเมื่อ WiFi
หลุด เพื่อให้เว็บเซิร์ฟเวอร์ LAN กลับมาตอบได้โดยไม่ติดอยู่ใน reconnect loop

## ข้อจำกัดด้านความปลอดภัยที่ยังเหลืออยู่

อ่านให้จบก่อนเปิดใช้จริง

1. **`/api/command` ยังไม่มีการยืนยันตัวตน** ใครก็ตามที่รู้ URL ของเว็บสามารถ POST
   เข้ามาสั่งเปิดตู้ยาได้ ตอนนี้กันด้วย rate limit เท่านั้น (10 ครั้ง/นาที/IP และ 12 ครั้ง/นาที
   รวมทุก IP) สาเหตุที่ยังไม่ใส่คือหน้า kiosk เป็นหน้าสาธารณะที่ไม่มีการล็อกอิน
   ความลับอะไรที่ใส่ลงไปก็เปิดอ่านได้อยู่ดี
   ทางแก้ที่ควรคิดต่อ: ให้กดปุ่ม A บน micro:bit ยืนยันก่อนเซอร์โวจะหมุน (ต้องอยู่หน้ากล่องจริง)
   หรือทำระบบล็อกอินให้หน้า kiosk
2. **ESP32 ยังไม่ตรวจใบรับรองของ broker** (`tlsClient.setInsecure()`) ข้อมูลถูกเข้ารหัสแล้ว
   แต่ถ้ามีคนดักกลางทางได้จะไม่มีอะไรเตือน เมื่อได้ root CA ของ broker มาให้เปลี่ยนไปใช้
   `tlsClient.setCACert(root_ca)` — ต้อง sync เวลาให้ตรงก่อน ไม่งั้น handshake จะไม่ผ่าน
   เพราะบอร์ดคิดว่าใบรับรองยังไม่ถึงวันใช้งาน (โค้ดเรียก `configTime()` ไว้ให้แล้ว)
3. **รหัส `web-viewer` เปิดอ่านได้จากเบราว์เซอร์** โดยตั้งใจ จึงต้องตั้งสิทธิ์ให้ subscribe
   ได้อย่างเดียวจริง ๆ ถ้าเผลอให้สิทธิ์ publish ด้วย เท่ากับเปิดตู้ยาให้ทุกคน

## อาการที่เจอบ่อยและสาเหตุ

| อาการ | สาเหตุที่พบบ่อยที่สุด |
|---|---|
| เบราว์เซอร์ต่อ broker ไม่ติด ไม่มี error ชัดเจน | ใช้ `ws://` แทน `wss://` หรือลืม `/mqtt` ต่อท้าย |
| ต่อติดแต่ไม่ได้รับข้อความ | base topic ไม่ตรงกันระหว่างสามที่ หรือ credential ไม่มีสิทธิ์ subscribe |
| เปิดสองแท็บแล้วต่อ ๆ หลุด ๆ วนไม่จบ | clientId ซ้ำกัน (โค้ดสุ่มให้แล้ว แต่ถ้าไปแก้เองต้องระวัง) |
| ESP32 publish แล้วข้อความหายเงียบ ไม่มี error | ข้อความยาวเกิน buffer ของ PubSubClient (โค้ดตั้ง `setBufferSize(512)` ไว้แล้ว) |
| ESP32 ต่อ broker ไม่ติด rc=-2 | ปัญหา TLS หรือชื่อโฮสต์ผิด ลองเช็คว่าใส่ host โดยไม่มี `mqtts://` นำหน้า |
| ตู้ยาปฏิเสธคำสั่งว่า `cmd_rejected` | คำสั่งเก่ากว่า 30 วินาที หรือเข้ามาเร็วเกินไปหลัง ESP32 เพิ่ง subscribe |
