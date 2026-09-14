// EDGE/PHOTOS.MJS — คิวรูปใบหน้าของคนที่ใช้ตู้โดยไม่มีบัตร ฝั่งตู้
//
// **ทำไมตู้ต้องเก็บรูปเอง แทนที่จะให้เบราว์เซอร์ยิงขึ้นคลาวด์ตรงๆ**
// `/api/photo` บังคับลายเซ็น HMAC จาก `SFAB_CABINET_SECRET` ซึ่งอยู่ที่ตู้กับ Vercel เท่านั้น
// และต้องไม่มีวันไปโผล่ในหน้าเว็บ ⇒ เบราว์เซอร์ยิงเองไม่ได้เลย ต้องผ่านตู้
//
// **ทำไมต้องมีคิว ไม่ใช่อัปโหลดทันทีแล้วจบ**
// ตู้ต้องจ่ายของได้ตอนเน็ตล่ม นั่นคือทั้งเหตุผลที่มันเป็นตู้ ไม่ใช่เว็บ ⇒ รูปที่อัปไม่ขึ้น
// ห้ามบล็อกการจ่าย · แต่รูปก็ต้องไม่หายไปเฉยๆ เพราะมันคือสิ่งเดียวที่ครูจะได้เห็นว่าใครมาใช้
//
// ⚠️ **ข้อแลกเปลี่ยนที่ต้องรู้**: payload ของ LINE ถูกแช่แข็งตั้งแต่ ingest ครั้งแรก
// (`lib/cabinet-line.js` — `state.payload || …`) ⇒ รูปที่อัปขึ้นไปทีหลังจากที่เหตุการณ์ถูก
// ingest ไปแล้ว **จะไม่ขึ้นบนการ์ดใบนั้น** ต่อให้อัปสำเร็จ · รูปยังอยู่ใน Firestore และเปิดดูได้
// ด้วยโทเคน แต่ไม่มีใครได้ลิงก์ ⇒ ต้องมีข้อความตามหลังให้ครู ซึ่ง **ยังไม่ได้ทำ** (จดไว้ที่ pending)
//
// **PDPA — อายุของรูปบนตู้**: นี่คือภาพใบหน้าเด็กบนการ์ด SD ของเครื่องที่ตั้งกลางทางเดินโรงเรียน
// กติกาคือ **ลบทิ้งทันทีที่คลาวด์รับแล้ว** (200 หรือ 409) ไม่เก็บสำเนาไว้ "เผื่อ" และรูปที่
// ส่งไม่ขึ้นสักทีถูกตัดทิ้งเมื่ออายุเกิน RETENTION_MS ซึ่งเท่ากับฝั่งคลาวด์ ⇒ ตู้ไม่เคยเป็นที่
// เก็บถาวรของภาพใบหน้าใคร

import { EVENT_ID } from '../lib/cabinet-protocol.js';

// เท่ากับ RETENTION_MS ของ api/photo.js โดยตั้งใจ — ตู้ต้องไม่เก็บนานกว่าคลาวด์
export const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

// 340 KiB คือเพดานของ `/api/photo` (MAX_BASE64) · ตู้ปฏิเสธตั้งแต่ต้นทางจะได้ไม่เก็บของที่
// อัปไม่ขึ้นแน่ๆ ไว้เต็มการ์ด แล้วไปพังเงียบๆ ตอนอัปโหลดรอบแรก
export const MAX_BASE64 = 340 * 1024;

// สั้นกว่านี้ไม่น่าจะเป็นรูปถ่ายจากกล้องจริง — เกณฑ์เดียวกับ api/photo.js:60
const MIN_BASE64 = 512;

export class CabinetPhotos {
    constructor(db) {
        this.db = db;
        db.exec(`CREATE TABLE IF NOT EXISTS photos (
            event_id TEXT PRIMARY KEY, jpeg_base64 TEXT NOT NULL,
            created_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0);`);
    }

    /** เก็บรูปของเหตุการณ์หนึ่ง — คืน false ถ้ารูปใช้ไม่ได้ ไม่โยน
     *
     * `INSERT OR IGNORE`: รูปของเหตุการณ์เดิมเขียนทับไม่ได้ ด้วยเหตุผลเดียวกับที่ `/api/photo`
     * ใช้ `create` ไม่ใช่ `set` — ประวัติต้องแก้ย้อนหลังไม่ได้ · กดถ่ายซ้ำในรอบเดิมจึงต้องได้
     * eventId ใหม่ ไม่ใช่ทับของเดิม
     */
    store(eventId, jpegBase64, now = Date.now()) {
        if (!EVENT_ID.test(String(eventId || ''))) return false;
        if (typeof jpegBase64 !== 'string' || jpegBase64.length < MIN_BASE64 ||
            jpegBase64.length > MAX_BASE64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(jpegBase64)) return false;
        this.db.prepare('INSERT OR IGNORE INTO photos (event_id, jpeg_base64, created_at) VALUES (?, ?, ?)')
            .run(eventId, jpegBase64, new Date(now).toISOString());
        return true;
    }

    has(eventId) {
        return !!this.db.prepare('SELECT 1 FROM photos WHERE event_id = ?').get(eventId);
    }

    /** รูปที่ยังไม่ได้ส่ง · `first` คือรายการ id ที่ต้องมาก่อน
     *
     * ลำดับสำคัญจริงๆ ไม่ใช่การปรับแต่ง: เหตุการณ์ที่กำลังจะถูก ingest ในรอบนี้ต้องได้อัปรูปก่อน
     * ไม่งั้นการ์ดของมันถูกแช่แข็งโดยไม่มีรูป แล้วแก้ทีหลังไม่ได้อีกเลย
     */
    pending(first = [], limit = 5) {
        const rows = this.db.prepare('SELECT event_id, jpeg_base64 FROM photos ORDER BY rowid LIMIT ?').all(limit * 4);
        const wanted = new Set(first);
        return [...rows].sort((a, b) => (wanted.has(b.event_id) ? 1 : 0) - (wanted.has(a.event_id) ? 1 : 0))
            .slice(0, limit)
            .map(row => ({ eventId: row.event_id, jpegBase64: row.jpeg_base64 }));
    }

    /** คลาวด์รับแล้ว (200) หรือมีอยู่แล้ว (409) — ทั้งสองแบบแปลว่าตู้ไม่ต้องถือรูปนี้อีกต่อไป */
    forget(eventId) {
        this.db.prepare('DELETE FROM photos WHERE event_id = ?').run(eventId);
    }

    /** นับความพยายามไว้เพื่อให้เห็นจากสมุดว่ารูปไหนส่งไม่ขึ้นสักที ไม่ได้ใช้ถ่วงจังหวะ
     *  (การถ่วงจังหวะเป็นหน้าที่ของ backoff ใน CabinetSync ซึ่งครอบทั้งรอบอยู่แล้ว) */
    failed(eventId) {
        this.db.prepare('UPDATE photos SET attempts = attempts + 1 WHERE event_id = ?').run(eventId);
    }

    /** ตัดรูปที่แก่เกินเพดานทิ้ง — เรียกทุกรอบ sync ไม่ใช่ตอนบูตอย่างเดียว
     *  ตู้ที่เปิดค้างเป็นเดือนต้องลบของเก่าด้วย ไม่ใช่เฉพาะตู้ที่ถูกรีบูต */
    prune(now = Date.now()) {
        const cutoff = new Date(now - RETENTION_MS).toISOString();
        return this.db.prepare('DELETE FROM photos WHERE created_at < ?').run(cutoff).changes;
    }
}
