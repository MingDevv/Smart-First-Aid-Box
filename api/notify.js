import { authorize, apiHeaders } from '../lib/auth.js';

export async function sendSchoolSos(token) {
    const channel = process.env.LINE_CHANNEL_ACCESS_TOKEN?.trim();
    const group = process.env.LINE_GROUP_ID?.trim();
    if (!channel || !group) return { success: false };
    // token เป็น null ได้ — การเรียกครูไม่บังคับล็อกอิน (Bank 2026-09-14) · ถ้าล็อกอินอยู่ก็บอกชื่อให้
    // ถ้าไม่ได้ล็อกอินก็ยังส่ง แต่บอกตามตรงว่าไม่รู้ว่าใคร ครูจะได้รู้ว่าต้องไปดูที่ตู้เอง
    const firstName = (typeof token?.name === 'string' ? token.name : '')
        .trim().split(/\s+/)[0].replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 60) || 'School user';
    // Client names and Flex payloads never reach LINE. UID disambiguates first names.
    const text = token
        ? `SOS — ${firstName}\nReference: ${token.uid}\n${new Date().toISOString()}\nPlease contact the student.`
        : `SOS — unidentified (not signed in)\n${new Date().toISOString()}\nGo to the first aid cabinet.`;
    try {
        const response = await fetch('https://api.line.me/v2/bot/message/push', {
            method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${channel}` },
            body: JSON.stringify({ to: group, messages: [{ type: 'text', text }] }),
            signal: AbortSignal.timeout(8000), redirect: 'error'
        });
        return { success: response.ok };
    } catch { return { success: false }; }
}

const DEDUPE_WINDOW_MS = 120000;
const GLOBAL_WINDOW_MS = 60000;
const GLOBAL_MAX_ATTEMPTS = 10;

export function createNotifyHandler({ authorizeRequest = authorize, send = sendSchoolSos, now = Date.now } = {}) {
    const deliveries = new Map();
    let globalWindow = { count: 0, until: 0 };
    return async function handler(req, res) {
        apiHeaders(res, 'POST, OPTIONS');
        if (req.method === 'OPTIONS') return res.status(204).end();
        if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'method_not_allowed' });
        // การเรียกครูไม่ถูกเกตด้วยตัวตน (Bank 2026-09-14 · ตรงกับกฎเดิมในวิกิข้อ 9 ที่ว่า
        // SOS/ออด/คู่มือ/LINE ไม่ถูกเกตด้วยตัวตน โหมด นาฬิกา หรือเน็ต)
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
            // Reserve before LINE starts so concurrent requests share its actual outcome.
            deliveries.set(uid, delivery);
            delivery.result = Promise.resolve().then(() => send(identity?.token ?? null))
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
