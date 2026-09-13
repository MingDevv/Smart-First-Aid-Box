# MQTT on Vercel, local control on Raspberry Pi

The same protocol-2 ESP32 + micro:bit firmware supports both clients:

| Client | Command path | Internet |
|---|---|---|
| Vercel website | HTTPS `/api/command` → MQTT broker → ESP32 → UART → micro:bit | Required |
| Chromium on Pi | localhost `/api/command` → Pi SQLite journal → ESP32 HTTP → UART → micro:bit | Not required for manual selection and cabinet control |

Use [PI_LOCAL_SETUP.md](docs/PI_LOCAL_SETUP.md) for the Pi service, UART wiring,
paired flashing, motor timing measurements and physical acceptance checks.
The Pi does not connect to cloud MQTT or fall back to it. ESP32 can accept both
transports; a busy micro:bit refuses a second motor command, while SOS is still
allowed. Demo mode never sends an actuator command or records real treatment.

## Broker and permissions

Use a private MQTT broker with TLS and WebSocket support, such as HiveMQ Cloud.
Create three separate credentials with these exact permissions:

| Credential | Publish | Subscribe | Stored in |
|---|---|---|---|
| ESP32 device | `<base>/evt`, `<base>/status` | `<base>/cmd` | Ignored `device_config.h` |
| Vercel publisher | `<base>/cmd` | `<base>/evt`, **`<base>/status`** | Vercel environment |
| Optional web viewer | None | `<base>/evt`, `<base>/status` | Browser settings |

The new server requires permission to subscribe to **both event and status**
topics. An old publisher credential allowing only events must be updated.
Do not put publisher/device credentials in browser JavaScript or Git.

Default base topic: `crms6/firstaidbox/box1`. Keep it identical on every side.
Commands and events are **never retained**. Status is retained and includes
an offline Last Will. Never publish test commands to the real cabinet topic.

## Vercel configuration

Set these values in Project Settings → Environment Variables, for the intended
deployment environment:

- `MQTT_URL`: `mqtts://<cluster-host>:8883`
- `MQTT_USERNAME`: the Vercel publisher username
- `MQTT_PASSWORD`: its password
- `MQTT_BASE_TOPIC`: the cabinet base topic

Install dependencies with `npm ci`. `vercel.json` sets `api/command.js`
`maxDuration` to **180 seconds**; the deployment must honor this setting.
Enable **Fluid Compute** in the Vercel project's function settings and verify
the deployed duration before connecting the real cabinet. Vercel's
[current duration limits](https://vercel.com/docs/functions/configuring-functions/duration)
(checked 2026-09-10) allow 300 seconds on Hobby with Fluid Compute. The older
60-second Hobby limit is not the Fluid limit; a legacy non-Fluid deployment
must be migrated or assessed separately. Do not shorten this handler to 60
seconds while allowing firmware to advertise a 120-second motor budget.
No frontend listener credential is required to issue commands or read status:
a fresh browser obtains readiness from `GET /api/command`.

Optional live events: Dashboard → medicine management → MQTT settings. Supply
`wss://<cluster-host>:8884/mqtt`, the **subscribe-only** credential and base topic.
Pi ignores these browser settings. The main kiosk polls the server for status
when no browser subscriber is configured.

## ESP32 configuration

Copy `firmware/esp32_smart_box/device_config.example.h` to `device_config.h`
in the same directory. Fill the Wi-Fi values locally. To enable the cloud
path, also configure the three MQTT macros shown in the example. Empty
`SFAB_MQTT_HOST` disables MQTT; local Pi control still works.

Use the **single canonical sketch** `firmware/esp32_smart_box/esp32_smart_box.ino`.
Required build versions: ESP32 core 3.3.1, ArduinoJson 7.4.2, PubSubClient 2.8.
Flash the matching `microbit/main.py` from this branch, using the existing
MakeCode Activity:Bit/OLED extensions. Update **both boards together** before
using protocol 2; old bare `OK1/OK2` responses cannot confirm commands.

## Readiness, timing and success

ESP32 publishes status every second with `protocol:2`, `online`, `microbit`,
`ready`, `ackTimeoutMs`, `reason`, and UTC `ts`. Vercel refuses to dispatch when
status is missing, older than five seconds, offline, the wrong protocol, or has
an invalid timing budget. `open` additionally requires `ready:true`; buzzer
commands can run while the motor is busy. NTP must be working on ESP32.
If MQTT shows offline despite working LAN control, check ESP32 NTP access
(UDP 123), broker access and the client/server clock before changing budgets.

Before each command the browser reads this metadata. With firmware budget `B`:

- Firmware accepts `B` between 3 and 120 seconds. The provisional default is
  **30 seconds**, pending physical OPEN-to-DONE measurement.
- Vercel waits for the exact device event for `B + 3 seconds` after connecting.
- The server advertises `commandTimeoutMs = B + 10 seconds`, accounting for
  MQTT connection and status reads. The browser allows another five seconds.
  With default `B=30s`, this gives a **45-second browser deadline**.
- Pi keeps its existing `B + 3 seconds` service / `B + 8 seconds` browser budgets.
- If firmware timing changes between the cloud browser's status read and POST,
  the server refuses before sending. Reload/check status and try again.

`PUBACK`, HTTP 202 and a generic `success:true` are not completion evidence.
Success requires the exact protocol-2 event, command ID and drawer or buzzer
state. ESP32 emits `drawer_opened` after matching UART `DONE1:<id>` or
`DONE2:<id>`, and `buzzer_set` after matching `BUZZ_DONE1:<id>` or
`BUZZ_DONE0:<id>`. This confirms firmware completion, not actual item output
or audible sound; those require physical observation.

A lost response or timeout after publishing remains uncertain. The browser
**does not automatically retry through LAN**, invent a successful Demo result,
or re-dispatch after a refusal. Inspect the cabinet before starting a new
command. A response marked `retrySafe:true` means the server/browser had not
sent an actuator command.
Validation failures (400) and rate-limit refusals (429) also carry this flag;
wait for the rate-limit window or correct the request before trying again.

SOS reports LINE acceptance and the cabinet's buzzer ACK separately. A failed
LINE request never silently becomes a Demo notification. In explicit Demo
mode, no LINE request is sent. The teacher dashboard provides **หยุดเสียง SOS
ที่ตู้**, which sends `buzzer:off` and waits for the matching ACK; check the
actual speaker as well. Stopping sound does not retract the LINE message.

The Pi's SQLite journal survives restarts. ESP32's shared deduplication ring
covers eight recent IDs from both MQTT and LAN, refuses ID reuse for a different
action, and re-ACKs completed duplicates without another motor/speaker command.
That ring does **not** survive board resets; Vercel has no durable command
journal. Do not manually replay uncertain cloud commands after a reset.

## Direct LAN fallback

An HTTP-hosted browser may use its configured ESP32 address only when Vercel
explicitly reports `mqttConfigured:false`. It first reads protocol-2 readiness
and the firmware budget, sends once, then polls `/command-status` for completion
(including buzzer commands). If the initial response is lost it only polls.

An HTTPS Vercel page cannot call an HTTP ESP32 due to browser mixed-content
rules. Use MQTT from Vercel, or open the **local Pi kiosk** for offline control.
Do not disable browser security flags to work around this.

## Verification

Run `npm test` for browser contracts, local HTTP/SQLite integration, native C++
command history and the micro:bit protocol tests.

For MQTT integration use a dedicated local Mosquitto listener on
`127.0.0.1:18884` with anonymous access and persistence disabled, then run:

```sh
npm run test:mqtt
```

Alternatively point `SFAB_TEST_MQTT_URL` at an **isolated test broker**. Tests
use unique `crms6/firstaidbox/integration/...` topics and a simulated device;
never use production credentials or the real cabinet topic. The integration
suite exercises a ten-second motor ACK, mismatched ACKs, SOS during a pending
motor, missing ACKs, refusals, stale/legacy metadata and concurrent requests.
It does not prove physical movement or a production Vercel deployment.

Before production, check `GET https://<site>/api/command` without actuating.
Expected after paired firmware/broker setup: `mqttConfigured:true`,
`connected:true`, `protocol:2`, `ready:true` and the measured timing budget.
Then perform the operator-present physical checks in the Pi guide from **both**
clients. Keep the Pi LAN connected and disconnect internet to prove offline
local control separately.

**Open hardware gate: MQTT enabled + WAN down.** The current ESP32 sketch calls
the synchronous MQTT connect/TLS path from the same loop that serves HTTP and
drains UART. `setSocketTimeout(2)` does not bound DNS/TCP/TLS time. Therefore
offline Pi responsiveness with MQTT configured is **not yet validated**.
Keep Wi-Fi/LAN up, block only WAN/DNS/broker access, poll `/status` during
reconnect attempts, and measure HTTP latency, UART heartbeat loss and an
operator-supervised open/SOS/stop cycle. Include WAN restoration and check for
delayed or duplicate actuation. Failure requires moving MQTT I/O off the
HTTP/UART loop; increasing retry backoff alone does not prove isolation.
Do not close this gate using a test with `SFAB_MQTT_HOST` empty.

## Remaining deployment limits

- `/api/command` has in-memory per-IP/global rate limits but no user login.
  The public endpoint can be invoked by someone who knows the URL. Decide the
  intended access boundary before exposing the real cabinet to the internet.
- ESP32 still uses `setInsecure()` for broker TLS: encryption without server
  certificate verification. Configure the correct root CA before treating the
  cloud connection as authenticated.
- Removing old credentials from source does not revoke them. Rotate any
  previously exposed values at their provider before reuse.
