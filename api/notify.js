import { authorize, apiHeaders } from '../lib/auth.js';
import { persistSchoolSos } from '../lib/web-sos.js';
import { lineMessage } from '../lib/line-flex.js';
import { publicOrigin } from '../lib/cabinet-line.js';

export async function sendSchoolSos(token) {
    const channel = process.env.LINE_CHANNEL_ACCESS_TOKEN?.trim();
    const group = process.env.LINE_GROUP_ID?.trim();
    if (!channel || !group) return { success: false };
    // token เป็น null ได้ — การเรียกครูไม่บังคับล็อกอิน · ถ้าล็อกอินอยู่ก็บอกชื่อให้
    // ถ้าไม่ได้ล็อกอินก็ยังส่ง แต่บอกตามตรงว่าไม่รู้ว่าใคร ครูจะได้รู้ว่าต้องไปดูที่ตู้เอง
    // ชื่อมาจาก token ที่ตรวจแล้วเท่านั้น ไม่เคยมาจากเนื้อคำขอ · ตัดอักขระควบคุมออกกันปลอมบรรทัด
    const firstName = (typeof token?.name === 'string' ? token.name : '')
        .trim().split(/\s+/)[0].replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 60);
    const student = firstName ? { name: firstName } : null;
    // เหตุการณ์สังเคราะห์ให้ตัวสร้างข้อความใช้ร่วมกับฝั่งตู้ ⇒ ครูเห็นหน้าตาเดียวกันทั้งสองทาง
    // `cabinetId: 'web'` ทำให้การ์ดบอกตรงๆ ว่ากดมาจากเว็บ ไม่ใช่กดที่หน้าตู้ ซึ่งเปลี่ยนสิ่งที่ครูต้องทำ
    const event = { kind: 'sos', cabinetId: 'web', ts: new Date().toISOString(),
        buzzerAck: null, clockTrust: 'ntp' };
    const message = lineMessage(event, { student, origin: publicOrigin() });
    try {
        const response = await fetch('https://api.line.me/v2/bot/message/push', {
            method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${channel}` },
            body: JSON.stringify({ to: group, messages: [message] }),
            signal: AbortSignal.timeout(8000), redirect: 'error'
        });
        return { success: response.ok };
    } catch { return { success: false }; }
}

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
            delivery.result = Promise.resolve().then(() => send(identity?.token ?? null, { dedupeKey: uid }))
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
