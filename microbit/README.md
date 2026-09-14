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
`DONE<d>:<id>`/`REJECT:<id>`, `BUZZ<1|0>:<id>` → `BUZZ_DONE<1|0>:<id>`); the Pi speaks them
directly through `edge/microbit-serial.mjs`. Pin map and motor constants are in `main.py`'s header.
`tests/microbit_protocol_test.py` executes the real functions with stubs.
