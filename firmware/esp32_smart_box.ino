/*
 * ==============================================================================
 * ESP32 FIRMWARE — SMART FIRST AID BOX (micro:bit Thailand Challenge 2026)
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
#include "esp32_smart_box/command_history.h"

const char* ssid = "iPhone";
const char* password = "thawin123";

const char* MQTT_HOST = "dd1fd4b3ede345959ee8abd925ddb1f9.s1.eu.hivemq.cloud";
const uint16_t MQTT_PORT = 8883;
const char* MQTT_USER = "esp32-box1";
const char* MQTT_PASS = "THAWIN123";
const char* BASE_TOPIC = "crms6/firstaidbox/box1";

const uint32_t MAX_CMD_AGE_MS = 30000;
const uint32_t COMMAND_ACK_TIMEOUT_MS = 15000;
const uint32_t POST_SUBSCRIBE_GUARD_MS = 500;
const uint8_t EVENT_QUEUE_SIZE = 16;

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

struct PendingMqttEvent {
  char eventName[24];
  char commandId[MAX_COMMAND_ID_LENGTH + 1];
  char reason[24];
  int drawer;
};

CommandHistory commandHistory;

PendingMqttEvent eventQueue[EVENT_QUEUE_SIZE] = {};
uint8_t eventQueueHead = 0;
uint8_t eventQueueTail = 0;
uint8_t eventQueueCount = 0;

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
    if (!isalnum(c) && c != '-' && c != '_') return false;
  }
  return true;
}

CommandRecord* rememberCommand(const char* commandId, int drawer, bool isBuzzer) {
  if (!commandIdIsValid(commandId)) return nullptr;
  return commandHistory.addRecord(commandId, drawer, isBuzzer, millis());
}

CommandRecord* findCommand(const char* commandId) {
  if (!commandIdIsValid(commandId)) return nullptr;
  return commandHistory.findRecord(commandId);
}

CommandRecord* findOldestPendingDrawer(int drawer) {
  return commandHistory.findOldestPendingDrawer(drawer);
}

void expirePendingCommands() {
  commandHistory.expireOldCommands(millis(), COMMAND_ACK_TIMEOUT_MS);
}

bool enqueueEvent(const char* eventName, int drawer = 0, const char* commandId = nullptr, const char* reason = nullptr) {
  if (eventQueueCount >= EVENT_QUEUE_SIZE) {
    Serial.println("[MQTT Event Queue] Queue full, dropping event!");
    return false;
  }

  PendingMqttEvent& item = eventQueue[eventQueueTail];
  snprintf(item.eventName, sizeof(item.eventName), "%s", eventName ? eventName : "");
  snprintf(item.commandId, sizeof(item.commandId), "%s", commandId ? commandId : "");
  snprintf(item.reason, sizeof(item.reason), "%s", reason ? reason : "");
  item.drawer = drawer;

  eventQueueTail = (eventQueueTail + 1) % EVENT_QUEUE_SIZE;
  eventQueueCount++;
  return true;
}

void publishEventPayload(const char* eventName, int drawer, const char* commandId, const char* reason) {
  JsonDocument doc;
  doc["event"] = eventName;
  if (drawer > 0) doc["drawer"] = drawer;
  if (commandId && strlen(commandId) > 0) doc["id"] = commandId;
  if (reason && strlen(reason) > 0) doc["reason"] = reason;
  doc["ts"] = utcNowMs();

  char buffer[256];
  size_t len = serializeJson(doc, buffer, sizeof(buffer));

  if (mqtt.connected()) {
    bool published = mqtt.publish(evtTopic, (const uint8_t*)buffer, len, false);
    if (published) {
      Serial.printf("[MQTT Event] Published: %s\n", buffer);
    } else {
      Serial.printf("[MQTT Event] Publish failed: %s\n", buffer);
    }
  } else {
    Serial.printf("[MQTT Event] Offline, skipped: %s\n", buffer);
  }
}

void publishEvent(const char* eventName, int drawer = 0, const char* commandId = nullptr, const char* reason = nullptr) {
  publishEventPayload(eventName, drawer, commandId, reason);
}

void flushPendingEvents() {
  if (!mqtt.connected() || eventQueueCount == 0) return;

  uint8_t countToProcess = eventQueueCount;
  for (uint8_t i = 0; i < countToProcess; i++) {
    if (!mqtt.connected()) break;

    PendingMqttEvent& item = eventQueue[eventQueueHead];
    publishEventPayload(item.eventName, item.drawer, item.commandId, item.reason);

    eventQueueHead = (eventQueueHead + 1) % EVENT_QUEUE_SIZE;
    eventQueueCount--;
  }
}

void publishStatus(bool online) {
  JsonDocument doc;
  doc["status"] = online ? "online" : "offline";
  doc["ts"] = utcNowMs();
  doc["firmware"] = "1.0.0";
  doc["uptime_s"] = millis() / 1000;
  doc["ip"] = WiFi.localIP().toString();

  char buffer[256];
  size_t len = serializeJson(doc, buffer, sizeof(buffer));

  if (mqtt.connected()) {
    mqtt.publish(statusTopic, (const uint8_t*)buffer, len, true);
    Serial.printf("[MQTT Status] Published: %s\n", buffer);
  }
}

void onMqttMessage(char* topic, byte* payload, unsigned int length) {
  if (length == 0 || length > 1024) return;

  JsonDocument doc;
  DeserializationError err = deserializeJson(doc, payload, length);
  if (err) {
    Serial.print("[MQTT] JSON parse error: ");
    Serial.println(err.c_str());
    enqueueEvent("cmd_rejected", 0, nullptr, "bad_json");
    return;
  }

  const char* action = doc["action"] | "";
  const char* cmdId  = doc["id"] | "";

  if (!commandIdIsValid(cmdId)) {
    Serial.println("[MQTT] ทิ้งคำสั่ง (id หายหรือไม่ถูกต้อง)");
    enqueueEvent("cmd_rejected", 0, nullptr, "invalid_id");
    return;
  }

  CommandRecord* duplicate = findCommand(cmdId);
  if (duplicate != nullptr) {
    Serial.printf("[MQTT] ไม่ทำคำสั่ง %s ซ้ำ\n", cmdId);
    if (duplicate->expired) {
      enqueueEvent("ack_timeout", duplicate->drawer, duplicate->id, "uart_timeout");
    } else if (duplicate->completed && duplicate->drawer > 0) {
      enqueueEvent("drawer_opened", duplicate->drawer, duplicate->id);
    }
    return;
  }

  if (millis() - mqttSubscribedAt < POST_SUBSCRIBE_GUARD_MS) {
    Serial.printf("[MQTT] ทิ้งคำสั่ง %s (เข้ามาเร็วผิดปกติหลังเชื่อมต่อ)\n", cmdId);
    enqueueEvent("cmd_rejected", 0, cmdId, "post_subscribe");
    return;
  }

  if (!doc["ts"].is<uint64_t>()) {
    Serial.printf("[MQTT] ทิ้งคำสั่ง %s (ts หาย)\n", cmdId);
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

    if (rememberCommand(cmdId, drawerNum, false) == nullptr) {
      Serial.printf("[MQTT] ทิ้งคำสั่ง %s (คิว ACK เต็ม)\n", cmdId);
      enqueueEvent("cmd_rejected", 0, cmdId, "queue_full");
      return;
    }
    Serial2.println(drawerNum == 1 ? "OPEN1" : "OPEN2");
    Serial.printf("[MQTT] %s -> เปิดลิ้นชัก %d\n", cmdId, drawerNum);
    publishEvent("drawer_opened", drawerNum, cmdId);
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
  } else if (strcmp(action, "next") == 0) {
    Serial2.println("NEXT");
    Serial.printf("[MQTT] %s -> เปลี่ยนหน้าถัดไป (NEXT)\n", cmdId);
  } else if (strcmp(action, "finish") == 0) {
    Serial2.println("FINISH");
    Serial.printf("[MQTT] %s -> จบการดูแลแผล (FINISH)\n", cmdId);
  }
}

void mqttEnsureConnected() {
  if (strlen(MQTT_HOST) == 0) return;
  if (mqtt.connected()) return;

  unsigned long now = millis();
  if (now - lastMqttAttempt < 5000) return;
  lastMqttAttempt = now;

  Serial.print("[MQTT] Connecting to ");
  Serial.print(MQTT_HOST);
  Serial.print("...");

  String clientId = "ESP32-FirstAidBox-" + String(random(0xffff), HEX);

  JsonDocument lwtDoc;
  lwtDoc["status"] = "offline";
  lwtDoc["ts"] = utcNowMs();
  lwtDoc["reason"] = "unexpected_disconnect";
  char lwtBuffer[256];
  size_t lwtLen = serializeJson(lwtDoc, lwtBuffer, sizeof(lwtBuffer));

  if (mqtt.connect(clientId.c_str(), MQTT_USER, MQTT_PASS, statusTopic, 1, true, lwtBuffer)) {
    Serial.println(" CONNECTED!");
    mqttSubscribedAt = millis();

    mqtt.subscribe(cmdTopic);
    Serial.printf("[MQTT] Subscribed to %s\n", cmdTopic);

    publishStatus(true);
    flushPendingEvents();
  } else {
    Serial.print(" FAILED, rc=");
    Serial.print(mqtt.state());
    Serial.println(" will retry in 5s");
  }
}

void handleRoot() {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.send(200, "text/plain", "Smart First Aid Box ESP32 Controller Online");
}

void sendDrawerCommandState(CommandRecord* record) {
  JsonDocument doc;
  doc["id"] = record->id;
  doc["drawer"] = record->drawer;
  doc["completed"] = record->completed;
  doc["expired"] = record->expired;
  doc["ts"] = record->timestamp;

  if (record->completed) {
    JsonDocument ack;
    ack["event"] = "drawer_opened";
    ack["drawer"] = record->drawer;
    ack["id"] = record->id;
    doc["ack"] = ack;
  }

  String json;
  serializeJson(doc, json);
  server.send(200, "application/json", json);
}

void handleStatus() {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  JsonDocument doc;
  doc["status"] = "online";
  doc["wifi_ssid"] = WiFi.SSID();
  doc["wifi_rssi"] = WiFi.RSSI();
  doc["ip"] = WiFi.localIP().toString();
  doc["uptime_seconds"] = millis() / 1000;
  doc["mqtt_connected"] = mqtt.connected();

  String json;
  serializeJson(doc, json);
  server.send(200, "application/json", json);
}

void handleOpen() {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  if (!server.hasArg("drawer") || !server.hasArg("id")) {
    server.send(400, "application/json", "{\"success\":false,\"error\":\"Missing parameters\"}");
    return;
  }

  int drawerNum = server.arg("drawer").toInt();
  String commandId = server.arg("id");

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
  record->completed = true;
  publishEvent("drawer_opened", drawerNum, record->id);
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

  Serial2.println(stateStr == "1" ? "BUZZ1" : "BUZZ0");
  server.send(200, "application/json", "{\"success\":true}");
}

void setup() {
  Serial.begin(115200);
  Serial2.begin(115200, SERIAL_8N1, RXD2, TXD2);
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

  configTime(7 * 3600, 0, "pool.ntp.org", "time.google.com");
  tlsClient.setInsecure();

  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setCallback(onMqttMessage);
  mqtt.setBufferSize(512);
  mqtt.setKeepAlive(30);
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
  expirePendingCommands();
  server.handleClient();

  mqttEnsureConnected();
  mqtt.loop();
  flushPendingEvents();

  if (Serial2.available()) {
    String line = Serial2.readStringUntil('\n');
    line.trim();
    if (line == "DOOR_OPEN") {
      publishEvent("door_open", 0);
    } else if (line == "CONFIRM_A") {
      publishEvent("confirm_a", 0);
    } else if (line == "CANCEL_B") {
      publishEvent("cancel_b", 0);
    } else if (line == "OK1" || line == "OK2") {
      int drawerNum = (line == "OK1") ? 1 : 2;
      CommandRecord* command = findOldestPendingDrawer(drawerNum);
      if (command != nullptr) {
        command->completed = true;
        publishEvent("drawer_opened", drawerNum, command->id);
      } else {
        publishEvent("drawer_opened", drawerNum);
      }
    }
  }
}
