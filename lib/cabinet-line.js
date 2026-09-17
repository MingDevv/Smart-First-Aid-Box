import { randomUUID } from 'node:crypto';
import { eventCollection, eventKey } from './cabinet-events.js';
import { lineMessage } from './line-flex.js';

// LINE เก็บคีย์กันส่งซ้ำไว้ 24 ชม. เราหยุดส่งซ้ำอัตโนมัติที่ 23 ชม.
// เลยจากนั้นคีย์หมดอายุ ข้อความที่เคยส่งสำเร็จอาจถูกส่งซ้ำ
export const RETRY_HORIZON_MS = 23 * 60 * 60 * 1000;
export async function pushLine(payload, retryKey, env = process.env, fetchImpl = fetch) {
    if (!env.LINE_CHANNEL_ACCESS_TOKEN) return false;
    try {
        const response = await fetchImpl('https://api.line.me/v2/bot/message/push', {
            method: 'POST', headers: { 'Content-Type': 'application/json',
                Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN.trim()}`, 'X-Line-Retry-Key': retryKey },
            body: JSON.stringify(payload), signal: AbortSignal.timeout(8000), redirect: 'error'
        });
        return response.ok || (response.status === 409 && Boolean(response.headers.get('x-line-accepted-request-id')));
    } catch { return false; }
}
/** ชื่อนักเรียนสำหรับใส่ในข้อความ LINE — และ **เฉพาะชื่อกับชั้นเรียนเท่านั้น**
 *
 * เอกสาร `students/{uid}` มีประวัติแพ้ยาและแพ้อาหารอยู่ด้วย ซึ่งเป็นข้อมูลสุขภาพของเด็ก
 * กลุ่ม LINE ของครูไม่ใช่ที่ของมัน ⇒ ที่นี่หยิบทีละฟิลด์ตามรายชื่อ ห้าม spread เอกสารทั้งใบ
 * เด็ดขาด แม้จะดูสะดวกกว่า · เทสเฝ้าข้อนี้ไว้ด้วยเอกสารที่มีฟิลด์ลับปนอยู่
 *
 * `validateEvent` บังคับให้ `uid` เป็น null เสมอ ฟังก์ชันนี้จึงคืน null ทุกครั้ง
 * และจะเริ่มทำงานเองเมื่อตู้ส่งตัวตนของนักเรียน (บัตรนักเรียน + QR) ขึ้นมาได้
 */
export async function resolveStudent(db, event, auth = null) {
    if (!event?.uid) return null;
    try {
        const snap = await db.doc(`students/${event.uid}`).get();
        if (snap.exists) {
            const data = snap.data() || {};
            const name = typeof data.name === 'string' ? data.name.trim() : '';
            const room = typeof data.room === 'string' ? data.room.trim() : '';
            if (name) return { name, room };
        }
    } catch { return null; }
    // รอบที่สั่งจากเว็บ: `uid` เป็นของบัญชี Google ไม่ใช่รหัสทะเบียน ⇒ ไม่มีเอกสาร `students/{uid}`
    // จนกว่าจะมีการผูกทะเบียนกับบัญชีโรงเรียน · ระหว่างนี้ใช้ชื่อที่บัญชีโรงเรียนถืออยู่
    // ซึ่งดีกว่า "ยังไม่ทราบว่าเป็นนักเรียนคนไหน" ทั้งที่ระบบยืนยันตัวตนไปแล้ว
    // ลำดับนี้ทำให้พอทะเบียนจริงถูกผูกเมื่อไหร่ ชื่อกับชั้นเรียนจะขึ้นมาแทนเองโดยไม่ต้องแก้โค้ด
    if (event.verifiedBy !== 'school_account' || !auth) return null;
    try {
        const user = await auth.getUser(event.uid);
        const name = typeof user?.displayName === 'string' ? user.displayName.trim() : '';
        return name ? { name, room: '' } : null;
    } catch { return null; }
}

// ปุ่ม "ดูประวัติการใช้ตู้" ต้องชี้กลับมาที่เว็บของเราเอง
//
// พึ่ง `VERCEL_PROJECT_PRODUCTION_URL` อย่างเดียวไม่ได้ — ถ้ามันว่าง ปุ่มจะหายไปทั้งใบ
// โดยไม่มีใครรู้ · ใช้ค่าตั้งต้นเป็นโดเมนจริงแบบเดียวกับที่
// `edge/server.mjs` ทำกับ SFAB_CLOUD_BASE อยู่แล้ว แล้วให้ env มาทับได้ถ้าย้ายโดเมน
const DEFAULT_ORIGIN = 'https://smart-first-aid-box.vercel.app';
export function publicOrigin(env = process.env) {
    const raw = (env.SFAB_PUBLIC_ORIGIN
        || (env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${env.VERCEL_PROJECT_PRODUCTION_URL}` : '')
        || DEFAULT_ORIGIN).replace(/\/+$/, '');
    return /^https:\/\/[a-z0-9.-]+$/i.test(raw) ? raw : DEFAULT_ORIGIN;
}

/** ลิงก์รูปใบหน้าสำหรับใส่ในการ์ด LINE — ถ้ามีรูปของเหตุการณ์นี้
 *
 * รูปถูกอัปโหลดแยกทาง `/api/photo` ก่อนเหตุการณ์จะถูก ingest เพราะ payload ของ LINE ถูกแช่แข็ง
 * ตั้งแต่ความพยายามส่งครั้งแรก ⇒ ถ้ารูปมาทีหลัง การ์ดจะไม่มีทางได้มันไปแสดง
 *
 * โทเคนอายุ 15 นาที · ถ้าหมดอายุแล้วรูปในการ์ดจะแตก ซึ่งเป็นผลที่ตั้งใจ
 */
export async function resolvePhoto(db, event, origin) {
    if (!origin || !event?.id || !event?.cabinetId) return null;
    try {
        const snap = await db.doc(`photos/${event.cabinetId}~${event.id}`).get();
        if (!snap.exists) return null;
        const token = snap.data()?.viewToken;
        if (typeof token !== 'string' || !token) return null;
        return `${origin}/api/photo?event=${encodeURIComponent(`${event.cabinetId}~${event.id}`)}&t=${encodeURIComponent(token)}`;
    } catch { return null; }
}

export async function deliverEvent(db, event, { env = process.env, send = pushLine, now = Date.now, resolve = resolveStudent, photo = resolvePhoto, auth = null } = {}) {
    // อ่านชื่อนอกทรานแซกชัน — ทรานแซกชันของ Firestore ห้ามอ่านหลังเขียน และ payload ที่เคย
    // เก็บไว้แล้วถูกใช้ซ้ำตอน retry อยู่แล้ว จึงไม่ต้องอ่านซ้ำให้ตรงจังหวะ
    const student = await resolve(db, event, auth);
    const origin = publicOrigin(env);
    const photoUrl = await photo(db, event, origin);
    const ref = db.doc(`_deliveries/${eventKey(event)}`);
    const record = db.doc(`${eventCollection(event)}/${eventKey(event)}`);
    const owner = randomUUID();
    const claim = await db.runTransaction(async tx => {
        const snap = await tx.get(ref);
        const state = snap.data();
        if (['delivered', 'skipped', 'manual_review'].includes(state.status)) return { status: state.status };
        const time = now();
        if (state.firstAttemptAt !== null && time - state.firstAttemptAt >= RETRY_HORIZON_MS) {
            tx.update(ref, { status: 'manual_review', leaseUntil: 0 });
            tx.update(record, { lineStatus: 'manual_review' });
            return { status: 'manual_review' };
        }
        if (state.leaseUntil > time || !env.LINE_GROUP_ID || !env.LINE_CHANNEL_ACCESS_TOKEN) return { status: 'pending' };
        const payload = state.payload || { to: env.LINE_GROUP_ID.trim(), messages: [lineMessage(event, { student, origin, photoUrl })] };
        tx.update(ref, { owner, leaseUntil: time + 30000, firstAttemptAt: state.firstAttemptAt ?? time, payload });
        return { status: 'claimed', retryKey: state.retryKey, payload };
    });
    if (claim.status !== 'claimed') return claim.status;
    const success = await send(claim.payload, claim.retryKey, env);
    return db.runTransaction(async tx => {
        const current = (await tx.get(ref)).data();
        if (current.status === 'delivered') return 'delivered';
        if (success) {
            tx.update(ref, { status: 'delivered', leaseUntil: 0 });
            tx.update(record, { lineDelivered: true, lineStatus: 'delivered' });
            return 'delivered';
        }
        if (current.owner === owner) tx.update(ref, { leaseUntil: 0 });
        return 'pending';
    });
}
