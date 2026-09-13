# Raspberry Pi 5 cabinet lockdown — systemd units, Chromium kiosk, labwc session

## STATUS: NOTHING HERE HAS BEEN APPLIED OR TESTED

Every file in `deploy/pi/` was written by reading `edge/server.mjs`,
`edge/controller.mjs`, `js/storage.js`, `js/kiosk-app.js` and `vercel.json` in this
checkout. **None of it has run on a Raspberry Pi.** The Pi was not reachable while this
was written (its Tailscale address timed out), so:

- no unit has been started, enabled, or `systemd-analyze verify`-ed
- no Chromium has been launched with these flags
- no policy has appeared on a `chrome://policy` page
- no labwc config has been parsed by labwc
- no escape route has been attempted with a real keyboard

What **has** been verified, all of it on a Mac and none of it on a Pi:

- `chromium-policies.json` parses, and contains no `/dashboard` or `/student` entry
- every shell script here passes `sh -n`; `rc.xml` and `menu.xml` are well-formed XML
- the `server.close()` timings quoted throughout were **measured** against the real
  `createLocalServer`, with a control case proving the probe can show a stalled close.
  They replace a claim that pointed the opposite way
- `bin/sfab-edge-healthcheck.sh` was exercised against a real edge server, a hung server,
  an impostor and a dead port

Treat this directory as a reviewed proposal. The checklist at the bottom is the work
that still has to happen on the device, and until it is done, the honest description of
this cabinet's lockdown is "designed, not deployed".

---

## What it deploys

```
boot
 └─ sfab-edge.service        (system unit, user sfab)
      node edge/server.mjs → listens 127.0.0.1:8787 → ESP32 over private LAN
      journal: /var/lib/sfab/commands.sqlite  (anti-replay + unresolved hold, WAL)
 └─ sfab-edge-watchdog.timer (system timer, every 30s)
      └─ sfab-edge-watchdog.service → sfab-edge-healthcheck.sh
           GET /api/local/status; 3 consecutive failures → restart sfab-edge
           (covers ALIVE-BUT-HUNG only; Restart= already covers exits)

login (autologin, user technology)
 └─ labwc session            (no panel, no desktop, no menus, no keybinds)
      └─ ~/.config/labwc/autostart
           └─ sfab-kiosk.service   (USER unit)
                ExecStartPre: wait until 127.0.0.1:8787/kiosk answers
                ExecStart:    chromium --kiosk http://localhost:8787/kiosk
                              + /etc/chromium/policies/managed/sfab-kiosk.json

operator, over SSH only (no HTTP endpoint, on purpose)
 └─ node edge/resolve.mjs --list
    node edge/resolve.mjs --check-cabinet <id>   → clears an 'uncertain' hold
```

| File here | Goes to | Owner/mode |
|---|---|---|
| `sfab-edge.service` | `/etc/systemd/system/sfab-edge.service` | root:root 0644 |
| `sfab-edge-watchdog.service` | `/etc/systemd/system/sfab-edge-watchdog.service` | root:root 0644 |
| `sfab-edge-watchdog.timer` | `/etc/systemd/system/sfab-edge-watchdog.timer` | root:root 0644 |
| `sfab-kiosk.service` | `/home/technology/.config/systemd/user/sfab-kiosk.service` | technology 0644 |
| `bin/sfab-wait-for-edge.sh` | `/usr/local/lib/sfab/sfab-wait-for-edge.sh` | root:root 0755 |
| `bin/sfab-kiosk-run.sh` | `/usr/local/lib/sfab/sfab-kiosk-run.sh` | root:root 0755 |
| `bin/sfab-edge-healthcheck.sh` | `/usr/local/lib/sfab/sfab-edge-healthcheck.sh` | root:root 0755 |
| `chromium-kiosk-flags.conf` | `/etc/sfab/chromium-kiosk-flags.conf` | root:root 0644 |
| `chromium-policies.json` | `/etc/chromium/policies/managed/sfab-kiosk.json` | root:root 0644 |
| `labwc-kiosk/rc.xml` | `~/.config/labwc/rc.xml` | **merge, do not copy** |
| `labwc-kiosk/menu.xml` | `~/.config/labwc/menu.xml` | technology 0644 |
| `labwc-kiosk/autostart` | `~/.config/labwc/autostart` | technology 0755 |
| `labwc-kiosk/environment` | `~/.config/labwc/environment` | technology 0644 |

`technology` is the existing desktop user on this Pi (its labwc config is at
`/home/technology/.config/labwc/rc.xml`). Confirm with `id technology` before assuming.
`sfab` is a new unprivileged system user for the edge service; it is deliberately not the
desktop user, so a compromised browser session does not own the command journal.

---

## The contract this config depends on

Read from the source this session. If any of it changes, this directory is wrong.

| Fact | Source |
|---|---|
| Binds `127.0.0.1` only | `server.listen(port, '127.0.0.1', …)` |
| Port = `SFAB_PORT` or 8787 | `Number(process.env.SFAB_PORT \|\| 8787)` |
| Host header must be exactly `127.0.0.1:<port>` or `localhost:<port>`, else **403** | the `allowed` array in `server.mjs` |
| Cross-site `Origin` or `Sec-Fetch-Site: cross-site` → 403 | same block |
| Kiosk route is `/kiosk` → `/kiosk/index.html` | `vercel.json` rewrite, read by the server at startup |
| DB = `SFAB_DATABASE` or `~/.local/share/smart-first-aid-box/commands.sqlite` | startup block in `server.mjs` |
| DB dir is created with mode `0700` at startup | `mkdir(dirname(database), …)` |
| SQLite runs `journal_mode=WAL`, `synchronous=FULL` | `controller.mjs` |
| `SFAB_ESP32_URL` must be a bare `http://` origin — no https, no credentials, no query, no path beyond `/` | the `new URL()` validation in `controller.mjs` throws otherwise |
| SIGTERM → `server.close()` → `controller.close()`, which awaits in-flight commands | `stop()` in `server.mjs` |
| A firmware ACK budget of **3–120 s** is accepted; the Pi adds 3 s, so one command can be in flight for up to **123 s** | the `validBudget` check and `commandTimeoutMs` in `controller.mjs` `status()` |
| A command that was sent but never confirmed becomes `state='uncertain'` and **blocks every later drawer-open** until an operator clears it | `unresolved()` and the `action === 'open'` guard in `controller.mjs` `command()` |
| The **buzzer is never blocked** by that hold — calling for help is not gated on a stuck drawer | same guard, `action === 'open'` only |
| The hold is cleared only over SSH, by `edge/resolve.mjs`, which sets `state='resolved_by_operator'` rather than deleting the row | `edge/resolve.mjs` |
| The operating mode is **tri-state** (`demo` / `real` / `unset`) and an unset cabinet refuses to actuate | `StorageService.getOperatingMode()` in `js/storage.js`, `ApiBridge.unprovisioned()` in `js/api-bridge.js` |
| The medicine stock and treatment history live in **browser `localStorage`** | `js/storage.js`, keys `smart_first_aid_medicine` / history |
| The camera request is `{ video: true, audio: false }` | `js/kiosk-app.js` |
| A failed camera falls back to manual wound selection | `cameraUnavailable()` in `js/kiosk-app.js` |

### Two stores, two backups — do not confuse them

- `/var/lib/sfab/commands.sqlite` — the **command journal**. It is the anti-replay
  mechanism: a repeated command ID returns its stored result instead of moving a motor
  again. Losing it means previously-used IDs can actuate a second time.
- The Chromium profile (`~/.config/chromium`) — the **medicine stock and treatment
  history**, in `localStorage`.

Neither backs up the other. Anything that wipes the browser profile destroys the stock
while leaving the journal intact, and looks like a working cabinet. This is why
`ForceEphemeralProfiles`, forced incognito and `ClearBrowsingDataOnExitList` are
excluded from the policy file — see `chromium-policies.notes.md`.

---

## STEP 0 — BACK UP BEFORE YOU CHANGE ANYTHING

Do this first. Not after the first thing goes wrong.

### The touch calibration is the thing most likely to be destroyed

An earlier session measured a five-point calibration for the ADS7846 resistive panel and
wrote it into `~/.config/labwc/rc.xml`, along with a repaired `mapToOutput="HDMI-A-1"`
(it had been pointing at `NOOP-1`, which is why touch looked dead) and
`mouseEmulation=yes`. **Installing a new `rc.xml`, changing the display mode, or
switching the session will break it.**

The measured result also exists outside this repo, at
`~/Desktop/Codex/pi5-tailscale-setup/touch-calibration-measured.json` — confirmed
present while writing this. It records a matrix, per-corner residuals of 8.75–9.45 px
and a held-out centre validation of 16.04 px.

**Those numbers are not reproduced in `labwc-kiosk/rc.xml`, and they must not be typed
from memory.** `rc.xml` ships with an empty, clearly marked slot where the live values
have to be transplanted verbatim from your backup.

> ⚠️ **Unresolved discrepancy, flag before you start.** That calibration file records
> `"screen": [1024, 768]`, and the prior session notes say the Pi came up in a 1024x768
> fallback mode while an earlier sample had shown the panel's native 800x480. This
> cabinet is specified as an 800x480 panel. The calibration matrix is expressed in
> normalised coordinates and so is not automatically invalidated by a resolution change,
> but it *does* encode the orientation it was measured in. **Do not assume it carries
> over to 800x480.** Settle the output mode first, then re-check alignment, then decide
> whether a re-measure is needed. Do not adjust the numbers to compensate.

### Commands

```sh
STAMP=$(date +%Y%m%d-%H%M%S)

# 1. Compositor session — this is where the calibration lives
mkdir -p ~/sfab-backup-$STAMP/labwc
cp -a ~/.config/labwc/. ~/sfab-backup-$STAMP/labwc/ 2>/dev/null || true

# 2. Display + touch overlay boot config
sudo cp -a /boot/firmware/config.txt ~/sfab-backup-$STAMP/config.txt
sudo cp -a /boot/firmware/cmdline.txt ~/sfab-backup-$STAMP/cmdline.txt

# 3. Record the CURRENT display mode, so you can tell whether you changed it
wlr-randr > ~/sfab-backup-$STAMP/display-mode.txt 2>&1 || \
  echo "wlr-randr not installed — record the mode another way BEFORE continuing" \
  > ~/sfab-backup-$STAMP/display-mode.txt

# 4. Existing Chromium flag injection and any existing policies
sudo cp -a /etc/chromium.d ~/sfab-backup-$STAMP/ 2>/dev/null || true
sudo cp -a /etc/chromium ~/sfab-backup-$STAMP/etc-chromium 2>/dev/null || true
sudo cp -a /etc/chromium-browser ~/sfab-backup-$STAMP/etc-chromium-browser 2>/dev/null || true

# 5. THE MEDICINE STOCK. This is browser localStorage, not a file you would think to copy.
#    Chromium must be stopped or the copy may be inconsistent.
systemctl --user stop sfab-kiosk.service 2>/dev/null || true
cp -a ~/.config/chromium ~/sfab-backup-$STAMP/chromium-profile

# 6. The command journal, if a previous deployment already created one
sudo cp -a /var/lib/sfab ~/sfab-backup-$STAMP/sfab-state 2>/dev/null || true

ls -la ~/sfab-backup-$STAMP
```

Copy `~/sfab-backup-$STAMP` off the Pi before continuing. A backup that only exists on
the SD card you are about to reconfigure is not a backup.

---

## Install order

Order matters: prove SSH works, then the service, then the browser, then the lockdown.
Never install the lockdown before you have a way back in.

**1. Confirm your way back in, first.**

```sh
ssh technology@<pi-tailscale-name> 'echo ok; uptime'
```
If this does not work, stop. Everything below assumes you can get a shell without the
screen.

**2. Deploy the application checkout outside `/home`.**

`sfab-edge.service` sets `ProtectHome=yes`, so a checkout under `/home` is invisible to
the service and it will fail with ENOENT.

```sh
sudo mkdir -p /opt/smart-first-aid-box
# copy or clone the checkout here, then:
cd /opt/smart-first-aid-box && sudo npm ci
node --version        # must be >= 24; see docs/PI_LOCAL_SETUP.md
command -v node       # must print /usr/bin/node, or edit ExecStart to match
```

**3. Create the service user and the edge unit.**

```sh
sudo useradd --system --no-create-home --shell /usr/sbin/nologin sfab
sudo install -o root -g root -m 0644 sfab-edge.service /etc/systemd/system/
sudo sed -i 's|http://192.168.1.100|http://<REAL-ESP32-IP>|' /etc/systemd/system/sfab-edge.service
sudo systemd-analyze verify sfab-edge.service     # syntax + hardening sanity
sudo systemctl daemon-reload
sudo systemctl enable --now sfab-edge.service
```

Optional secrets for `/api/analyze` and `/api/notify` — the unit references this file
optionally, so the service starts fine without it:

```sh
sudo mkdir -p /etc/sfab
sudo install -o root -g sfab -m 0640 /dev/null /etc/sfab/edge.env
# then add GEMINI_API_KEY / LINE_* from .env.example. Never commit this file.
```

Optional cloud path (the website on Vercel opening the cabinet through the broker) — the
Pi holds the **device** credential from `MQTT_SETUP.md` (publish `evt`/`status`, subscribe
`cmd`). Same variable names as the Vercel side; leave them out and the cabinet stays
touchscreen-only:

```sh
MQTT_URL=mqtts://<cluster-host>:8883
MQTT_USERNAME=<device username>
MQTT_PASSWORD=<device password>
MQTT_BASE_TOPIC=crms6/firstaidbox/box1
```

Optional fifth line: `SFAB_CLOUD_ACTIONS=buzzer` lets the website ring the buzzer but never
open a drawer (the website's `/api/command` has no login of its own); the default
`open,buzzer` is parity with the ESP32 era. A wrong or missing `MQTT_URL` only disables the
cloud path — the journal shows `[SFAB cloud] disabled: …` and the touchscreen keeps working.

`edge/mqtt-cloud.mjs` loads the `mqtt` package lazily, so the checkout on the Pi needs a
`node_modules` (the edge service itself uses only Node built-ins). The cabinet runs from
`~/sfab` under the **user** unit, not `/opt`; ship code and the lockfile, never
`node_modules`, then install on the Pi with its own npm (not on the unit's PATH by default):

```sh
# on the Mac
rsync -a --delete --exclude node_modules --exclude .git --exclude '*.sqlite*' <checkout>/ pi5:~/sfab/
# on the Pi
cd ~/sfab && ~/.local/node/bin/npm ci --omit=dev
timedatectl show -p NTPSynchronized      # must be yes: commands carry a timestamp the Pi judges
systemctl --user restart sfab-edge
journalctl _SYSTEMD_USER_UNIT=sfab-edge.service -n 20    # expect "[SFAB cloud] on broker as <base>"
```

Then confirm the broker shows a retained `<base>/status` with `"transport":"pi"` and
`GET /api/command` on the website reports `connected:true`.

Check it before going near the browser:

```sh
curl -fsS http://127.0.0.1:8787/api/local/status; echo
curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8787/kiosk
```

Both must succeed. A `403` means the Host header was wrong — use the literal loopback
address, not the hostname.

**4. Install the kiosk launcher scripts and the flags file.**

```sh
sudo mkdir -p /usr/local/lib/sfab /etc/sfab
sudo install -o root -g root -m 0755 bin/sfab-wait-for-edge.sh /usr/local/lib/sfab/
sudo install -o root -g root -m 0755 bin/sfab-kiosk-run.sh /usr/local/lib/sfab/
sudo install -o root -g root -m 0755 bin/sfab-edge-healthcheck.sh /usr/local/lib/sfab/
sudo install -o root -g root -m 0644 chromium-kiosk-flags.conf /etc/sfab/
```

**4b. Install the liveness watchdog.** Covers the edge service being *alive but not
answering*, which `Restart=on-failure` cannot see. It does not watch the browser — read
"Hang recovery" below before assuming it does.

```sh
sudo install -o root -g root -m 0644 sfab-edge-watchdog.service /etc/systemd/system/
sudo install -o root -g root -m 0644 sfab-edge-watchdog.timer   /etc/systemd/system/
sudo systemd-analyze verify sfab-edge-watchdog.service sfab-edge-watchdog.timer
sudo systemctl daemon-reload

# Prove the probe agrees with reality BEFORE arming it. With the edge service running
# this must print nothing about strikes and exit 0.
sudo /usr/local/lib/sfab/sfab-edge-healthcheck.sh --dry-run

sudo systemctl enable --now sfab-edge-watchdog.timer     # the TIMER, not the .service
systemctl list-timers sfab-edge-watchdog.timer
```

**5. Install the Chromium managed policy.**

Two candidate directories; which one this Chromium package reads is not verified here.
Install both, then delete the one `chrome://policy` does not show as loaded.

```sh
sudo mkdir -p /etc/chromium/policies/managed /etc/chromium-browser/policies/managed
sudo install -m 0644 chromium-policies.json /etc/chromium/policies/managed/sfab-kiosk.json
sudo install -m 0644 chromium-policies.json /etc/chromium-browser/policies/managed/sfab-kiosk.json
```

**6. Install the kiosk user unit — but start it by hand first.**

```sh
sudo -u technology mkdir -p /home/technology/.config/systemd/user
sudo install -o technology -g technology -m 0644 sfab-kiosk.service \
     /home/technology/.config/systemd/user/
sudo loginctl enable-linger technology
```

Then, **from the Pi's own screen and keyboard**, not over SSH:

```sh
systemctl --user daemon-reload
systemctl --user start sfab-kiosk.service
journalctl --user -u sfab-kiosk -f
```

Chromium should come up fullscreen on `/kiosk`. If it does not, the two usual causes are
`--ozone-platform=wayland` (comment it out in `/etc/sfab/chromium-kiosk-flags.conf` and
retry) and a wrong binary path (see `sfab-kiosk-run.sh`). Fix this **before** locking the
session down, because afterwards you lose the easy way to look.

**7. Lock the session down — last.**

Only now, and only after the backup in step 0 exists off-device:

```sh
# menus, environment, autostart: straight copies
sudo install -o technology -g technology -m 0644 labwc-kiosk/menu.xml    /home/technology/.config/labwc/
sudo install -o technology -g technology -m 0644 labwc-kiosk/environment /home/technology/.config/labwc/
sudo install -o technology -g technology -m 0755 labwc-kiosk/autostart   /home/technology/.config/labwc/

# rc.xml: MERGE. Open the backup, copy the <touch> element and the <libinput> device
# entry holding calibrationMatrix into the marked slot in labwc-kiosk/rc.xml FIRST,
# then install the merged result.
```

Reload, then reboot to confirm the whole chain:

```sh
LABWC_PID=$(pidof labwc) labwc --reconfigure
sudo reboot
```

The session hardening in `labwc-kiosk/README.md` (VT switching, SysRq, Ctrl+Alt+Del) is
separate and optional. Read the trade-offs there; each one removes a recovery path.

---

## Rollback — per piece

Each piece reverses independently. Nothing here needs a full reimage.

**Kiosk browser only** (leaves the edge service running):
```sh
systemctl --user stop sfab-kiosk.service
systemctl --user disable sfab-kiosk.service
systemctl --user mask sfab-kiosk.service      # also survives reboot
```
Undo with `systemctl --user unmask --now sfab-kiosk.service`.

**Chromium flags** — the file is read at each launch, no reload needed:
```sh
sudo cp ~/sfab-backup-$STAMP/... /etc/sfab/chromium-kiosk-flags.conf   # or edit in place
systemctl --user restart sfab-kiosk.service
```

**Chromium policy** — delete the file and restart the browser:
```sh
sudo rm -f /etc/chromium/policies/managed/sfab-kiosk.json \
           /etc/chromium-browser/policies/managed/sfab-kiosk.json
systemctl --user restart sfab-kiosk.service
```

**labwc session** — restore the whole directory from the backup, which is the only way to
be sure the calibration comes back:
```sh
cp -a ~/sfab-backup-$STAMP/labwc/. ~/.config/labwc/
LABWC_PID=$(pidof labwc) labwc --reconfigure
```
If touch is wrong after this, log out and back in rather than assuming reconfigure
re-applied the calibration matrix.

**Liveness watchdog only** (leaves the edge service running, and with it the exit-recovery
that `Restart=on-failure` provides):
```sh
sudo systemctl disable --now sfab-edge-watchdog.timer
sudo rm -f /etc/systemd/system/sfab-edge-watchdog.timer \
           /etc/systemd/system/sfab-edge-watchdog.service
sudo systemctl daemon-reload
```
Do this first if you suspect the watchdog is restarting a service that was actually
healthy — `journalctl -u sfab-edge-watchdog` shows every strike it recorded.

**Edge service**:
```sh
sudo systemctl disable --now sfab-edge-watchdog.timer    # remove the watchdog too; a timer
                                                         # probing a deleted unit is just noise
sudo systemctl disable --now sfab-edge.service
sudo rm /etc/systemd/system/sfab-edge.service
sudo systemctl daemon-reload
```
The watchdog will **not** fight you here: it checks `systemctl is-active` first and exits
without acting when the unit is stopped, precisely so a maintenance stop is not undone by
a machine. Removing it alongside is tidiness, not a race.
**Do not delete `/var/lib/sfab`.** That is the command journal. Removing it discards the
record that prevents a previously-used command ID from actuating a drawer a second time.
Keep it even when you remove everything else.

**Everything, back to a normal desktop**: rollback in reverse install order — session,
policy, flags, kiosk unit, edge unit — then reboot.

---

## Maintenance mode over SSH

The goal: stop the browser, keep the cabinet service running, get a usable shell.

```sh
ssh technology@<pi-tailscale-name>

# systemctl --user over SSH needs to find the user's systemd instance
export XDG_RUNTIME_DIR=/run/user/$(id -u)

# 1. Stop the browser. The screen goes to the bare compositor; the cabinet is now
#    out of service, so do this deliberately.
systemctl --user stop sfab-kiosk.service

# 2. Confirm the edge service is untouched and still serving
systemctl is-active sfab-edge.service
curl -fsS http://127.0.0.1:8787/api/local/status; echo
curl -fsS http://127.0.0.1:8787/api/local/history | head -c 400; echo

# ... work ...

# 3. Back into service
systemctl --user start sfab-kiosk.service
```

For a long job that must survive a reboot, `systemctl --user mask sfab-kiosk.service`
first and unmask when done. A disabled-but-unmasked unit still comes back, because the
labwc autostart hook starts it explicitly.

### Stopping the edge service — corrected

**An earlier version of this section was wrong, in two ways at once, and the wrong version
had been copied into `sfab-edge.service` and `edge/server.mjs` as well.** It claimed that
`server.close()` waits for Chromium's idle keep-alive sockets, so stopping the service
always burns the full `TimeoutStopSec`; and it claimed `edge/server.mjs` does not call
`closeIdleConnections()`. The second half was checkable in ten seconds and false — that
call is right there in `stop()`, and always was.

Measured on node v26.8.2 against this server, rather than reasoned about:

| What is held open when `close()` is called | Time for `close()` to resolve |
|---|---|
| One idle keep-alive socket, **no** `closeIdleConnections()` | **0.2 ms** |
| One idle keep-alive socket, **with** `closeIdleConnections()` | 0.0 ms |
| A socket mid-request (control — proves the probe can show a stall) | did not resolve inside 10 s |
| An in-flight `POST /api/command`, 3 s stubbed, `Connection: close` | 2808 ms (the remaining command time) |
| The same over a keep-alive agent | 6811 ms (command time **plus** the 5 s `keepAliveTimeout` tail) |

So:

- **You do not need to stop the kiosk first.** With no command in flight, `systemctl stop
  sfab-edge` returns in milliseconds whether or not Chromium is running.
- What genuinely delays a stop is **an in-flight request**, and the longest legitimate one
  is a drawer command — up to 123 s, because `controller.mjs` accepts any firmware ACK
  budget to 120 s and adds 3 s. Add ~1.5 s for the `/status` fetch and up to 5 s of
  keep-alive tail for the socket that goes idle only after the response
  (`closeIdleConnections()` fires once, at stop time, so it cannot catch that one).
- `TimeoutStopSec` is therefore **150 s**, raised from 45 s, which covered only the
  provisional 30 s bench budget. The reasoning is written out in `sfab-edge.service`.

The thing worth not losing: a SIGKILL mid-command leaves a `pending` row that the next
start rewrites to `uncertain`, and an uncertain row now takes the cabinet **out of
service** until an operator clears it (next section). That is the failure the stop budget
is sized to avoid — and note that the false belief above is what made the correct budget
look unaffordable, since a 150 s timeout would have been intolerable if every routine stop
really did wait it out.

Stopping deliberately while a dispense is running is still worth avoiding: you will wait,
and interrupting it is exactly what creates the hold.

### Clearing an unresolved command — the operator recovery path

A command that was sent to the cabinet but never confirmed is recorded as
`state='uncertain'`. Nobody knows what the hardware did: the drawer may be open, the
stepper may be halfway, supplies may or may not have come out. From that moment the edge
service **refuses every new drawer-open** with HTTP 409 until a human resolves it. The
buzzer is deliberately still allowed — calling for help must never be gated on a stuck
drawer.

This is a durable hold, not a UI state. It survives a page reload, the done-screen
countdown, a new student, a browser restart and a reboot, because the per-command-ID
replay guard cannot see that a *new* ID refers to the *same* unreconciled physical
operation.

**Physically inspect the cabinet before clearing. This step is the entire point.**
Is the drawer shut? Is anything jammed in the slide? Where is the stepper sitting? Did
supplies actually come out? Clearing the hold tells the system a human has looked; if
nobody looked, the next command can drive a mechanism that is not where it is assumed to
be. Nothing in software can check this for you.

```sh
ssh technology@<pi-tailscale-name>
cd /opt/smart-first-aid-box

# What is held, and since when
sudo -u sfab SFAB_DATABASE=/var/lib/sfab/commands.sqlite node edge/resolve.mjs --list

# After looking at the cabinet with your own eyes:
sudo -u sfab SFAB_DATABASE=/var/lib/sfab/commands.sqlite \
     node edge/resolve.mjs --check-cabinet <command-id>
```

`SFAB_DATABASE` must be passed explicitly: the CLI defaults to
`~/.local/share/smart-first-aid-box/commands.sqlite`, while the service is configured to
`/var/lib/sfab/commands.sqlite`. Run it as `sfab` so the journal and its `-wal`/`-shm`
files keep their ownership. `--list` opens the database read-only.

The row is set to `state='resolved_by_operator'` and kept, never deleted: the record of
what happened and when it was cleared is the point of a journal.

**Why there is no button for this.** The only HTTP client of this service is the
touchscreen a student is standing at. An endpoint that cleared the hold would be reachable
from that screen, and a hold a student can clear is not a hold — it is a dialog in the way
of getting supplies. Requiring SSH means clearing it requires the same person who can walk
to the cabinet. The long flag name `--check-cabinet` is chosen so it cannot be typed
without reading it.

### Hang recovery — what is covered, and what is still unfinished

**`Restart=always` and `Restart=on-failure` are not hang recovery.** They restart a
process that **exits**. A process that is alive, holding its port, and never answering
looks perfectly healthy to systemd: the unit is `active`, nothing has failed, nothing
restarts, and the cabinet is dead. Anywhere this directory previously implied otherwise is
wrong; the restart lines cover crashes, `Alt+F4`, `Ctrl+W` and bad flags, which is
genuinely most of what happens, but it is a different failure class.

**Covered now — the edge service.** `sfab-edge-watchdog.timer` fires
`bin/sfab-edge-healthcheck.sh` every 30 s. It performs a real HTTP `GET
/api/local/status` with a 5 s budget and checks the **body**, not just the status code,
then restarts `sfab-edge.service` after **3 consecutive** failures. It acts only when
systemd reports the unit `active` — a service an operator stopped for maintenance, or one
already in `failed`, is left alone.

The probe logic was exercised locally against four servers before shipping (not on a Pi):
a real `createLocalServer` (passes, no strikes), a **hung** server that accepts the
connection and never responds (three strikes, then restarts — this is the case
`Restart=` cannot see), an impostor answering `200` with a different body (fails, which is
why the body is checked), and a dead port (fails). Recovery clears the strike count.

What it **cannot** detect, stated so nobody reads a green timer as a healthy cabinet:

- **A dead ESP32.** `controller.status()` catches its own fetch errors and returns HTTP
  200 with `connected:false`. A cabinet that cannot open a drawer at all probes green.
  This watches the service, not the cabinet.
- **A partial wedge** that still serves `GET /api/local/status` but hangs
  `POST /api/command`. The probe is a GET and must stay one — a watchdog that sent
  commands would move motors.
- **Slow versus hung.** Only the 5 s budget and the 3 strikes separate them.
- Worst case it is **~4 minutes** from wedge to recovery: up to 90 s to decide, plus up
  to the 150 s `TimeoutStopSec` while SIGTERM is tried before systemd escalates. Those two
  numbers pull against each other on purpose; see the timer file.

**NOT covered — a wedged browser. This is unfinished D-phase work.** Nothing here watches
Chromium's liveness. A renderer that has locked up — frozen page, last frame still on
screen, process alive and not exiting — is invisible to `Restart=always`, to the labwc
session, and to the edge watchdog, which never looks at the browser. The cabinet would
show a normal-looking screen that does not respond to touch, and no mechanism in this
directory would notice or fix it. Today the only recovery is a human: touch it, see
nothing happen, and `systemctl --user restart sfab-kiosk.service` over SSH.

Closing it properly needs a liveness signal **from inside the page** — the kiosk
periodically telling the edge service it is still running its own event loop, with a
server-side staleness check restarting the browser. That means changes in `js/`, which is
outside this directory's scope, and it is the honest reason it is not here. Do not paper
over it by pointing at `Restart=always`; a hung renderer never exits.

### If you are locked out of the screen entirely

SSH is the only remaining path — which is why step 1 of the install is proving it works,
and why the VT-switching remedy in `labwc-kiosk/README.md` should be applied last, if at
all. If SSH is also gone, the recovery is physical: power off, pull the SD card, and
restore `~/.config/labwc/` from the backup on another machine.

---

## Verify on the device — the unverified list

Every row is currently **UNVERIFIED**. One line per thing, with how to check it and what
a real pass looks like. Do not mark a row green from a screenshot of something adjacent.

### Display and touch

| # | What | How to check | Pass looks like |
|---|---|---|---|
| 1 | Backup exists **off** the Pi | `ls` the copy on the Mac | `labwc/rc.xml` present in it and contains the calibration matrix |
| 2 | Output mode is 800x480 | `wlr-randr` | The panel's native mode, not the 1024x768 fallback the prior session recorded |
| 3 | Touch calibration survived the session change | Tap all four corners **and the centre** after installing the merged `rc.xml` and rebooting | The pointer lands under the finger in all five places. Corner-only checks pass on matrices that are wrong in the middle |
| 4 | Calibration vs. resolution question settled | Compare the mode from row 2 with `"screen": [1024,768]` in `touch-calibration-measured.json` | An explicit decision recorded: carried over, or re-measured. Not "it seemed fine" |
| 5 | Screen blanking is off | Leave the cabinet untouched longer than the previous blank timeout | Screen still lit and responsive to the first tap |
| 6 | Mouse pointer visibility acceptable | Look at the screen after a tap | Decision recorded — a pointer parked mid-screen is expected with `mouseEmulation=yes`; no fix is shipped here |

### Services

| # | What | How to check | Pass looks like |
|---|---|---|---|
| 7 | Node path and version match the unit | `command -v node`, `node --version` | `/usr/bin/node`, v24 or newer. On Node 22.x, `node:sqlite` needs `--experimental-sqlite` and the unit as written would fail |
| 8 | Unit syntax and hardening | `sudo systemd-analyze verify sfab-edge.service` | No errors. If Node fails to start, comment out `SystemCallFilter` first — it is the most likely hardening line to bite |
| 9 | `/var/lib/sfab` is writable under the hardening | Issue one real command, then `sudo ls -la /var/lib/sfab` | `commands.sqlite`, `-wal` and `-shm` present and owned by `sfab`. WAL needs the **directory** writable, not just the file |
| 10 | Journald is not chewing the SD card | `journalctl --disk-usage`, and again after a day | Bounded. If it grows fast, cap it with `SystemMaxUse=` in `/etc/systemd/journald.conf` |
| 11 | ESP32 URL accepted | `journalctl -u sfab-edge -n 30` | No `Use an HTTP ESP32 origin` throw — the URL must be a bare `http://` origin |

### Browser

| # | What | How to check | Pass looks like |
|---|---|---|---|
| 12 | Chromium binary name is right | `ls -l /usr/bin/chromium*` | Matches what `sfab-kiosk-run.sh` finds |
| 13 | Nothing injects `--no-sandbox` | `grep -rn no-sandbox /etc/chromium.d` and `chrome://version` | Absent. Its presence voids the browser sandbox for a page that drives a motor |
| 14 | The right policy directory is loaded | `chrome://policy` (see the temporary-allowlist procedure in `chromium-policies.notes.md`) | Source "Platform", **zero** key errors, and `VideoCaptureAllowedUrls` showing the origin the browser is on |
| 14b | The **narrowed** `URLAllowlist` did not break the page | Load `/kiosk` and look at it | Fully styled, Thai text in IBM Plex (not a fallback), images present, hardware status updating. Unstyled or image-less ⇒ this build filters subresources as well as navigations, the asset entries are load-bearing, and anything missing from them is now a real break |
| 14c | The old pages are actually unreachable | With a keyboard, try `http://localhost:8787/dashboard` and `http://localhost:8787/student/wound-scan` | Both blocked. `student/wound-scan.html:113` is the `<input type="file">` this narrowing exists to put out of reach |
| 14d | …but the mode and stock can still be provisioned | Follow the temporary-unlock procedure in `chromium-policies.notes.md`, set the mode, remove the entry again | Dashboard reachable during the unlock only, mode persists afterwards. **Settle this before go-live**: with the policy as shipped a teacher cannot reach stock management unaided. Record which option you chose |
| 15 | `--ozone-platform=wayland` works on this build | Start the unit and watch the journal | Window appears. If not, comment the flag out — it is the most likely launch failure |
| 16 | Camera permission is actually granted | Open the scan view on the cabinet | Live preview with **no prompt**. A prompt means the policy did not match the origin; a fallback message means the camera or driver, not the permission |
| 17 | Camera **fallback** works | Unplug the camera, open the scan view | The manual wound-selection path is offered and usable. A degraded cabinet, not a dead one |
| 18 | Microphone stays denied | Same view | No microphone indicator. The app asks for `audio:false`; `AudioCaptureAllowed:false` is the backstop |
| 19 | Medicine stock survives restarts | Note a stock count, `systemctl --user restart sfab-kiosk`, look again | Identical count. A reset to defaults means the profile is being wiped — find it before going live |

### Escapes — with a keyboard plugged in

| # | Key | Expected | Notes |
|---|---|---|---|
| 20 | `Esc` | Nothing | `--kiosk` should not exit on Esc |
| 21 | `F11` | Nothing visible | Already fullscreen |
| 22 | `Alt+F4` | Window closes, **returns within ~3s** | Prevention is not possible; `Restart=always` is the answer. Time it |
| 23 | `Super` | Nothing | No launcher, no panel — the labwc `<keyboard>` block is empty |
| 24 | `Ctrl+L` | Nothing | No omnibox exists under `--kiosk` |
| 25 | `Ctrl+W` / `Ctrl+Shift+Q` | Closes, returns within ~3s | Same as row 22; test explicitly, it is the likeliest accidental exit |
| 26 | `Ctrl+Alt+F2` | **Expected to still reach a console** | Kernel/logind, not the compositor. Closed only by the `NAutoVTs`/getty-masking remedy in `labwc-kiosk/README.md`. Record which state you chose |
| 27 | `F12` / `Ctrl+Shift+I` | Nothing | `DeveloperToolsAvailability: 2` |
| 28 | Long-press / right-click on screen | No menu | Both `menu.xml` and the empty `<mouse>` block must hold |
| 29 | **labwc's empty-`<keyboard>` assumption** | Try `Alt+Tab` and any terminal binding | Nothing happens. If they still work, labwc fell back to defaults and **none** of rows 20–25 mean what they appear to |

### Recovery

| # | What | How to check | Pass looks like |
|---|---|---|---|
| 30 | Browser **exit** recovery | `pkill -f chromium` | Kiosk page back within a few seconds, on `/kiosk`, not on a restore bubble. This tests an exit, not a hang — row 48 is the hang, and it is not recovered |
| 31 | Edge **exit** recovery | `sudo systemctl kill -s SIGKILL sfab-edge` | Service back within `RestartSec`; the open page recovers on its next poll without being reloaded. Again an exit — row 44 is the hang |
| 32 | Crash-loop containment | Break the config deliberately, e.g. a bad `SFAB_ESP32_URL`, and watch | Gives up after 5 starts in 300s and stays failed, rather than restarting forever onto the SD card. Then put the config back |
| 33 | Reboot 1, 2 and 3 | `sudo reboot`, three times, waiting for full boot each time | All three land on the kiosk unattended. Three because boot-order races show up intermittently, and one success proves nothing |
| 34 | Boot wait-loop behaviour | `journalctl --user -u sfab-kiosk -b` after a reboot | `sfab-wait-for-edge` reports the wait in seconds and exits 0. If it ever hits 60 attempts, the budget is too tight for this Pi |
| 35 | **SSH from Bank's Mac still works after lockdown** | From the Mac, after the final reboot: `ssh technology@<pi> 'uptime'` | A shell. Check this **last, and again after any VT/getty hardening** — that is exactly the change that can strand the device |

### Operating mode, the unresolved hold, and the watchdog — all UNVERIFIED

| # | What | How to check | Pass looks like |
|---|---|---|---|
| 36 | **A freshly imaged Pi refuses to actuate until a teacher picks a mode.** This is intended behaviour, not a fault — do not "fix" it | On a new profile, before touching the dashboard, run a treatment through to "รับอุปกรณ์" | No motor, no network command. The UI reports the cabinet has no operating mode set. `mode:'unprovisioned'` with `retrySafe:true` — nothing was sent, so it is safe to set the mode and retry. **A cabinet that dispenses here is the bug** |
| 37 | Picking a mode provisions it, and it sticks | In the dashboard choose Demo or Real, then restart the browser | The choice survives. It is the `modeProvisionedAt` stamp, not the boolean, that makes the mode "chosen" — an old profile carrying `demoMode:true` from the previous default is treated as unset until someone re-picks, deliberately |
| 38 | Real mode actuates, Demo mode does not | Set Real, run one treatment; set Demo, run another | Real moves a motor and writes a journal row. Demo does neither. Note the asymmetry: **calling a teacher over LINE is still attempted when the mode is unset** — the fail-closed rule covers actuation, not asking a human for help |
| 39 | An uncertain command really does block the next open | Create one (interrupt a dispense, e.g. cut ESP32 power mid-command), then try another treatment | The second open is refused with 409 and a message naming the held drawer. **The buzzer / เรียกครู must still work** — verify that explicitly, it is the whole reason the hold excludes it |
| 40 | The hold survives everything a student can do | After creating it: reload the page, let the done-screen countdown run out, restart the browser, reboot the Pi | Still held every time. A hold that a reload clears is not a hold |
| 41 | The operator path clears it | `node edge/resolve.mjs --list`, physically inspect the cabinet, then `--check-cabinet <id>` | `--list` names the id, drawer and time. After clearing, opens work again. Check `state='resolved_by_operator'` in the journal — the row must still exist, not be deleted |
| 42 | There is genuinely no HTTP route to clear it | From the kiosk browser and with `curl`, try to find one | Nothing clears the hold over HTTP. If a future change adds one, the hold stops being a hold |
| 43 | The watchdog agrees with a healthy service | `sudo /usr/local/lib/sfab/sfab-edge-healthcheck.sh --dry-run` while everything is up | Exit 0, no strike recorded. **Run this first**: a probe that cannot pass makes every failure below meaningless |
| 44 | The watchdog catches a real **hang**, not just an exit | `sudo systemctl kill -s SIGSTOP sfab-edge` (alive, holding the port, not answering), then watch `journalctl -u sfab-edge-watchdog -f`. Undo with SIGCONT if you stop the test early | Three strikes logged ~30 s apart, then a restart. This is the case `Restart=on-failure` cannot see, so it is the row that decides whether the watchdog was worth adding |
| 45 | The watchdog leaves a deliberately stopped service alone | `sudo systemctl stop sfab-edge`, wait two minutes | No restart, and the journal says it is not the watchdog's job. A watchdog that undoes a maintenance stop is worse than none |
| 46 | The watchdog does not flap | Leave it armed for a day of normal use | Zero restarts in `journalctl -u sfab-edge-watchdog`. Any restart of a service that was actually healthy means the budget or the strike count is wrong — raise it, do not disable the probe |
| 47 | A restart-storm still parks the unit | While the watchdog is armed, keep the service wedged | After a few rounds `sfab-edge` stays `failed` (StartLimitBurst=5/300s) instead of restarting forever onto the SD card. Dark cabinet until `systemctl reset-failed` — confirm that is the trade you want |
| 48 | **The browser-hang gap is real** — confirm it rather than assume it | `sudo kill -SIGSTOP $(pgrep -f 'chromium.*--kiosk' \| head -1)`, then try to use the screen | The page stays on screen and ignores touch, and **nothing recovers it**: not `Restart=always`, not the edge watchdog. Recovery is `systemctl --user restart sfab-kiosk.service` by hand. Record the observed behaviour — this is the known unfinished piece, and it should be confirmed, not discovered by a student |

### Hardware acceptance — unchanged and still outstanding

The physical checks in `docs/PI_LOCAL_SETUP.md` ("Validation and physical acceptance")
are **not** superseded by anything here, and this directory closes none of them. In
particular the OPEN-to-DONE bench measurement and the ACK-budget configuration remain
open. A kiosk that boots reliably into a page is not a cabinet that has been proven to
dispense safely.

---

## Open items, stated rather than hidden

1. **The 1024x768 / 800x480 calibration question** (rows 2–4). Unresolved. Do not guess.
2. **labwc element names** — `windowRule` attributes, the `<openbox_menu>` root element,
   and above all whether an empty `<keyboard>` means "no bindings". Row 29 is the one
   that decides whether the lockdown is real.
3. **Which Chromium policy directory this package reads.** Both are installed; one must
   be removed after `chrome://policy` says which won.
4. **`--ozone-platform=wayland`** may or may not be right for this Chromium build.
5. **The pointer stays visible** with `mouseEmulation=yes`. No fix shipped; see
   `labwc-kiosk/environment` for why the usual answers do not apply.
6. ~~**Stopping `sfab-edge` while Chromium runs takes the full 45s timeout.**~~
   **WITHDRAWN — this was false.** Measured on node v26.8.2: `close()` with an idle
   keep-alive socket held open resolves in 0.2 ms, and `edge/server.mjs` was already
   calling `closeIdleConnections()`, which the same item claimed it did not. There was
   never a procedure to follow here. See "Stopping the edge service — corrected".
   Kept rather than deleted because it was repeated in three files and someone may still
   be carrying the wrong version in their head.
7. **`TimeoutStopSec=150` is derived, not measured on this cabinet.** It comes from the
   supported maximum (`ackTimeoutMs` ≤ 120 s, +3 s, +~1.5 s status, +5 s keep-alive tail).
   Once the bench measurement in `docs/PI_LOCAL_SETUP.md` fixes the real ACK budget, this
   can come down to match it — and should, because it is also the watchdog's worst-case
   recovery time.
8. **Browser hang recovery does not exist.** The edge watchdog covers the service only.
   A wedged renderer needs a liveness signal from inside the page, which means changes in
   `js/`. Stated in "Hang recovery"; row 48 confirms the gap on the device.
9. **The narrowed `URLAllowlist` blocks the teacher dashboard**, which is where the
   operating mode and the medicine stock are set — and both live in that Chromium
   profile's `localStorage`, so no other device can do it. Shipped locked, with a
   temporary-unlock procedure in `chromium-policies.notes.md`. Rows 14c/14d. **This one
   needs a decision before go-live, not a checkbox.**
10. **Whether this Chromium filters subresources or only navigations** (row 14b). The
   asset entries in the allowlist are written to be correct either way, but which it is
   decides whether they are documentation or load-bearing.
