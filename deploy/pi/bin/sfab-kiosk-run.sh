#!/bin/sh
# Launch Chromium as the cabinet kiosk.
#
# STATUS: NEVER RUN ON HARDWARE. No Chromium has been started by this script.
# Install: /usr/local/lib/sfab/sfab-kiosk-run.sh   (root:root 0755)
# Used by: deploy/pi/sfab-kiosk.service  ExecStart=
#
# The command line lives in /etc/sfab/chromium-kiosk-flags.conf (one flag per line) so
# that changing a flag does not mean editing a unit file and reloading systemd, and so
# the flags can carry their own comments explaining why each one is there.

set -eu

URL="${SFAB_KIOSK_URL:-http://localhost:8787/kiosk}"
FLAGS="${SFAB_KIOSK_FLAGS:-/etc/sfab/chromium-kiosk-flags.conf}"

# Raspberry Pi OS ships the binary as `chromium-browser` (a wrapper script); plain Debian
# ships `chromium`. Verify which exists on the device — do not assume.
CHROMIUM=""
for candidate in /usr/bin/chromium-browser /usr/bin/chromium; do
    if [ -x "$candidate" ]; then CHROMIUM="$candidate"; break; fi
done
if [ -z "$CHROMIUM" ]; then
    echo "sfab-kiosk-run: no chromium binary at /usr/bin/chromium-browser or /usr/bin/chromium" >&2
    exit 1
fi

if [ ! -r "$FLAGS" ]; then
    echo "sfab-kiosk-run: flags file not readable: $FLAGS" >&2
    exit 1
fi

# HARD STOP on --no-sandbox. This is not a style preference. The kiosk page calls
# getUserMedia and POSTs to an endpoint that moves a motor; the renderer sandbox is the
# boundary that keeps a compromised web page from becoming a compromised cabinet.
# Disabling it is the single most common "fix" found in kiosk tutorials, so it is worth
# failing loudly instead of drifting in unnoticed.
if grep -qE '^[[:space:]]*--no-sandbox\b' "$FLAGS"; then
    echo "sfab-kiosk-run: refusing to start — --no-sandbox is present in $FLAGS" >&2
    exit 1
fi

# The Raspberry Pi OS chromium-browser wrapper also sources /etc/chromium.d/*, which can
# inject flags this script never sees. Warn; we cannot prevent it from here.
if [ -d /etc/chromium.d ] && grep -rqE -- '--no-sandbox' /etc/chromium.d 2>/dev/null; then
    echo "sfab-kiosk-run: WARNING — --no-sandbox is injected by a file in /etc/chromium.d" >&2
    echo "sfab-kiosk-run: WARNING — inspect 'grep -rn no-sandbox /etc/chromium.d' before trusting this kiosk" >&2
fi

# Build argv from the flags file: skip blank lines and # comments.
set --
while IFS= read -r line; do
    case "$line" in
        ''|'#'*) continue ;;
    esac
    set -- "$@" "$line"
done < "$FLAGS"

echo "sfab-kiosk-run: exec $CHROMIUM with $# flags -> $URL"
exec "$CHROMIUM" "$@" "$URL"
