import { randomUUID } from 'node:crypto';
import { firebaseServices } from './firebase-admin.js';
import { digest } from './cabinet-protocol.js';
import { deliverEvent } from './cabinet-line.js';

export function createWebSosSender({ services = firebaseServices, env = process.env, now = Date.now, send } = {}) {
    return async (token, { dedupeKey = token?.uid || 'anonymous' } = {}) => {
        try {
            const { db } = services();
            // ใช้เพดานเดียวกับที่อื่น 120 วินาทีต่อคนต่อ IP
            // ไม่เก็บ ไม่คืน และไม่ส่ง IP จริงเข้า LINE
            const dedupe = db.doc('_sos_requests/' + digest('web-sos:' + dedupeKey));
            const id = randomUUID();
            const event = await db.runTransaction(async tx => {
                const previous = (await tx.get(dedupe)).data();
                if (previous?.until > now()) return (await tx.get(db.doc('sos/web~' + previous.eventId))).data();
                const row = { id, kind: 'sos', cabinetId: 'web', uid: token?.uid || null, ts: new Date(now()).toISOString(),
                    historical: false, clockTrust: 'ntp', buzzerAck: null };
                const firstName = (typeof token?.name === 'string' ? token.name : '').trim().split(/\s+/)[0]
                    .replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 60) || 'School user';
                const text = `SOS — ${token ? firstName : 'unidentified (not signed in)'}\n${row.ts}\nPlease contact the student.`;
                const hash = digest(JSON.stringify(row));
                tx.set(dedupe, { eventId: id, until: now() + 120000 });
                tx.create(db.doc('sos/web~' + id), { ...row, syncedAt: row.ts, payloadHash: hash, lineDelivered: false, lineStatus: 'pending' });
                tx.create(db.doc('_deliveries/web~' + id), { payloadHash: hash, status: 'pending', retryKey: randomUUID(),
                    firstAttemptAt: null, leaseUntil: 0, payload: env.LINE_GROUP_ID ? {
                        to: env.LINE_GROUP_ID.trim(), messages: [{ type: 'text', text }]
                    } : null });
                return row;
            });
            const status = await deliverEvent(db, event, { env, now, ...(send ? { send } : {}) });
            return { success: status === 'delivered' };
        } catch { return { success: false }; }
    };
}
export const persistSchoolSos = createWebSosSender();

export async function retryWebSos(db, options) {
    const pending = await db.collection('sos').where('cabinetId', '==', 'web').where('lineStatus', '==', 'pending').limit(20).get();
    await Promise.all(pending.docs.map(doc => deliverEvent(db, doc.data(), options)));
}
