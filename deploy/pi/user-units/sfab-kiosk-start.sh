#!/bin/bash
# เปิดหน้าตู้บนจอ Pi — สคริปต์ทดสอบด้วยมือ ยังไม่ใช่ systemd unit
export XDG_RUNTIME_DIR=/run/user/$(id -u)
export WAYLAND_DISPLAY=$(ls "$XDG_RUNTIME_DIR" | grep -E "^wayland-[0-9]+$" | head -1)
# --password-store=basic: ไม่ให้ Chromium ไปขอปลดล็อก GNOME keyring
# ซึ่งเด้งหน้าต่าง "Authentication required" พร้อมคีย์บอร์ดบนจอทับหน้าตู้
exec chromium --kiosk --ozone-platform=wayland --user-data-dir=/home/technology/.config/sfab-kiosk \
  --password-store=basic \
  --no-first-run --disable-features=Translate,TranslateUI --disable-translate --lang=th-TH --disable-infobars \
  --disable-session-crashed-bubble --noerrdialogs \
  --use-fake-ui-for-media-stream \
  http://localhost:8787/kiosk
