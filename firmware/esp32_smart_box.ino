/*
 * ==============================================================================
 * ESP32 FIRMWARE — SMART FIRST AID BOX (micro:bit Thailand Challenge 2026)
 * ==============================================================================
 * Connects ESP32 to local Wi-Fi and bridges Web App requests to micro:bit v2 via UART.
 *
 * มีสองเส้นทางที่ทำงานพร้อมกัน:
 *
 * 1) MQTT (เส้นหลัก) — ต่อออกไปหา broker บนคลาวด์ สั่งงานจากที่ไหนก็ได้
 *    - subscribe : <BASE_TOPIC>/cmd     รับคำสั่งจากหน้าเว็บ (ผ่าน /api/command)
 *    - publish   : <BASE_TOPIC>/evt     ส่งเหตุการณ์จาก micro:bit ขึ้นไป
 *    - publish   : <BASE_TOPIC>/status  สถานะออนไลน์ (retained) + LWT ตอนหลุด
 *
 * 2) HTTP บนวง LAN (เส้นสำรอง) — ของเดิม ไม่พึ่งอินเทอร์เน็ต
 *    - GET /status          -> Returns JSON status of controller & micro:bit
 *    - GET /open?drawer=1   -> Sends OPEN1 command to micro:bit over UART (Serial2)
 *    - GET /buzzer?state=1  -> Sends BUZZ1 command to micro:bit over UART (Serial2)
 *
 * ห้ามลบเส้นที่ 2 ทิ้ง วันแข่งถ้าเน็ตล่ม MQTT ตายทันทีแต่ตู้ยายังต้องเปิดได้
 *
 * ไลบรารีที่ต้องติดตั้งเพิ่มใน Library Manager:
 *   - PubSubClient (Nick O'Leary)
 *   - ArduinoJson  (Benoit Blanchon) เวอร์ชัน 7 ขึ้นไป
 * ==============================================================================
 */

#include <WiFi.h>
#include <WebServer.h>
#include <WiFiClientSecure.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <time.h>

const char* ssid = "YOUR_WIFI_SSID";
const char* password = "YOUR_WIFI_PASSWORD";

// ---------- MQTT config ----------
// เอาค่าจากหน้า cluster ของ HiveMQ Cloud (ดู MQTT_SETUP.md)
// ปล่อย MQTT_HOST ว่างไว้ = ปิด MQTT ใช้เฉพาะเส้น LAN
const char* MQTT_HOST = "";                          // เช่น "abc123.s1.eu.hivemq.cloud"
const uint16_t MQTT_PORT = 8883;                     // TLS
const char* MQTT_USER = "esp32-box1";
const char* MQTT_PASS = "YOUR_DEVICE_PASSWORD";
const char* BASE_TOPIC = "crms6/firstaidbox/box1";

// คำสั่งที่เก่ากว่านี้จะถูกทิ้ง กันคำสั่งค้างคิวตอนเน็ตหลุดแล้วเด้งกลับมาเปิดตู้เองตอนไม่มีคนอยู่
const uint32_t MAX_CMD_AGE_MS = 30000;

// Hardware Serial 2 pins connected to micro:bit (P14/P15)
#define RXD2 16
#define TXD2 17

WebServer server(80);
WiFiClientSecure tlsClient;
PubSubClient mqtt(tlsClient);

char cmdTopic[128];
char evtTopic[128];
char statusTopic[128];

unsigned long lastMqttAttempt = 0;
unsigned long mqttSubscribedAt = 0;

// ---------- MQTT helpers ----------

void publishEvent(const char* eventName, int drawer) {
  if (!mqtt.connected()) return;

  JsonDocument doc;
  doc["event"] = eventName;
  if (drawer > 0) doc["drawer"] = drawer;
  doc["ts"] = (uint64_t)time(nullptr) * 1000ULL;

  char buf[192];
  size_t n = serializeJson(doc, buf);
  mqtt.publish(evtTopic, (const uint8_t*)buf, n, false);
}

void publishOnlineStatus() {
  JsonDocument doc;
  doc["online"] = true;
  doc["ip"] = WiFi.localIP().toString();
  doc["rssi"] = WiFi.RSSI();
  doc["ts"] = (uint64_t)time(nullptr) * 1000ULL;

  char buf[192];
  size_t n = serializeJson(doc, buf);
  // retained = หน้าเว็บที่เพิ่งเปิดจะรู้สถานะทันทีโดยไม่ต้องรอ ไม่ต้อง poll เหมือนเดิม
  mqtt.publish(statusTopic, (const uint8_t*)buf, n, true);
}

void onMqttMessage(char* topic, byte* payload, unsigned int length) {
  JsonDocument doc;
  DeserializationError err = deserializeJson(doc, payload, length);
  if (err) {
    Serial.printf("[MQTT] JSON ผิดรูปแบบ: %s\n", err.c_str());
    return;
  }

  const char* action = doc["action"] | "";
  const char* cmdId = doc["id"] | "-";

  // ด่านที่ 1: ทิ้งทุกคำสั่งที่เข้ามาทันทีหลัง subscribe
  // PubSubClient ไม่บอกเราว่าข้อความไหนเป็น retained ถ้ามีใครเผลอ publish คำสั่งแบบ
  // retain ไว้ broker จะยัดให้เราทันทีที่ต่อติด แปลว่าตู้ยาจะเปิดเองทุกครั้งที่รีบูต
  if (millis() - mqttSubscribedAt < 2000) {
    Serial.printf("[MQTT] ทิ้งคำสั่ง %s (เข้ามาเร็วผิดปกติหลังเชื่อมต่อ อาจเป็น retained)\n", cmdId);
    publishEvent("cmd_rejected", 0);
    return;
  }

  // ด่านที่ 2: ทิ้งคำสั่งที่เก่าเกินไป
  // เช็คได้เฉพาะตอนนาฬิกาตรงแล้ว ถ้า NTP ยังไม่สำเร็จให้ปล่อยผ่าน
  // ไม่งั้นตู้ยาจะปฏิเสธทุกคำสั่งเพราะคิดว่าทุกอย่างเก่า = กล่องใช้ไม่ได้เลย
  time_t nowSec = time(nullptr);
  bool clockReady = nowSec > 1700000000;
  if (clockReady && doc["ts"].is<uint64_t>()) {
    uint64_t nowMs = (uint64_t)nowSec * 1000ULL;
    uint64_t cmdMs = doc["ts"].as<uint64_t>();
    if (nowMs > cmdMs && (nowMs - cmdMs) > MAX_CMD_AGE_MS) {
      Serial.printf("[MQTT] ทิ้งคำสั่ง %s (เก่าเกิน %lu ms)\n", cmdId, MAX_CMD_AGE_MS);
      publishEvent("cmd_rejected", 0);
      return;
    }
  }

  if (strcmp(action, "open") == 0) {
    int drawerNum = doc["drawer"] | 0;
    if (drawerNum == 1) {
      Serial2.println("OPEN1");
    } else if (drawerNum == 2) {
      Serial2.println("OPEN2");
    } else {
      Serial.printf("[MQTT] คำสั่ง %s ระบุลิ้นชักไม่ถูกต้อง\n", cmdId);
      return;
    }
    Serial.printf("[MQTT] %s -> เปิดลิ้นชัก %d\n", cmdId, drawerNum);
  } else if (strcmp(action, "buzzer") == 0) {
    const char* state = doc["state"] | "off";
    Serial2.println(strcmp(state, "on") == 0 ? "BUZZ1" : "BUZZ0");
    Serial.printf("[MQTT] %s -> เสียงแจ้งเตือน %s\n", cmdId, state);
  } else {
    Serial.printf("[MQTT] ไม่รู้จักคำสั่ง: %s\n", action);
  }
}

// เชื่อมต่อแบบไม่บล็อก — ห้ามใช้ while(!connected){delay()} เด็ดขาด
// ถ้า broker ล่มแล้วเราวนรอตรงนั้น server.handleClient() จะไม่ได้ทำงาน
// เส้นสำรอง LAN จะตายไปพร้อมกับ MQTT ทั้งที่มันควรจะรอด
void mqttEnsureConnected() {
  if (strlen(MQTT_HOST) == 0 || mqtt.connected()) return;
  if (millis() - lastMqttAttempt < 5000) return;
  lastMqttAttempt = millis();

  Serial.print("[MQTT] กำลังเชื่อมต่อ broker... ");

  String clientId = "sfab-esp32-" + WiFi.macAddress();
  // LWT: บอก broker ไว้ล่วงหน้าว่าถ้าเราหายไปให้ประกาศแทนเราว่าออฟไลน์
  // หน้าเว็บจึงรู้ว่ากล่องดับภายในไม่กี่วินาที โดยที่เราไม่ต้องส่งอะไรเลย
  const char* willPayload = "{\"online\":false}";

  if (mqtt.connect(clientId.c_str(), MQTT_USER, MQTT_PASS, statusTopic, 1, true, willPayload)) {
    Serial.println("สำเร็จ");
    mqtt.subscribe(cmdTopic, 1);
    mqttSubscribedAt = millis();
    publishOnlineStatus();
    publishEvent("boot", 0);
  } else {
    Serial.printf("ไม่สำเร็จ (rc=%d) จะลองใหม่ใน 5 วินาที\n", mqtt.state());
  }
}

// ---------- HTTP handlers (เส้นสำรองบนวง LAN) ----------

void handleRoot() {
  server.send(200, "text/plain", "Smart First Aid Box ESP32 Bridge Active");
}

void handleStatus() {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  String json = String("{\"status\":\"online\",\"microbit\":\"connected\",\"drawers\":2,\"mode\":\"production\",\"mqtt\":") +
                (mqtt.connected() ? "true" : "false") + "}";
  server.send(200, "application/json", json);
}

void handleOpen() {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  if (!server.hasArg("drawer")) {
    server.send(400, "application/json", "{\"success\":false,\"error\":\"Missing drawer parameter\"}");
    return;
  }

  String drawerStr = server.arg("drawer");
  int drawerNum = drawerStr.toInt();

  if (drawerNum == 1) {
    Serial2.println("OPEN1");
  } else if (drawerNum == 2) {
    Serial2.println("OPEN2");
  } else {
    server.send(400, "application/json", "{\"success\":false,\"error\":\"Invalid drawer number\"}");
    return;
  }

  server.send(200, "application/json", "{\"success\":true,\"drawer\":" + String(drawerNum) + "}");
}

void handleBuzzer() {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  String stateStr = server.arg("state");
  if (stateStr == "1") {
    Serial2.println("BUZZ1");
  } else {
    Serial2.println("BUZZ0");
  }
  server.send(200, "application/json", "{\"success\":true}");
}

void setup() {
  Serial.begin(115200);
  Serial2.begin(115200, SERIAL_8N1, RXD2, TXD2);

  snprintf(cmdTopic, sizeof(cmdTopic), "%s/cmd", BASE_TOPIC);
  snprintf(evtTopic, sizeof(evtTopic), "%s/evt", BASE_TOPIC);
  snprintf(statusTopic, sizeof(statusTopic), "%s/status", BASE_TOPIC);

  WiFi.begin(ssid, password);
  Serial.print("Connecting to WiFi");
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println("");
  Serial.print("Connected! IP Address: ");
  Serial.println(WiFi.localIP());

  // ต้อง sync เวลาก่อน ไม่งั้นตรวจอายุคำสั่งไม่ได้ และถ้าเปิดการตรวจใบรับรอง TLS
  // มันจะ handshake ไม่ผ่านเพราะบอร์ดคิดว่าใบรับรองยังไม่ถึงวันใช้งาน
  configTime(7 * 3600, 0, "pool.ntp.org", "time.google.com");

  // ยังไม่ได้ตรวจใบรับรองของ broker — ข้อมูลถูกเข้ารหัส แต่ถ้ามีคนดักกลางทางได้
  // เราจะไม่รู้ตัว พอได้ใบรับรอง root ของ broker มาแล้วให้เปลี่ยนเป็น
  // tlsClient.setCACert(root_ca); ตามขั้นตอนใน MQTT_SETUP.md
  tlsClient.setInsecure();

  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setCallback(onMqttMessage);
  // ค่าเริ่มต้นของ PubSubClient คือ 256 ไบต์ ข้อความที่ยาวกว่านั้นจะหายเงียบ ๆ ไม่มี error
  mqtt.setBufferSize(512);
  mqtt.setKeepAlive(30);

  server.on("/", handleRoot);
  server.on("/status", handleStatus);
  server.on("/open", handleOpen);
  server.on("/buzzer", handleBuzzer);

  server.begin();
  Serial.println("HTTP Server Started");
}

void loop() {
  server.handleClient();

  mqttEnsureConnected();
  mqtt.loop();

  // Read incoming events from micro:bit via Serial2
  if (Serial2.available()) {
    String line = Serial2.readStringUntil('\n');
    line.trim();
    if (line == "DOOR_OPEN") {
      Serial.println("[EVENT] Door Opened Sensor Triggered on micro:bit!");
      publishEvent("door_open", 0);
    } else if (line == "CONFIRM_A") {
      Serial.println("[EVENT] User Pressed Button A (Confirmed) on micro:bit!");
      publishEvent("confirm_a", 0);
    } else if (line == "CANCEL_B") {
      Serial.println("[EVENT] User Pressed Button B (Cancelled) on micro:bit!");
      publishEvent("cancel_b", 0);
    } else if (line == "OK1" || line == "OK2") {
      // micro:bit ตอบกลับหลังหมุนเซอร์โวเสร็จ = ยืนยันว่าลิ้นชักเปิดจริง ไม่ใช่แค่ส่งคำสั่งออกไป
      int drawerNum = (line == "OK1") ? 1 : 2;
      Serial.printf("[EVENT] Drawer %d opened and closed on micro:bit\n", drawerNum);
      publishEvent("drawer_opened", drawerNum);
    }
  }
}
