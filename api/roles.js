// API/ROLES.JS — ให้ผู้ดูแลระบบตั้งสิทธิ์ครูพยาบาลจากหน้าเว็บ
//
// ทำไมต้องมี: `firestore.rules` ปิดการเขียน `roles/` ไว้ทั้งหมด (อ่านได้อย่างเดียว + catch-all
// `write: if false`) ซึ่งถูกต้อง เพราะเอกสารนี้คือแหล่งเดียวที่บอกว่าใครเป็นครูพยาบาล ปล่อยให้
// เบราว์เซอร์เขียนเองไม่ได้ · แต่ WP1 ไม่ได้ทำทางเขียนฝั่งเซิร์ฟเวอร์ไว้เลย ⇒ วันที่ 2026-09-14
// ระบบมีครูพยาบาลได้แค่คนเดียวคือคนที่ Khai เขียนให้ด้วย Admin SDK จากเครื่องตัวเอง
//
// กฎที่ฝังไว้ในนี้ ไม่ได้อยู่ใน UI เพราะ UI โกหกได้:
//   • เฉพาะ `admin` เท่านั้นที่เรียกได้ — ครูพยาบาลตั้งสิทธิ์ให้คนอื่นไม่ได้
//   • คนที่จะได้สิทธิ์ต้องเคยล็อกอินอย่างน้อยหนึ่งครั้ง ไม่งั้นไม่มี uid ให้ผูก
//   • ต้องเป็นบัญชีโรงเรียนที่ยืนยันอีเมลแล้วเท่านั้น
//   • **ถอดสิทธิ์ admin ของตัวเองไม่ได้** — ระบบที่ล็อกตัวเองออกจนไม่เหลือ admin ต้องกลับไปแก้
//     ด้วย Admin SDK จากเครื่องใครสักคน ซึ่งคือสภาพที่ไฟล์นี้เกิดมาเพื่อเลิก
import { authorize, accessFailure, apiHeaders, AccessError, STAFF_ROLES } from '../lib/auth.js';
import { firebaseServices } from '../lib/firebase-admin.js';
import { FieldValue } from 'firebase-admin/firestore';

const ASSIGNABLE = Object.freeze([...STAFF_ROLES, 'student']);   // student = ถอดสิทธิ์ ไม่ใช่บทบาทที่เก็บ

export function createRolesHandler({ authorizeRequest = authorize, services = firebaseServices } = {}) {
    return async function handler(req, res) {
        apiHeaders(res, 'GET, POST, OPTIONS');
        if (req.method === 'OPTIONS') return res.status(204).end();
        if (!['GET', 'POST'].includes(req.method)) {
            return res.status(405).json({ success: false, error: 'method_not_allowed' });
        }
        let actor;
        try {
            actor = await authorizeRequest(req);
            if (actor.role !== 'admin') throw new AccessError(403, 'admin_role_required');
        } catch (error) { return accessFailure(res, error); }

        const { auth, db } = services();
        if (req.method === 'GET') {
            const snap = await db.collection('roles').get();
            const staff = snap.docs.map(doc => ({
                uid: doc.id,
                email: typeof doc.data().email === 'string' ? doc.data().email : '',
                role: doc.data().role,
                grantedBy: typeof doc.data().grantedBy === 'string' ? doc.data().grantedBy : '',
                grantedAt: doc.data().grantedAt?.toDate?.()?.toISOString() ?? null
            })).sort((a, b) => a.email.localeCompare(b.email));
            return res.status(200).json({ success: true, staff });
        }

        const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
        const role = req.body?.role;
        if (!/^[^@\s]+@tesaban6\.ac\.th$/.test(email)) {
            return res.status(400).json({ success: false, error: 'school_email_required' });
        }
        if (!ASSIGNABLE.includes(role)) {
            return res.status(400).json({ success: false, error: 'unknown_role' });
        }

        let user;
        // ไก่กับไข่: uid เกิดตอนล็อกอินครั้งแรกเท่านั้น ⇒ ตั้งสิทธิ์ล่วงหน้าให้คนที่ยังไม่เคยเข้าไม่ได้
        // บอกให้ชัดว่าต้องให้เขาเปิดเว็บแล้วกดลงชื่อเข้าใช้ก่อน แทนที่จะขึ้นว่า "ไม่พบผู้ใช้" เฉยๆ
        try { user = await auth.getUserByEmail(email); }
        catch { return res.status(404).json({ success: false, error: 'never_signed_in' }); }
        if (!user.emailVerified) {
            return res.status(400).json({ success: false, error: 'email_not_verified' });
        }
        if (user.uid === actor.token.uid && role !== 'admin') {
            return res.status(409).json({ success: false, error: 'cannot_demote_self' });
        }

        const ref = db.doc(`roles/${user.uid}`);
        if (role === 'student') {
            // `student` คือค่าโดยปริยายของคนที่ไม่มีเอกสาร ⇒ ถอดสิทธิ์ = ลบเอกสาร ไม่ใช่เขียนคำว่า student
            // ทำให้ `roles` มีแต่คนที่มีสิทธิ์จริง อ่านแล้วรู้ทันทีว่าใครเข้าหลังบ้านได้บ้าง
            await ref.delete();
            return res.status(200).json({ success: true, uid: user.uid, email, role: 'student' });
        }
        await ref.set({
            role,
            email,
            grantedAt: FieldValue.serverTimestamp(),
            grantedBy: actor.token.email || actor.token.uid
        });
        return res.status(200).json({ success: true, uid: user.uid, email, role });
    };
}
export default createRolesHandler();
