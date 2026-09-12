# labwc kiosk session — what it closes, and what it does not

STATUS (2026-09-12): `rc.xml` here **is the deployed file** (touch calibration + 20 None binds +
Ctrl+Alt+K/R operator exit/return), verified on the cabinet with wtype. The rest of this README
still describes the original never-applied plan. Original status line kept below for history:

STATUS: **NEVER APPLIED, NEVER TESTED ON HARDWARE.** Nothing in this directory has been
parsed by labwc, and no escape listed below has been attempted on the device. Treat every
"closed" claim here as a claim to be tested, not a result.

Files, and where each one goes on the Pi:

| File | Install path | Closes |
|---|---|---|
| `rc.xml` | `~/.config/labwc/rc.xml` | keybindings (terminal, close-window, minimise, workspace switch, window switcher, window menu), decorations |
| `menu.xml` | `~/.config/labwc/menu.xml` | root menu and client menu contents |
| `autostart` | `~/.config/labwc/autostart` | panel, desktop icons, launcher — and starts the kiosk unit |
| `environment` | `~/.config/labwc/environment` | session-wide env (kept near-empty on purpose) |

**`rc.xml` must be merged, not copied.** It has a marked slot where the existing
touchscreen calibration has to be transplanted. Read the banner at the top of that file
before touching anything.

Reload after editing, using the compositor's real PID — a plain `labwc --reconfigure`
reports "LABWC_PID not set" and silently does nothing:

```sh
LABWC_PID=$(pidof labwc) labwc --reconfigure
```

---

## What this configuration does NOT close

A compositor can only govern what the compositor owns. Everything below is outside that
boundary, and each needs its own, separate remedy. None of these remedies are applied by
anything in this repo.

### 1. VT switching — Ctrl+Alt+F1 … Ctrl+Alt+F6

**Not a compositor concern.** Virtual-terminal switching is handled by the kernel and
`systemd-logind`, below and outside labwc. labwc never sees the key combination, so no
`rc.xml` setting can intercept it. A student with a keyboard lands on a text console with
a login prompt.

Separate remedy — give logind no other VTs to switch to, in `/etc/systemd/logind.conf`:

```ini
[Login]
NAutoVTs=0
ReserveVT=0
```

then mask the getty units so nothing offers a login on them:

```sh
sudo systemctl mask getty@tty1.service getty@tty2.service getty@tty3.service
sudo systemctl mask getty@tty4.service getty@tty5.service getty@tty6.service
```

Apply this **only after** SSH has been proven to work, and understand what you are
giving up: with no VTs and no getty, a Pi that fails to bring up the network has no local
console left. That is a real trade, not a free win. Verify with a physical keyboard that
Ctrl+Alt+F2 no longer reaches a prompt.

### 2. Magic SysRq — Alt+SysRq+<key>

**Kernel.** Can reboot or kill processes regardless of anything in userspace.

Separate remedy: `kernel.sysrq=0` in `/etc/sysctl.d/99-sfab-kiosk.conf`, then
`sudo sysctl --system`. Verify by reading `/proc/sys/kernel/sysrq`.

### 3. Ctrl+Alt+Del and the power button

**logind, not the compositor.**

Separate remedy: `sudo systemctl mask ctrl-alt-del.target`, and in
`/etc/systemd/logind.conf` set `HandlePowerKey=ignore`. Note the physical power button on
the Pi 5 also performs a hard power-off when held — that is firmware, and no software
setting removes it. The answer to that one is the cabinet lock.

### 4. Chromium's own keyboard shortcuts

**The browser owns these, not labwc, and not the managed policy either.** Chromium's
internal accelerators are processed inside the browser process. Ctrl+W, Ctrl+Shift+W,
Ctrl+Shift+Q and Alt+F4 can close the kiosk window; `--kiosk` removes the UI, not the
key handling. There is no policy key that rebinds or removes accelerators.

Separate remedy: **recovery, not prevention.** `sfab-kiosk.service` sets
`Restart=always` with `RestartSec=3`, so a closed window comes back in about three
seconds. Verify by closing it deliberately with a keyboard and timing the return. Accept
that a three-second black screen is the best available outcome here.

Ctrl+Shift+I and F12 *are* closed, by `DeveloperToolsAvailability: 2` in the managed
policy — that one is a policy, not an accelerator rebinding.

### 5. A USB keyboard or mouse plugged into the cabinet

Every escape above needs a keyboard, and the cabinet does not normally have one. That
makes physical access the actual control: an unlocked USB port is equivalent to all of
the remedies above being off.

Separate remedy: the enclosure lock, and blanked or internally-routed USB ports. A
software option exists (`usbguard`, or a udev rule that refuses new HID devices) but it
locks *you* out too, during maintenance, and on a device that is already physically
inside a locked cabinet it mostly buys inconvenience. Decide deliberately; do not add it
reflexively.

### 6. Booting something else

Holding shift, an SD card swap, or a USB boot bypasses all of this. The remedy is the
cabinet lock and physical control of the SD card slot, not configuration.

---

## Honest summary

This configuration closes the **touch-only** escapes: no panel, no desktop icons, no
launcher, no menus, no window keybindings. That is the threat that actually matters here,
because a student standing at the cabinet has a single-touch resistive panel and nothing
else.

It does **not** close keyboard-based escapes, and several of them cannot be closed from a
compositor at all. The layered answer is: the items above for software, the cabinet lock
for hardware, and `Restart=always` for the ones that can only be recovered from rather
than prevented.
