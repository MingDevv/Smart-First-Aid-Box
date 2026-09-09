import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';

const ID = /^[a-zA-Z0-9_-]{8,64}$/;
export const isAck = (ack, command) => ack?.id === command.id && ack.protocol === 2 &&
    (command.action === 'open' ? ack.event === 'drawer_opened' && ack.drawer === command.drawer
        : ack.event === 'buzzer_set' && ack.state === command.state);

export class LocalController {
    constructor({ esp32Url = '', database, timeoutMs = 18000, pollMs = 200 }) {
        if (esp32Url) {
            const url = new URL(esp32Url);
            if (url.protocol !== 'http:' || url.username || url.password || url.search ||
                url.hash || url.pathname !== '/') throw new Error('Use an HTTP ESP32 origin');
            this.origin = url.origin;
        }
        this.timeoutMs = timeoutMs;
        this.pollMs = pollMs;
        this.active = new Map();
        this.db = new DatabaseSync(database);
        this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
            CREATE TABLE IF NOT EXISTS commands (
                id TEXT PRIMARY KEY, drawer INTEGER NOT NULL, state TEXT NOT NULL,
                created_at TEXT NOT NULL, confirmed_at TEXT, response TEXT
            );`);
        // A process may die after sending /open. Never replay a persisted pending command.
        this.db.exec("UPDATE commands SET state = 'uncertain' WHERE state = 'pending'");
    }

    async request(path, timeoutMs = 1500) {
        const response = await fetch(this.origin + path, {
            signal: AbortSignal.timeout(timeoutMs), redirect: 'error'
        });
        return { status: response.status, data: await response.json() };
    }

    async status() {
        if (!this.origin) return { connected: false, ready: false, mode: 'pi-local', configured: false };
        try {
            const { status, data } = await this.request('/status');
            const connected = status === 200 && data.protocol === 2 && data.microbit === 'connected';
            return { connected, ready: connected && data.ready === true, mode: 'pi-local', configured: true };
        } catch {
            return { connected: false, ready: false, mode: 'pi-local', configured: true };
        }
    }

    history() {
        return this.db.prepare(`SELECT id, drawer, state, created_at, confirmed_at FROM commands
            ORDER BY rowid DESC LIMIT 100`).all();
    }

    failure(status, id, error) {
        return { status, body: { success: false, mode: 'pi-local', commandId: id, error } };
    }

    async command(command) {
        if (!command || typeof command !== 'object' || !ID.test(command.id || '') ||
            typeof command.id !== 'string' ||
            !(command.action === 'open' && [1, 2].includes(command.drawer) ||
              command.action === 'buzzer' && ['on', 'off'].includes(command.state))) {
            return this.failure(400, undefined, 'คำสั่งเปิดช่องยาไม่ถูกต้อง');
        }
        const channel = command.action === 'open' ? command.drawer : command.state === 'on' ? 3 : 4;
        const previous = this.db.prepare('SELECT * FROM commands WHERE id = ?').get(command.id);
        if (previous) {
            if (previous.drawer !== channel) return this.failure(409, command.id, 'command ID ถูกใช้กับช่องยาอื่นแล้ว');
            if (this.active.has(command.id)) return this.active.get(command.id);
            if (previous.response) return JSON.parse(previous.response);
            return this.failure(409, command.id, 'ผลคำสั่งเดิมยังไม่แน่นอน กรุณาตรวจตู้ก่อน ห้ามสั่งซ้ำ');
        }
        if (!this.origin) return this.failure(503, command.id, 'ยังไม่ได้ตั้งค่าการเชื่อมต่อ ESP32 บน Pi');
        if (this.active.size) return this.failure(409, command.id, 'ตู้กำลังทำงาน กรุณารอ');

        this.db.prepare("INSERT INTO commands (id, drawer, state, created_at) VALUES (?, ?, 'pending', ?)")
            .run(command.id, channel, new Date().toISOString());
        const task = this.dispatch(command).finally(() => this.active.delete(command.id));
        this.active.set(command.id, task);
        return task;
    }

    finish(command, result, state) {
        this.db.prepare('UPDATE commands SET state = ?, confirmed_at = ?, response = ? WHERE id = ?')
            .run(state, state === 'confirmed' ? new Date().toISOString() : null, JSON.stringify(result), command.id);
        return result;
    }

    async dispatch(command) {
        let sent = false;
        try {
            const hardware = await this.status();
            if (!hardware.connected || (command.action === 'open' && !hardware.ready)) {
                return this.finish(command, this.failure(503, command.id,
                    'ตู้ยังไม่พร้อม ตรวจการเชื่อมต่อหรือทำขั้นตอนหน้าตู้ให้จบก่อน'), 'rejected');
            }
            const deadline = Date.now() + this.timeoutMs;
            // Persisted above BEFORE this side effect. Never retry /open on a network error.
            sent = true;
            let reply;
            try {
                const path = command.action === 'open' ? `/open?drawer=${command.drawer}`
                    : `/buzzer?state=${command.state === 'on' ? 1 : 0}`;
                reply = await this.request(`${path}&id=${encodeURIComponent(command.id)}`);
            } catch { /* The response may be lost after actuation; only query status from here. */ }

            while (Date.now() < deadline) {
                if (reply?.status === 200 && reply.data.success === true && isAck(reply.data, command)) {
                    return this.finish(command, { status: 200, body: {
                        success: true, mode: 'pi-local', compartment: command.drawer,
                        commandId: command.id, ack: reply.data
                    } }, 'confirmed');
                }
                if (reply && [400, 409, 503].includes(reply.status)) {
                    return this.finish(command, this.failure(409, command.id, 'ตู้ปฏิเสธคำสั่ง กรุณาตรวจสถานะหน้าตู้'), 'rejected');
                }
                await delay(Math.min(this.pollMs, Math.max(1, deadline - Date.now())));
                const remaining = deadline - Date.now();
                if (remaining <= 0) break;
                try {
                    reply = await this.request(`/command-status?id=${encodeURIComponent(command.id)}`, Math.min(1000, remaining));
                } catch { reply = null; }
            }
        } catch {
            // Includes a journal write failure: never turn a side effect into simulated success.
        }
        return this.finish(command, this.failure(504, command.id,
            'ยังยืนยันผลการจ่ายไม่ได้ กรุณาตรวจตู้ก่อน ห้ามสั่งซ้ำ'), sent ? 'uncertain' : 'rejected');
    }

    async close() {
        await Promise.allSettled(this.active.values());
        this.db.close();
    }
}
