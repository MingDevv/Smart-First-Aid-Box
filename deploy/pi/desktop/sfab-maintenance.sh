#!/bin/bash
# โหมดดูแล — หยุดหน้าตู้แล้วเปิดหน้าครูในเบราว์เซอร์ปกติ
#
# ทำไมต้องมี: หน้าตู้ไม่มีลิงก์ออก และ Ctrl+L/Ctrl+N ถูกบล็อกด้วย managed policy
# ⇒ ถ้าไม่มีทางนี้ ครูไปหน้าตั้งค่าไม่ได้เลย และตู้จะค้างที่ "ยังไม่ได้ตั้งโหมด" ตลอดกาล
# เพราะโหมดเก็บอยู่ใน localStorage ของโปรไฟล์ Chromium บนเครื่องนี้
#
# ปลอดภัยเพราะไอคอนนี้อยู่บนเดสก์ท็อป ซึ่งมองไม่เห็นเลยตอนหน้าตู้รันอยู่
set -u
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
export WAYLAND_DISPLAY="$(ls "$XDG_RUNTIME_DIR" | grep -E '^wayland-[0-9]+$' | head -1)"

systemctl --user stop sfab-kiosk.service

# ใช้โปรไฟล์เดียวกับหน้าตู้ — สำคัญมาก เพราะคลังยาและโหมดอยู่ใน localStorage ของโปรไฟล์นั้น
# ถ้าเปิดคนละโปรไฟล์ จะตั้งค่าไปคนละที่กับที่หน้าตู้อ่าน
exec chromium --ozone-platform=wayland \
  --user-data-dir=/home/technology/.config/sfab-kiosk \
  --password-store=basic --disable-translate --lang=th-TH \
  --new-window http://localhost:8787/dashboard
