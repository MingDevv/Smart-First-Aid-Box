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

The only thing verified is that `chromium-policies.json` is syntactically valid JSON.
Treat this directory as a reviewed proposal. The checklist at the bottom is the work
that still has to happen on the device, and until it is done, the honest description of
this cabinet's lockdown is "designed, not deployed".

---

## What it deploys

```
boot
 └─ sfab-edge.service        (system unit, user sfab)
      node edge/server.mjs → listens 127.0.0.1:8787 → ESP32 over private LAN
      journal: /var/lib/sfab/commands.sqlite  (anti-replay, WAL)

login (autologin, user technology)
 └─ labwc session            (no panel, no desktop, no menus, no keybinds)
      └─ ~/.config/labwc/autostart
           └─ sfab-kiosk.service   (USER unit)
                ExecStartPre: wait until 127.0.0.1:8787/kiosk answers
                ExecStart:    chromium --kiosk http://localhost:8787/kiosk
                              + /etc/chromium/policies/managed/sfab-kiosk.json
```

| File here | Goes to | Owner/mode |
|---|---|---|
| `sfab-edge.service` | `/etc/systemd/system/sfab-edge.service` | root:root 0644 |
| `sfab-kiosk.service` | `/home/technology/.config/systemd/user/sfab-kiosk.service` | technology 0644 |
| `bin/sfab-wait-for-edge.sh` | `/usr/local/lib/sfab/sfab-wait-for-edge.sh` | root:root 0755 |
| `bin/sfab-kiosk-run.sh` | `/usr/local/lib/sfab/sfab-kiosk-run.sh` | root:root 0755 |
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
sudo install -o root -g root -m 0644 chromium-kiosk-flags.conf /etc/sfab/
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

**Edge service**:
```sh
sudo systemctl disable --now sfab-edge.service
sudo rm /etc/systemd/system/sfab-edge.service
sudo systemctl daemon-reload
```
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

### Stopping the edge service: stop the kiosk first

`server.close()` waits for open connections, and `edge/server.mjs` does not call
`closeIdleConnections()`. Chromium holds keep-alive sockets to it. So with the browser
running, `systemctl stop sfab-edge` will sit there until `TimeoutStopSec=45` expires and
systemd sends SIGKILL — which can interrupt a command mid-flight and leave a `pending`
row that the next start rewrites to `uncertain`. That row is then locked out, by design.

Stop the kiosk first and the edge service stops in a second or two.

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
| 30 | Browser crash recovery | `pkill -f chromium` | Kiosk page back within a few seconds, on `/kiosk`, not on a restore bubble |
| 31 | Edge crash recovery | `sudo systemctl kill -s SIGKILL sfab-edge` | Service back within `RestartSec`; the open page recovers on its next poll without being reloaded |
| 32 | Crash-loop containment | Break the config deliberately, e.g. a bad `SFAB_ESP32_URL`, and watch | Gives up after 5 starts in 300s and stays failed, rather than restarting forever onto the SD card. Then put the config back |
| 33 | Reboot 1, 2 and 3 | `sudo reboot`, three times, waiting for full boot each time | All three land on the kiosk unattended. Three because boot-order races show up intermittently, and one success proves nothing |
| 34 | Boot wait-loop behaviour | `journalctl --user -u sfab-kiosk -b` after a reboot | `sfab-wait-for-edge` reports the wait in seconds and exits 0. If it ever hits 60 attempts, the budget is too tight for this Pi |
| 35 | **SSH from Bank's Mac still works after lockdown** | From the Mac, after the final reboot: `ssh technology@<pi> 'uptime'` | A shell. Check this **last, and again after any VT/getty hardening** — that is exactly the change that can strand the device |

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
6. **Stopping `sfab-edge` while Chromium runs takes the full 45s timeout.** Documented
   as a procedure (stop the kiosk first) rather than patched, because the fix belongs in
   `edge/server.mjs`, which is out of scope here.
