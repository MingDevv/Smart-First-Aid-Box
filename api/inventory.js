// API/INVENTORY.JS — ทางเดียวที่จำนวนเวชภัณฑ์จะถูกเขียนได้
//
// ก่อนมีไฟล์นี้ `inventory` มีแต่กฎให้ "อ่าน" ใน firestore.rules แต่**ไม่มีโค้ดเขียนเลยสักจุด**
// ทั้ง api/ lib/ และ edge/ และคอลเลกชันนี้ไม่เคยมีอยู่จริงใน Firestore ด้วยซ้ำ
// ⇒ ปุ่ม "เติมเวชภัณฑ์" บนหน้าแรกหลังบ้านพาไปที่หัวข้อที่แสดงผลอย่างเดียว กดอะไรก็ไม่เกิด
// (Bank เจอเอง 2026-09-14: "คลังยาก็เพิ่มยาอะไรไม่ได้เลย คือไร?")
//
// กฎที่ฝังไว้ที่นี่ ไม่ได้อยู่ใน UI เพราะ UI โกหกได้:
//   • ครูกับผู้ดูแลระบบเขียนได้เท่ากัน นักเรียนเขียนไม่ได้ (กติกาเดียวกับทั้งระบบ)
//   • เบราว์เซอร์เขียน Firestore ตรงไม่ได้ — กฎยังเป็น read-only และต้องเป็นแบบนั้นต่อไป
//   • ทุกการบันทึกจดว่าใครนับและนับเมื่อไหร่ ไม่งั้นตัวเลขที่ไม่มีที่มาก็เชื่อไม่ได้
//   • ACK ของตู้ไม่เคยแตะตัวเลขนี้ — ดู lib/inventory.js ว่าทำไม
import { authorize, accessFailure, apiHeaders, AccessError, STAFF_ROLES } from '../lib/auth.js';
import { firebaseServices } from '../lib/firebase-admin.js';
import { validateInventory, inventoryView, lowDrawers, DRAWERS } from '../lib/inventory.js';
import { CABINET_ID } from '../lib/cabinet-protocol.js';

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
