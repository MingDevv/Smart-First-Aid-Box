#!/bin/sh
# Liveness probe for the edge service. Restart it only if it is ALIVE BUT NOT ANSWERING.
#
# STATUS: NEVER RUN ON HARDWARE. The probe logic was exercised locally against a real
#         edge server, a dead port, a deliberately hung server and an impostor server
#         (see deploy/pi/README.md "Hang recovery"); no Raspberry Pi has run it.
# Install: /usr/local/lib/sfab/sfab-edge-healthcheck.sh   (root:root 0755)
# Used by: deploy/pi/sfab-edge-watchdog.service, fired by sfab-edge-watchdog.timer
#
# WHY THIS EXISTS
# `Restart=on-failure` recovers a process that EXITS. It does nothing for a process that
# is alive, holding the port, and never answering — a wedged event loop, a blocked
# synchronous call, a deadlock. systemd cannot see the difference: the unit is `active`
# and the cabinet is dead. That gap is the only thing this script closes.
#
# WHAT A FAILED PROBE HERE ACTUALLY PROVES, AND WHAT IT DOES NOT
#   It proves: within $BUDGET seconds, nothing on the loopback port completed an HTTP
#              response whose body looked like this service's own /api/local/status.
#   It does NOT prove the cabinet works, and it CANNOT SEE:
#     · a dead or unplugged ESP32 — controller.status() catches its own fetch errors and
#       returns HTTP 200 with connected:false. A cabinet that cannot open a drawer at all
#       still probes GREEN here. This is a service watchdog, not a cabinet watchdog.
#     · a wedged Chromium — nothing here looks at the browser. A frozen kiosk page in
#       front of a perfectly healthy edge service passes every probe. See README.md;
#       that half is unfinished.
#     · a partial wedge that still serves /api/local/status but hangs POST /api/command.
#       The probe is a GET; it does not and must not send commands.
#     · the difference between "hung" and "slow". Only $BUDGET and the strike count
#       separate them, which is why the default is 3 strikes and not 1.
#
# THE COST OF BEING WRONG, which is why it is deliberately slow to act:
# restarting mid-command leaves a 'pending' row that the next start rewrites to
# 'uncertain', and an uncertain row BLOCKS every later drawer-open until an operator
# clears it over SSH (edge/resolve.mjs). A trigger-happy watchdog would take the cabinet
# out of service to fix a problem that did not exist. Three consecutive failures at the
# timer's interval, not one.

set -eu

PORT="${SFAB_PORT:-8787}"
URL="http://127.0.0.1:${PORT}/api/local/status"
UNIT="${SFAB_WATCHDOG_UNIT:-sfab-edge.service}"
# /run is tmpfs: the strike count resets on reboot, which is what we want, and it never
# touches the SD card.
STATE="${SFAB_WATCHDOG_STATE:-/run/sfab-edge-watchdog.strikes}"
STRIKES="${SFAB_WATCHDOG_STRIKES:-3}"
BUDGET="${SFAB_WATCHDOG_TIMEOUT:-5}"

DRYRUN=0
if [ "${1:-}" = "--dry-run" ]; then
    DRYRUN=1
fi

read_strikes() {
    if [ -r "$STATE" ]; then
        v=$(cat "$STATE" 2>/dev/null || echo 0)
        case "$v" in
            ''|*[!0-9]*) echo 0 ;;
            *) echo "$v" ;;
        esac
    else
        echo 0
    fi
}

clear_strikes() {
    rm -f "$STATE" 2>/dev/null || true
}

# 127.0.0.1 and not localhost: edge/server.mjs binds 127.0.0.1 only, and its Host
# allowlist rejects anything else with 403 — which `curl -f` reports as failure. Same
# trap as sfab-wait-for-edge.sh; do not "improve" this to a hostname.
#
# Checking the BODY, not just the status code, on purpose: a 200 from something else that
# grabbed port 8787 is not this service. The string is what json() emits for
# controller.status(), which returns mode:'pi-local' on every branch — including the
# unconfigured and unreachable ones — so a cabinet with no ESP32 configured still passes,
# correctly: that is a cabinet problem, not a service hang.
probe() {
    body=$(curl -fsS --max-time "$BUDGET" "$URL" 2>/dev/null) || return 1
    case "$body" in
        *'"mode":"pi-local"'*) return 0 ;;
        *) return 1 ;;
    esac
}

# Only act when systemd believes the unit is running. Two cases this deliberately skips:
#   · an operator stopped it for maintenance — restarting it under their hands would be
#     hostile, and README.md's maintenance procedure does exactly this stop
#   · it exited and is in `failed` or `activating` — Restart=/StartLimitBurst own that
#     path already, and a second mechanism fighting them just hides the crash loop
if [ "$DRYRUN" -eq 0 ]; then
    if ! systemctl is-active --quiet "$UNIT"; then
        clear_strikes
        echo "sfab-edge-watchdog: ${UNIT} is not active — not this watchdog's job (Restart= owns exits)"
        exit 0
    fi
fi

if probe; then
    if [ "$(read_strikes)" -ne 0 ]; then
        echo "sfab-edge-watchdog: recovered — ${URL} is answering again"
    fi
    clear_strikes
    exit 0
fi

n=$(( $(read_strikes) + 1 ))
printf '%s\n' "$n" > "$STATE"
echo "sfab-edge-watchdog: no healthy answer from ${URL} (strike ${n}/${STRIKES})" >&2

if [ "$n" -lt "$STRIKES" ]; then
    exit 0
fi

clear_strikes
echo "sfab-edge-watchdog: ${STRIKES} consecutive failures — the service is up but not answering" >&2
echo "sfab-edge-watchdog: restarting ${UNIT}; a command in flight will be lost and may leave an uncertain row" >&2

if [ "$DRYRUN" -eq 1 ]; then
    echo "sfab-edge-watchdog: DRY RUN — would run: systemctl restart ${UNIT}"
    exit 0
fi

# restart, not `kill -s SIGKILL`: SIGTERM first gives a merely-slow dispatch its chance to
# land in the journal before the process goes. If it really is wedged, TimeoutStopSec on
# the unit (150s) bounds the wait and systemd escalates to SIGKILL by itself.
systemctl restart "$UNIT"
