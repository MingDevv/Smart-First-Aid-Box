#!/bin/bash
# สรุปสถานะตู้แบบอ่านครั้งเดียวจบ
echo "=== บริการ ==="
systemctl --user is-active sfab-edge.service  | sed 's/^/  edge:  /'
systemctl --user is-active sfab-kiosk.service | sed 's/^/  kiosk: /'
echo
echo "=== หน้าตู้ตอบไหม ==="
curl -sS -o /dev/null -w "  HTTP %{http_code}\n" http://localhost:8787/kiosk 2>/dev/null || echo "  ต่อไม่ได้"
echo
echo "=== ไฟเลี้ยง ==="
T=$(vcgencmd get_throttled 2>/dev/null)
echo "  $T"
[ "$T" = "throttled=0x0" ] && echo "  ไฟปกติ" || echo "  ** ไฟเคยตก/เคยถูกลดความเร็ว — ตรวจอะแดปเตอร์ (Pi 5 ต้อง 5V/5A) **"
echo
echo "=== คำสั่งที่ค้างอยู่ (ตู้จะไม่จ่ายของจนกว่าจะเคลียร์) ==="
cd /home/technology/sfab 2>/dev/null && ~/.local/node/bin/node edge/resolve.mjs --list 2>&1 | sed 's/^/  /'
echo
echo "=== เครือข่าย ==="
tailscale ip -4 2>/dev/null | sed 's/^/  tailscale: /' || echo "  tailscale: ไม่ทราบ"
hostname -I | sed 's/^/  lan: /'
echo
read -rp "กด Enter เพื่อปิด "
