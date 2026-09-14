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
        this.add({ id: row.id, kind: 'dispense', cabinetId: this.cabinetId, ts,
            uid: null, badgeId: null, verifiedBy: 'unidentified', clockTrust: 'untrusted',
            drawer: row.drawer, woundType: row.drawer === 1 ? 'cut_abrasion' : 'insect',
            itemsUsed: [], ack: result?.body?.ack ? 'confirmed' : row.state,
            uncertain: row.state === 'uncertain', historical });
    }
    queueSos(id = randomUUID()) {
        this.add({ id, kind: 'sos', cabinetId: this.cabinetId, uid: null,
            ts: new Date().toISOString(), buzzerAck: null, clockTrust: 'untrusted', historical: false });
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
        // WP2 caches clearing decisions only. Applying nurse clear requests belongs to WP4.
        this.db.prepare("INSERT OR REPLACE INTO inbox_cache (id, payload) VALUES ('bundle', ?)")
            .run(JSON.stringify(bundle));
    }
}
