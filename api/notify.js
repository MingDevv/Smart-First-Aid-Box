import { authorize, apiHeaders } from '../lib/auth.js';
import { persistSchoolSos } from '../lib/web-sos.js';

// เคยมี `sendSchoolSos()` อยู่ตรงนี้ ซึ่งปั้นการ์ด Flex ไทยถูกต้องทุกอย่าง — แต่ **ไม่มีใครเรียก**
// ในโปรดักชันเลย เพราะ handler ข้างล่างใช้ `persistSchoolSos` เป็นค่าเริ่มต้น
// มีแต่ tests/auth.test.mjs ที่เรียก ⇒ เทสเขียวอยู่บนฟังก์ชันที่ผู้ใช้ไม่เคยเจอ
// ขณะที่ของจริงส่งข้อความอังกฤษล้วนหาครูมาตลอด
// ลบทิ้ง 2026-09-19 แล้วย้ายการปั้นการ์ดไปอยู่เส้นทางเดียวกับฝั่งตู้ที่ lib/web-sos.js
// **บทเรียน**: ทางที่ถูกซึ่งไม่มีใครเดิน ไม่ต่างจากไม่มี และมันทำให้เทสโกหกแทนที่จะเตือน

const DEDUPE_WINDOW_MS = 120000;
const GLOBAL_WINDOW_MS = 60000;
const GLOBAL_MAX_ATTEMPTS = 10;

export function createNotifyHandler({ authorizeRequest = authorize, send = persistSchoolSos, now = Date.now } = {}) {
    const deliveries = new Map();
    let globalWindow = { count: 0, until: 0 };
    return async function handler(req, res) {
        apiHeaders(res, 'POST, OPTIONS');
        if (req.method === 'OPTIONS') return res.status(204).end();
        if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'method_not_allowed' });
        // SOS/ออด/คู่มือ/LINE ไม่ถูกเกตด้วยตัวตน โหมด นาฬิกา หรือเน็ต
        // ตัวตนกลายเป็นของแถมที่ทำให้ข้อความมีชื่อ ไม่ใช่เงื่อนไขก่อนส่ง · เด็กที่เจ็บจนล็อกอินไม่ไหว
        // ต้องเรียกครูได้ · กันสแปมด้วยเพดานรวมต่อนาที ซึ่งไม่ต้องรู้ว่าใครก็ทำงานได้
        let identity = null;
        try { identity = await authorizeRequest(req); } catch { identity = null; }
        if (req.body?.event !== 'sos') return res.status(400).json({ success: false, error: 'sos_event_required' });
        // ไม่มี uid ให้ใช้เป็นกุญแจกันส่งซ้ำ ก็ใช้ที่อยู่ผู้เรียกแทน คนละคนจึงไม่บังกัน
        const time = now();
        const uid = identity?.token?.uid
            ?? `anon:${(req.headers?.['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown'}`;
        for (const [key, entry] of deliveries) {
            if (entry.settled && entry.until <= time) deliveries.delete(key);
        }
        let delivery = deliveries.get(uid);
        const deduplicated = Boolean(delivery);
        if (!delivery) {
            if (globalWindow.until <= time) globalWindow = { count: 0, until: time + GLOBAL_WINDOW_MS };
            if (globalWindow.count >= GLOBAL_MAX_ATTEMPTS) {
                res.setHeader('Retry-After', String(Math.ceil((globalWindow.until - time) / 1000)));
                return res.status(429).json({ success: false, error: 'too_many_requests' });
            }
            globalWindow.count++;
            delivery = { until: time + DEDUPE_WINDOW_MS, settled: false };
            // จองที่ไว้ก่อนเริ่มส่ง LINE คำขอที่เข้ามาพร้อมกันจะได้ใช้ผลเดียวกัน
            deliveries.set(uid, delivery);
            // ส่ง `symptom` ต่อให้ตัวเขียนเหตุการณ์ด้วย — ของเดิมอ่านแค่ `event` แล้วทิ้งที่เหลือ
            // ⇒ จอเว็บถามว่า "แน่นหน้าอกไหม" แล้วครูไม่มีวันเห็นคำตอบ (แก้ 2026-09-19)
            // ไม่กรองค่าที่นี่โดยตั้งใจ ให้ lib/web-sos.js เป็นคนตรวจกับ enum ที่เดียว
            delivery.result = Promise.resolve().then(() => send(identity?.token ?? null,
                { dedupeKey: uid, symptom: req.body?.symptom ?? null }))
                .then(result => result?.success === true, () => false)
                .then(success => {
                    delivery.settled = true;
                    if (!success) deliveries.delete(uid);
                    return success;
                });
        }
        const success = await delivery.result;
        return res.status(success ? 200 : 503).json(success
            ? { success: true, mode: 'messaging_api', ...(deduplicated ? { deduplicated: true } : {}) }
            : { success: false, error: 'line_unavailable' });
    };
}
export default createNotifyHandler();
