import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const CABINET_ID = /^[a-zA-Z0-9_-]{1,48}$/;
export const EVENT_ID = /^[a-zA-Z0-9_-]{8,80}$/;
// uid ของบัญชี Firebase — **คนละสัญญากับ EVENT_ID** ถึงหน้าตาจะคล้ายกัน
//
// ต้องอยู่ที่เดียวและใช้ร่วมกันทั้งฝั่งตู้ (`edge/mqtt-cloud.mjs`) กับฝั่ง ingest
// (`lib/cabinet-events.js`) ไม่งั้นด่านหนึ่งรับแล้วอีกด่านปฏิเสธ: uid ที่มีขีดหรือขีดล่าง
// (เช่น `api-student` ที่ใช้อยู่ในเทส) ผ่าน MQTT แล้วไปตายตอน ingest ซึ่ง validate ทั้งชุด
// ก่อนเขียน ⇒ เหตุการณ์ใบเดียวทำทั้งชุดตกและ outbox วนส่งซ้ำไม่จบ
// ขอบเขต 1–128 ตัวอักษรตามที่ Firebase Auth รับ ไม่ใช่ 8–64 ของรหัสคำสั่ง
export const ACCOUNT_UID = /^[a-zA-Z0-9_-]{1,128}$/;
export const digest = value => createHash('sha256').update(value).digest('hex');
export const mac = (secret, value) => createHmac('sha256', secret).update(value).digest('hex');
export function equalMac(a, b) {
    return typeof a === 'string' && /^[a-f0-9]{64}$/.test(a) &&
        typeof b === 'string' && /^[a-f0-9]{64}$/.test(b) &&
        timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}
export function requestSignature(secret, method, path, cabinetId, timestamp, body = '') {
    return mac(secret, ['SFAB1', method, path, cabinetId, timestamp, digest(body)].join('\n'));
}
export function signedHeaders(secret, method, path, cabinetId, body = '', now = Date.now()) {
    const timestamp = String(now);
    return { 'x-sfab-cabinet': cabinetId, 'x-sfab-timestamp': timestamp,
        'x-sfab-signature': requestSignature(secret, method, path, cabinetId, timestamp, body) };
}
export function authenticateCabinet(req, body, path, env = process.env, now = Date.now()) {
    const secret = env.SFAB_CABINET_SECRET;
    const cabinetId = env.SFAB_CABINET_ID || 'box1';
    if (!secret || secret.length < 32 || !CABINET_ID.test(cabinetId)) {
        throw Object.assign(new Error('cabinet_not_configured'), { status: 503 });
    }
    const timestamp = req.headers?.['x-sfab-timestamp'];
    const supplied = req.headers?.['x-sfab-signature'];
    if (req.headers?.['x-sfab-cabinet'] !== cabinetId || !/^\d{13}$/.test(timestamp || '') ||
        now - Number(timestamp) > 30000 || Number(timestamp) - now > 2000 ||
        !equalMac(supplied, requestSignature(secret, req.method, path, cabinetId, timestamp, body))) {
        throw Object.assign(new Error('invalid_cabinet_signature'), { status: 401 });
    }
    return { cabinetId, secret, signature: supplied };
}
export function responseSignature(secret, requestMac, status, etag, body) {
    return mac(secret, ['SFAB1-response', requestMac, status, etag, digest(body)].join('\n'));
}
