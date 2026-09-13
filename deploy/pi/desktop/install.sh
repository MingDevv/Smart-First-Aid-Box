#!/bin/bash
# ติดตั้งไอคอนบนเดสก์ท็อปของตู้ — รันบน Pi ไม่ต้องใช้ sudo
#
#   bash ~/sfab/deploy/pi/desktop/install.sh
#
# ถอนออก:  rm ~/Desktop/sfab-*.desktop ~/.local/bin/sfab-{maintenance,status}.sh
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"

mkdir -p "$HOME/.local/bin" "$HOME/Desktop"
install -m 755 "$HERE/sfab-maintenance.sh" "$HOME/.local/bin/sfab-maintenance.sh"
install -m 755 "$HERE/sfab-status.sh"      "$HOME/.local/bin/sfab-status.sh"
install -m 755 "$HERE/sfab-set-mode.sh"    "$HOME/.local/bin/sfab-set-mode.sh"

for f in sfab-kiosk-start sfab-mode-demo sfab-mode-real sfab-maintenance sfab-status; do
    install -m 755 "$HERE/$f.desktop" "$HOME/Desktop/$f.desktop"
    # pcmanfm บน Pi OS ต้องการให้ไฟล์ถูกทำเครื่องหมายว่าเชื่อถือได้ ไม่งั้นดับเบิลคลิกแล้วถามซ้ำทุกครั้ง
    gio set "$HOME/Desktop/$f.desktop" metadata::trusted true 2>/dev/null || true
done

# โลโก้: .desktop อ้าง .png ส่วนเรพเก็บทั้ง .png และ .webp — เช็คว่ามีจริง
[ -f "$HOME/sfab/images/logo_first_aid.png" ] || \
    echo "เตือน: ไม่พบ ~/sfab/images/logo_first_aid.png — ไอคอนจะขึ้นเป็นรูปปริยาย ไม่กระทบการทำงาน"

echo "ติดตั้งแล้ว 5 ไอคอนที่ ~/Desktop:"
echo "  เปิดหน้าตู้ยา        — start sfab-kiosk.service (ปกติขึ้นเองตอนบูตอยู่แล้ว)"
echo "  ตั้งเป็นโหมดสาธิต     — SFAB_MODE=demo แล้วรีสตาร์ท"
echo "  ตั้งเป็นใช้งานจริง    — SFAB_MODE=real แล้วรีสตาร์ท"
echo "  โหมดดูแล (ตั้งค่าครู) — หยุดหน้าตู้ แล้วเปิดหน้าครูในโปรไฟล์เดียวกับหน้าตู้"
echo "  ดูสถานะตู้ยา         — บริการ ไฟเลี้ยง คำสั่งค้าง เครือข่าย"
echo
echo "หมายเหตุ: ไอคอนพวกนี้มองเห็นได้เฉพาะตอนหน้าตู้ไม่ได้รันอยู่"
echo "เพราะ Chromium --kiosk คลุมเต็มจอ — นั่นคือสิ่งที่ตั้งใจ ไม่ใช่ข้อบกพร่อง"
