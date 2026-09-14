import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';

const ID = /^[a-zA-Z0-9_-]{8,64}$/;
export const isAck = (ack, command) => ack?.id === command.id && ack.protocol === 2 &&
    (command.action === 'open' ? ack.event === 'drawer_opened' && ack.drawer === command.drawer
        : ack.event === 'buzzer_set' && ack.state === command.state);

export class LocalController {
    // mode: 'real' | 'demo' | 'unset' — เกตการสั่งฮาร์ดแวร์อยู่ตรงนี้ ไม่ใช่ในเบราว์เซอร์
    //
    // เดิมโหมดถูกบังคับใช้ฝั่งหน้าเว็บอย่างเดียว เซิร์ฟเวอร์ไม่เคยเห็นมันเลย ⇒ POST ตรงเข้า
    // /api/command ในโหมดสาธิตหรือโหมดที่ยังไม่ตั้ง **ยังสั่งมอเตอร์จริงได้** และคืน ACK
    // เหมือนของจริง (นัยวัดได้: หนึ่ง POST = หนึ่ง /open ทั้งใน demo และ unset)
    // หน้าเว็บที่โหลดค้างไว้ตอนเป็น Real ก็ยังยิงได้หลังผู้ดูแลสลับเป็น Demo แล้ว
    // การตรวจ Host/Origin ไม่ช่วย เพราะคนยิงเป็น client ที่ถูกต้องใน origin เดียวกัน
    constructor({ esp32Url = '', serial = null, database, timeoutMs, pollMs = 200, mode = 'unset' }) {
        this.mode = mode === 'real' || mode === 'demo' ? mode : 'unset';
        // 2026-09-12: the cabinet's ESP32 is gone; the Pi talks to the micro:bit over USB
        // through edge/microbit-serial.mjs, which answers the very same four requests.
        // Precedence: serial wins, so an old SFAB_ESP32_URL left in a unit cannot re-route
        // commands to a box that no longer exists.
        if (serial) {
            this.serial = serial;
            this.origin = 'serial:' + serial.device;
        } else if (esp32Url) {
            const url = new URL(esp32Url);
            if (url.protocol !== 'http:' || url.username || url.password || url.search ||
                url.hash || url.pathname !== '/') throw new Error('Use an HTTP ESP32 origin');
            this.origin = url.origin;
        }
        this.timeoutMs = timeoutMs;
        this.pollMs = pollMs;
        this.active = new Map();
        this.activeOpens = new Set();
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
        if (this.serial) return this.serial.request(path);
        const response = await fetch(this.origin + path, {
            signal: AbortSignal.timeout(timeoutMs), redirect: 'error'
        });
        return { status: response.status, data: await response.json() };
    }

    async status() {
        // Reported on every status read, including the unconfigured and unreachable branches:
        // a cabinet that has gone offline while a command was in flight is exactly the case
        // where the caller must not be told it is free to send another one.
        const unresolved = this.unresolved();
        const deviceMode = this.mode;
        if (!this.origin) return { connected: false, ready: false, mode: 'pi-local', configured: false, unresolved, deviceMode };
        try {
            const { status, data } = await this.request('/status');
            const validBudget = Number.isInteger(data.ackTimeoutMs) && data.ackTimeoutMs >= 3000 && data.ackTimeoutMs <= 120000;
            const connected = status === 200 && data.protocol === 2 && data.microbit === 'connected' && validBudget;
            return { connected, ready: connected && data.ready === true, mode: 'pi-local', configured: true,
                // The raw firmware budget, republished verbatim on the broker by edge/mqtt-cloud.mjs.
                ackTimeoutMs: validBudget ? data.ackTimeoutMs : null,
                commandTimeoutMs: validBudget ? data.ackTimeoutMs + 3000 : null,
                reason: data.reason === 'awaiting_new_ready_epoch' ? data.reason : '', unresolved, deviceMode };
        } catch {
            return { connected: false, ready: false, mode: 'pi-local', configured: true, unresolved, deviceMode };
        }
    }

    history() {
        return this.db.prepare(`SELECT id, drawer, state, created_at, confirmed_at FROM commands
            ORDER BY rowid DESC LIMIT 100`).all();
    }

    // The hold that outlives a student session, a page reload and a process restart.
    // A command that was sent but never confirmed is a physical operation nobody has
    // reconciled: the drawer may already be open, the stepper may be mid-travel. Issuing a
    // fresh command with a new ID is not a replay — the journal cannot catch it — so the
    // block has to come from here, from durable state, not from UI memory.
    // Cleared only by an operator through edge/resolve.mjs over SSH. Deliberately not
    // reachable over HTTP: the only HTTP client is the touchscreen the students use.
    unresolved() {
        return this.db.prepare(`SELECT id, drawer, created_at FROM commands
            WHERE state = 'uncertain' ORDER BY rowid DESC LIMIT 1`).get() ?? null;
    }

    failure(status, id, error) {
        return { status, body: { success: false, mode: 'pi-local', commandId: id, error } };
    }

    async command(command) {
        if (!command || typeof command !== 'object' || typeof command.id !== 'string' || !ID.test(command.id) ||
            !(command.action === 'open' && [1, 2].includes(command.drawer) ||
              command.action === 'buzzer' && ['on', 'off'].includes(command.state))) {
            return this.failure(400, undefined, 'คำสั่งเปิดช่องยาไม่ถูกต้อง');
        }
        // เกตโหมดต้องมาก่อนทุกอย่างที่ทิ้งร่องรอย — ก่อนดูประวัติ ก่อนเขียนแถว ก่อนแตะสาย
        // คำสั่งที่ถูกปฏิเสธตรงนี้ยังไม่เคยออกไปไหน จึงไม่เขียนสมุด ไม่แตะ hold ที่ค้างอยู่
        // และปลอดภัยที่จะลองใหม่หลังผู้ดูแลตั้งโหมดแล้ว
        if (this.mode !== 'real') {
            return { status: 503, body: {
                success: false, mode: 'pi-local', commandId: command.id,
                // ยังไม่ได้ส่งอะไรออกไป จึงลองใหม่ได้อย่างปลอดภัยเมื่อตั้งโหมดแล้ว
                retrySafe: true, deviceMode: this.mode,
                error: this.mode === 'demo'
                    ? 'ตู้อยู่ในโหมดสาธิต จึงไม่สั่งฮาร์ดแวร์จริง'
                    : 'ตู้ยังไม่ได้ตั้งโหมดการทำงาน ให้ผู้ดูแลตั้งค่าที่เครื่องก่อน'
            } };
        }
        const channel = command.action === 'open' ? command.drawer : command.state === 'on' ? 3 : 4;
        const previous = this.db.prepare('SELECT * FROM commands WHERE id = ?').get(command.id);
        if (previous) {
            if (previous.drawer !== channel) return this.failure(409, command.id, 'command ID ถูกใช้กับช่องยาอื่นแล้ว');
            if (this.active.has(command.id)) return this.active.get(command.id);
            if (previous.response) return JSON.parse(previous.response);
            // uncertain:true lets a transport tell "look at the cabinet" apart from "refused".
            const uncertain = this.failure(409, command.id, 'ผลคำสั่งเดิมยังไม่แน่นอน กรุณาตรวจตู้ก่อน ห้ามสั่งซ้ำ');
            uncertain.body.uncertain = true;
            return uncertain;
        }
        if (!this.origin) return this.failure(503, command.id, 'ยังไม่ได้ตั้งค่าการเชื่อมต่อ micro:bit บน Pi');
        if (command.action === 'open' && this.activeOpens.size) return this.failure(409, command.id, 'ตู้กำลังทำงาน กรุณารอ');
        // Enforced here, not only in the UI: a reload, a new student or a second browser tab
        // all produce a fresh command ID, which the per-ID replay guard above cannot catch.
        // The buzzer is left alone — calling for help must never be blocked by a stuck drawer.
        if (command.action === 'open') {
            const held = this.unresolved();
            if (held) {
                return this.failure(409, command.id,
                    `ตู้ยังมีคำสั่งค้างที่ไม่รู้ผล (ช่องที่ ${held.drawer}) ต้องให้ครูตรวจตู้และเคลียร์ก่อน`);
            }
        }

        this.db.prepare("INSERT INTO commands (id, drawer, state, created_at) VALUES (?, ?, 'pending', ?)")
            .run(command.id, channel, new Date().toISOString());
        if (command.action === 'open') this.activeOpens.add(command.id);
        const task = this.dispatch(command).finally(() => {
            this.active.delete(command.id);
            this.activeOpens.delete(command.id);
        });
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
                    hardware.reason === 'awaiting_new_ready_epoch'
                        ? 'ตู้รอการตรวจสาย UART และเริ่มบอร์ดทั้งคู่ใหม่ กรุณาให้ครูตรวจตู้ก่อน'
                        : 'ตู้ยังไม่พร้อม ตรวจการเชื่อมต่อหรือทำขั้นตอนหน้าตู้ให้จบก่อน'), 'rejected');
            }
            const deadline = Date.now() + (this.timeoutMs ?? hardware.commandTimeoutMs);
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
                if (reply && reply.data.actuated === false && reply.data.id === command.id) {
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

    async drain() {
        await Promise.allSettled(this.active.values());
    }

    async close() {
        await this.drain();
        await this.serial?.close();
        this.db.close();
    }
}
