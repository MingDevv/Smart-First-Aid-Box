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

// micro:bit หมุนเซอร์โวและ sleep 3 วินาทีก่อนตอบ OK จึงต้องเผื่อเวลารับ event
// แต่ยังคุมงบรวมฝั่งเซิร์ฟเวอร์ให้สั้นกว่า timeout 9.5 วินาทีของเบราว์เซอร์
const MQTT_CONNECT_TIMEOUT_MS = 2500;
const MQTT_PUBLISH_TIMEOUT_MS = 1500;
const DEFAULT_DRAWER_ACK_TIMEOUT_MS = 5500;

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

function mqttConfigured() {
    return (process.env.MQTT_URL || '').trim() !== '';
}

function drawerAckTimeoutMs() {
    // ใช้เฉพาะ test harness ลดเวลารอได้ โดย production ไม่ต้องตั้งค่านี้
    const override = Number(process.env.MQTT_DRAWER_ACK_TIMEOUT_MS);
    return Number.isFinite(override) && override >= 100 ? override : DEFAULT_DRAWER_ACK_TIMEOUT_MS;
}

function commandIdIsValid(value) {
    return typeof value === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(value);
}

function createCommandId() {
    return 'c-' + Date.now().toString(36) + '-' + Math.random().toString(16).slice(2, 10);
}

// Vercel อุ่นเครื่อง (warm) ฟังก์ชันไว้ระหว่าง request เก็บ client ไว้ใช้ซ้ำได้
// แต่หนึ่ง isolate ต้องมี client ที่ยังไม่ end อยู่เพียงตัวเดียวเท่านั้น
let activeClientState = null;
let clientPromise = null;
let retirementPromise = null;
let clientCreationCount = 0;

// แต่ละ id อาจมี request ซ้ำที่กำลังรออยู่พร้อมกัน จึงเก็บ waiter เป็น Set
const drawerAckWaiters = new Map();

function settleDrawerAck(data) {
    if (!data || !['drawer_opened', 'cmd_rejected', 'ack_timeout'].includes(data.event)) return;
    if (!commandIdIsValid(data.id)) return;

    const waiters = drawerAckWaiters.get(data.id);
    if (!waiters) return;

    for (const waiter of [...waiters]) {
        if (data.event === 'drawer_opened' && Number(data.drawer) !== waiter.drawer) continue;
        waiter.finish(data);
    }
}

function createDrawerAckWaiter(commandId, drawer) {
    let settled = false;
    let resolvePromise;
    const promise = new Promise((resolve) => { resolvePromise = resolve; });

    const waiter = {
        drawer,
        finish(value) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            const waiters = drawerAckWaiters.get(commandId);
            if (waiters) {
                waiters.delete(waiter);
                if (waiters.size === 0) drawerAckWaiters.delete(commandId);
            }
            resolvePromise(value);
        }
    };

    let waiters = drawerAckWaiters.get(commandId);
    if (!waiters) {
        waiters = new Set();
        drawerAckWaiters.set(commandId, waiters);
    }
    waiters.add(waiter);

    const timer = setTimeout(() => waiter.finish(null), drawerAckTimeoutMs());
    return { promise, cancel: () => waiter.finish(null) };
}

function endClient(client) {
    return new Promise((resolve) => {
        if (!client) return resolve();
        // force=true ไม่รอ packet ค้าง; callback ยืนยันว่าตัวเก่าปิดก่อนสร้างตัวใหม่
        try {
            client.end(true, {}, resolve);
        } catch {
            resolve();
        }
    });
}

async function retireClient(client) {
    const state = activeClientState;
    if (state?.client !== client) {
        await endClient(client);
        return;
    }
    if (retirementPromise) return retirementPromise;

    // ready=false กัน request ใหม่หยิบ client ที่กำลังปิด ส่วน getClient จะรอจน end เสร็จ
    state.ready = false;
    const inFlight = (async () => {
        await endClient(client);
        if (activeClientState === state) activeClientState = null;
    })();
    retirementPromise = inFlight;
    try {
        await inFlight;
    } finally {
        if (retirementPromise === inFlight) retirementPromise = null;
    }
}

async function getClient(baseTopic) {
    if (retirementPromise) await retirementPromise;
    if (activeClientState?.ready && activeClientState.baseTopic === baseTopic && activeClientState.client.connected) {
        return activeClientState.client;
    }
    if (clientPromise) return clientPromise;

    const inFlight = (async () => {
        if (activeClientState) {
            const oldState = activeClientState;
            await endClient(oldState.client);
            if (activeClientState === oldState) activeClientState = null;
        }

        const url = (process.env.MQTT_URL || '').trim();
        if (!url) throw new Error('ยังไม่ได้ตั้งค่า MQTT_URL บน Vercel');

        const client = mqtt.connect(url, {
            username: (process.env.MQTT_USERNAME || '').trim() || undefined,
            password: (process.env.MQTT_PASSWORD || '').trim() || undefined,
            clientId: 'sfab-server-' + Math.random().toString(16).slice(2, 10),
            clean: true,
            connectTimeout: MQTT_CONNECT_TIMEOUT_MS,
            // serverless request ถัดไปเป็นผู้ตัดสินใจสร้าง client ใหม่ ไม่ปล่อยตัวเก่าวน reconnect
            reconnectPeriod: 0
        });
        clientCreationCount++;

        const state = { client, baseTopic, ready: false };
        activeClientState = state;

        client.on('message', (topic, payload) => {
            if (topic !== `${baseTopic}/evt`) return;
            try {
                settleDrawerAck(JSON.parse(payload.toString()));
            } catch {
                console.warn('[MQTT] ignored non-JSON event');
            }
        });

        client.on('close', () => {
            // close ของ client เก่าที่มาช้า ห้ามล้าง cache ของ client รุ่นใหม่
            if (activeClientState === state) activeClientState = null;
        });

        return new Promise((resolve, reject) => {
            let settled = false;
            const readyTimer = setTimeout(
                () => fail(new Error('MQTT connection or subscription timed out')),
                MQTT_CONNECT_TIMEOUT_MS
            );

            const fail = async (err) => {
                if (settled) return;
                settled = true;
                clearTimeout(readyTimer);
                if (activeClientState === state) activeClientState = null;
                await endClient(client);
                reject(err);
            };

            client.once('error', fail);
            const onPrematureClose = () => fail(new Error('MQTT connection closed before it was ready'));
            client.once('close', onPrematureClose);
            client.once('connect', () => {
                client.subscribe(`${baseTopic}/evt`, { qos: 1 }, (err) => {
                    if (err) return fail(err);
                    if (settled) return;
                    settled = true;
                    clearTimeout(readyTimer);
                    client.removeListener('error', fail);
                    client.removeListener('close', onPrematureClose);
                    client.on('error', (mqttError) => console.error('[MQTT] error:', mqttError.message));
                    state.ready = true;
                    resolve(client);
                });
            });
        });
    })();

    clientPromise = inFlight;
    try {
        return await inFlight;
    } finally {
        if (clientPromise === inFlight) clientPromise = null;
    }
}

function publish(client, topic, payload) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const done = (err) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (err) reject(err);
            else resolve();
        };
        const timer = setTimeout(() => {
            done(new Error('MQTT PUBACK timed out'));
        }, MQTT_PUBLISH_TIMEOUT_MS);

        client.publish(
            topic,
            JSON.stringify(payload),
            // retain ต้องเป็น false เด็ดขาด — ถ้า retain ไว้ ESP32 จะได้คำสั่งเดิมซ้ำ
            // ทุกครั้งที่ต่อ broker ใหม่ แปลว่าตู้ยาจะเปิดเองตอนไฟกลับมา
            { qos: 1, retain: false },
            done
        );
    });
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
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();

    // localStorage ไม่ใช่แหล่งจริงว่าขาลง MQTT ใช้ได้หรือไม่ — ให้ server รายงานเอง
    if (req.method === 'GET') {
        return res.status(200).json({
            success: true,
            mqttConfigured: mqttConfigured(),
            mqttConnected: !!(activeClientState?.ready && activeClientState.client.connected)
        });
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ success: false, error: 'Method Not Allowed', mqttConfigured: mqttConfigured() });
    }

    const clientIp = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown-ip';
    if (checkRateLimit(clientIp)) {
        console.warn(`[MQTT Command] Rate limit exceeded for IP: ${clientIp}`);
        return res.status(429).json({
            success: false,
            error: 'ส่งคำสั่งถี่เกินไป กรุณารอสักครู่แล้วลองใหม่',
            mqttConfigured: mqttConfigured()
        });
    }

    const { action, woundId, drawer, state, id } = req.body || {};

    if (action !== 'open' && action !== 'buzzer') {
        return res.status(400).json({
            success: false,
            error: 'คำสั่งไม่ถูกต้อง (action ต้องเป็น open หรือ buzzer)',
            mqttConfigured: mqttConfigured()
        });
    }

    if (id !== undefined && !commandIdIsValid(id)) {
        return res.status(400).json({ success: false, error: 'รหัสคำสั่งไม่ถูกต้อง', mqttConfigured: mqttConfigured() });
    }

    const baseTopic = (process.env.MQTT_BASE_TOPIC || 'crms6/firstaidbox/box1').trim().replace(/\/+$/, '');
    const commandId = id || createCommandId();

    let payload;
    let compartment = null;

    if (action === 'open') {
        compartment = Number(drawer) || WOUND_COMPARTMENT_MAP[woundId] || 1;
        if (compartment !== 1 && compartment !== 2) {
            return res.status(400).json({
                success: false,
                error: 'หมายเลขลิ้นชักต้องเป็น 1 หรือ 2',
                mqttConfigured: mqttConfigured()
            });
        }
        payload = { action: 'open', drawer: compartment };
    } else {
        if (state !== 'on' && state !== 'off') {
            return res.status(400).json({
                success: false,
                error: 'สถานะเสียงแจ้งเตือนต้องเป็น on หรือ off',
                mqttConfigured: mqttConfigured()
            });
        }
        payload = { action: 'buzzer', state };
    }

    // ใช้ id จาก browser ซ้ำในเส้น LAN ได้ ส่วนเวลาใช้ clock ของ server ที่เชื่อถือได้
    payload.id = commandId;
    payload.ts = Date.now();

    if (!mqttConfigured()) {
        return res.status(503).json({
            success: false,
            mqttConfigured: false,
            commandId,
            error: 'เซิร์ฟเวอร์ยังไม่ได้ตั้งค่า MQTT — ระบบจะลองสั่งผ่านสาย LAN แทน'
        });
    }

    let ackWaiter = null;
    let client = null;

    try {
        client = await getClient(baseTopic);
        // เริ่มนับ 5.5 วินาทีหลัง connect สำเร็จ ไม่เอา cold-start budget มากินเวลา servo
        ackWaiter = action === 'open' ? createDrawerAckWaiter(commandId, compartment) : null;
        await publish(client, `${baseTopic}/cmd`, payload);
        console.log(`[MQTT Command] published ${payload.id} action=${payload.action}`);

        // PUBACK ยืนยันเพียงว่า broker รับข้อความ ไม่ได้แปลว่าลิ้นชักเปิด
        if (action === 'open') {
            const ack = await ackWaiter.promise;
            if (!ack || ack.event !== 'drawer_opened') {
                const rejected = ack?.event === 'cmd_rejected';
                const uartTimedOut = ack?.event === 'ack_timeout';
                return res.status(rejected ? 409 : 504).json({
                    success: false,
                    mqttConfigured: true,
                    commandId,
                    error: uartTimedOut
                        ? 'ตู้ยาไม่ได้รับคำยืนยันจาก micro:bit ทาง UART'
                        : rejected
                            ? `ตู้ยาปฏิเสธคำสั่ง${ack.reason ? ` (${ack.reason})` : ''}`
                            : 'ไม่พบคำยืนยันจากลิ้นชักภายในเวลาที่กำหนด — ระบบจะลองสั่งผ่านสาย LAN แทน'
                });
            }

            return res.status(200).json({
                success: true,
                mode: 'mqtt',
                mqttConfigured: true,
                compartment,
                commandId,
                ack: { event: ack.event, id: ack.id, drawer: Number(ack.drawer) }
            });
        }

        return res.status(200).json({
            success: true,
            mode: 'mqtt',
            mqttConfigured: true,
            commandId
        });
    } catch (err) {
        ackWaiter?.cancel();
        if (client) await retireClient(client);
        console.error('[MQTT Command] publish failed:', err.message);
        return res.status(502).json({
            success: false,
            mqttConfigured: true,
            commandId,
            error: 'ส่งคำสั่งขึ้น MQTT broker ไม่สำเร็จ — ระบบจะลองสั่งผ่านสาย LAN แทน'
        });
    }
}

// ให้ integration harness ปิด socket ที่ warm cache ถืออยู่เพื่อให้ process จบสะอาด
export async function closeMqttClientForTests() {
    if (clientPromise) await clientPromise.catch(() => {});
    if (retirementPromise) await retirementPromise.catch(() => {});
    const state = activeClientState;
    if (!state) return;
    await endClient(state.client);
    if (activeClientState === state) activeClientState = null;
}

export function mqttClientStatsForTests() {
    return {
        created: clientCreationCount,
        active: !!activeClientState,
        connecting: !!clientPromise,
        retiring: !!retirementPromise
    };
}
