import { spawn } from 'node:child_process';
import { open } from 'node:fs/promises';

// The Pi's replacement for the ESP32 bridge: the same frames over USB CDC, exposed to
// LocalController through the same four "requests" the ESP32 answered over HTTP
// (/status, /open, /buzzer, /command-status), so controller.mjs keeps its journal, hold
// and ACK logic untouched. Port of firmware/esp32_smart_box/readiness_latch.h +
// command_history.h; the frame grammar is the one microbit/main.py speaks.
//
// No native module: a CDC-ACM tty is a file once `stty` has put it in raw 115200 mode.
// Measured on the cabinet 2026-09-12: the board heartbeats READY:<epoch> every 500 ms
// unsolicited, so "connected" is simply "heard from it in the last 1500 ms".

const ID = /^[a-zA-Z0-9_-]{8,64}$/;
const CONNECTED_WINDOW_MS = 1500;

// Same rules as ReadinessLatch in the ESP32 firmware, same names, so the behaviour that
// edge.test.mjs already pins (busy, stale epoch, awaiting_new_ready_epoch) carries over.
export class ReadinessLatch {
    constructor() {
        this.seen = false; this.available = false; this.consumed = false;
        this.seenAt = 0; this.epoch = 0; this.consumedEpoch = 0; this.commandId = '';
    }
    ready(epoch, now) { this.epoch = epoch; this.seenAt = now; this.seen = true; this.available = true; }
    busy(now) { this.seenAt = now; this.seen = true; this.available = false; }
    connected(now) { return this.seen && now - this.seenAt < CONNECTED_WINDOW_MS; }
    waitingForEpoch() { return this.consumed && this.epoch === this.consumedEpoch; }
    canOpen(now) { return this.connected(now) && this.available && !this.waitingForEpoch(); }
    needsResync() { return this.available && this.waitingForEpoch(); }
    consume(id) { this.consumed = true; this.consumedEpoch = this.epoch; this.available = false; this.commandId = id; }
    // Only proof that THIS frame was refused can release the latch. A timer never can.
    reject(id) {
        if (!this.consumed || this.commandId !== id) return false;
        this.consumed = false; this.available = false; this.commandId = '';
        return true;
    }
}

export class MicrobitSerial {
    constructor({ device, ackTimeoutMs = 30000, now = Date.now }) {
        if (!device) throw new Error('SFAB_SERIAL device path required');
        if (!Number.isInteger(ackTimeoutMs) || ackTimeoutMs < 3000 || ackTimeoutMs > 120000) {
            throw new Error('ackTimeoutMs must be 3000..120000');
        }
        this.device = device;
        this.ackTimeoutMs = ackTimeoutMs;
        this.now = now;
        this.latch = new ReadinessLatch();
        this.commands = new Map();   // id -> { action, drawer, state, sentAt, completed, rejected, ack }
        this.line = '';
        this.overflow = false;
        this.handle = null;
        this.reader = null;
        // ตั้งจากภายนอกหลัง controller เกิดแล้ว (outbox อยู่บน controller ซึ่งสร้างทีหลัง serial)
        this.onRemoteSos = null;
    }

    async open() {
        await new Promise((resolve, reject) => {
            const stty = spawn('stty', ['-F', this.device, '115200', 'raw', '-echo', '-echoe', '-echok', '-echoctl', '-echoke'], { stdio: 'ignore' });
            stty.on('error', reject);
            stty.on('exit', code => code === 0 ? resolve() : reject(new Error(`stty exited ${code} on ${this.device}`)));
        });
        this.handle = await open(this.device, 'r+');
        this.reader = this.handle.createReadStream({ autoClose: false });
        this.reader.on('data', chunk => this.feed(chunk));
        this.reader.on('error', error => console.error('[serial] read error:', error.message));
    }

    async close() {
        this.reader?.destroy();
        await this.handle?.close();
        this.handle = null;
    }

    // Tests drive this directly with fake bytes; the reader stream calls it for real ones.
    feed(chunk) {
        for (const byte of chunk) {
            if (byte === 13) continue;
            if (byte === 10) {
                const frame = this.line;
                const dropped = this.overflow;
                this.line = '';
                this.overflow = false;
                if (!dropped) this.onFrame(frame);
            } else if (!this.overflow) {
                if (this.line.length >= 128) { this.overflow = true; this.line = ''; }
                else this.line += String.fromCharCode(byte);
            }
        }
    }

    onFrame(frame) {
        const now = this.now();
        if (frame.startsWith('READY:')) {
            const epoch = Number.parseInt(frame.slice(6), 10);
            if (Number.isInteger(epoch) && epoch >= 0) this.latch.ready(epoch, now);
            return;
        }
        if (frame === 'BUSY') return this.latch.busy(now);
        const sep = frame.indexOf(':');
        if (sep < 0) return;
        const head = frame.slice(0, sep);
        const id = frame.slice(sep + 1);
        if (!ID.test(id)) return;
        // ปุ่ม SOS ไร้สาย — บอร์ดเป็นฝ่ายเริ่มเอง ไม่มีคำสั่งค้างใน this.commands ให้จับคู่
        // ⇒ ต้องดักก่อนการหาคำสั่งข้างล่าง ไม่งั้นโดนทิ้งเงียบเหมือน frame ที่ไม่รู้จัก
        if (head === 'REMOTE_SOS') {
            if (this.remoteSosSeen === id) return;   // กันซ้ำเผื่อบอร์ดยิงมาเกินหนึ่งครั้ง
            this.remoteSosSeen = id;
            try { this.onRemoteSos?.(id); }
            catch (error) { console.error('[serial] remote SOS handler failed:', error.message); }
            return;
        }
        const command = this.commands.get(id);
        if (!command || command.completed || command.rejected) return;
        if (head === 'REJECT') {
            if (command.action === 'open' && this.latch.reject(id)) command.rejected = true;
            else if (command.action === 'buzzer') command.rejected = true;
            return;
        }
        if ((head === 'DONE1' || head === 'DONE2') && command.action === 'open' && command.drawer === Number(head[4])) {
            command.completed = true;
            command.ack = { success: true, protocol: 2, event: 'drawer_opened', id, drawer: command.drawer };
            return;
        }
        if ((head === 'BUZZ_DONE1' || head === 'BUZZ_DONE0') && command.action === 'buzzer' &&
            command.state === (head[9] === '1' ? 'on' : 'off')) {
            command.completed = true;
            command.ack = { success: true, protocol: 2, event: 'buzzer_set', id, state: command.state };
        }
    }

    async write(frame) {
        if (!this.handle) throw new Error('serial not open');
        await this.handle.write(frame + '\n');
    }

    status() {
        const now = this.now();
        return { status: 200, data: {
            protocol: 2,
            microbit: this.latch.connected(now) ? 'connected' : 'disconnected',
            ready: this.latch.canOpen(now),
            ackTimeoutMs: this.ackTimeoutMs,
            reason: this.latch.needsResync() ? 'awaiting_new_ready_epoch' : ''
        } };
    }

    commandStatus(id) {
        const command = this.commands.get(id);
        if (!command) return { status: 404, data: { success: false, error: 'unknown command' } };
        if (command.completed) return { status: 200, data: command.ack };
        if (command.rejected) return { status: 409, data: { success: false, actuated: false, id } };
        if (this.now() - command.sentAt > this.ackTimeoutMs) {
            return { status: 504, data: { success: false, id, event: 'ack_timeout' } };
        }
        return { status: 202, data: { success: false, id, pending: true } };
    }

    // Same shape LocalController.request() got back from fetch(): { status, data }.
    async request(path) {
        const url = new URL(path, 'http://serial');
        const id = url.searchParams.get('id') ?? '';
        switch (url.pathname) {
            case '/status':
                return this.status();
            case '/command-status':
                return this.commandStatus(id);
            case '/open': {
                const drawer = Number(url.searchParams.get('drawer'));
                if (![1, 2].includes(drawer) || !ID.test(id)) return { status: 400, data: { success: false, actuated: false, id } };
                if (this.commands.has(id)) return this.commandStatus(id);
                // Never a frame the board would refuse anyway: unsent is a definite, retry-safe outcome.
                if (!this.latch.canOpen(this.now())) return { status: 409, data: { success: false, actuated: false, id } };
                const command = { action: 'open', drawer, sentAt: this.now(), completed: false, rejected: false };
                this.commands.set(id, command);
                this.latch.consume(id);
                await this.write(`OPEN${drawer}:${id}:${this.latch.consumedEpoch}`);
                return { status: 202, data: { success: false, id, pending: true } };
            }
            case '/buzzer': {
                const state = url.searchParams.get('state') === '1' ? 'on' : url.searchParams.get('state') === '0' ? 'off' : null;
                if (!state || !ID.test(id)) return { status: 400, data: { success: false, actuated: false, id } };
                if (this.commands.has(id)) return this.commandStatus(id);
                const command = { action: 'buzzer', state, sentAt: this.now(), completed: false, rejected: false };
                this.commands.set(id, command);
                // Asking for help never touches the readiness latch (ESP32 did the same).
                await this.write(`BUZZ${state === 'on' ? 1 : 0}:${id}`);
                return { status: 202, data: { success: false, id, pending: true } };
            }
            default:
                return { status: 404, data: { success: false, error: 'Not found' } };
        }
    }
}
