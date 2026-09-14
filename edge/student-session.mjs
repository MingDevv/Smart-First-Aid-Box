import { performance } from 'node:perf_hooks';
import { createHash, randomBytes } from 'node:crypto';
export class StudentSession {
    constructor(outbox, now = () => performance.now()) { this.outbox = outbox; this.now = now; this.clear(); }
    clear() { this.current = null; }
    scan(code) {
        this.clear();
        if (typeof code !== 'string' || !/^SFAB3:[A-Za-z0-9_-]{43}$/.test(code)) return null;
        const hash = createHash('sha256').update(code).digest('hex');
        const row = this.outbox.cache()?.roster?.find(item => item.cardHash === hash);
        if (!row) return null;
        this.current = { studentId: row.studentId, badgeId: hash, sessionId: randomBytes(24).toString('base64url'), expiresAt: this.now() + 10 * 60000, commandId: null };
        return { sessionId: this.current.sessionId, givenName: row.givenName, surname: row.surname };
    }
    release(commandId) { if (this.current?.commandId === commandId) this.current.commandId = null; }
    identify(sessionId, commandId) {
        const value = this.current;
        if (!value || sessionId !== value.sessionId || this.now() >= value.expiresAt ||
            value.commandId && value.commandId !== commandId || !this.outbox.cache()?.roster?.some(row => row.studentId === value.studentId && row.cardHash === value.badgeId)) return null;
        value.commandId = commandId;
        return { studentId: value.studentId, badgeId: value.badgeId };
    }
}
