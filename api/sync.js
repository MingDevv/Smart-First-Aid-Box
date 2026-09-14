import { firebaseServices } from '../lib/firebase-admin.js';
import { authenticateCabinet, digest, EVENT_ID } from '../lib/cabinet-protocol.js';
import { inventoryProjection } from '../lib/cabinet-events.js';
import { signedResponse, cabinetFailure } from '../lib/cabinet-http.js';

export function createSyncHandler({ services = firebaseServices, env = process.env, now = Date.now } = {}) {
    return async (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        if (req.method !== 'GET') return res.status(405).json({ success: false, error: 'GET required' });
        try {
            const auth = authenticateCabinet(req, '', '/api/sync', env, now());
            const { db } = services();
            const [stock, cabinet] = await db.getAll(db.doc(`inventory/${auth.cabinetId}`), db.doc(`cabinets/${auth.cabinetId}`));
            const requests = cabinet.data()?.clearRequests;
            // Read-only cache contract for WP4; no role, roster, allergy or photo data in WP2.
            const clearing = Array.isArray(requests) ? requests.filter(item => EVENT_ID.test(item?.commandId) &&
                typeof item.decisionId === 'string' && item.decisionId.length <= 80 &&
                typeof item.checkedBy === 'string' && item.checkedBy.length <= 128 &&
                typeof item.checkedAt === 'string' && Number.isFinite(Date.parse(item.checkedAt)))
                .slice(0, 20).map(({ commandId, decisionId, checkedBy, checkedAt }) => ({ commandId, decisionId, checkedBy, checkedAt })) : [];
            const bundle = { version: 1, cabinetId: auth.cabinetId, inventory: inventoryProjection(stock.data()), clearing };
            const etag = `"${digest(JSON.stringify(bundle))}"`;
            return signedResponse(res, auth, req.headers['if-none-match'] === etag ? 304 : 200, bundle, etag);
        } catch (error) { return cabinetFailure(res, error); }
    };
}
export default createSyncHandler();
