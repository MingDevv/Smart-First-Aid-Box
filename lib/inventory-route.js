// LIB/INVENTORY-ROUTE.JS — ตัวจัดการคำขอของคลังเวชภัณฑ์
//
// **ทำไมไม่ได้อยู่ที่ api/inventory.js ตามที่ควร**: Vercel แผนที่โรงเรียนใช้จำกัด serverless
// function ไว้ 12 ตัว และ api/ เต็มพอดีที่ 12 · การเพิ่มไฟล์ที่ 13 ทำให้ build ล้มทั้งชุด
// (เจอตอน deploy 2026-09-14) ⇒ Bank เลือกยุบ endpoint แทนอัปเกรดแผน
//
// ที่ยุบเข้า api/history.js เพราะมันเป็นที่ที่เข้ากันจริง ไม่ใช่ที่ว่างที่ยัดได้:
// history เป็น staff-only เหมือนกัน ตอบ no-store เหมือนกัน และ**อ่าน collection inventory
// อยู่แล้ว**เพื่อเอาไปแสดงบนแดชบอร์ด · ถ้าวันหนึ่งอัปเกรดแผน ย้ายกลับได้โดยแก้แค่ path
import { authorize, accessFailure, apiHeaders, AccessError, STAFF_ROLES } from './auth.js';
import { firebaseServices } from './firebase-admin.js';
import { validateInventory, inventoryView, lowDrawers, DRAWERS } from './inventory.js';
import { CABINET_ID } from './cabinet-protocol.js';

const cabinetOf = (query, env) => {
    const id = query.get('cabinet') || env.SFAB_CABINET_ID || 'box1';
    if (!CABINET_ID.test(id)) throw new AccessError(400, 'invalid_cabinet');
    return id;
};

export function createInventoryHandler({ authorizeRequest = authorize, services = firebaseServices,
    env = process.env, now = Date.now } = {}) {
    return async function handler(req, res) {
        apiHeaders(res, 'GET, POST, OPTIONS');
        if (req.method === 'OPTIONS') return res.status(204).end();
        if (!['GET', 'POST'].includes(req.method)) {
            return res.status(405).json({ success: false, error: 'method_not_allowed' });
        }
        let actor;
        try {
            actor = await authorizeRequest(req);
            if (!STAFF_ROLES.includes(actor.role)) throw new AccessError(403, 'staff_role_required');
        } catch (error) { return accessFailure(res, error); }

        try {
            const query = new URL(req.url || '/api/inventory', 'https://sfab.invalid').searchParams;
            const cabinetId = cabinetOf(query, env);
            const { db } = services();
            const ref = db.doc(`inventory/${cabinetId}`);

            if (req.method === 'GET') {
                const snap = await ref.get();
                const view = inventoryView(snap.exists ? snap.data() : null);
                return res.status(200).json({ success: true, cabinetId, ...view, low: lowDrawers(view) });
            }

            const drawers = validateInventory(req.body);
            const at = new Date(now()).toISOString();
            // merge เพราะครูอาจนับทีละช่อง ⇒ บันทึกช่อง 1 ต้องไม่ลบสิ่งที่เคยบันทึกไว้ของช่อง 2
            await ref.set({ ...drawers, cabinetId, countedAt: at,
                countedBy: actor.token.email || actor.token.uid }, { merge: true });
            const snap = await ref.get();
            const view = inventoryView(snap.data());
            return res.status(200).json({ success: true, cabinetId, ...view, low: lowDrawers(view),
                saved: DRAWERS.filter(drawer => drawer in drawers) });
        } catch (error) { return accessFailure(res, error); }
    };
}

export default createInventoryHandler();
