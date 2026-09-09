# Run the kiosk and hardware service on Raspberry Pi 5

This deployment removes cloud MQTT from cabinet control:

`Chromium on Pi → localhost API → ESP32 over private LAN → micro:bit UART → motor completion ACK`

The existing Vercel deployment remains available. The Pi service never imports
the MQTT command handler, never connects the browser to a broker, and never falls
back to cloud MQTT or simulated success after a real command fails.

## Install and configure

1. Use Node.js 24 LTS on the Pi. Run `npm ci` in this checkout.
2. Copy `firmware/esp32_smart_box/device_config.example.h` to
   `firmware/esp32_smart_box/device_config.h`; fill Wi-Fi settings **locally**.
   The file is ignored by Git. MQTT is disabled by default.
3. Flash `firmware/esp32_smart_box/esp32_smart_box.ino` using ESP32 Arduino core
   3.3.1, ArduinoJson 7.4.2 and PubSubClient 2.8. The root `.ino` is a compatibility
   include, not a second implementation.
4. Import the updated `microbit/main.py` into the existing MakeCode project with
   the Activity:Bit/OLED extensions and flash micro:bit V2. **Both boards must be
   updated together.** The Pi refuses older ESP32 firmware lacking protocol 2;
   ESP32 refuses to dispatch without a fresh micro:bit READY heartbeat.
5. Verify the documented UART wiring: micro:bit P2 TX → ESP32 GPIO16 RX;
   ESP32 GPIO17 TX → micro:bit P3 RX; common GND. The previous code incorrectly
   selected P2 for both TX and RX. Keep motor power separate and verify wiring
   on the bench before enabling motors.
6. Give the ESP32 a stable address on the same private LAN as the Pi. Start:

   ```sh
   SFAB_ESP32_URL=http://192.168.1.100 npm run start:edge
   ```

   Use the **actual** ESP32 address. This example is not discovered hardware.
7. Open `http://localhost:8787/student/kiosk` in Chromium **on the Pi**. Optional:

   ```sh
   chromium --kiosk http://localhost:8787/student/kiosk
   ```

8. Existing browser settings start in Demo mode. Turn Demo off in the dashboard
   when ready to test actual hardware. Demo never calls the actuator or records
   real treatment history. A disconnected cabinet in Real mode reports failure.

The service binds only to `127.0.0.1`; it also rejects foreign Host/Origin values.
Do not expose it with a public proxy. Camera access works on the localhost secure
context without mixing an HTTPS Vercel page with HTTP device requests.

Optional process settings: `SFAB_PORT` (default 8787), `SFAB_DATABASE` (default
`~/.local/share/smart-first-aid-box/commands.sqlite`). Store the database outside
the checkout, retain it across application updates, and back it up along with
the cabinet. Run one service per cabinet/database. No service is installed or
started at boot by this PR.

## Command and acknowledgement contract

- The Pi saves each command ID to SQLite with full synchronous writes **before**
  sending it. Repeating an ID returns its stored result and never re-actuates.
  The same ID cannot change drawer or buzzer state. Concurrent distinct commands
  are refused; there is no delayed actuation queue.
- The ESP32 sends `OPEN1:<id>:<readyEpoch>` or `OPEN2:<id>:<readyEpoch>`.
  A micro:bit physical or remote start changes the readiness epoch, so a queued
  frame from an earlier idle period cannot start a later treatment.
- micro:bit emits `DONE1:<id>`/`DONE2:<id>` **after** `motor_run` returns.
  ESP32 accepts only an exact pending ID and drawer. Bare `OK1`/`OK2`, stale IDs,
  duplicates, and ACKs after expiry cannot confirm another command.
- The ACK proves that the firmware completed its motor sequence. It does **not**
  prove a drawer moved or an item emerged: this hardware has no verified output
  sensor. A physical bench check remains necessary.
- While the user follows the micro:bit care steps it stays BUSY. Finish those
  steps with the existing buttons before a new treatment.
- Buzzer commands use `BUZZ1:<id>`/`BUZZ0:<id>` and `BUZZ_DONE1:<id>`/
  `BUZZ_DONE0:<id>`. The micro:bit V2 speaker acknowledges after applying the
  sound setting. This is not acoustic verification.
- A lost `/open` response triggers only `/command-status` polling, never another
  `/open`. The Pi waits up to 18 seconds after readiness checking; Chromium waits
  23 seconds. A pending record surviving restart becomes `uncertain` and is never
  automatically replayed. Inspect the cabinet before initiating a new command
  after an uncertain result.

`GET /api/local/status` reports connection/readiness. `GET /api/local/history`
returns the last 100 command journal entries (drawer 1/2, buzzer on/off 3/4).
Only matched confirmations have `confirmed_at`. This journal is separate from
the existing patient/treatment history, browser inventory and optional Supabase
sync; this change does not migrate those stores.

## Internet and scope

Manual wound selection and local actuation need the cabinet LAN, not internet
or a broker. The existing font CDN, statistics Chart.js, Gemini image analysis,
LINE notifications and optional Supabase sync still use internet. Optional
Gemini/LINE server environment settings must be supplied locally on the Pi if
those functions are wanted. `/api/analyze` and `/api/notify` reuse their existing
handlers; no cloud command API is contacted. Local edge AI and USB serial
transport are separate future changes.

The former tracked device credential values have been removed from the active
firmware; they are not reproduced here. Removing source values does not revoke
previous credentials or erase history. Rotate previously exposed credentials
through the respective provider before reusing those services.

## Validation and physical acceptance

Run `npm test`. The edge integration tests use real HTTP sockets and SQLite,
plus the real browser bridge in a VM. Python tests execute the actual micro:bit
functions with hardware stubs; they do not compile the MakeCode extensions.

Before switching the cabinet, with an operator present:

1. Verify UART TX/RX, separate motor supply, board firmware and fresh READY.
2. Disconnect internet while retaining the Pi ↔ ESP32 LAN. In Real mode, select
   one supported wound and confirm. Observe one motor cycle, then UI success,
   then one confirmed journal entry.
3. Repeat the **same command ID**; verify no second movement or journal entry.
4. Unplug UART before a fresh command; require failure with no false success.
5. Restart the Pi service after an uncertain command; require no replay.
6. Finish micro:bit care steps, verify it becomes ready, and test the other drawer
   and V2 speaker on/off. Confirm physical output separately from firmware ACK.

No Pi deployment, board flashing, motor movement or physical output validation
is claimed by the software test suite.
