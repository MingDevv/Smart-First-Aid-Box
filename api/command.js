// API/COMMAND.JS — ขาลง: รับคำสั่งจากหน้าเว็บแล้ว publish ขึ้น MQTT broker
//
// ทำไมต้องผ่านเซิร์ฟเวอร์แทนที่จะให้เบราว์เซอร์ publish เอง:
//   JavaScript ในเบราว์เซอร์เปิดอ่านได้หมด ใครกด View Source ก็เห็นรหัส broker
//   แล้วสั่งเปิดตู้ยาได้จากที่ไหนก็ได้ รหัสที่ publish ได้จึงต้องอยู่ใน env ของ Vercel
//   Server-only credentials; browser requests use Firebase ID tokens.
// Cloud status and open commands require a verified school account. Ringing the SOS buzzer needs no
// account at all; silencing it is staff-only.
import mqtt from 'mqtt';
import { authorize, accessFailure, apiHeaders, AccessError, STAFF_ROLES } from '../lib/auth.js';

const RATE_LIMIT_WINDOW_MS = 60 * 1000;
// โรงเรียนทั้งโรงออกเน็ตผ่าน IP สาธารณะเดียว ⇒ เมื่อนักเรียนสั่งเปิดช่องยาเองได้ เพดานต่อ IP
// กลายเป็นเพดานของทุกคนพร้อมกัน ไม่ใช่เครื่องมือกันคนก่อกวนอีกต่อไป
// แกนที่แยกคนออกจากกันได้จริงคือ uid ซึ่งมีทุกคำสั่งที่ต้องล็อกอิน
// ออด SOS ที่ยิงได้โดยไม่ล็อกอินไม่มี uid ⇒ เหลือเพดานต่อ IP กับเพดานรวมเป็นตัวกันของมัน
const MAX_REQUESTS_PER_USER = 4;
const MAX_REQUESTS_PER_IP = 30;
// เพดานรวมทุก IP กันกรณีมีคนยิงจากหลายที่พร้อมกัน เซอร์โวจะได้ไม่ถูกสั่งรัว
const MAX_REQUESTS_GLOBAL = 30;

// Firmware advertises its measured motor budget. Include connect/status overhead
// in the browser deadline; Vercel allows 180 seconds for this handler.
const MQTT_CONNECT_TIMEOUT_MS = 4500;
const MQTT_PUBLISH_TIMEOUT_MS = 2500;
const MQTT_STATUS_TIMEOUT_MS = 2000;
const STATUS_MAX_AGE_MS = 5000;

const rateLimitMap = new Map();
let globalWindow = { count: 0, resetTime: 0 };

function overBudget(key, max, now) {
    const windowData = rateLimitMap.get(key) || { count: 0, resetTime: now + RATE_LIMIT_WINDOW_MS };
    if (now > windowData.resetTime) {
        windowData.count = 1;
        windowData.resetTime = now + RATE_LIMIT_WINDOW_MS;
    } else {
        windowData.count++;
    }
    rateLimitMap.set(key, windowData);
    return windowData.count > max;
}

function checkRateLimit(ip, uid) {
    const now = Date.now();

    if (now > globalWindow.resetTime) {
        globalWindow = { count: 1, resetTime: now + RATE_LIMIT_WINDOW_MS };
    } else {
        globalWindow.count++;
    }
    if (globalWindow.count > MAX_REQUESTS_GLOBAL) return true;

    // นับทั้งสองถังเสมอ ไม่ใช้ `||` ลัด — ถังที่ไม่ถูกนับในรอบที่อีกถังเต็ม จะทำให้คนที่ยิงรัว
    // "ได้โควตาคืน" ทุกครั้งที่เพื่อนร่วม IP ชนเพดานก่อน
    const ipOver = overBudget(`ip:${ip}`, MAX_REQUESTS_PER_IP, now);
    // ออด SOS ยิงได้โดยไม่ล็อกอิน ⇒ ไม่มี uid ให้นับ เหลือเพดานต่อ IP กับเพดานรวมเป็นตัวกัน
    const userOver = uid ? overBudget(`uid:${uid}`, MAX_REQUESTS_PER_USER, now) : false;
    return ipOver || userOver;
}

function mqttConfigured() {
    return (process.env.MQTT_URL || '').trim() !== '';
}

function hardwareStatus(state) {
    const data = state?.hardware;
    const validBudget = Number.isInteger(data?.ackTimeoutMs) && data.ackTimeoutMs >= 3000 && data.ackTimeoutMs <= 120000;
    const age = Date.now() - data?.ts;
    const connected = !!(state?.ready && state.client.connected && data?.protocol === 2 &&
        data.online === true && data.microbit === 'connected' && validBudget &&
        Number.isFinite(age) && age >= -2000 && age <= STATUS_MAX_AGE_MS);
    return { connected, ready: connected && data.ready === true, protocol: data?.protocol,
        ackTimeoutMs: connected ? data.ackTimeoutMs : null,
        commandTimeoutMs: connected ? data.ackTimeoutMs + 10000 : null,
        reason: data?.reason === 'awaiting_new_ready_epoch' ? data.reason : '', mode: 'mqtt' };
}

async function readHardwareStatus(client) {
    const deadline = Date.now() + MQTT_STATUS_TIMEOUT_MS;
    while (activeClientState?.client === client && !activeClientState.hardware &&
        client.connected && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    return hardwareStatus(activeClientState?.client === client ? activeClientState : null);
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
    if (!data || data.protocol !== 2 || !['drawer_opened', 'buzzer_set', 'cmd_rejected', 'ack_timeout'].includes(data.event)) return;
    if (!commandIdIsValid(data.id)) return;

    const waiters = drawerAckWaiters.get(data.id);
    if (!waiters) return;

    for (const waiter of [...waiters]) {
        if (data.event === 'drawer_opened' && (waiter.action !== 'open' || data.drawer !== waiter.drawer)) continue;
        if (data.event === 'buzzer_set' && (waiter.action !== 'buzzer' || data.state !== waiter.state)) continue;
        waiter.finish(data);
    }
}

function createDrawerAckWaiter(command, timeoutMs) {
    const commandId = command.id;
    let settled = false;
    let resolvePromise;
    const promise = new Promise((resolve) => { resolvePromise = resolve; });

    const waiter = {
        action: command.action, drawer: command.drawer, state: command.state,
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

    const timer = setTimeout(() => waiter.finish(null), timeoutMs);
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

        const state = { client, baseTopic, ready: false, hardware: null };
        activeClientState = state;

        client.on('message', (topic, payload, packet) => {
            try {
                const data = JSON.parse(payload.toString());
                if (topic === `${baseTopic}/status`) state.hardware = data;
                // A retained result from an earlier connection is never completion evidence.
                if (topic === `${baseTopic}/evt` && !packet.retain) settleDrawerAck(data);
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
                client.subscribe([`${baseTopic}/evt`, `${baseTopic}/status`], { qos: 1 }, (err, granted) => {
                    if (err || granted?.length !== 2 || granted.some(g => g.qos > 2)) {
                        return fail(new Error('MQTT event/status subscription denied'));
                    }
                    if (settled) return;
                    settled = true;
                    clearTimeout(readyTimer);
                    client.removeListener('error', fail);
                    client.removeListener('close', onPrematureClose);
                    client.on('error', () => console.error('[MQTT] connection error'));
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

export function createCommandHandler(authorizeRequest = authorize) {
return async function handler(req, res) {
    apiHeaders(res, 'GET, POST, OPTIONS');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (!['GET', 'POST'].includes(req.method)) {
        return res.status(405).json({ success: false, error: 'Method Not Allowed', retrySafe: true });
    }
    // บัญชีโรงเรียนที่ยืนยันแล้วก็พอสำหรับอ่านสถานะและเปิดช่องยา — เกต staff ย้ายไปอยู่กับ
    // action ที่ต้องการมันจริงๆ (buzzer off) ข้างล่าง แทนที่จะปิดทั้งไฟล์
    //
    // **ออด SOS ดังได้โดยไม่ต้องล็อกอิน**: คนที่เจ็บอาจไม่ใช่เจ้าของ
    // เครื่อง ไม่มีบัญชีโรงเรียน หรือล็อกอินไม่ทัน · การขอให้ล็อกอินก่อนเรียกคนช่วย คือการ
    // กันคนออกจากความช่วยเหลือในนาทีที่ต้องการมันที่สุด ⇒ ยอมแลกกับความเสี่ยงเรื่องคนก่อกวน
    // ซึ่งกันด้วยเพดานต่อ IP/รวม ข้างล่าง และ `SFAB_CLOUD_ACTIONS` ฝั่งตู้
    const ringingSos = req.method === 'POST' && req.body?.action === 'buzzer' && req.body?.state === 'on';
    let actor = null;
    try { actor = await authorizeRequest(req); }
    catch (error) { if (!ringingSos) return accessFailure(res, error); }

    // localStorage ไม่ใช่แหล่งจริงว่าขาลง MQTT ใช้ได้หรือไม่ — ให้ server รายงานเอง
    if (req.method === 'GET') {
        if (!mqttConfigured()) return res.status(200).json({ success: true, mqttConfigured: false, connected: false });
        try {
            const baseTopic = (process.env.MQTT_BASE_TOPIC || 'crms6/firstaidbox/box1').trim().replace(/\/+$/, '');
            const client = await getClient(baseTopic);
            const hardware = await readHardwareStatus(client);
            return res.status(200).json({ success: true, mqttConfigured: true, mqttConnected: client.connected, ...hardware });
        } catch {
            return res.status(503).json({ success: false, mqttConfigured: true, connected: false });
        }
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ success: false, error: 'Method Not Allowed', mqttConfigured: mqttConfigured(), retrySafe: true });
    }

    const clientIp = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown-ip';
    if (checkRateLimit(clientIp, actor?.token?.uid || null)) {
        console.warn(`[MQTT Command] Rate limit exceeded for IP: ${clientIp}`);
        return res.status(429).json({
            success: false,
            error: 'ส่งคำสั่งถี่เกินไป กรุณารอสักครู่แล้วลองใหม่',
            mqttConfigured: mqttConfigured(), retrySafe: true
        });
    }

    const { action, woundId, drawer, state, id, ackTimeoutMs } = req.body || {};

    if (action !== 'open' && action !== 'buzzer') {
        return res.status(400).json({
            success: false,
            error: 'คำสั่งไม่ถูกต้อง (action ต้องเป็น open หรือ buzzer)',
            mqttConfigured: mqttConfigured(), retrySafe: true
        });
    }

    // ออด "ดัง" = ใครกดก็ได้ ไม่ต้องล็อกอิน
    // ออด "หยุด" = ครูเท่านั้น — ไม่งั้นคนที่ก่อเหตุปิดปาก SOS ของตัวเองได้ และเสียงที่ใครก็
    // ปิดได้ไม่ใช่สัญญาณขอความช่วยเหลือ · ไม่ได้ล็อกอิน (`actor` เป็น null) ก็หยุดไม่ได้เช่นกัน
    if (action === 'buzzer' && state !== 'on' && !STAFF_ROLES.includes(actor?.role)) {
        return accessFailure(res, new AccessError(403, 'staff_role_required'));
    }

    if (id !== undefined && !commandIdIsValid(id)) {
        return res.status(400).json({ success: false, error: 'รหัสคำสั่งไม่ถูกต้อง', mqttConfigured: mqttConfigured(), retrySafe: true });
    }

    const baseTopic = (process.env.MQTT_BASE_TOPIC || 'crms6/firstaidbox/box1').trim().replace(/\/+$/, '');
    const commandId = id || createCommandId();

    let payload;
    let compartment = null;

    if (action === 'open') {
        compartment = drawer === undefined ? WOUND_COMPARTMENT_MAP[woundId] : drawer;
        if (compartment !== 1 && compartment !== 2) {
            return res.status(400).json({
                success: false,
                error: 'หมายเลขลิ้นชักต้องเป็น 1 หรือ 2',
                mqttConfigured: mqttConfigured(), retrySafe: true
            });
        }
        // ส่ง **uid เปล่าๆ** ไปกับคำสั่ง ไม่ส่งชื่อหรืออีเมล
        //
        // ชื่อกับอีเมลเป็นข้อมูลส่วนบุคคล และ broker เป็นบริการภายนอก ⇒ ของที่เดินทางบน MQTT
        // ควรเป็นตัวชี้ที่เปิดอ่านเองไม่ได้ · ฝั่ง Vercel แปลง uid เป็นชื่อตอนจะส่ง LINE เท่านั้น
        // (`resolveStudent`) ซึ่งได้ชื่อล่าสุดเสมอด้วย ไม่ใช่ชื่อที่แช่แข็งไว้ตอนกดปุ่ม
        payload = { action: 'open', drawer: compartment, ...(actor ? { actorUid: actor.token.uid } : {}) };
    } else {
        if (state !== 'on' && state !== 'off') {
            return res.status(400).json({
                success: false,
                error: 'สถานะเสียงแจ้งเตือนต้องเป็น on หรือ off',
                mqttConfigured: mqttConfigured(), retrySafe: true
            });
        }
        payload = { action: 'buzzer', state };
    }

    // ใช้ id จาก browser ซ้ำในเส้น LAN ได้ ส่วนเวลาใช้ clock ของ server ที่เชื่อถือได้
    payload.id = commandId;
    payload.protocol = 2;

    if (!mqttConfigured()) {
        return res.status(503).json({
            success: false,
            mqttConfigured: false,
            commandId,
            // เคยเขียนว่า "ระบบจะลองสั่งผ่านสาย LAN แทน" ซึ่งไม่จริงมาตั้งแต่เลิกเส้น LAN ฝั่งเบราว์เซอร์
            // — `sendLanCommand`/`sendLanOpen` ไม่มีใครเรียกแล้ว ⇒ ข้อความนั้นส่งคนไปตามหาทางที่ไม่มีอยู่
            error: 'เซิร์ฟเวอร์ยังไม่ได้ตั้งค่า MQTT จึงสั่งตู้จากเว็บไม่ได้ กรุณาใช้หน้าจอที่ตัวตู้ หรือแจ้งครูผู้ดูแลระบบ'
        });
    }

    let ackWaiter = null;
    let client = null;
    let published = false;

    try {
        client = await getClient(baseTopic);
        const hardware = await readHardwareStatus(client);
        if (!hardware.connected || (action === 'open' && !hardware.ready) ||
            (ackTimeoutMs !== undefined && ackTimeoutMs !== hardware.ackTimeoutMs)) {
            return res.status(503).json({ success: false, mqttConfigured: true, commandId, retrySafe: true,
                error: 'ยังไม่ได้ส่งคำสั่ง ตู้ยังไม่พร้อมหรือข้อมูลเวลารอเปลี่ยน กรุณาตรวจสถานะแล้วลองใหม่' });
        }
        // Reserve the waiter before publishing: a fast board may ACK before broker PUBACK.
        ackWaiter = createDrawerAckWaiter(payload, hardware.ackTimeoutMs + 3000);
        payload.ts = Date.now();
        published = true;
        await publish(client, `${baseTopic}/cmd`, payload);
        const ack = await ackWaiter.promise;
        if (!ack || !['drawer_opened', 'buzzer_set'].includes(ack.event)) {
            return res.status(ack?.event === 'cmd_rejected' ? 409 : 504).json({
                success: false, mqttConfigured: true, commandId,
                error: ack?.event === 'cmd_rejected'
                    ? 'ตู้ปฏิเสธคำสั่ง กรุณาตรวจสถานะหน้าตู้'
                    : 'ยังยืนยันผลจาก micro:bit ไม่ได้ กรุณาตรวจตู้ก่อน ห้ามสั่งซ้ำ'
            });
        }
        return res.status(200).json({
            success: true, mode: 'mqtt', mqttConfigured: true, compartment, commandId,
            ack: { protocol: 2, event: ack.event, id: ack.id,
                ...(action === 'open' ? { drawer: ack.drawer } : { state: ack.state }) }
        });
    } catch (err) {
        ackWaiter?.cancel();
        if (client) await retireClient(client);
        console.error('[MQTT Command] transport failed');
        return res.status(502).json({
            success: false,
            mqttConfigured: true,
            commandId,
            retrySafe: !published,
            error: published ? 'การเชื่อมต่อขัดข้อง ผลคำสั่งยังไม่แน่นอน กรุณาตรวจตู้ก่อน ห้ามสั่งซ้ำ'
                : 'ยังไม่ได้ส่งคำสั่ง เชื่อมต่อ MQTT ไม่สำเร็จ กรุณาตรวจการตั้งค่า'
        });
    }
};
}
export default createCommandHandler();

// ให้ integration harness ปิด socket ที่ warm cache ถืออยู่เพื่อให้ process จบสะอาด
export async function closeMqttClientForTests() {
    if (clientPromise) await clientPromise.catch(() => {});
    if (retirementPromise) await retirementPromise.catch(() => {});
    const state = activeClientState;
    if (!state) return;
    await endClient(state.client);
    if (activeClientState === state) activeClientState = null;
}

// ถังนับถูกคีย์ด้วย uid แล้ว ⇒ เทสหลายเคสในไฟล์เดียวที่ใช้ uid เดียวกันจะกินโควตากันเอง
// และล้มด้วย 429 ที่ไม่เกี่ยวกับสิ่งที่มันกำลังตรวจ · ล้างถังก่อนเคสที่นับจำนวนคำสั่งจริงจัง
export function resetRateLimitForTests() {
    rateLimitMap.clear();
    globalWindow = { count: 0, resetTime: 0 };
}

export function mqttClientStatsForTests() {
    return {
        created: clientCreationCount,
        active: !!activeClientState,
        connecting: !!clientPromise,
        retiring: !!retirementPromise
    };
}
