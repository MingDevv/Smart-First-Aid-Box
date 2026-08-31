// API/COMMAND.JS — ขาลง: รับคำสั่งจากหน้าเว็บแล้ว publish ขึ้น MQTT broker
//
// ทำไมต้องผ่านเซิร์ฟเวอร์แทนที่จะให้เบราว์เซอร์ publish เอง:
//   JavaScript ในเบราว์เซอร์เปิดอ่านได้หมด ใครกด View Source ก็เห็นรหัส broker
//   แล้วสั่งเปิดตู้ยาได้จากที่ไหนก็ได้ รหัสที่ publish ได้จึงต้องอยู่ใน env ของ Vercel
//   เท่านั้น ส่วนเบราว์เซอร์ถือแค่รหัสที่ subscribe ได้ (ดู js/mqtt-bridge.js)
//
// ⚠️ ข้อจำกัดที่ต้องรู้: endpoint นี้ยังไม่มีระบบยืนยันตัวตน เพราะหน้า kiosk เป็นหน้า
//   สาธารณะที่ไม่มีการล็อกอิน — ความลับอะไรก็ตามที่ใส่ลงในหน้านั้นก็เปิดอ่านได้อยู่ดี
//   ตอนนี้จึงกันด้วย rate limit สองชั้นเท่านั้น ถ้าจะเปิดใช้จริงนอกโรงเรียน
//   ต้องเพิ่มการยืนยันตัวตนก่อน (ดู MQTT_SETUP.md หัวข้อ "ข้อจำกัดด้านความปลอดภัย")
import mqtt from 'mqtt';

const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const MAX_REQUESTS_PER_IP = 10;
// เพดานรวมทุก IP กันกรณีมีคนยิงจากหลายที่พร้อมกัน เซอร์โวจะได้ไม่ถูกสั่งรัว
const MAX_REQUESTS_GLOBAL = 12;

const rateLimitMap = new Map();
let globalWindow = { count: 0, resetTime: 0 };

function checkRateLimit(ip) {
    const now = Date.now();

    if (now > globalWindow.resetTime) {
        globalWindow = { count: 1, resetTime: now + RATE_LIMIT_WINDOW_MS };
    } else {
        globalWindow.count++;
    }
    if (globalWindow.count > MAX_REQUESTS_GLOBAL) return true;

    const windowData = rateLimitMap.get(ip) || { count: 0, resetTime: now + RATE_LIMIT_WINDOW_MS };
    if (now > windowData.resetTime) {
        windowData.count = 1;
        windowData.resetTime = now + RATE_LIMIT_WINDOW_MS;
    } else {
        windowData.count++;
    }
    rateLimitMap.set(ip, windowData);
    return windowData.count > MAX_REQUESTS_PER_IP;
}

// Vercel อุ่นเครื่อง (warm) ฟังก์ชันไว้ระหว่าง request เก็บ client ไว้ใช้ซ้ำได้
// การต่อ TLS ใหม่ทุกครั้งกินเวลาเกือบครึ่งวินาที ซึ่งรู้สึกได้ตอนกดเปิดตู้ยา
let clientPromise = null;

function getClient() {
    if (clientPromise) return clientPromise;

    const url = (process.env.MQTT_URL || '').trim();
    if (!url) return Promise.reject(new Error('ยังไม่ได้ตั้งค่า MQTT_URL บน Vercel'));

    clientPromise = new Promise((resolve, reject) => {
        const client = mqtt.connect(url, {
            username: (process.env.MQTT_USERNAME || '').trim() || undefined,
            password: (process.env.MQTT_PASSWORD || '').trim() || undefined,
            clientId: 'sfab-server-' + Math.random().toString(16).slice(2, 10),
            clean: true,
            connectTimeout: 8000,
            reconnectPeriod: 2000
        });

        const onFail = (err) => {
            // ทิ้ง client ที่ต่อไม่ติด ไม่งั้น request ถัดไปจะติดอยู่กับตัวที่พังตลอดไป
            clientPromise = null;
            client.end(true);
            reject(err);
        };

        client.once('connect', () => {
            client.removeListener('error', onFail);
            client.on('error', (err) => console.error('[MQTT] error:', err.message));
            client.on('close', () => { clientPromise = null; });
            resolve(client);
        });
        client.once('error', onFail);
    });

    return clientPromise;
}

// แผลแต่ละชนิดอยู่ลิ้นชักไหน — ต้องตรงกับ woundCompartmentMap ใน js/api-bridge.js
const WOUND_COMPARTMENT_MAP = {
    cut_abrasion: 1,
    abrasion: 1,
    cut: 1,
    insect: 2
};

export default async function handler(req, res) {
    const origin = req.headers.origin || '*';
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ success: false, error: 'Method Not Allowed' });
    }

    const clientIp = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown-ip';
    if (checkRateLimit(clientIp)) {
        console.warn(`[MQTT Command] Rate limit exceeded for IP: ${clientIp}`);
        return res.status(429).json({
            success: false,
            error: 'ส่งคำสั่งถี่เกินไป กรุณารอสักครู่แล้วลองใหม่'
        });
    }

    const { action, woundId, drawer, state } = req.body || {};

    if (action !== 'open' && action !== 'buzzer') {
        return res.status(400).json({ success: false, error: 'คำสั่งไม่ถูกต้อง (action ต้องเป็น open หรือ buzzer)' });
    }

    const baseTopic = (process.env.MQTT_BASE_TOPIC || 'crms6/firstaidbox/box1').trim().replace(/\/+$/, '');

    let payload;
    let compartment = null;

    if (action === 'open') {
        compartment = Number(drawer) || WOUND_COMPARTMENT_MAP[woundId] || 1;
        if (compartment !== 1 && compartment !== 2) {
            return res.status(400).json({ success: false, error: 'หมายเลขลิ้นชักต้องเป็น 1 หรือ 2' });
        }
        payload = { action: 'open', drawer: compartment };
    } else {
        if (state !== 'on' && state !== 'off') {
            return res.status(400).json({ success: false, error: 'สถานะเสียงแจ้งเตือนต้องเป็น on หรือ off' });
        }
        payload = { action: 'buzzer', state };
    }

    // id ไว้ไล่ log ว่าคำสั่งไหนไปถึงกล่องบ้าง, ts ให้ฝั่ง ESP32 ใช้ตัดคำสั่งที่ค้างคิวนานเกินไป
    payload.id = 'c-' + Date.now().toString(36) + '-' + Math.random().toString(16).slice(2, 6);
    payload.ts = Date.now();

    try {
        const client = await getClient();

        await new Promise((resolve, reject) => {
            client.publish(
                `${baseTopic}/cmd`,
                JSON.stringify(payload),
                // retain ต้องเป็น false เด็ดขาด — ถ้า retain ไว้ ESP32 จะได้คำสั่งเดิมซ้ำ
                // ทุกครั้งที่ต่อ broker ใหม่ แปลว่าตู้ยาจะเปิดเองตอนไฟกลับมา
                { qos: 1, retain: false },
                (err) => (err ? reject(err) : resolve())
            );
        });

        console.log(`[MQTT Command] published ${payload.id} action=${payload.action}`);
        return res.status(200).json({
            success: true,
            mode: 'mqtt',
            compartment,
            commandId: payload.id
        });
    } catch (err) {
        console.error('[MQTT Command] publish failed:', err.message);
        return res.status(502).json({
            success: false,
            error: 'ส่งคำสั่งขึ้น MQTT broker ไม่สำเร็จ — ระบบจะลองสั่งผ่านสาย LAN แทน'
        });
    }
}
