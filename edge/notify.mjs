import { EVENT_ID } from '../lib/cabinet-protocol.js';

// Journal SOS immediately, independently of internet, identity, mode and buzzer ACK.
export function createLocalNotify(outbox) {
    return async (req, res) => {
        if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'POST required' });
        if (!outbox) return res.status(503).json({ success: false, error: 'journal_unavailable' });
        if (req.body?.event !== 'sos' || (req.body.eventId !== undefined && !EVENT_ID.test(req.body.eventId))) {
            return res.status(400).json({ success: false, error: 'sos_event_required' });
        }
        // อาการมาจากปุ่มบนจอตู้ที่มีให้เลือกตายตัว ⇒ รับเฉพาะค่าที่รู้จัก ค่าอื่นทิ้งเป็น null
        // ไม่ปฏิเสธทั้งคำขอ เพราะการเรียกครูสำคัญกว่าการได้เหตุผลครบ
        const eventId = outbox.queueSos(req.body.eventId, req.body.symptom ?? null);
        return res.status(202).json({ success: true, mode: 'queued', lineDelivered: false, eventId });
    };
}
export default createLocalNotify(null);
