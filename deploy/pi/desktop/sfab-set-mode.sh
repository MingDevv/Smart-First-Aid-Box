#!/bin/bash
# ตั้งโหมดการทำงานของตู้ แล้วรีสตาร์ทให้มีผลทันที
#   sfab-set-mode.sh demo   → จำลอง ไม่สั่งมอเตอร์จริง
#   sfab-set-mode.sh real   → สั่งตู้จริง
#
# เขียนลง systemd drop-in ไม่ใช่ localStorage ของเบราว์เซอร์ เพราะ:
#   · หน้าตู้ไม่มีลิงก์ไปหน้าครู และ managed policy บล็อกการพิมพ์ URL
#   · โหมดเป็นการตัดสินใจของ "เครื่องนี้ถูกติดตั้งมาทำอะไร" ไม่ใช่ของเบราว์เซอร์
# edge/server.mjs อ่าน SFAB_MODE แล้วฉีดเข้าหน้า และค่าที่ฉีดชนะ localStorage เสมอ
set -eu

MODE="${1:-}"
case "$MODE" in
  demo) LABEL="โหมดสาธิต — จำลองการเปิดลิ้นชัก ไม่สั่งมอเตอร์จริง" ;;
  real) LABEL="ใช้งานจริง — ตู้จะสั่งมอเตอร์จริง" ;;
  *) echo "ใช้: $0 demo|real" >&2; exit 2 ;;
esac

DROPIN="$HOME/.config/systemd/user/sfab-edge.service.d"
mkdir -p "$DROPIN"
cat > "$DROPIN/10-mode.conf" <<CONF
# เขียนโดย sfab-set-mode.sh — อย่าแก้มือ
# ถอนกลับเป็น "ยังไม่ได้ตั้งโหมด": rm $DROPIN/10-mode.conf แล้ว restart
[Service]
Environment=SFAB_MODE=$MODE
CONF

systemctl --user daemon-reload
systemctl --user restart sfab-edge.service
# หน้าจออ่านโหมดจากหน้าที่เสิร์ฟมา จึงต้องโหลดหน้าใหม่ = รีสตาร์ทตัวเบราว์เซอร์
# ห้ามกลืนความล้มเหลว — ถ้าเบราว์เซอร์ตัวเก่ายังรันอยู่ มันยังถือหน้าเดิมที่มีโหมดเดิม
# และยังยิงคำสั่งได้ การรายงานว่า "สลับโหมดเรียบร้อย" ตอนนั้นคือคำโกหก
KIOSK_RESTART_OK=1
systemctl --user restart sfab-kiosk.service || KIOSK_RESTART_OK=0

# ยืนยันจากสิ่งที่เสิร์ฟออกมาจริง ไม่ใช่จากสิ่งที่เพิ่งเขียนลงไฟล์
for _ in $(seq 1 20); do
    sleep 1
    SERVED=$(curl -sS http://localhost:8787/kiosk 2>/dev/null | grep -o 'SFAB_RUNTIME.mode = "[a-z]*"' | head -1)
    [ -n "$SERVED" ] && break
done

if [ "$SERVED" = "SFAB_RUNTIME.mode = \"$MODE\"" ] && [ "$KIOSK_RESTART_OK" = 1 ]; then
    STATUS="ตั้งเป็น $LABEL เรียบร้อย"
elif [ "$KIOSK_RESTART_OK" = 0 ]; then
    STATUS="เซิร์ฟเวอร์รับโหมดใหม่แล้ว แต่รีสตาร์ทหน้าจอไม่สำเร็จ — หน้าจอเดิมอาจยังถือโหมดเก่าอยู่ ให้ตรวจก่อนใช้งาน"
else
    STATUS="ตั้งค่าแล้วแต่ยังยืนยันจากหน้าที่เสิร์ฟไม่ได้ (ได้: ${SERVED:-ไม่มีค่า}) — ลองดูสถานะตู้"
fi
echo "$STATUS"
command -v notify-send >/dev/null && notify-send "ตู้ปฐมพยาบาล" "$STATUS" || true
