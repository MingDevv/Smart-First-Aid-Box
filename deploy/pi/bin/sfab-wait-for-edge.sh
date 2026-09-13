#!/bin/sh
# Wait until the local edge service actually SERVES the kiosk route, then exit 0.
#
# STATUS: NEVER RUN ON HARDWARE. Written from edge/server.mjs, not observed.
# Install: /usr/local/lib/sfab/sfab-wait-for-edge.sh   (root:root 0755)
# Used by: deploy/pi/sfab-kiosk.service  ExecStartPre=
#
# WHY THIS EXISTS
# systemd's After= orders against a unit *starting*, and for Type=simple that means
# "forked", not "listening". A user unit also cannot order against a system unit at all.
# So the only honest readiness signal available here is an HTTP request.
#
# WHAT A PASS ACTUALLY PROVES  (read this before trusting a green boot)
#   It proves: the TCP listener is up on the loopback address, the Host allowlist
#              accepted us, and the static route for /kiosk read a file off disk.
#   It does NOT prove:
#     · the ESP32 is reachable          — controller.status() catches its own fetch
#                                          errors and returns connected:false with HTTP
#                                          200, so a dead cabinet still probes green
#     · /var/lib/sfab is writable       — the SQLite journal is only touched on the
#                                          first POST /api/command, long after this
#     · the camera works
#     · the service is still alive one second from now (classic TOCTOU: we can pass,
#       then the service can die, and Chromium lands on an error page anyway —
#       Restart=always on the kiosk unit is the fallback for that, not this script)
#
# GOTCHA, and it will look like an outage if you hit it: edge/server.mjs rejects any
# request whose Host header is not exactly 127.0.0.1:<port> or localhost:<port>, with
# HTTP 403. `curl -f` reports 403 as failure. So if someone "improves" the URL below to
# use the Pi's hostname or Tailscale name, this loop fails forever while the service is
# perfectly healthy. Keep it on the literal loopback address.
#
# 127.0.0.1 and not localhost on purpose: the server binds 127.0.0.1 only, and on a
# dual-stack Pi `localhost` can resolve to ::1 first and burn a refused connection per
# attempt. (Chromium is pointed at localhost so the browser ORIGIN matches the managed
# policy's VideoCaptureAllowedUrls entry — that is a different requirement, not an
# inconsistency. http://localhost:8787 and http://127.0.0.1:8787 are distinct origins to
# Chromium's permission store.)

set -eu

PORT="${SFAB_PORT:-8787}"
URL="http://127.0.0.1:${PORT}/kiosk"
TRIES="${SFAB_WAIT_TRIES:-60}"      # ~60s worst case with the 1s sleep below
SLEEP="${SFAB_WAIT_SLEEP:-1}"

probe() {
    if command -v curl >/dev/null 2>&1; then
        # --max-time 2 so a hung socket cannot stall the whole budget on one attempt.
        curl -fsS --max-time 2 -o /dev/null "$URL"
        return $?
    fi
    # Fallback if curl is not installed. Weaker: this only proves the port accepts a
    # connection. It does not read a response, so it cannot tell a serving edge service
    # apart from anything else that happens to hold port "$PORT". Install curl.
    if command -v bash >/dev/null 2>&1; then
        bash -c "exec 3<>/dev/tcp/127.0.0.1/${PORT}" >/dev/null 2>&1
        return $?
    fi
    echo "sfab-wait-for-edge: neither curl nor bash available; cannot probe" >&2
    return 1
}

n=0
while [ "$n" -lt "$TRIES" ]; do
    if probe; then
        echo "sfab-wait-for-edge: ${URL} answered after ${n}s"
        exit 0
    fi
    n=$((n + 1))
    sleep "$SLEEP"
done

echo "sfab-wait-for-edge: ${URL} did not answer within ${TRIES} attempts" >&2
echo "sfab-wait-for-edge: check 'systemctl status sfab-edge' and 'journalctl -u sfab-edge -n 50'" >&2
exit 1
