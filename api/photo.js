// API/PHOTO.JS — รูปใบหน้าของคนที่ใช้ตู้โดยไม่มีบัตร
//
// คนไม่มีบัตรหรือคนนอกที่บาดเจ็บต้องใช้ตู้ได้ แต่ต้องถ่ายรูปหน้าส่งครู — เหตุผลคือกันคนมากดเล่น
//
// **ทำไมต้องแยกจาก /api/ingest**: ingest จำกัดทั้งชุดที่ 64 KiB (lib/cabinet-http.js)
// รูปหน้าย่อแล้วยังกินเกือบหมด ⇒ ยัดรวมไปไม่ได้ ต้องมีช่องของตัวเองที่มีเพดานของตัวเอง
//
// **ทำไม GET ถึงไม่ต้องล็อกอิน**: เซิร์ฟเวอร์ของ LINE เป็นคนไปดึงรูปมาแสดงในการ์ด มันล็อกอิน
// แทนครูไม่ได้ ⇒ การโชว์รูปใน LINE แปลว่ารูปต้องดึงได้โดยไม่ต้องล็อกอิน เลี่ยงไม่ได้ในทางเทคนิค
// สิ่งที่ทำได้คือทำให้เดาไม่ได้และอายุสั้น:
//   • โทเคน 256 บิตจาก randomBytes ไม่ได้มาจาก eventId ⇒ รู้ eventId ก็เดาโทเคนไม่ได้
//   • เทียบแบบ timingSafeEqual ⇒ เดาทีละตัวอักษรด้วยการจับเวลาไม่ได้
//   • หมดอายุ 15 นาที นับจากตอนอัปโหลด
//   • `Cache-Control: private, no-store` ⇒ ไม่ให้ค้างตาม CDN หลังโทเคนตาย
// **ข้อจำกัดที่เหลือและบอกไว้ตรงนี้**: ภายใน 15 นาทีนั้น ใครถือลิงก์ก็ดูได้ รวมถึงคนที่ครู
// ส่งต่อให้ · และ LINE เองแคชรูปไว้ในแชตถาวร ซึ่งอยู่นอกการควบคุมของระบบนี้
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { firebaseServices } from '../lib/firebase-admin.js';
import { authenticateCabinet } from '../lib/cabinet-protocol.js';
import { EVENT_ID } from '../lib/cabinet-protocol.js';
import { signedResponse, cabinetFailure } from '../lib/cabinet-http.js';

export const VIEW_TTL_MS = 15 * 60 * 1000;
export const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
// รูปเดินทางเป็น base64 ในเนื้อคำขอ เพราะลายเซ็น HMAC คิดจากไบต์ของ "ข้อความ" ไม่ใช่ไบนารีดิบ
// 340 KiB base64 ≈ 255 KiB JPEG — พอสำหรับหน้าคนที่ 640px และยังห่างจากเพดาน 1 MiB ของเอกสาร Firestore
export const MAX_BASE64 = 340 * 1024;

async function readBase64Body(req, limit = MAX_BASE64) {
    if (typeof req.body === 'string' || Buffer.isBuffer(req.body)) {
        const body = Buffer.from(req.body);
        if (body.length > limit) throw Object.assign(new Error('body_too_large'), { status: 413 });
        return body.toString('utf8');
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > limit) throw Object.assign(new Error('body_too_large'), { status: 413 });
        chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
}

const equalToken = (a, b) => typeof a === 'string' && typeof b === 'string' &&
    a.length === b.length && a.length >= 32 && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function createPhotoHandler({ services = firebaseServices, env = process.env, now = Date.now, makeToken = () => randomBytes(32).toString('base64url') } = {}) {
    return async (req, res) => {
        res.setHeader('Cache-Control', 'private, no-store');
        if (req.method === 'GET') return viewPhoto(req, res, { services, now });
        if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'POST required' });
        try {
            const raw = await readBase64Body(req);
            const auth = authenticateCabinet(req, raw, '/api/photo', env, now());
            const eventId = req.headers?.['x-sfab-event'];
            if (!EVENT_ID.test(String(eventId || ''))) throw Object.assign(new Error('invalid_event'), { status: 400 });
            // ตรวจว่าเป็น base64 จริงก่อนเก็บ ไม่งั้นเราเก็บขยะไว้แล้วไปพังตอนครูเปิดดู
            if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw) || raw.length < 512) {
                throw Object.assign(new Error('invalid_image'), { status: 400 });
            }
            const { db } = services();
            const at = now();
            const viewToken = makeToken();
            // create ไม่ใช่ set — รูปของเหตุการณ์เดิมเขียนทับไม่ได้ ประวัติต้องแก้ย้อนหลังไม่ได้
            // ส่งซ้ำด้วย id เดิมจึงได้ 409 และตู้จะถือว่าส่งสำเร็จไปแล้ว
            try {
                await db.doc(`photos/${auth.cabinetId}~${eventId}`).create({
                    jpegBase64: raw, viewToken, cabinetId: auth.cabinetId, eventId,
                    createdAt: new Date(at).toISOString(),
                    viewExpiresAt: new Date(at + VIEW_TTL_MS).toISOString(),
                    expiresAt: new Date(at + RETENTION_MS)
                });
            } catch (error) {
                if (error?.code === 6 || /already exists/i.test(error?.message || '')) {
                    throw Object.assign(new Error('event_conflict'), { status: 409 });
                }
                throw error;
            }
            return signedResponse(res, auth, 200, { success: true, viewToken, expiresAt: at + VIEW_TTL_MS });
        } catch (error) { return cabinetFailure(res, error); }
    };
}

async function viewPhoto(req, res, { services, now }) {
    // เส้นทางนี้ไม่มีการล็อกอินโดยเจตนา — LINE เป็นคนดึง · ความปลอดภัยอยู่ที่โทเคนล้วน
    try {
        const url = new URL(req.url || '', 'https://sfab.invalid');
        const key = url.searchParams.get('event') || '';
        const token = url.searchParams.get('t') || '';
        if (!/^[A-Za-z0-9_-]{1,48}~[A-Za-z0-9_-]{8,80}$/.test(key)) return res.status(404).end();
        const { db } = services();
        const snap = await db.doc(`photos/${key}`).get();
        // ไม่มีรูป โทเคนผิด และหมดอายุ ตอบ 404 เหมือนกันหมด ไม่บอกว่าพลาดตรงไหน
        if (!snap.exists) return res.status(404).end();
        const data = snap.data();
        if (!equalToken(token, data.viewToken)) return res.status(404).end();
        if (now() >= Date.parse(data.viewExpiresAt)) return res.status(404).end();
        const image = Buffer.from(data.jpegBase64, 'base64');
        res.setHeader('Content-Type', 'image/jpeg');
        res.setHeader('Content-Length', String(image.length));
        res.setHeader('Cache-Control', 'private, no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        return res.status(200).end(image);
    } catch { return res.status(404).end(); }
}

export default createPhotoHandler();
