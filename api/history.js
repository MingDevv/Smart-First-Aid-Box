import { FieldPath } from 'firebase-admin/firestore';
import { authorize, accessFailure, apiHeaders, AccessError } from '../lib/auth.js';
import { inventoryProjection } from '../lib/cabinet-events.js';

const LIMIT = 100;
function project(doc) {
    const row = doc.data();
    const result = { eventId: doc.id, kind: row.kind, cabinetId: row.cabinetId, ts: row.ts,
        syncedAt: row.syncedAt, drawer: row.drawer ?? null, ack: row.ack ?? null,
        uncertain: row.uncertain === true, clockTrust: row.clockTrust, lineStatus: row.lineStatus,
        buzzerAck: row.buzzerAck ?? null };
    // All staff share the same explicit history projection.
    Object.assign(result, { uid: row.uid ?? null, woundType: row.woundType ?? null,
        verifiedBy: row.verifiedBy ?? null, itemsUsed: row.itemsUsed || [] });
    return result;
}
export function createHistoryHandler({ authorizeRequest = authorize, now = Date.now } = {}) {
    return async (req, res) => {
        apiHeaders(res, 'GET');
        if (req.method !== 'GET') return res.status(405).json({ success: false, error: 'GET required' });
        try {
            const { db } = await authorizeRequest(req, { staffOnly: true });
            const query = new URL(req.url || '/api/history', 'https://sfab.invalid').searchParams;
            const kind = query.get('kind') || 'dispense';
            if (!['dispense', 'sos'].includes(kind)) throw new AccessError(400, 'invalid_kind');
            let cursor;
            if (query.has('cursor')) {
                try { cursor = JSON.parse(Buffer.from(query.get('cursor'), 'base64url').toString()); } catch { /* validate below */ }
                if (!Array.isArray(cursor) || cursor.length !== 2 || typeof cursor[0] !== 'string' ||
                    !Number.isFinite(Date.parse(cursor[0])) || typeof cursor[1] !== 'string' ||
                    !/^[a-zA-Z0-9_-]{1,48}~[a-zA-Z0-9_-]{8,80}$/.test(cursor[1])) throw new AccessError(400, 'invalid_cursor');
            }
            let history = db.collection(kind === 'sos' ? 'sos' : 'dispenses')
                .orderBy('syncedAt', 'desc').orderBy(FieldPath.documentId(), 'desc');
            if (cursor) history = history.startAfter(...cursor);
            const [page, stock, cabinets] = await Promise.all([
                history.limit(LIMIT + 1).get(),
                db.collection('inventory').limit(20).get(),
                db.collection('cabinets').limit(20).get()
            ]);
            const docs = page.docs.slice(0, LIMIT);
            const last = docs.at(-1);
            return res.status(200).json({ rows: docs.map(doc => project(doc)),
                nextCursor: page.size > LIMIT ? Buffer.from(JSON.stringify([last.data().syncedAt, last.id])).toString('base64url') : null,
                inventory: stock ? stock.docs.map(doc => ({ cabinetId: doc.id, ...inventoryProjection(doc.data()) })) : null,
                cabinets: cabinets.docs.map(doc => ({ cabinetId: doc.id, lastSeen: doc.data().lastSeen ?? null,
                    status: doc.data().statusMirror ? { mode: doc.data().statusMirror.mode ?? null,
                        clockTrust: doc.data().statusMirror.clockTrust ?? null, unresolved: doc.data().statusMirror.unresolved ? {
                            id: doc.data().statusMirror.unresolved.id, drawer: doc.data().statusMirror.unresolved.drawer
                        } : null } : null })),
                fetchedAt: new Date(now()).toISOString() });
        } catch (error) { return accessFailure(res, error); }
    };
}
export default createHistoryHandler();
