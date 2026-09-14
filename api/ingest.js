import { randomUUID } from 'node:crypto';
import { firebaseServices } from '../lib/firebase-admin.js';
import { authenticateCabinet, digest } from '../lib/cabinet-protocol.js';
import { validateEvent, validateHeartbeat, invalid, eventKey, eventCollection } from '../lib/cabinet-events.js';
import { readCabinetBody, signedResponse, cabinetFailure } from '../lib/cabinet-http.js';
import { deliverEvent } from '../lib/cabinet-line.js';
import { retryWebSos } from '../lib/web-sos.js';

export function createIngestHandler({ services = firebaseServices, env = process.env, now = Date.now, send } = {}) {
    return async (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'POST required' });
        try {
            const raw = await readCabinetBody(req);
            const auth = authenticateCabinet(req, raw, '/api/ingest', env, now());
            let body;
            try { body = JSON.parse(raw); } catch { throw invalid(); }
            if (!Array.isArray(body.events) || body.events.length > 20) throw invalid();
            const events = body.events.map(event => validateEvent(event, auth.cabinetId));
            if (new Set(events.map(event => event.id)).size !== events.length) throw invalid();
            const heartbeat = validateHeartbeat(body.heartbeat);
            const { db } = services();
            await db.runTransaction(async tx => {
                // Read the whole batch before any write. A reused ID cannot change its payload.
                const refs = events.map(event => db.doc(`${eventCollection(event)}/${eventKey(event)}`));
                const deliveries = events.map(event => db.doc(`_deliveries/${eventKey(event)}`));
                const snapshots = refs.length ? await tx.getAll(...refs, ...deliveries) : [];
                for (let i = 0; i < events.length; i++) {
                    const event = events[i];
                    const hash = digest(JSON.stringify(event));
                    const previous = snapshots[i];
                    const delivery = snapshots[i + events.length];
                    if ((previous.exists && previous.data().payloadHash !== hash) ||
                        (delivery.exists && delivery.data().payloadHash !== hash)) {
                        throw Object.assign(new Error('event_conflict'), { status: 409 });
                    }
                    if (previous.exists) continue;
                    const skip = event.historical || (event.kind === 'dispense' && event.ack === 'rejected');
                    tx.create(refs[i], { ...event, payloadHash: hash, syncedAt: new Date(now()).toISOString(),
                        lineDelivered: false, lineStatus: skip ? 'skipped' : 'pending' });
                    tx.create(deliveries[i], { payloadHash: hash, status: skip ? 'skipped' : 'pending',
                        retryKey: randomUUID(), firstAttemptAt: null, leaseUntil: 0, payload: null });
                }
                tx.set(db.doc(`cabinets/${auth.cabinetId}`), { statusMirror: heartbeat,
                    lastSeen: new Date(now()).toISOString() }, { merge: true });
            });
            // All physical evidence is committed before external delivery begins.
            const deliveryOptions = { env, now, ...(send ? { send } : {}) };
            const [acks] = await Promise.all([
                Promise.all(events.map(async event => ({ id: event.id, stored: true,
                    line: await deliverEvent(db, event, deliveryOptions) }))),
                retryWebSos(db, deliveryOptions)
            ]);
            return signedResponse(res, auth, 200, { acks });
        } catch (error) { return cabinetFailure(res, error); }
    };
}
export default createIngestHandler();
