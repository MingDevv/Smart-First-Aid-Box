# micro:bit V1.5 firmware — build, flash, verify

`main.py` is MicroPython (bbcmicrobit/micropython **v1.1.1**, the V1 runtime). It is not MakeCode
any more — the last MakeCode revision is git `2a1de19`, and the students' 2026-09-12 MakeCode build
is kept as a raw flash+UICR dump outside the repo (see wiki `smart-first-aid-box` §7).

## Build (Mac, once per change)

```bash
# needs: uflash 1.3.0, intelhex (a venv with both exists at harness-audits/sfab-usb-v1-20260910/venv)
python3 - <<'PY'
import uflash
runtime = open('micropython-microbit-v1.1.1.hex').read()          # official v1.1.1 release hex
hx = uflash.embed_hex(runtime, uflash.hexlify(open('microbit/main.py','rb').read()))
for n, line in enumerate(hx.splitlines(), 1):                   # refuse a hex DAPLink would half-write
    raw = bytes.fromhex(line[1:]); assert line[0] == ':' and sum(raw) & 0xFF == 0 and raw[3] in (0,1,4,5), n
open('sfab-v1-usb.hex', 'w').write(hx)
PY
```

`embed_hex()` takes the **hexlified** script. Raw source produces a hex that DAPLink partially
writes before failing on the first bad checksum (`FAIL.TXT`) — measured 2026-09-12. Back up first.

## Flash (from the Pi, board on USB)

```bash
openocd -f interface/cmsis-dap.cfg -c "transport select swd" -f target/nrf51.cfg -c init -c halt \
  -c "dump_image before-flash.bin 0x0 0x40000" -c "dump_image before-uicr.bin 0x10001000 0x100" -c resume -c shutdown
# Resolve the mount — do NOT hardcode /media/technology/MICROBIT. udisks appends a digit when a
# stale mountpoint from an earlier session is still there, and the stale one is root-owned 0700,
# so a hardcoded path fails with "Permission denied" while the real board sits at MICROBIT2.
# (Cost 2026-09-14: a flash that looked like a permissions problem and was a wrong path.)
M=$(lsblk -no LABEL,MOUNTPOINT | awk '$1=="MICROBIT"{print $2}' | head -1); echo "$M"
cp sfab-v1-usb.hex "$M/SFAB.HEX" && sync -f "$M"
sleep 6; ls "$M"        # FAIL.TXT here = it did not take; restore from the dump.
                        # "No such file or directory" right after the copy is NORMAL — DAPLink
                        # reboots and re-enumerates; wait and re-resolve $M before concluding.
```

## Verify (sends nothing)

```bash
stty -F /dev/ttyACM0 115200 raw -echo; timeout 3 cat /dev/ttyACM0     # expect READY:<epoch> every 500 ms
```

`READY:<epoch>` alone does NOT prove the new build took — the old firmware says exactly the same
thing, and `dump_image` during the pre-flash backup resets the board so the epoch is 1 either way.
MicroPython stores the script as plain text in flash, so dump it back and grep for an identifier
that only the new code has, with the pre-flash dump as the control:

```bash
openocd -f interface/cmsis-dap.cfg -c "transport select swd" -f target/nrf51.cfg -c init -c halt \
  -c "dump_image after-flash.bin 0x0 0x40000" -c resume -c shutdown
strings after-flash.bin  | grep -c service_buzzer     # new build: > 0
strings before-flash.bin | grep -c service_buzzer     # control: must be 0
```

Then `systemctl --user restart sfab-edge` and `curl -s localhost:8787/api/local/status` must show
`"connected":true,"ready":true,"configured":true`.

## Contract

Frames are unchanged from the ESP32 era (`READY:<epoch>`/`BUSY`, `OPEN<d>:<id>:<epoch>` →
`DONE<d>:<id>`/`REJECT:<id>`, `BUZZ<1|0>:<id>` → `BUZZ_DONE<1|0>:<id>`), plus `REMOTE_SOS:<id>`
which the board sends on its own; the Pi speaks them through `edge/microbit-serial.mjs`. Pin map
and motor constants are in `main.py`'s header. `tests/microbit_protocol_test.py` executes the real
functions with stubs.

**Why the rewrite** (2026-09-12): the ESP32 is gone, the Pi drives the board over USB, and
MicroPython is what we can build, flash and verify from the Pi end to end. The last MakeCode
revision is git `2a1de19`, preserved as a raw dump in
`harness-audits/sfab-nema-v1-20260912/live-20260912-*.bin`.

**Why the buzzer timer lives on the board, not on the Pi**: `BUZZ1` used to play
`music.pitch(..., -1)` = forever, and the only stop button was the teacher page on Vercel, which
requires a login. If nobody could log in, nobody at the cabinet could stop it. The countdown has to
survive the Pi dying mid-alarm, so it belongs to the board. `BUZZ0` still stops it at once, and a
fresh `BUZZ1` restarts the window. A `BUZZ_DONE` ACK therefore means "command received", never
"sound finished".

## `remote.py` — wireless SOS button and buzzer repeater (2026-09-17)

A second micro:bit V1 carried to the football field or activity yard.

| direction | what happens |
|---|---|
| button A pressed | sends `SFAB1:SOS:<seq>` ×5 → cabinet buzzes and emits `REMOTE_SOS:<id>` → Pi journals an SOS → LINE reaches the school nurse |
| cabinet buzzing | cabinet broadcasts `SFAB1:B1` every 400 ms → remote buzzes along; `SFAB1:B0` ×3 on stop → both go quiet together |

The beacon means "still ringing", not "switch on". If the off packet is lost, the cabinet dies, or
the remote walks out of range, the remote falls silent by itself after `HOLD_MS` (1500 ms). There is
no state in which the remote can be stuck ringing.

Radio group 91 keeps us off other traffic; the `SFAB1:` payload prefix is the part that matters at a
competition, where other teams' micro:bits may sit on the same group — without it, a stranger's
packet could sound our alarm.

⚠️ **The remote's buzzer is on P3, which is also an LED-matrix column pin.** While the display is
on, the matrix scan drives P3 and a piezo there screams continuously with nobody having asked for a
sound (measured 2026-09-17 — `music.stop(pin3)` itself fails with `ValueError: Pin 3 in display
mode`). `remote.py` therefore calls `display.off()` at boot and never turns it back on, so the board
shows nothing. Moving the buzzer to P0, P1 or P2 would give the display back.

## Tray sensor — proving the item actually fell (2026-09-17)

`DONE<d>:<id>` only ever proved that the motor finished its 200 steps. An HC-SR04 fires across the
collection tray, about 3 cm above its floor, so a falling item breaks the beam on its way down.

| pin | role |
|---|---|
| P10 | TRIG |
| P9 | ECHO — **through a 1 kΩ + 2 kΩ divider**; the module drives 5 V and the pin takes 3.3 V |

Both are LED-matrix column pins, so `main.py` calls `display.off()` at boot and never turns the
display back on. Nothing is lost in practice: the board sits at the bottom of the cabinet where
nobody can see a 5×5 matrix. Without that call the sensor reads garbage and `music.stop` on a
display pin raises `ValueError: Pin N in display mode`.

**Why sampling fast is safe, and why it does not slow the motor.** Measured on this board with a
probe build on 2026-09-17: three `write_digital` calls cost **340 µs**, and `time_pulse_us` adds
its timeout plus ~84 µs (single timeout, not double — a 1000 µs and a 3000 µs run differed by
exactly 1996 µs). With the sensor answering at ~1.5 ms across a 25 cm tray, one reading costs about
**2.3 ms**. A step already sleeps 5 ms, so `motor_run` pings and then sleeps `STEP_MS - 2`: step
timing is unchanged and the firmware gets 200 free readings while the spiral turns, plus
`WATCH_MS` (1500 ms) more after it stops in case an item hangs on the coil.

An item falling ~18 cm crosses the beam at ~1.9 m/s, so even a box landing on its 1.5 cm edge sits
in the beam for ~8 ms — at least three readings.

**Frames.** `BASE:<id>` measures the empty tray and answers `BASE:<id>:<mm>`; the Pi writes it
immediately before `OPEN<d>`, and the board processes frames in arrival order, so no waiting is
needed. Measuring fresh every round is what stops an item left in the tray from last time being
counted as this round's. After the motor and the watch window, the board sends
`DROP:<id>:<nearest mm>:<blocked readings>` **before** `DONE<d>:<id>`.

`DROP` is a separate frame on purpose: `DONE` keeps its old shape, every existing test and the
Pi-side parser are untouched, and a board without this firmware simply never sends `DROP` — which
the Pi reads as "not checked", not as "nothing fell".

**Three states, never a boolean** (`dropVerdict` in `edge/microbit-serial.mjs`): two or more
blocked readings is `confirmed`; fewer is `not_found`; and a sensor that never echoed at all, or a
round with no usable baseline, is `unknown`. One lone reading is not proof — we fire 26× faster
than the datasheet's 60 ms guidance, so a lingering echo inside a closed acrylic box looks exactly
like a single blip. Collapsing `unknown` into `not_found` would turn a loose wire into an
accusation that the cabinet never dispensed.

**What it does not prove**: that the right item fell, or that the student picked it up. Something
very thin — a single plaster — may not register at all.

## Script size limit

MicroPython on micro:bit V1 refuses a script over **8188 bytes** — `uflash.hexlify()` raises
`ValueError` at build time. Thai comments cost 3 bytes per character, so prose belongs in this file
rather than in the firmware. `test_both_scripts_fit_the_v1_script_limit` fails before a flash can.
