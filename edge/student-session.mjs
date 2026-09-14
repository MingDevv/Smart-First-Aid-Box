import { performance } from 'node:perf_hooks';
import { createHash, randomBytes } from 'node:crypto';
import { EVENT_ID } from '../lib/cabinet-protocol.js';
export class StudentSession {
    // `photos` เป็นตัวเลือก — ตู้ที่ยังไม่ได้ตั้งคิวรูปจะไม่มีทาง "ไม่มีบัตร" เลย
    // ซึ่งเป็นพฤติกรรมเดิมเป๊ะ ไม่ใช่การพังแบบเงียบ
    constructor(outbox, now = () => performance.now(), photos = null) { this.outbox = outbox; this.now = now; this.photos = photos; this.clear(); }
    clear() { this.current = null; }
    scan(code) {
        this.clear();
        if (typeof code !== 'string' || !/^SFAB3:[A-Za-z0-9_-]{43}$/.test(code)) return null;
        const hash = createHash('sha256').update(code).digest('hex');
        const row = this.outbox.cache()?.roster?.find(item => item.cardHash === hash);
        if (!row) return null;
        this.current = { kind: 'card', studentId: row.studentId, badgeId: hash, sessionId: randomBytes(24).toString('base64url'), expiresAt: this.now() + 10 * 60000, commandId: null };
        return { sessionId: this.current.sessionId, givenName: row.givenName, surname: row.surname };
    }

    /** รอบที่ไม่มีบัตร — รูปใบหน้าทำหน้าที่แทนบัตร
     *
     * **รูปคือเงื่อนไข ไม่ใช่ของแถม** — ถ้าไม่มีรูปของ `eventId` นี้อยู่ในคิวของตู้จริงๆ
     * รอบนี้เปิดไม่ได้ · ถ้าปล่อยให้ไม่มีรูปก็เปิดได้ เท่ากับถอดเกตตัวตนของตู้ทิ้งทั้งใบ
     * เพราะใครก็ยิง `/api/command` ในวง LAN ได้โดยไม่ต้องมีอะไรเลย
     *
     * **ผูกกับ commandId ตั้งแต่ต้น** ไม่ใช่ปล่อยว่างแบบรอบที่ใช้บัตร: คีย์ของรูปในคลาวด์คือ
     * `photos/{cabinetId}~{eventId}` และ eventId ต้องเป็นตัวเดียวกับ id ของคำสั่ง ไม่งั้นรูป
     * ไปนอนอยู่คีย์ที่ไม่มีใครเปิดหา ⇒ หนึ่งรูป = หนึ่งคำสั่ง ไม่ใช่หนึ่งรูปใช้ได้ทั้งวัน
     */
    beginPhotoRound(eventId) {
        this.clear();
        if (!EVENT_ID.test(String(eventId || '')) || !this.photos?.has(eventId)) return null;
        this.current = { kind: 'photo', studentId: null, badgeId: null,
            sessionId: randomBytes(24).toString('base64url'), expiresAt: this.now() + 10 * 60000, commandId: eventId };
        return { sessionId: this.current.sessionId };
    }

    release(commandId) { if (this.current?.commandId === commandId) this.current.commandId = null; }
    identify(sessionId, commandId) {
        const value = this.current;
        if (!value || sessionId !== value.sessionId || this.now() >= value.expiresAt) return null;
        if (value.kind === 'photo') {
            // ตรวจรูปซ้ำตอนสั่งจริง ไม่เชื่อว่าตอนเปิดรอบมันเคยมี — คิวถูกตัดทิ้งได้ระหว่างทาง
            // (อัปโหลดสำเร็จแล้ว forget() หรือ prune() เก็บไป) และคำสั่งต้องตรงกับใบที่ถ่ายไว้
            if (commandId !== value.commandId || !this.photos?.has(commandId)) return null;
            return { studentId: null, badgeId: null, verifiedBy: 'cabinet_photo' };
        }
        if (value.commandId && value.commandId !== commandId ||
            !this.outbox.cache()?.roster?.some(row => row.studentId === value.studentId && row.cardHash === value.badgeId)) return null;
        value.commandId = commandId;
        return { studentId: value.studentId, badgeId: value.badgeId, verifiedBy: 'cabinet_card' };
    }
}
