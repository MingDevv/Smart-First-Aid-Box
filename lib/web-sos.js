import { randomUUID } from 'node:crypto';
import { firebaseServices } from './firebase-admin.js';
import { digest } from './cabinet-protocol.js';
import { deliverEvent } from './cabinet-line.js';
import { SOS_SYMPTOMS } from './cabinet-events.js';

export function createWebSosSender({ services = firebaseServices, env = process.env, now = Date.now, send } = {}) {
    return async (token, { dedupeKey = token?.uid || 'anonymous', symptom = null } = {}) => {
        try {
            const { db, auth } = services();
            // ใช้เพดานเดียวกับที่อื่น 120 วินาทีต่อคนต่อ IP
            // ไม่เก็บ ไม่คืน และไม่ส่ง IP จริงเข้า LINE
            const dedupe = db.doc('_sos_requests/' + digest('web-sos:' + dedupeKey));
            const id = randomUUID();
            const event = await db.runTransaction(async tx => {
                const previous = (await tx.get(dedupe)).data();
                if (previous?.until > now()) return (await tx.get(db.doc('sos/web~' + previous.eventId))).data();
                // อาการต้องอยู่ใน enum เท่านั้น ค่านี้เดินทางไปโผล่ในกลุ่ม LINE ของครู
                // ถ้าเปิดให้เป็นข้อความอิสระ ใครก็ยิง /api/notify เพื่อส่งข้อความเข้ากลุ่มครูได้
                const safeSymptom = SOS_SYMPTOMS.includes(symptom) ? symptom : null;
                const row = { id, kind: 'sos', cabinetId: 'web', uid: token?.uid || null, ts: new Date(now()).toISOString(),
                    historical: false, clockTrust: 'ntp', buzzerAck: null, symptom: safeSymptom,
                    // resolveStudent หาชื่อจากบัญชีโรงเรียนได้เฉพาะเมื่อฟิลด์นี้เป็น school_account
                    // ไม่ใส่ = การ์ดขึ้น "ยังไม่ทราบว่าเป็นใคร" ทั้งที่ระบบยืนยันตัวตนไปแล้ว
                    verifiedBy: token?.uid ? 'school_account' : 'unidentified' };
                const hash = digest(JSON.stringify(row));
                tx.set(dedupe, { eventId: id, until: now() + 120000 });
                tx.create(db.doc('sos/web~' + id), { ...row, syncedAt: row.ts, payloadHash: hash, lineDelivered: false, lineStatus: 'pending' });
                // `payload: null` โดยตั้งใจ — ปล่อยให้ deliverEvent ปั้นข้อความด้วย lineMessage()
                // ซึ่งเป็นตัวเดียวกับที่ฝั่งตู้ใช้ ⇒ ครูเห็นการ์ดหน้าตาเดียวกันทั้งสองทาง
                // ของเดิมปั้น payload เป็นข้อความอังกฤษไว้ตรงนี้ แล้ว deliverEvent ก็ใช้ของที่มีให้
                // ⇒ การ์ด Flex ที่เขียนไว้แล้วไม่เคยถูกใช้บนเส้นทางเว็บเลย (แก้ 2026-09-19)
                tx.create(db.doc('_deliveries/web~' + id), { payloadHash: hash, status: 'pending', retryKey: randomUUID(),
                    firstAttemptAt: null, leaseUntil: 0, payload: null });
                return row;
            });
            const status = await deliverEvent(db, event, { env, now, auth, ...(send ? { send } : {}) });
            return { success: status === 'delivered' };
        } catch { return { success: false }; }
    };
}
export const persistSchoolSos = createWebSosSender();

export async function retryWebSos(db, options) {
    const pending = await db.collection('sos').where('cabinetId', '==', 'web').where('lineStatus', '==', 'pending').limit(20).get();
    await Promise.all(pending.docs.map(doc => deliverEvent(db, doc.data(), options)));
}
