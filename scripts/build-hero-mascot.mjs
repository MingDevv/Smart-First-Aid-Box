// SCRIPTS/BUILD-HERO-MASCOT.MJS — สร้าง images/hero_mascot_tagline.webp จากภาพต้นฉบับ
//
// ทำไมต้องมีสคริปต์ ไม่ใช่ลากภาพเข้าโฟลเดอร์เฉยๆ: Bank ทักสองรอบเรื่องภาพนี้ (2026-09-14)
// ว่า "ไม่คม" กับ "ลบพื้นหลังขาวออกไม่หมด" ทั้งสองอย่างเป็นผลของ *วิธีแปลง* ไม่ใช่ของต้นฉบับ
// ถ้าไม่จดวิธีไว้ รอบหน้าก็ได้ผลเดิมอีก
//
// ต้นฉบับ = images/hero_mascot_tagline_source.png (1920x1080 พื้นขาวทึบ ไม่มีอัลฟา)
//
// **กับดักที่พิสูจน์แล้วว่าพัง — อย่าทำ**: คีย์พื้นหลังด้วย "ความขาว" ทั้งภาพ หรือใช้เกณฑ์หลวม
// (min>=236 ขึ้นไป) จะกิน *ของที่ตั้งใจให้ขาว* ไปด้วย คือเส้นขอบขาวของตัวอักษรสโลแกน และ
// หน้าผ้าใบขาวของรองเท้า — ทดลองแล้วเห็นรูโหว่ในรองเท้าและสโลแกนเสียเส้นขอบ (ดูรูปเทียบใน rrr)
// ทางที่ถูกคือ **flood fill จากขอบภาพ** ด้วยเกณฑ์แคบ: ขาวจริง (min>=248) และไม่มีสี (sat<=8)
// สิ่งที่อยู่ในกรอบของงานศิลป์จึงรอด เพราะมันไม่ต่อกับขอบภาพ
//
// จากนั้นกัดขอบเข้ามา 1 พิกเซลแล้วเบลอ 0.8 เพื่อฆ่าขอบขาวที่เหลือจาก antialias ของต้นฉบับ
// (ของเดิมอัลฟาเป็นไบนารีเกือบหมด — โปร่ง 369,840 / ทึบ 259,994 / กึ่งกลางแค่ 12,566 พิกเซล
// = 2% ⇒ ขอบฟันเลื่อยและมีขอบขาวค้างรอบรูป) และ **un-premultiply กับสีขาว** ในแถบขอบ
// เพื่อคืนสีจริงของขอบ ไม่ใช่สีที่ถูกผสมขาวมาแล้ว
//
// ขนาดออก = ความกว้างของต้นฉบับหลังครอป (1893 px) ไม่ย่อ เพราะจอจริงต้องการสูงสุด
// ~1682 device px แล้ว (MacBook 1728 logical x2, ภาพกว้าง 841 CSS px) · ของเดิม 1100 px
// จึงถูก *ขยาย* ทุกเครื่องจริง — วัดแล้ว เดสก์ท็อป 1.02x มือถือ 1.06x — ซึ่งคือคำว่า
// "ไม่คม" ที่ Bank เห็น · เพดาน 1900 px กันไว้เผื่อวันหนึ่งได้ต้นฉบับใหญ่กว่านี้มา

import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(ROOT, 'images/hero_mascot_tagline_source.png');
const TARGET = join(ROOT, 'images/hero_mascot_tagline.webp');

// การประมวลผลภาพทำใน Python เพราะ Pillow มีอยู่ในเครื่องอยู่แล้ว และเรพนี้ไม่มี
// dependency ฝั่งภาพเลย — การเพิ่ม sharp เข้ามาเพื่อสร้างไฟล์เดียวไม่คุ้มกับ
// น้ำหนักที่ทุกคนต้องติดตั้งตาม
const PY = String.raw`
import sys
from collections import deque
import numpy as np
from PIL import Image, ImageFilter

src, dst = sys.argv[1], sys.argv[2]
MAX_WIDTH, QUALITY = 1900, 88
MIN_WHITE, MAX_SAT = 248, 8   # แคบไว้ก่อน — ดูคอมเมนต์เรื่องรองเท้ากับเส้นขอบสโลแกน
ERODE_PX, BLUR_PX = 1, 0.8

a = np.asarray(Image.open(src).convert('RGB')).astype(np.float64)
H, W, _ = a.shape
mn, mx = a.min(axis=2), a.max(axis=2)
bg_like = (mn >= MIN_WHITE) & ((mx - mn) <= MAX_SAT)

# flood fill จากขอบภาพเท่านั้น — ของขาวที่อยู่ในตัวงานศิลป์ไม่ต่อกับขอบ จึงไม่ถูกลบ
seen = np.zeros((H, W), bool)
dq = deque()
ys, xs = np.where(bg_like)
edge = (ys == 0) | (ys == H - 1) | (xs == 0) | (xs == W - 1)
for y, x in zip(ys[edge], xs[edge]):
    if not seen[y, x]:
        seen[y, x] = True
        dq.append((y, x))
while dq:
    y, x = dq.popleft()
    for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        ny, nx = y + dy, x + dx
        if 0 <= ny < H and 0 <= nx < W and bg_like[ny, nx] and not seen[ny, nx]:
            seen[ny, nx] = True
            dq.append((ny, nx))

mask = Image.fromarray(((~seen) * 255).astype(np.uint8), 'L')
mask = mask.filter(ImageFilter.MinFilter(2 * ERODE_PX + 1)).filter(ImageFilter.GaussianBlur(BLUR_PX))
alpha = np.asarray(mask).astype(np.float64) / 255.0

al = np.clip(alpha, 0, 1)[..., None]
rgb = np.clip((a - (1 - al) * 255.0) / np.where(al < 0.02, 1.0, al), 0, 255)
im = Image.fromarray(np.dstack([rgb, alpha * 255]).astype(np.uint8), 'RGBA')
im = im.crop(im.split()[3].getbbox())

# ย่อเฉพาะเมื่อกว้างเกินเพดาน — ต้นฉบับครอปแล้วได้ 1893 px ซึ่งพอดีอยู่ใต้เพดาน
# จึงไม่ถูก resample เลย ไม่มีความคมหายไปจากขั้นนี้ และไฟล์โตขึ้นจาก 1600 px แค่ ~13 KB
if im.width > MAX_WIDTH:
    im = im.resize((MAX_WIDTH, round(im.height * MAX_WIDTH / im.width)), Image.LANCZOS)
im.save(dst, 'WEBP', quality=QUALITY, method=6, alpha_quality=100)
print(f'{im.width}x{im.height}')
`;

readFileSync(SOURCE);
const size = execFileSync('python3', ['-c', PY, SOURCE, TARGET], { encoding: 'utf8' }).trim();
console.log(`hero_mascot_tagline.webp -> ${size}`);
