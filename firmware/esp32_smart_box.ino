/*
 * ==============================================================================
 * ESP32 FIRMWARE — SMART FIRST AID BOX (micro:bit Thailand Challenge 2026)
 * ==============================================================================
 * Connects ESP32 to local Wi-Fi and bridges Web App requests to micro:bit v2 via UART.
 *
 * Endpoints:
 * - GET /status          -> Returns JSON status of controller & micro:bit
 * - GET /open?drawer=1   -> Sends OPEN1 command to micro:bit over UART (Serial2)
 * - GET /buzzer?state=1  -> Sends BUZZ1 command to micro:bit over UART (Serial2)
 * ==============================================================================
 */

#include <WiFi.h>
#include <WebServer.h>
#include <HTTPClient.h>

const char* ssid = "YOUR_WIFI_SSID";
const char* password = "YOUR_WIFI_PASSWORD";

WebServer server(80);

// Hardware Serial 2 pins connected to micro:bit (P14/P15)
#define RXD2 16
#define TXD2 17

void handleRoot() {
  server.send(200, "text/plain", "Smart First Aid Box ESP32 Bridge Active");
}

void handleStatus() {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  String json = "{\"status\":\"online\",\"microbit\":\"connected\",\"drawers\":2,\"mode\":\"production\"}";
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

  WiFi.begin(ssid, password);
  Serial.print("Connecting to WiFi");
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println("");
  Serial.print("Connected! IP Address: ");
  Serial.println(WiFi.localIP());

  server.on("/", handleRoot);
  server.on("/status", handleStatus);
  server.on("/open", handleOpen);
  server.on("/buzzer", handleBuzzer);

  server.begin();
  Serial.println("HTTP Server Started");
}

void loop() {
  server.handleClient();
  
  // Read incoming events from micro:bit via Serial2
  if (Serial2.available()) {
    String line = Serial2.readStringUntil('\n');
    line.trim();
    if (line == "DOOR_OPEN") {
      Serial.println("[EVENT] Door Opened Sensor Triggered on micro:bit!");
    } else if (line == "CONFIRM_A") {
      Serial.println("[EVENT] User Pressed Button A (Confirmed) on micro:bit!");
    } else if (line == "CANCEL_B") {
      Serial.println("[EVENT] User Pressed Button B (Cancelled) on micro:bit!");
    }
  }
}
