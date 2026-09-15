// The Pi takes the ESP32's seat on the broker. Same three topics, same protocol-2 payloads,
// so api/command.js on Vercel does not change: it publishes <base>/cmd, waits on <base>/evt,
// and decides "connected" from the retained <base>/status. Everything that arrives here is
// handed to the very same LocalController the touchscreen uses — mode gate, journal, hold,
// duplicate replay — so a cloud command can never do more than a local one.
//
// This module must never sit on the local path's import chain: the `mqtt` package is loaded
// lazily in startCloudBridge(), so a cabinet without node_modules (or without MQTT_URL) still
// boots its touchscreen service exactly as before.
// นำเข้าได้ปลอดภัยแม้ไฟล์นี้ห้ามอยู่บนสายนำเข้าของเส้นทางในเครื่อง — `cabinet-protocol.js`
// พึ่งแต่ `node:crypto` และ `edge/student-session.mjs` ซึ่งอยู่บนเส้นทางนั้นก็นำเข้ามันอยู่แล้ว
import { ACCOUNT_UID } from '../lib/cabinet-protocol.js';

const ID = /^[a-zA-Z0-9_-]{8,64}$/;
// Same three freshness rules as the ESP32 firmware (MAX_CMD_AGE_MS, future_ts, clock_not_ready):
// a command that sat in a queue while the network was down must not open the cabinet when the
// link comes back and nobody is there, and a Pi whose clock has not synced yet must not act on
// timestamps it cannot judge. The 2 s future tolerance matches the skew Vercel accepts on status.
const MAX_CMD_AGE_MS = 30000;
const MAX_FUTURE_MS = 2000;
const CLOCK_SANE_AFTER_MS = 1_700_000_000_000;
// Vercel treats a status older than 5 s as offline (STATUS_MAX_AGE_MS); the ESP32 published
// every second at QoS 0. Keep that cadence: the will and the age check make delivery
// guarantees unnecessary, and QoS 1 would pile up unacked heartbeats on a half-open link.
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
        // Which actions the internet may ask for. api/command.js has no login of its own, so
        // this is the one place a school can say "the website may ring the buzzer but not open
        // a drawer" without touching Vercel. Default is parity with the ESP32 era.
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
            // Unlike the serverless side, the cabinet must keep trying on its own.
            reconnectPeriod: 5000,
            // The broker publishes this for us if the Pi drops: retained, so a page that opens
            // during the outage reads "offline" instead of the last "ready".
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
        // A cabinet on a dead Wi-Fi retries every 5 s for hours: log a message once, not per attempt.
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

    // Mirrors publishOnlineStatus() in the firmware. ackTimeoutMs must be an integer in
    // 3000..120000 for Vercel to count the cabinet as connected; the controller only knows
    // it while the micro:bit answers /status, so an unplugged board publishes null = offline.
    // ready:false + reason tells the website to refuse BEFORE publishing a command the
    // controller is guaranteed to reject (wrong mode, unresolved hold, opens disabled here).
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

    // One status publish at a time. A request that arrives mid-flight (a command just
    // finished while the heartbeat was reading the serial status) is folded into one more
    // publish afterwards, so readiness changes are never dropped and never queue up.
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
        // mqtt.js tells us exactly which delivery is retained, so no timing guess is needed:
        // a retained command would otherwise open the drawer on every reconnect.
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
        // Checked before the journal on purpose: a late QoS 1 redelivery of an already-executed
        // id gets 'stale' here instead of a re-ACK. The firmware ordered these the other way;
        // the safer failure is to make the website look at the cabinet, not to re-ACK from a
        // 30-second-old message.
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

    // The controller already answers a replayed id with the recorded outcome, so a
    // redelivered cmd re-ACKs without touching the motor — same contract as the firmware.
    eventFor(command, { status, body }) {
        const where = command.action === 'open' ? { drawer: command.drawer } : { state: command.state };
        if (body?.success === true) {
            return { protocol: 2, event: command.action === 'open' ? 'drawer_opened' : 'buzzer_set', id: command.id, ...where, ts: this.now() };
        }
        // 504 = sent, never confirmed; body.uncertain = a replay of such a command. Both are
        // "look at the cabinet", which Vercel renders from ack_timeout, not from "refused".
        if (status === 504 || body?.uncertain === true) {
            return { protocol: 2, event: 'ack_timeout', id: command.id, ...where, reason: 'uart_timeout', ts: this.now() };
        }
        const reason = body?.deviceMode && body.deviceMode !== 'real' ? `mode_${body.deviceMode}`
            : status === 503 ? 'not_ready' : status === 409 ? 'rejected' : 'invalid_action';
        return { protocol: 2, event: 'cmd_rejected', id: command.id, reason, ts: this.now() };
    }

    // Bounded: a stop during a Wi-Fi outage must not sit until systemd's TimeoutStopSec and
    // SIGKILL the process before controller.close() runs. The retained will covers the
    // ungraceful case, so after the deadlines we just force the socket shut.
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

// Optional cloud path. Anything wrong here — no URL, a mistyped scheme, a missing `mqtt`
// package — disables the cloud path and logs why; it never takes the touchscreen down.
export async function startCloudBridge(env, controller, options = {}) {
    const log = options.log ?? console;
    const url = (env.MQTT_URL || '').trim();
    if (!url) {
        log.log('[SFAB cloud] MQTT_URL not set — touchscreen-only');
        return null;
    }
    try {
        if (!URL_SCHEME.test(url)) throw new Error('MQTT_URL must start with mqtt://, mqtts://, ws:// or wss://');
        // mqtt.connect('mqtts://') would happily retry an empty host every 5 s forever.
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
