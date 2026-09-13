import mqtt from 'mqtt';

// The Pi takes the ESP32's seat on the broker. Same three topics, same protocol-2 payloads,
// so api/command.js on Vercel does not change: it publishes <base>/cmd, waits on <base>/evt,
// and decides "connected" from the retained <base>/status. Everything that arrives here is
// handed to the very same LocalController the touchscreen uses — mode gate, journal, hold,
// duplicate replay — so a cloud command can never do more than a local one.
const ID = /^[a-zA-Z0-9_-]{8,64}$/;
// Same as MAX_CMD_AGE_MS in the ESP32 firmware: a command that sat in a queue while the
// network was down must not open the cabinet when the link comes back and nobody is there.
const MAX_CMD_AGE_MS = 30000;
// Vercel treats a status older than 5 s as offline (STATUS_MAX_AGE_MS); the ESP32 published
// every second. Keep that cadence so the cloud sees the same heartbeat it always did.
const STATUS_INTERVAL_MS = 1000;

export class CloudBridge {
    constructor({ controller, url, username = '', password = '', baseTopic = 'crms6/firstaidbox/box1',
        connect = mqtt.connect, now = Date.now, log = console, statusIntervalMs = STATUS_INTERVAL_MS }) {
        if (!controller || !url) throw new Error('CloudBridge needs a controller and an MQTT url');
        this.controller = controller;
        this.url = url;
        this.auth = { username: username || undefined, password: password || undefined };
        this.base = baseTopic.trim().replace(/\/+$/, '');
        this.topics = { cmd: `${this.base}/cmd`, evt: `${this.base}/evt`, status: `${this.base}/status` };
        this.connect = connect;
        this.now = now;
        this.log = log;
        this.statusIntervalMs = statusIntervalMs;
        this.client = null;
        this.timer = null;
        this.closed = false;
    }

    start() {
        this.client = this.connect(this.url, {
            ...this.auth,
            clientId: 'sfab-pi-' + Math.random().toString(16).slice(2, 10),
            clean: true,
            connectTimeout: 10000,
            // Unlike the serverless side, the cabinet must keep trying on its own.
            reconnectPeriod: 5000,
            // The broker publishes this for us if the Pi drops: retained, so a page that opens
            // during the outage reads "offline" instead of the last "ready".
            will: { topic: this.topics.status, payload: JSON.stringify({ protocol: 2, online: false }), qos: 1, retain: true }
        });
        this.client.on('connect', () => {
            this.client.subscribe(this.topics.cmd, { qos: 1 }, (err, granted) => {
                if (err || granted?.[0]?.qos > 2) {
                    this.log.error('[SFAB cloud] cmd subscription denied');
                    return;
                }
                this.log.log(`[SFAB cloud] on broker as ${this.base}`);
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
        this.client.on('close', () => this.stopHeartbeat());
        this.client.on('error', e => this.log.error('[SFAB cloud] mqtt error', e.message));
        return this;
    }

    stopHeartbeat() {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }

    // Mirrors publishOnlineStatus() in the firmware. ackTimeoutMs must be an integer in
    // 3000..120000 for Vercel to count the cabinet as connected; the controller only knows
    // it while the micro:bit answers /status, so an unplugged board publishes null = offline.
    async statusDocument() {
        const hw = await this.controller.status();
        const connected = hw.connected === true;
        return {
            protocol: 2, online: true, transport: 'pi',
            microbit: connected ? 'connected' : 'unknown',
            // A cabinet not set to Real will refuse every open; say so before Vercel publishes.
            ready: connected && hw.ready === true && hw.deviceMode === 'real',
            ackTimeoutMs: connected && Number.isInteger(hw.ackTimeoutMs) ? hw.ackTimeoutMs : null,
            reason: hw.reason === 'awaiting_new_ready_epoch' ? hw.reason
                : connected && hw.deviceMode !== 'real' ? `mode_${hw.deviceMode}` : '',
            ts: this.now()
        };
    }

    async publishStatus() {
        if (this.closed || !this.client?.connected) return;
        try {
            await this.publish(this.topics.status, await this.statusDocument(), true);
        } catch (e) {
            this.log.error('[SFAB cloud] status publish failed', e.message);
        }
    }

    publish(topic, doc, retain = false) {
        return new Promise((resolve, reject) => {
            this.client.publish(topic, JSON.stringify(doc), { qos: 1, retain }, err => err ? reject(err) : resolve());
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
        // mqtt.js tells us exactly which delivery is retained, so no timing guess is needed:
        // a retained command would otherwise open the drawer on every reconnect.
        if (packet?.retain) return this.reject(id, 'retained');
        if (doc.protocol !== 2) return this.reject(id, 'unsupported_protocol');
        const command = doc.action === 'open' && [1, 2].includes(doc.drawer) ? { action: 'open', drawer: doc.drawer, id }
            : doc.action === 'buzzer' && ['on', 'off'].includes(doc.state) ? { action: 'buzzer', state: doc.state, id }
                : null;
        if (!command) return this.reject(id, 'invalid_action');
        if (!Number.isFinite(doc.ts)) return this.reject(id, 'invalid_ts');
        if (this.now() - doc.ts > MAX_CMD_AGE_MS) return this.reject(id, 'stale');

        const result = await this.controller.command(command);
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
        if (status === 504) return { protocol: 2, event: 'ack_timeout', id: command.id, ...where, reason: 'uart_timeout', ts: this.now() };
        const reason = body?.deviceMode && body.deviceMode !== 'real' ? `mode_${body.deviceMode}`
            : status === 503 ? 'not_ready' : status === 409 ? 'rejected' : 'invalid_action';
        return { protocol: 2, event: 'cmd_rejected', id: command.id, reason, ts: this.now() };
    }

    async close() {
        this.closed = true;
        this.stopHeartbeat();
        const client = this.client;
        if (!client) return;
        try {
            if (client.connected) await this.publish(this.topics.status, { protocol: 2, online: false, ts: this.now() }, true);
        } catch { /* the will covers an ungraceful exit */ }
        await new Promise(resolve => client.end(false, {}, resolve));
    }
}

export function startCloudBridge(env, controller, options = {}) {
    const url = (env.MQTT_URL || '').trim();
    if (!url) return null;
    return new CloudBridge({
        controller, url,
        username: (env.MQTT_USERNAME || '').trim(),
        password: (env.MQTT_PASSWORD || '').trim(),
        baseTopic: (env.MQTT_BASE_TOPIC || 'crms6/firstaidbox/box1').trim(),
        ...options
    }).start();
}
