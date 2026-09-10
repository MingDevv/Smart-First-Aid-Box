#pragma once
// Copy to device_config.h (ignored by Git), then fill values locally.
#define SFAB_WIFI_SSID ""
#define SFAB_WIFI_PASSWORD ""
// MQTT is disabled by default. Enable all three together for Vercel + Pi use.
// #define SFAB_MQTT_HOST ""       // host only, no mqtts:// prefix
// #define SFAB_MQTT_USER ""
// #define SFAB_MQTT_PASSWORD ""
// #define SFAB_MQTT_BASE_TOPIC "crms6/firstaidbox/box1"
// Before physical release: measure worst OPEN-to-DONE at the actual STEP_DELAY_MS.
// Budget = measured maximum + at least 50% + 2000 ms. Allowed range 3000..120000.
// #define SFAB_COMMAND_ACK_TIMEOUT_MS <measured budget in milliseconds>
