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
 *    - GET /open?drawer=1&id=... -> Sends OPEN1 once, then waits for UART ACK
 *    - GET /command-status?id=... -> Reports whether that UART command completed
 *    - GET /buzzer?state=1&id=... -> Sends BUZZ1 once over UART (Serial2)
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
#include <sys/time.h>
#include <ctype.h>

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
const uint32_t POST_SUBSCRIBE_GUARD_MS = 500;
const uint8_t COMMAND_HISTORY_SIZE = 8;
const uint8_t EVENT_QUEUE_SIZE = 8;
const size_t MAX_COMMAND_ID_LENGTH = 64;

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

struct CommandRecord {
  bool used;
  char id[MAX_COMMAND_ID_LENGTH + 1];
  uint8_t drawer;
  bool completed;
  uint32_t sequence;
};

struct PendingMqttEvent {
  char eventName[24];
  char commandId[MAX_COMMAND_ID_LENGTH + 1];
  char reason[24];
  int drawer;
};

CommandRecord commandHistory[COMMAND_HISTORY_SIZE] = {};
uint8_t commandHistoryNext = 0;
uint32_t commandSequence = 0;

PendingMqttEvent eventQueue[EVENT_QUEUE_SIZE] = {};
uint8_t eventQueueHead = 0;
uint8_t eventQueueTail = 0;
uint8_t eventQueueCount = 0;

// ---------- MQTT helpers ----------

uint64_t utcNowMs() {
  struct timeval now;
  gettimeofday(&now, nullptr);
  return (uint64_t)now.tv_sec * 1000ULL + (uint64_t)now.tv_usec / 1000ULL;
}

bool commandIdIsValid(const char* commandId) {
  if (commandId == nullptr) return false;
  size_t length = strlen(commandId);
  if (length < 8 || length > MAX_COMMAND_ID_LENGTH) return false;

  for (size_t i = 0; i < length; i++) {
    char c = commandId[i];
    if (!isalnum((unsigned char)c) && c != '-' && c != '_') return false;
  }
  return true;
}

CommandRecord* findCommand(const char* commandId) {
  for (uint8_t i = 0; i < COMMAND_HISTORY_SIZE; i++) {
    if (commandHistory[i].used && strcmp(commandHistory[i].id, commandId) == 0) {
      return &commandHistory[i];
    }
  }
  return nullptr;
}

CommandRecord* rememberCommand(const char* commandId, uint8_t drawer, bool completed) {
  CommandRecord* record = &commandHistory[commandHistoryNext];
  // ห้ามทับรายการที่ยังรอ OK ไม่เช่นนั้น OK จะถูกผูกกับ id ถัดไปและเกิด false ACK
  if (record->used && !record->completed) return nullptr;
  record->used = true;
  strlcpy(record->id, commandId, sizeof(record->id));
  record->drawer = drawer;
  record->completed = completed;
  record->sequence = ++commandSequence;
  commandHistoryNext = (commandHistoryNext + 1) % COMMAND_HISTORY_SIZE;
  return record;
}

CommandRecord* findOldestPendingDrawer(uint8_t drawer) {
  CommandRecord* oldest = nullptr;
  for (uint8_t i = 0; i < COMMAND_HISTORY_SIZE; i++) {
    CommandRecord* record = &commandHistory[i];
    if (!record->used || record->completed || record->drawer != drawer) continue;
    if (oldest == nullptr || record->sequence < oldest->sequence) oldest = record;
  }
  return oldest;
}

void publishEvent(const char* eventName, int drawer, const char* commandId = nullptr, const char* reason = nullptr) {
  if (!mqtt.connected()) return;

  JsonDocument doc;
  doc["event"] = eventName;
  if (drawer > 0) doc["drawer"] = drawer;
  if (commandId != nullptr && commandId[0] != '\0') doc["id"] = commandId;
  if (reason != nullptr && reason[0] != '\0') doc["reason"] = reason;
  doc["ts"] = utcNowMs();

  char buf[256];
  size_t n = serializeJson(doc, buf);
  mqtt.publish(evtTopic, (const uint8_t*)buf, n, false);
}

void enqueueEvent(const char* eventName, int drawer, const char* commandId = nullptr, const char* reason = nullptr) {
  if (eventQueueCount >= EVENT_QUEUE_SIZE) {
    Serial.println("[MQTT] event queue เต็ม ทิ้ง event เพื่อไม่ให้ callback ค้าง");
    return;
  }

  PendingMqttEvent* event = &eventQueue[eventQueueTail];
  strlcpy(event->eventName, eventName, sizeof(event->eventName));
  strlcpy(event->commandId, commandId == nullptr ? "" : commandId, sizeof(event->commandId));
  strlcpy(event->reason, reason == nullptr ? "" : reason, sizeof(event->reason));
  event->drawer = drawer;
  eventQueueTail = (eventQueueTail + 1) % EVENT_QUEUE_SIZE;
  eventQueueCount++;
}

void flushPendingEvents() {
  while (mqtt.connected() && eventQueueCount > 0) {
    PendingMqttEvent* event = &eventQueue[eventQueueHead];
    publishEvent(event->eventName, event->drawer, event->commandId, event->reason);
    eventQueueHead = (eventQueueHead + 1) % EVENT_QUEUE_SIZE;
    eventQueueCount--;
  }
}

void publishOnlineStatus() {
  JsonDocument doc;
  doc["online"] = true;
  doc["ip"] = WiFi.localIP().toString();
  doc["rssi"] = WiFi.RSSI();
  doc["ts"] = utcNowMs();

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
  if (!doc["id"].is<const char*>()) {
    Serial.println("[MQTT] ทิ้งคำสั่งที่ไม่มี id แบบข้อความ");
    enqueueEvent("cmd_rejected", 0, nullptr, "invalid_id");
    return;
  }

  const char* cmdId = doc["id"].as<const char*>();
  if (!commandIdIsValid(cmdId)) {
    Serial.println("[MQTT] ทิ้งคำสั่งที่ id ไม่ถูกต้อง");
    enqueueEvent("cmd_rejected", 0, nullptr, "invalid_id");
    return;
  }

  // ตรวจซ้ำก่อน guard อายุ: redelivery ของคำสั่งที่ทำเสร็จแล้วปลอดภัยที่จะ ACK ซ้ำ
  // แต่ห้ามส่ง UART ซ้ำเด็ดขาด เพราะ browser อาจกำลัง fallback มาทาง LAN ด้วย id เดิม
  CommandRecord* duplicate = findCommand(cmdId);
  if (duplicate != nullptr) {
    Serial.printf("[MQTT] ไม่ทำคำสั่ง %s ซ้ำ\n", cmdId);
    if (duplicate->completed && duplicate->drawer > 0) {
      enqueueEvent("drawer_opened", duplicate->drawer, duplicate->id);
    }
    return;
  }

  // ด่านที่ 1: ทิ้งทุกคำสั่งที่เข้ามาทันทีหลัง subscribe
  // PubSubClient ไม่บอกเราว่าข้อความไหนเป็น retained ถ้ามีใครเผลอ publish คำสั่งแบบ
  // retain ไว้ broker จะยัดให้เราทันทีที่ต่อติด แปลว่าตู้ยาจะเปิดเองทุกครั้งที่รีบูต
  if (millis() - mqttSubscribedAt < POST_SUBSCRIBE_GUARD_MS) {
    Serial.printf("[MQTT] ทิ้งคำสั่ง %s (เข้ามาเร็วผิดปกติหลังเชื่อมต่อ อาจเป็น retained)\n", cmdId);
    enqueueEvent("cmd_rejected", 0, cmdId, "post_subscribe");
    return;
  }

  // ด่านที่ 2: เวลาเป็น field บังคับและต้องเป็นตัวเลข ห้าม fail-open ตอน NTP ยังไม่พร้อม
  if (!doc["ts"].is<uint64_t>()) {
    Serial.printf("[MQTT] ทิ้งคำสั่ง %s (ts หายหรือไม่ใช่ตัวเลข)\n", cmdId);
    enqueueEvent("cmd_rejected", 0, cmdId, "invalid_ts");
    return;
  }

  uint64_t nowMs = utcNowMs();
  uint64_t cmdMs = doc["ts"].as<uint64_t>();
  if (nowMs < 1700000000000ULL) {
    Serial.printf("[MQTT] ทิ้งคำสั่ง %s (นาฬิกายังไม่พร้อม)\n", cmdId);
    enqueueEvent("cmd_rejected", 0, cmdId, "clock_not_ready");
    return;
  }
  if (cmdMs > nowMs) {
    Serial.printf("[MQTT] ทิ้งคำสั่ง %s (เวลาอยู่ในอนาคต)\n", cmdId);
    enqueueEvent("cmd_rejected", 0, cmdId, "future_ts");
    return;
  }
  if ((nowMs - cmdMs) > MAX_CMD_AGE_MS) {
    Serial.printf("[MQTT] ทิ้งคำสั่ง %s (เก่าเกิน %lu ms)\n", cmdId, MAX_CMD_AGE_MS);
    enqueueEvent("cmd_rejected", 0, cmdId, "stale_ts");
    return;
  }

  if (strcmp(action, "open") == 0) {
    int drawerNum = doc["drawer"] | 0;
    if (drawerNum != 1 && drawerNum != 2) {
      Serial.printf("[MQTT] คำสั่ง %s ระบุลิ้นชักไม่ถูกต้อง\n", cmdId);
      enqueueEvent("cmd_rejected", 0, cmdId, "invalid_drawer");
      return;
    }

    // จำ id ก่อนส่ง UART: ต่อให้ event ขาขึ้นหาย retry/fallback ก็จะไม่หมุนเซอร์โวซ้ำ
    if (rememberCommand(cmdId, drawerNum, false) == nullptr) {
      Serial.printf("[MQTT] ทิ้งคำสั่ง %s (คิว ACK เต็ม)\n", cmdId);
      enqueueEvent("cmd_rejected", 0, cmdId, "queue_full");
      return;
    }
    Serial2.println(drawerNum == 1 ? "OPEN1" : "OPEN2");
    Serial.printf("[MQTT] %s -> เปิดลิ้นชัก %d\n", cmdId, drawerNum);
  } else if (strcmp(action, "buzzer") == 0) {
    const char* state = doc["state"] | "";
    if (strcmp(state, "on") != 0 && strcmp(state, "off") != 0) {
      Serial.printf("[MQTT] คำสั่ง %s ระบุสถานะ buzzer ไม่ถูกต้อง\n", cmdId);
      enqueueEvent("cmd_rejected", 0, cmdId, "invalid_state");
      return;
    }
    if (rememberCommand(cmdId, 0, true) == nullptr) {
      Serial.printf("[MQTT] ทิ้งคำสั่ง %s (คิว ACK เต็ม)\n", cmdId);
      enqueueEvent("cmd_rejected", 0, cmdId, "queue_full");
      return;
    }
    Serial2.println(strcmp(state, "on") == 0 ? "BUZZ1" : "BUZZ0");
    Serial.printf("[MQTT] %s -> เสียงแจ้งเตือน %s\n", cmdId, state);
  } else {
    Serial.printf("[MQTT] ไม่รู้จักคำสั่ง: %s\n", action);
    enqueueEvent("cmd_rejected", 0, cmdId, "invalid_action");
  }
}

// PubSubClient::connect เป็น synchronous จึงไม่ควรเรียกว่า non-blocking:
// ทำเพียงหนึ่งครั้งต่อรอบและจำกัด socket timeout สั้น ๆ เพื่อให้เส้น LAN หยุดรอน้อยที่สุด
void mqttEnsureConnected() {
  if (strlen(MQTT_HOST) == 0 || mqtt.connected()) return;
  if (WiFi.status() != WL_CONNECTED) return;
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

void sendDrawerCommandState(CommandRecord* record) {
  if (record->completed) {
    String json = String("{\"success\":true,\"acknowledged\":true,\"event\":\"drawer_opened\",\"id\":\"") +
                  record->id + "\",\"drawer\":" + String(record->drawer) + "}";
    server.send(200, "application/json", json);
  } else {
    String json = String("{\"success\":false,\"accepted\":true,\"acknowledged\":false,\"id\":\"") +
                  record->id + "\",\"drawer\":" + String(record->drawer) + "}";
    server.send(202, "application/json", json);
  }
}

void handleOpen() {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  if (!server.hasArg("drawer") || !server.hasArg("id")) {
    server.send(400, "application/json", "{\"success\":false,\"error\":\"Missing drawer or id parameter\"}");
    return;
  }

  String drawerStr = server.arg("drawer");
  String commandId = server.arg("id");
  int drawerNum = drawerStr.toInt();

  if (drawerNum != 1 && drawerNum != 2) {
    server.send(400, "application/json", "{\"success\":false,\"error\":\"Invalid drawer number\"}");
    return;
  }
  if (!commandIdIsValid(commandId.c_str())) {
    server.send(400, "application/json", "{\"success\":false,\"error\":\"Invalid command id\"}");
    return;
  }

  CommandRecord* duplicate = findCommand(commandId.c_str());
  if (duplicate != nullptr) {
    if (duplicate->drawer != drawerNum) {
      server.send(409, "application/json", "{\"success\":false,\"error\":\"Command id belongs to another action\"}");
      return;
    }
    if (duplicate->completed) publishEvent("drawer_opened", duplicate->drawer, duplicate->id);
    sendDrawerCommandState(duplicate);
    return;
  }

  CommandRecord* record = rememberCommand(commandId.c_str(), drawerNum, false);
  if (record == nullptr) {
    server.send(503, "application/json", "{\"success\":false,\"error\":\"Command acknowledgement queue is full\"}");
    return;
  }
  Serial2.println(drawerNum == 1 ? "OPEN1" : "OPEN2");
  Serial.printf("[LAN] %s -> เปิดลิ้นชัก %d\n", record->id, drawerNum);
  sendDrawerCommandState(record);
}

void handleCommandStatus() {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  if (!server.hasArg("id") || !commandIdIsValid(server.arg("id").c_str())) {
    server.send(400, "application/json", "{\"success\":false,\"error\":\"Missing or invalid command id\"}");
    return;
  }

  CommandRecord* record = findCommand(server.arg("id").c_str());
  if (record == nullptr || record->drawer == 0) {
    server.send(404, "application/json", "{\"success\":false,\"error\":\"Command id not found\"}");
    return;
  }
  sendDrawerCommandState(record);
}

void handleBuzzer() {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  if (!server.hasArg("id") || !commandIdIsValid(server.arg("id").c_str())) {
    server.send(400, "application/json", "{\"success\":false,\"error\":\"Missing or invalid command id\"}");
    return;
  }

  String stateStr = server.arg("state");
  if (stateStr != "1" && stateStr != "0") {
    server.send(400, "application/json", "{\"success\":false,\"error\":\"Invalid buzzer state\"}");
    return;
  }

  String commandId = server.arg("id");
  CommandRecord* duplicate = findCommand(commandId.c_str());
  if (duplicate != nullptr) {
    if (duplicate->drawer != 0) {
      server.send(409, "application/json", "{\"success\":false,\"error\":\"Command id belongs to another action\"}");
      return;
    }
    server.send(200, "application/json", "{\"success\":true,\"duplicate\":true}");
    return;
  }

  if (rememberCommand(commandId.c_str(), 0, true) == nullptr) {
    server.send(503, "application/json", "{\"success\":false,\"error\":\"Command acknowledgement queue is full\"}");
    return;
  }
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
  // readStringUntil ต้องไม่หยุด HTTP/MQTT loop นานเมื่อ UART ได้ข้อมูลไม่ครบหนึ่งบรรทัด
  Serial2.setTimeout(100);

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
  // mqtt.connect ยัง synchronous แต่ broker ล่มแล้วจะขวางเส้น LAN ไม่เกินช่วงสั้นนี้
  mqtt.setSocketTimeout(2);

  server.on("/", handleRoot);
  server.on("/status", handleStatus);
  server.on("/open", handleOpen);
  server.on("/command-status", handleCommandStatus);
  server.on("/buzzer", handleBuzzer);

  server.begin();
  Serial.println("HTTP Server Started");
}

void loop() {
  server.handleClient();

  mqttEnsureConnected();
  mqtt.loop();
  // ห้าม publish จาก PubSubClient callback โดยตรง เพราะใช้ packet buffer ชุดเดียวกัน
  flushPendingEvents();

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
      CommandRecord* command = findOldestPendingDrawer(drawerNum);
      if (command != nullptr) {
        command->completed = true;
        publishEvent("drawer_opened", drawerNum, command->id);
      } else {
        // เก็บ event sensor ไว้สำหรับ dashboard แต่ไม่มี id จึงใช้ยืนยันคำสั่งเว็บไม่ได้
        publishEvent("drawer_opened", drawerNum);
      }
    }
  }
}
