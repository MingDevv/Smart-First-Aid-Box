import { FieldPath } from 'firebase-admin/firestore';
import { firebaseServices } from '../lib/firebase-admin.js';
import { authorize, accessFailure, apiHeaders, AccessError } from '../lib/auth.js';
import { inventoryProjection } from '../lib/cabinet-events.js';
import { createInventoryHandler } from '../lib/inventory-route.js';

const LIMIT = 100;
function project(doc) {
    const row = doc.data();
    const result = { eventId: doc.id, kind: row.kind, cabinetId: row.cabinetId, ts: row.ts,
        syncedAt: row.syncedAt, drawer: row.drawer ?? null, ack: row.ack ?? null,
        uncertain: row.uncertain === true, clockTrust: row.clockTrust, lineStatus: row.lineStatus,
        buzzerAck: row.buzzerAck ?? null };
    // ครูทุกคนเห็นประวัติชุดเดียวกัน และเลือกฟิลด์ที่ส่งออกไว้ชัดเจน
    Object.assign(result, { uid: row.uid ?? null, studentId: row.studentId ?? null, woundType: row.woundType ?? null,
        verifiedBy: row.verifiedBy ?? null, itemsUsed: row.itemsUsed || [] });
    return result;
}
/** เติมชื่อให้แถวที่สั่งจากเว็บ — หนึ่งคำขอต่อหนึ่งหน้า ไม่ใช่หนึ่งคำขอต่อหนึ่งแถว
 *
 * `getUsers` รับได้ 100 ตัวระบุต่อครั้ง ซึ่งเท่ากับ LIMIT ของหน้านี้พอดี ⇒ ราคาคงที่
 * ชื่อไม่ได้ถูกเก็บลงเหตุการณ์โดยตั้งใจ (เหตุการณ์เก็บแต่ uid) จึงต้องแปลงตอนอ่าน
 * แปลงไม่ได้ก็ปล่อยว่าง — หน้าเว็บมีข้อความของตัวเองสำหรับกรณีนั้น ไม่ใช่ทำทั้งหน้าพัง
 */
async function withAccountNames(rows, auth) {
    const uids = [...new Set(rows.filter(row => row.verifiedBy === 'school_account' && row.uid).map(row => row.uid))];
    if (!uids.length || !auth?.getUsers) return rows;
    let names = new Map();
    try {
        const found = await auth.getUsers(uids.map(uid => ({ uid })));
        names = new Map((found?.users || []).map(user => [user.uid, (user.displayName || '').trim()]));
    } catch { return rows; }
    return rows.map(row => row.verifiedBy === 'school_account' && names.get(row.uid)
        ? { ...row, accountName: names.get(row.uid) } : row);
}
export function createHistoryHandler({ authorizeRequest = authorize, now = Date.now,
    services = firebaseServices, inventory = createInventoryHandler() } = {}) {
    return async (req, res) => {
        const query = new URL(req.url || '/api/history', 'https://sfab.invalid').searchParams;
        // คลังเวชภัณฑ์อยู่ใต้ endpoint นี้เพราะ Vercel จำกัด serverless function ไว้ 12 ตัว
        // และ api/ เต็มพอดี · เหตุผลเต็มอยู่ในหัวไฟล์ lib/inventory-route.js
        if (query.get('resource') === 'inventory') return inventory(req, res);
        apiHeaders(res, 'GET');
        if (req.method !== 'GET') return res.status(405).json({ success: false, error: 'GET required' });
        try {
            const { db } = await authorizeRequest(req, { staffOnly: true });
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
            let adminAuth = null;
            try { ({ auth: adminAuth } = services()); } catch { /* ชื่อเป็นของเสริม ไม่ใช่เหตุให้ประวัติทั้งหน้าพัง */ }
            const rows = await withAccountNames(docs.map(doc => project(doc)), adminAuth);
            return res.status(200).json({ rows,
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
