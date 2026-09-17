// Pi มานั่งที่เดิมของ ESP32 บน broker หัวข้อเดิม payload เดิม ฝั่ง Vercel จึงไม่ต้องแก้
// คำสั่งที่มาทางนี้ส่งต่อให้ LocalController ตัวเดียวกับจอตู้ ผ่านด่านเดียวกันทุกด่าน
// สั่งจากคลาวด์จึงทำอะไรได้ไม่เกินสั่งจากจอ
//
// ห้ามให้ไฟล์นี้อยู่ในสายที่จอตู้ import แพ็กเกจ mqtt โหลดตอนเรียก startCloudBridge เท่านั้น
// ตู้ที่ไม่มี node_modules หรือไม่ได้ตั้ง MQTT_URL จะได้เปิดจอทำงานได้ตามปกติ
// นำเข้าได้ปลอดภัยแม้ไฟล์นี้ห้ามอยู่บนสายนำเข้าของเส้นทางในเครื่อง — `cabinet-protocol.js`
// พึ่งแต่ `node:crypto` และ `edge/student-session.mjs` ซึ่งอยู่บนเส้นทางนั้นก็นำเข้ามันอยู่แล้ว
import { ACCOUNT_UID } from '../lib/cabinet-protocol.js';

const ID = /^[a-zA-Z0-9_-]{8,64}$/;
// กันคำสั่งเก่า 3 แบบ คำสั่งที่ค้างคิวตอนเน็ตหลุดต้องไม่เปิดตู้ตอนเน็ตกลับมาแล้วไม่มีใครอยู่
// ถ้านาฬิกา Pi ยังไม่ sync ก็ตัดสินเวลาไม่ได้ ห้ามทำตาม
// เผื่อเวลาอนาคตไว้ 2 วิ เท่ากับที่ Vercel ยอมให้คลาดเคลื่อน
const MAX_CMD_AGE_MS = 30000;
const MAX_FUTURE_MS = 2000;
const CLOCK_SANE_AFTER_MS = 1_700_000_000_000;
// Vercel ถือว่าสถานะเก่าเกิน 5 วิ คือออฟไลน์ จึงต้องส่งทุกวินาที
// ใช้ QoS 0 พอ เพราะมี will กับการเช็คอายุคุมอยู่แล้ว ถ้าใช้ QoS 1 ข้อความที่ยังไม่ ack
// จะกองสะสมตอนสายครึ่งใบ
const STATUS_INTERVAL_MS = 1000;
const CLOSE_PUBLISH_MS = 2000;
const CLOSE_END_MS = 3000;
const URL_SCHEME = /^(mqtts?|wss?):\/\//;

const parseActions = value => new Set((value ?? 'open,buzzer').split(',').map(s => s.trim()).filter(Boolean));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

export class CloudBridge {
    constructor({ controller, url, connect, username = '', password = '', baseTopic = 'crms6/firstaidbox/box1',
        cloudActions = 'open,buzzer', now = Date.now, log = console, statusIntervalMs = STATUS_INTERVAL_MS }) {
        if (!controller || !url || typeof connect !== 'function') throw new Error('CloudBridge needs a controller, an MQTT url and a connect function');
        this.controller = controller;
        this.url = url;
        this.auth = { username: username || undefined, password: password || undefined };
        this.base = baseTopic.trim().replace(/\/+$/, '');
        this.topics = { cmd: `${this.base}/cmd`, evt: `${this.base}/evt`, status: `${this.base}/status` };
        // คำสั่งที่ยอมให้สั่งจากอินเทอร์เน็ตได้ ตรงนี้คือที่เดียวที่โรงเรียนบอกได้ว่า
        // "เว็บสั่งออดได้ แต่เปิดลิ้นชักไม่ได้" โดยไม่ต้องไปแก้อะไรบน Vercel
        this.cloudActions = parseActions(cloudActions);
        this.connect = connect;
        this.now = now;
        this.log = log;
        this.statusIntervalMs = statusIntervalMs;
        this.client = null;
        this.timer = null;
        this.closed = false;
        this.statusInFlight = false;
        this.lastError = null;
        this.wasConnected = false;
    }

    start() {
        this.client = this.connect(this.url, {
            ...this.auth,
            clientId: 'sfab-pi-' + Math.random().toString(16).slice(2, 10),
            clean: true,
            keepalive: 30,
            connectTimeout: 10000,
            // ฝั่งตู้ต้องพยายามต่อเองเรื่อยๆ ต่างจากฝั่ง serverless ที่จบเป็นครั้งๆ
            reconnectPeriod: 5000,
            // ถ้า Pi หลุด broker จะประกาศข้อความนี้ให้เอง และค้างไว้ หน้าเว็บที่เปิดตอนตู้ดับ
            // จะได้เห็นว่าออฟไลน์ ไม่ใช่เห็นสถานะพร้อมใช้ค้างจากครั้งก่อน
            will: { topic: this.topics.status, payload: JSON.stringify({ protocol: 2, online: false }), qos: 1, retain: true }
        });
        this.client.on('connect', () => {
            this.lastError = null;
            this.client.subscribe(this.topics.cmd, { qos: 1 }, (err, granted) => {
                if (err) return this.log.error(`[SFAB cloud] cmd subscribe failed: ${err.message}`);
                if (granted?.[0]?.qos > 2) return this.log.error('[SFAB cloud] cmd subscription denied by broker (check the credential permission)');
                if (!this.wasConnected) this.log.log(`[SFAB cloud] on broker as ${this.base}`);
                this.wasConnected = true;
                this.publishStatus();
                if (this.statusIntervalMs > 0 && !this.timer) {
                    this.timer = setInterval(() => this.publishStatus(), this.statusIntervalMs);
                    this.timer.unref?.();
                }
            });
        });
        this.client.on('message', (topic, payload, packet) => {
            this.onCommand(topic, payload, packet).catch(e => this.log.error('[SFAB cloud] command failed', e.message));
        });
        this.client.on('close', () => {
            this.stopHeartbeat();
            if (this.wasConnected && !this.closed) this.log.error('[SFAB cloud] broker link lost — reconnecting');
            this.wasConnected = false;
        });
        // ตู้ที่เน็ตตายจะลองใหม่ทุก 5 วิ เป็นชั่วโมง เขียน log ครั้งเดียวพอ
        this.client.on('error', e => {
            if (e.message === this.lastError) return;
            this.lastError = e.message;
            this.log.error(`[SFAB cloud] mqtt error: ${e.message}`);
        });
        return this;
    }

    stopHeartbeat() {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }

    // ackTimeoutMs ต้องเป็นจำนวนเต็ม 3000-120000 Vercel ถึงจะนับว่าตู้ต่ออยู่
    // ค่านี้รู้ได้เฉพาะตอน micro:bit ตอบ ถ้าถอดบอร์ดออกจะส่ง null ไป = ออฟไลน์
    // ready:false พร้อมเหตุผล ทำให้เว็บปฏิเสธตั้งแต่ต้น ไม่ต้องส่งคำสั่งที่ยังไงก็ถูกปฏิเสธ
    async statusDocument() {
        const hw = await this.controller.status();
        const connected = hw.connected === true;
        const reason = hw.reason === 'awaiting_new_ready_epoch' ? hw.reason
            : !connected ? ''
                : hw.deviceMode !== 'real' ? `mode_${hw.deviceMode}`
                    : hw.unresolved ? 'unresolved_hold'
                        : !this.cloudActions.has('open') ? 'cloud_open_disabled' : '';
        return {
            protocol: 2, online: true, transport: 'pi',
            microbit: connected ? 'connected' : 'unknown',
            ready: connected && hw.ready === true && reason === '',
            ackTimeoutMs: connected && Number.isInteger(hw.ackTimeoutMs) ? hw.ackTimeoutMs : null,
            reason,
            ts: this.now()
        };
    }

    // ส่งสถานะทีละครั้ง ถ้ามีคำขอเข้ามาระหว่างที่กำลังส่งอยู่ ให้รวบไปส่งรอบถัดไปรอบเดียว
    // สถานะที่เปลี่ยนจะได้ไม่หาย และไม่กองซ้อนกัน
    async publishStatus() {
        if (this.closed || !this.client?.connected) return;
        if (this.statusInFlight) { this.statusDirty = true; return; }
        this.statusInFlight = true;
        try {
            do {
                this.statusDirty = false;
                await this.publish(this.topics.status, await this.statusDocument(), { qos: 0, retain: true });
            } while (this.statusDirty && !this.closed && this.client?.connected);
        } catch (e) {
            this.log.error('[SFAB cloud] status publish failed', e.message);
        } finally {
            this.statusInFlight = false;
            this.statusDirty = false;
        }
    }

    publish(topic, doc, { qos = 1, retain = false } = {}) {
        return new Promise((resolve, reject) => {
            this.client.publish(topic, JSON.stringify(doc), { qos, retain }, err => err ? reject(err) : resolve());
        });
    }

    reject(id, reason) {
        const doc = { protocol: 2, event: 'cmd_rejected', reason, ts: this.now() };
        if (id) doc.id = id;
        return this.publish(this.topics.evt, doc);
    }

    async onCommand(topic, payload, packet) {
        if (topic !== this.topics.cmd) return;
        let doc;
        try {
            doc = JSON.parse(payload.toString());
        } catch {
            return this.reject(undefined, 'invalid_json');
        }
        const id = typeof doc?.id === 'string' && ID.test(doc.id) ? doc.id : undefined;
        if (!id) return this.reject(undefined, 'invalid_id');
        if (this.closed) return this.reject(id, 'shutting_down');
        // mqtt.js บอกตรงๆ ว่าข้อความไหนเป็นข้อความค้าง ไม่ต้องเดาจากเวลา
        // ถ้าปล่อยผ่าน คำสั่งค้างจะเปิดลิ้นชักทุกครั้งที่ตู้ต่อใหม่
        if (packet?.retain) return this.reject(id, 'retained');
        if (doc.protocol !== 2) return this.reject(id, 'unsupported_protocol');
        const command = doc.action === 'open' && [1, 2].includes(doc.drawer) ? { action: 'open', drawer: doc.drawer, id }
            : doc.action === 'buzzer' && ['on', 'off'].includes(doc.state) ? { action: 'buzzer', state: doc.state, id }
                : null;
        if (!command) return this.reject(id, 'invalid_action');
        if (!this.cloudActions.has(command.action)) return this.reject(id, `cloud_${command.action}_disabled`);
        if (!Number.isFinite(doc.ts)) return this.reject(id, 'invalid_ts');
        const now = this.now();
        if (now < CLOCK_SANE_AFTER_MS) return this.reject(id, 'clock_not_ready');
        if (doc.ts - now > MAX_FUTURE_MS) return this.reject(id, 'future_ts');
        // ตรวจก่อนดูสมุดคำสั่งโดยตั้งใจ ข้อความเก่าที่ถูกส่งซ้ำมาจะได้ตอบว่าเก่าเกินไป
        // แทนที่จะตอบรับซ้ำ ให้เว็บไปดูที่ตู้ ปลอดภัยกว่าตอบรับจากข้อความอายุ 30 วิ
        if (now - doc.ts > MAX_CMD_AGE_MS) return this.reject(id, 'stale');

        // ใครเป็นคนสั่งจากเว็บ — Vercel ยืนยันโทเคนบัญชีโรงเรียนมาแล้วก่อน publish
        // เก็บแค่ uid เพราะนั่นคือทั้งหมดที่มากับคำสั่ง · ชื่อถูกแปลงฝั่งคลาวด์ตอนส่ง LINE
        // ไม่มี uid = คำสั่งที่ไม่มีตัวตน (เช่นออด SOS) ซึ่งยังคงเป็น null เหมือนเดิม
        // ใช้สัญญาเดียวกับฝั่ง ingest — `ID` เป็นของรหัสคำสั่ง (8–64) ไม่ใช่ของ uid บัญชี (1–128)
        // ถ้าสองด่านใช้คนละกฎ uid จะผ่านตรงนี้แล้วไปตายตอน ingest ซึ่งทำทั้งชุดตก
        const actorUid = typeof doc.actorUid === 'string' && ACCOUNT_UID.test(doc.actorUid) ? doc.actorUid : null;
        const identity = command.action === 'open' && actorUid
            ? { studentId: null, badgeId: null, uid: actorUid, verifiedBy: 'school_account' }
            : null;
        const result = await this.controller.command(command, identity);
        await this.publish(this.topics.evt, this.eventFor(command, result));
        await this.publishStatus();
    }

    // controller ตอบคำสั่งซ้ำด้วยผลที่บันทึกไว้อยู่แล้ว ข้อความที่ถูกส่งซ้ำจึงตอบได้
    // โดยไม่ต้องหมุนมอเตอร์อีกรอบ
    eventFor(command, { status, body }) {
        const where = command.action === 'open' ? { drawer: command.drawer } : { state: command.state };
        if (body?.success === true) {
            return { protocol: 2, event: command.action === 'open' ? 'drawer_opened' : 'buzzer_set', id: command.id, ...where, ts: this.now() };
        }
        // 504 คือส่งไปแล้วแต่ไม่ได้คำยืนยัน ทั้งสองกรณีแปลว่า "ไปดูที่ตู้"
        // ไม่ใช่ "ถูกปฏิเสธ" ซึ่งคนละเรื่องกัน
        if (status === 504 || body?.uncertain === true) {
            return { protocol: 2, event: 'ack_timeout', id: command.id, ...where, reason: 'uart_timeout', ts: this.now() };
        }
        const reason = body?.deviceMode && body.deviceMode !== 'real' ? `mode_${body.deviceMode}`
            : status === 503 ? 'not_ready' : status === 409 ? 'rejected' : 'invalid_action';
        return { protocol: 2, event: 'cmd_rejected', id: command.id, reason, ts: this.now() };
    }

    // ต้องมีเพดานเวลา ถ้าสั่งหยุดตอนเน็ตหลุดแล้วค้างรอ systemd จะ SIGKILL ทิ้ง
    // ก่อนที่ controller.close() จะได้ทำงาน ครบเวลาแล้วปิด socket ทิ้งเลย
    // กรณีปิดไม่สวยมี will ค้างบน broker รับไว้อยู่แล้ว
    async close() {
        this.closed = true;
        this.stopHeartbeat();
        const client = this.client;
        if (!client) return;
        if (client.connected) {
            await Promise.race([
                this.publish(this.topics.status, { protocol: 2, online: false, ts: this.now() }, { qos: 1, retain: true }).catch(() => {}),
                delay(CLOSE_PUBLISH_MS)
            ]);
        }
        const graceful = new Promise(resolve => client.end(false, {}, resolve));
        const timedOut = await Promise.race([graceful.then(() => false), delay(CLOSE_END_MS).then(() => true)]);
        if (timedOut) client.end(true);
    }
}

// เส้นคลาวด์เป็นของเสริม ถ้ามีอะไรผิด ไม่มี URL พิมพ์ scheme ผิด หรือไม่มีแพ็กเกจ mqtt
// ให้ปิดเส้นนี้แล้วเขียน log บอกเหตุผล ห้ามทำให้จอตู้ล่มตามไปด้วย
export async function startCloudBridge(env, controller, options = {}) {
    const log = options.log ?? console;
    const url = (env.MQTT_URL || '').trim();
    if (!url) {
        log.log('[SFAB cloud] MQTT_URL not set — touchscreen-only');
        return null;
    }
    try {
        if (!URL_SCHEME.test(url)) throw new Error('MQTT_URL must start with mqtt://, mqtts://, ws:// or wss://');
        // mqtt.connect('mqtts://') จะลองต่อ host ว่างทุก 5 วิ ไปตลอดกาลโดยไม่บ่น
        if (!new URL(url).hostname) throw new Error('MQTT_URL has no host');
        const connect = options.connect ?? (await import('mqtt')).default.connect;
        return new CloudBridge({
            controller, url, connect,
            username: (env.MQTT_USERNAME || '').trim(),
            password: (env.MQTT_PASSWORD || '').trim(),
            baseTopic: (env.MQTT_BASE_TOPIC || 'crms6/firstaidbox/box1').trim(),
            cloudActions: env.SFAB_CLOUD_ACTIONS,
            ...options
        }).start();
    } catch (e) {
        log.error(`[SFAB cloud] disabled: ${e.message}`);
        return null;
    }
}
