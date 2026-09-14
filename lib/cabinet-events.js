import { EVENT_ID } from './cabinet-protocol.js';

// อาการฉุกเฉินที่จอตู้ถามหลังเลือก "แมลงกัดต่อย" · สองอย่างแรกคือสัญญาณของการแพ้รุนแรง
// ซึ่งการให้ยาทาเองไม่ช่วย และทำให้เสียเวลาที่ควรใช้ตามครู ⇒ ตู้ปฏิเสธแล้วเรียกครูแทน
export const SOS_SYMPTOMS = Object.freeze(['swelling', 'chest_tightness']);
export function invalid(code = 'invalid_event') { return Object.assign(new Error(code), { status: 400 }); }
export function validateEvent(value, cabinetId) {
    if (!value || typeof value.id !== 'string' || !EVENT_ID.test(value.id) || value.cabinetId !== cabinetId ||
        !['dispense', 'sos'].includes(value.kind) || typeof value.ts !== 'string' ||
        !Number.isFinite(Date.parse(value.ts)) || value.ts !== new Date(value.ts).toISOString() ||
        !(value.uid === null || value.kind === 'dispense' && value.verifiedBy === 'cabinet_card' && value.uid === value.studentId) || typeof value.historical !== 'boolean' ||
        !['ntp', 'rtc', 'untrusted'].includes(value.clockTrust)) throw invalid();
    const event = { id: value.id, kind: value.kind, cabinetId, uid: value.uid, ts: value.ts,
        historical: value.historical, clockTrust: value.clockTrust };
    if (value.kind === 'sos') {
        if (value.buzzerAck !== null && typeof value.buzzerAck !== 'boolean') throw invalid();
        // อาการที่ทำให้ตู้ปฏิเสธการจ่ายยาแล้วเรียกครูแทน (หมวดแมลงกัดต่อย)
        // **enum เท่านั้น ไม่ใช่ข้อความอิสระ** — ค่าที่นี่เดินทางไปโผล่ในกลุ่ม LINE ของครู
        // ถ้าเปิดให้พิมพ์อะไรก็ได้ จอตู้ที่ไม่มีใครเฝ้าก็กลายเป็นช่องส่งข้อความเข้ากลุ่มครู
        if (value.symptom !== undefined && value.symptom !== null &&
            !SOS_SYMPTOMS.includes(value.symptom)) throw invalid();
        return { ...event, buzzerAck: value.buzzerAck, symptom: value.symptom ?? null };
    }
    const identified = value.uid === value.studentId && value.verifiedBy === 'cabinet_card' && typeof value.studentId === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(value.studentId) && typeof value.badgeId === 'string' && /^[a-f0-9]{64}$/.test(value.badgeId);
    // `cabinet_photo` = ไม่มีบัตร ถ่ายรูปใบหน้าไว้แทน · ไม่มีตัวตนติดมาด้วย
    // เหมือน `unidentified` ทุกประการ ต่างกันแค่ว่ามีคนยืนอยู่หน้าตู้จริงและครูมีรูปให้ดู
    // ⚠️ validateEvent เป็น whitelist ที่ประกอบเหตุการณ์ขึ้นใหม่จากฟิลด์ที่ระบุชื่อ — ค่าที่ไม่อยู่
    // ในรายการนี้ถูก **ทิ้งเงียบๆ** ไม่ใช่ error ⇒ ลืมเติมที่นี่ = ฟิลด์หายไปโดยไม่มีใครรู้
    const anonymous = value.badgeId === null && value.studentId == null &&
        ['unidentified', 'cabinet_photo'].includes(value.verifiedBy);
    if (![1, 2].includes(value.drawer) || !(identified || anonymous) ||
        !['confirmed', 'uncertain', 'rejected', 'resolved_by_operator'].includes(value.ack) ||
        value.uncertain !== (value.ack === 'uncertain') ||
        value.woundType !== (value.drawer === 1 ? 'cut_abrasion' : 'insect') ||
        !Array.isArray(value.itemsUsed) || value.itemsUsed.length !== 0) throw invalid();
    return { ...event, drawer: value.drawer, ...(identified ? { studentId: value.studentId } : {}), badgeId: value.badgeId, verifiedBy: value.verifiedBy,
        woundType: value.woundType, itemsUsed: [], ack: value.ack, uncertain: value.uncertain };
}
export function validateHeartbeat(value) {
    if (!value || !['real', 'demo', 'unset'].includes(value.mode) ||
        !['ntp', 'rtc', 'untrusted'].includes(value.clockTrust) ||
        (value.unresolved !== null && (!EVENT_ID.test(value.unresolved?.id) || ![1, 2].includes(value.unresolved?.drawer)))) throw invalid('invalid_heartbeat');
    return { mode: value.mode, clockTrust: value.clockTrust,
        unresolved: value.unresolved ? { id: value.unresolved.id, drawer: value.unresolved.drawer } : null };
}
export const eventKey = event => `${event.cabinetId}~${event.id}`;
export const eventCollection = event => event.kind === 'sos' ? 'sos' : 'dispenses';
export function lineText(event) {
    return event.kind === 'sos'
        ? `SOS — unidentified\nCabinet: ${event.cabinetId}\n${event.ts}\nGo to the first aid cabinet.`
        : `Cabinet ${event.cabinetId} — ${event.ack}\nDrawer ${event.drawer}: ${event.woundType}\n${event.ts}\n${event.studentId ? 'Card identified student: ' + event.studentId + '. Card possession is not proof of identity.' : 'Identity not verified.'} ACK is not proof that supplies were collected.`;
}
export function inventoryProjection(value) {
    if (!value) return null;
    const counts = {}, targets = {};
    for (const drawer of ['drawer1', 'drawer2']) {
        counts[drawer] = Number.isSafeInteger(value.counts?.[drawer]) && value.counts[drawer] >= 0 ? value.counts[drawer] : null;
        targets[drawer] = Number.isSafeInteger(value.targets?.[drawer]) && value.targets[drawer] >= 0 ? value.targets[drawer] : null;
    }
    return { counts, targets, lastCountAt: value.lastCountAt?.toDate?.().toISOString() ||
        (typeof value.lastCountAt === 'string' ? value.lastCountAt : null) };
}
