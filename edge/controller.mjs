import { DatabaseSync } from 'node:sqlite';
import { CabinetOutbox } from './outbox.mjs';
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
    constructor({ esp32Url = '', serial = null, database, timeoutMs, pollMs = 200, mode = 'unset', cabinetId = 'box1' }) {
        this.mode = mode === 'real' || mode === 'demo' ? mode : 'unset';
        // ตู้ไม่มี ESP32 แล้ว Pi คุยกับ micro:bit ผ่านสาย USB
        // ถ้ามีทั้งสองทาง ให้สายชนะ ค่า SFAB_ESP32_URL เก่าที่ค้างอยู่จะได้ไม่ส่งคำสั่งไปหากล่องที่ไม่มีแล้ว
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
        if (!this.db.prepare('PRAGMA table_info(commands)').all().some(row => row.name === 'student_identity')) {
            this.db.exec('ALTER TABLE commands ADD COLUMN student_identity TEXT');
        }
        this.outbox = new CabinetOutbox(this.db, cabinetId);
        // โปรแกรมอาจตายหลังส่งคำสั่งเปิดไปแล้ว ห้ามส่งคำสั่งที่ค้างอยู่ซ้ำเด็ดขาด
        this.db.exec("UPDATE commands SET state = 'uncertain' WHERE state = 'pending'");
        this.db.exec('BEGIN IMMEDIATE');
        try {
            // ย้ายประวัติการจ่ายยามาได้ แต่ห้ามส่ง LINE เก่าซ้ำ
            const historical = !this.db.prepare("SELECT 1 FROM sync_state WHERE id = 'journal_migrated'").get();
            for (const row of this.db.prepare(`SELECT commands.* FROM commands LEFT JOIN outbox ON commands.id = outbox.id
                WHERE commands.state != 'pending' AND outbox.id IS NULL`).all()) {
                this.outbox.record(row, row.response ? JSON.parse(row.response) : null, { historical });
            }
            this.db.prepare("INSERT OR IGNORE INTO sync_state (id, value) VALUES ('journal_migrated', '1')").run();
            this.db.exec('COMMIT');
        } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    }

    async request(path, timeoutMs = 1500) {
        if (this.serial) return this.serial.request(path);
        const response = await fetch(this.origin + path, {
            signal: AbortSignal.timeout(timeoutMs), redirect: 'error'
        });
        return { status: response.status, data: await response.json() };
    }

    async status() {
        // รายงานทุกครั้งที่อ่านสถานะ รวมถึงตอนตู้ยังไม่ได้ตั้งค่าหรือติดต่อไม่ได้
        // ตู้ที่หลุดไปตอนมีคำสั่งค้างอยู่ คือกรณีที่ห้ามบอกคนเรียกว่าส่งใบใหม่ได้
        const unresolved = this.unresolved();
        const deviceMode = this.mode;
        if (!this.origin) return { connected: false, ready: false, mode: 'pi-local', configured: false, unresolved, deviceMode };
        try {
            const { status, data } = await this.request('/status');
            const validBudget = Number.isInteger(data.ackTimeoutMs) && data.ackTimeoutMs >= 3000 && data.ackTimeoutMs <= 120000;
            const connected = status === 200 && data.protocol === 2 && data.microbit === 'connected' && validBudget;
            return { connected, ready: connected && data.ready === true, mode: 'pi-local', configured: true,
                // เวลารอคำตอบของบอร์ด ส่งต่อขึ้น broker ตามค่าเดิมไม่แปลง
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

    // การล็อกที่อยู่ข้ามรอบการใช้งาน ข้ามการรีเฟรชหน้า และข้ามการรีสตาร์ตโปรแกรม
    // คำสั่งที่ส่งไปแล้วแต่ไม่ได้คำยืนยัน แปลว่ามีของจริงขยับไปแล้วแต่ไม่มีใครไปดู
    // ลิ้นชักอาจเปิดค้าง มอเตอร์อาจหมุนค้างกลางทาง
    // ถ้าคนกดใหม่ มันจะได้ id ใหม่ซึ่งตัวกันคำสั่งซ้ำจับไม่ได้ การบล็อกจึงต้องมาจากตรงนี้
    // เคลียร์ได้ทางเดียวคือครูเข้า SSH ไปรันสคริปต์ ตั้งใจไม่เปิดทาง HTTP
    // เพราะคนที่เข้าถึง HTTP ได้คือจอที่เด็กใช้อยู่
    unresolved() {
        return this.db.prepare(`SELECT id, drawer, created_at FROM commands
            WHERE state = 'uncertain' ORDER BY rowid DESC LIMIT 1`).get() ?? null;
    }

    failure(status, id, error) {
        return { status, body: { success: false, mode: 'pi-local', commandId: id, error } };
    }

    async command(command, identity = null) {
        if (!command || typeof command !== 'object' || typeof command.id !== 'string' || !ID.test(command.id) ||
            !(command.action === 'open' && [1, 2].includes(command.drawer) ||
              command.action === 'buzzer' && ['on', 'off'].includes(command.state))) {
            return this.failure(400, undefined, 'คำสั่งเปิดช่องยาไม่ถูกต้อง');
        }
        // เกตโหมดต้องมาก่อนทุกอย่างที่ทิ้งร่องรอย — ก่อนดูประวัติ ก่อนเขียนแถว ก่อนแตะสาย
        // คำสั่งที่ถูกปฏิเสธตรงนี้ยังไม่เคยออกไปไหน จึงไม่เขียนสมุด ไม่แตะ hold ที่ค้างอยู่
        // และปลอดภัยที่จะลองใหม่หลังผู้ดูแลตั้งโหมดแล้ว
        if (command.action === 'open' && this.mode !== 'real') {
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
            // uncertain:true ใช้แยก "ไปดูที่ตู้" ออกจาก "ถูกปฏิเสธ" ซึ่งคนละความหมายกัน
            const uncertain = this.failure(409, command.id, 'ผลคำสั่งเดิมยังไม่แน่นอน กรุณาตรวจตู้ก่อน ห้ามสั่งซ้ำ');
            uncertain.body.uncertain = true;
            return uncertain;
        }
        if (this.db.prepare('SELECT 1 FROM outbox WHERE id = ?').get(command.id)) {
            return this.failure(409, command.id, 'Event ID already belongs to another journal entry');
        }
        if (!this.origin) return this.failure(503, command.id, 'ยังไม่ได้ตั้งค่าการเชื่อมต่อ micro:bit บน Pi');
        if (command.action === 'open' && this.activeOpens.size) return this.failure(409, command.id, 'ตู้กำลังทำงาน กรุณารอ');
        // ต้องบังคับตรงนี้ ไม่ใช่แค่ที่หน้าจอ เพราะรีเฟรชหน้า เปลี่ยนคนใช้ หรือเปิดแท็บใหม่
        // ล้วนได้ id ใหม่ซึ่งตัวกันคำสั่งซ้ำจับไม่ได้
        // ยกเว้นออด การเรียกครูต้องไม่ถูกบล็อกเพราะลิ้นชักค้าง
        if (command.action === 'open') {
            const held = this.unresolved();
            if (held) {
                return this.failure(409, command.id,
                    `ตู้ยังมีคำสั่งค้างที่ไม่รู้ผล (ช่องที่ ${held.drawer}) ต้องให้ครูตรวจตู้และเคลียร์ก่อน`);
            }
        }

        this.db.prepare("INSERT INTO commands (id, drawer, state, created_at, student_identity) VALUES (?, ?, 'pending', ?, ?)")
            .run(command.id, channel, new Date().toISOString(), identity ? JSON.stringify(identity) : null);
        if (command.action === 'open') this.activeOpens.add(command.id);
        const task = this.dispatch(command).finally(() => {
            this.active.delete(command.id);
            this.activeOpens.delete(command.id);
        });
        this.active.set(command.id, task);
        return task;
    }

    finish(command, result, state) {
        this.db.exec('BEGIN IMMEDIATE');
        try {
            this.db.prepare('UPDATE commands SET state = ?, confirmed_at = ?, response = ? WHERE id = ?')
                .run(state, state === 'confirmed' ? new Date().toISOString() : null, JSON.stringify(result), command.id);
            this.outbox.record(this.db.prepare('SELECT * FROM commands WHERE id = ?').get(command.id), result);
            this.db.exec('COMMIT');
        } catch (error) { this.db.exec('ROLLBACK'); throw error; }
        this.outbox.onNew();
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
            // บันทึกลงสมุดก่อนสั่งของจริงเสมอ และห้ามสั่งเปิดซ้ำเมื่อเน็ตมีปัญหา
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
            // รวมถึงตอนเขียนสมุดไม่สำเร็จด้วย ห้ามแปลงของที่เกิดขึ้นจริงให้กลายเป็นความสำเร็จปลอม
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
