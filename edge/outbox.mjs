import { SOS_SYMPTOMS } from '../lib/cabinet-events.js';
import { randomUUID } from 'node:crypto';

export class CabinetOutbox {
    constructor(db, cabinetId = 'box1') {
        this.db = db;
        this.cabinetId = cabinetId;
        this.onNew = () => {};
        db.exec(`CREATE TABLE IF NOT EXISTS outbox (
            id TEXT PRIMARY KEY, payload TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL, delivery_state TEXT NOT NULL DEFAULT 'pending', retry_after INTEGER NOT NULL DEFAULT 0);
            CREATE TABLE IF NOT EXISTS inbox_cache (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS sync_state (id TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    }
    add(event) {
        const previous = this.db.prepare('SELECT payload FROM outbox WHERE id = ?').get(event.id);
        if (previous && JSON.parse(previous.payload).kind !== event.kind) {
            throw Object.assign(new Error('event_conflict'), { status: 409 });
        }
        this.db.prepare('INSERT OR IGNORE INTO outbox (id, payload, created_at) VALUES (?, ?, ?)')
            .run(event.id, JSON.stringify(event), event.ts);
    }
    record(row, result, { historical = false } = {}) {
        if (![1, 2].includes(row.drawer)) return;
        const ts = Number.isFinite(Date.parse(row.created_at)) ? row.created_at : new Date().toISOString();
        const identity = row.student_identity ? JSON.parse(row.student_identity) : null;
        // สามค่า ไม่ใช่สอง: `cabinet_photo` คือรอบที่ไม่มีบัตรแล้วถ่ายรูปแทน
        // ซึ่งต้องแยกจาก `unidentified` ให้ขาด เพราะ `unidentified` วันนี้หมายถึงคำสั่งที่มาจาก
        // MQTT/คลาวด์ซึ่งไม่มีใครยืนอยู่หน้าตู้เลย · ถ้ายุบเป็นค่าเดียว ครูจะแยกไม่ออกว่า
        // แถวนี้คือเด็กที่ลืมบัตรแล้วเรามีรูปให้ดู หรือคือคำสั่งที่ยิงมาจากที่อื่น
        // `identity` เก่าที่ค้างใน SQLite ก่อนวันนี้ไม่มีฟิลด์นี้ จึงตกไปที่ `cabinet_card` ตามเดิม
        const verifiedBy = identity?.verifiedBy || (identity ? 'cabinet_card' : 'unidentified');
        this.add({ id: row.id, kind: 'dispense', cabinetId: this.cabinetId, ts,
            // รอบที่มาจากเว็บมี `uid` ของบัญชีโรงเรียนแต่ไม่มี `studentId` ของทะเบียนบัตร
            // ⇒ อ่าน uid ตรงๆ ก่อน แล้วค่อยตกไปที่ studentId ของรอบที่ใช้บัตร
            uid: identity?.uid || identity?.studentId || null, studentId: identity?.studentId || null, badgeId: identity?.badgeId || null, verifiedBy, clockTrust: 'untrusted',
            drawer: row.drawer, woundType: row.drawer === 1 ? 'cut_abrasion' : 'insect',
            itemsUsed: [], ack: result?.body?.ack ? 'confirmed' : row.state,
            uncertain: row.state === 'uncertain', historical });
    }
    queueSos(id = randomUUID(), symptom = null) {
        this.add({ id, kind: 'sos', cabinetId: this.cabinetId, uid: null,
            ts: new Date().toISOString(), buzzerAck: null, clockTrust: 'untrusted', historical: false,
            symptom: SOS_SYMPTOMS.includes(symptom) ? symptom : null });
        this.onNew();
        return id;
    }
    pending(limit = 20, now = Date.now()) {
        return this.db.prepare(`SELECT payload FROM outbox WHERE delivered = 0 AND retry_after <= ?
            ORDER BY CASE delivery_state WHEN 'pending' THEN 0 ELSE 1 END,
                CASE json_extract(payload, '$.kind') WHEN 'sos' THEN 0 ELSE 1 END, retry_after, rowid LIMIT ?`)
            .all(now, limit).map(row => JSON.parse(row.payload));
    }
    acknowledge(acks) {
        this.db.exec('BEGIN IMMEDIATE');
        try {
            for (const ack of acks) {
                if (ack.stored !== true || !['delivered', 'skipped', 'pending', 'manual_review'].includes(ack.line)) continue;
                this.db.prepare('UPDATE outbox SET delivered = ?, delivery_state = ?, retry_after = ? WHERE id = ?')
                    .run(['delivered', 'skipped', 'manual_review'].includes(ack.line) ? 1 : 0,
                        ack.line === 'pending' ? 'stored' : ack.line, ack.line === 'pending' ? Date.now() + 60000 : 0, ack.id);
            }
            this.db.exec('COMMIT');
        } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    }
    cache() {
        const row = this.db.prepare("SELECT payload FROM inbox_cache WHERE id = 'bundle'").get();
        return row ? JSON.parse(row.payload) : null;
    }
    saveCache(bundle) {
        // ตรงนี้เก็บแค่ผลการตัดสินใจเคลียร์ ส่วนการลงมือเคลียร์ตามคำสั่งครูอยู่คนละส่วน
        this.db.prepare("INSERT OR REPLACE INTO inbox_cache (id, payload) VALUES ('bundle', ?)")
            .run(JSON.stringify(bundle));
    }
}
