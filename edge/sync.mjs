import { signedHeaders, equalMac, responseSignature, CABINET_ID } from '../lib/cabinet-protocol.js';

export class CabinetSync {
    constructor({ controller, origin, secret, cabinetId = 'box1', fetchImpl = fetch, now = Date.now }) {
        const url = new URL(origin);
        if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
            throw new Error('SFAB_SYNC_URL must be an HTTPS origin');
        }
        if (!CABINET_ID.test(cabinetId) || !secret || secret.length < 32) throw new Error('Invalid cabinet sync configuration');
        Object.assign(this, { controller, origin: url.origin, secret, cabinetId, fetchImpl, now });
        this.outbox = controller.outbox;
        this.flight = null;
        this.backoff = 60000;
        this.stopped = false;
    }
    async request(path, method, body = '', extra = {}) {
        const headers = { ...signedHeaders(this.secret, method, path, this.cabinetId, body, this.now()), ...extra };
        const response = await this.fetchImpl(this.origin + path, { method, headers: { ...headers, 'Content-Type': 'application/octet-stream' },
            ...(method === 'POST' ? { body } : {}), signal: AbortSignal.timeout(15000), redirect: 'error' });
        const text = await response.text();
        if (text.length > 2 * 1024 * 1024) throw new Error('Sync response too large');
        if (!response.ok && response.status !== 304) throw new Error('Sync request failed');
        const etag = response.headers.get('etag') || '';
        if (!equalMac(response.headers.get('x-sfab-signature'),
            responseSignature(this.secret, headers['x-sfab-signature'], response.status, etag, text))) {
            throw new Error('Invalid sync response signature');
        }
        return { status: response.status, etag, data: text ? JSON.parse(text) : null };
    }
    async cycle() {
        const events = this.outbox.pending();
        const held = this.controller.unresolved();
        const body = JSON.stringify({ events, heartbeat: { mode: this.controller.mode,
            clockTrust: 'untrusted', unresolved: held ? { id: held.id, drawer: held.drawer } : null } });
        const result = await this.request('/api/ingest', 'POST', body);
        const ids = new Set(events.map(event => event.id));
        if (!Array.isArray(result.data?.acks) || result.data.acks.some(ack => !ids.has(ack.id))) throw new Error('Invalid acknowledgements');
        this.outbox.acknowledge(result.data.acks);
        const cached = this.outbox.cache();
        const sync = await this.request('/api/sync', 'GET', '', cached ? { 'If-None-Match': cached.etag } : {});
        if (sync.status === 200) {
            if (sync.data?.cabinetId !== this.cabinetId || sync.data.version !== 1) throw new Error('Invalid cabinet bundle');
            this.outbox.saveCache({ ...sync.data, etag: sync.etag });
        } else if (!cached || cached.etag !== sync.etag) throw new Error('Missing cached bundle');
        this.outbox.db.prepare("INSERT OR REPLACE INTO sync_state (id, value) VALUES ('last_success', ?)").run(new Date(this.now()).toISOString());
    }
    run() {
        if (this.flight) return this.flight;
        this.flight = this.cycle().finally(() => { this.flight = null; });
        return this.flight;
    }
    wake() {
        if (this.stopped || this.flight) return;
        clearTimeout(this.timer);
        void this.run().then(() => { this.backoff = this.outbox.db.prepare("SELECT 1 FROM outbox WHERE delivery_state = 'pending' LIMIT 1").get() ? 1000 : 60000; }, () => {
            this.backoff = Math.min(Math.max(this.backoff * 2, 60000), 300000);
        }).finally(() => {
            if (!this.stopped) this.timer = setTimeout(() => this.wake(), this.backoff);
        });
    }
    start() { this.outbox.onNew = () => this.wake(); this.wake(); return this; }
    async close() { this.stopped = true; clearTimeout(this.timer); this.outbox.onNew = () => {}; await this.flight?.catch(() => {}); }
}
export function startCabinetSync(env, controller) {
    if (!env.SFAB_SYNC_URL || !env.SFAB_CABINET_SECRET) return null;
    try { return new CabinetSync({ controller, origin: env.SFAB_SYNC_URL, secret: env.SFAB_CABINET_SECRET,
        cabinetId: env.SFAB_CABINET_ID || 'box1' }).start(); }
    catch { console.warn('[SFAB] Sync configuration invalid; events remain in the local journal.'); return null; }
}
