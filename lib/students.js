import { createHash, randomBytes } from 'node:crypto';
import { AccessError } from './auth.js';
export const MAX_STUDENTS = 500;
export const MAX_IMPORT = 200;
export const FIELDS = ['studentId', 'givenName', 'surname', 'classLevel', 'room', 'drugAllergies', 'foodAllergies', 'schoolEmail'];
export const STUDENT_ID = /^[A-Za-z0-9_-]{1,32}$/;
export const hash = value => createHash('sha256').update(value).digest('hex');
export const newCard = () => 'SFAB3:' + randomBytes(32).toString('base64url');
export function validateStudent(raw) {
    const row = {};
    for (const key of FIELDS) {
        const value = raw?.[key] ?? '';
        if (typeof value !== 'string' || value.length > (key.endsWith('Allergies') ? 2000 : 160) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) throw new Error('invalid_' + key);
        row[key] = value.trim();
    }
    if (!STUDENT_ID.test(row.studentId)) throw new Error('invalid_studentId');
    for (const key of ['givenName', 'surname', 'classLevel', 'room']) if (!row[key] || !/[\p{L}\p{N}]/u.test(row[key]) || /^[=+@]/.test(row[key])) throw new Error('invalid_' + key);
    if (row.schoolEmail && !/^[a-zA-Z0-9._+-]+@tesaban6\.ac\.th$/.test(row.schoolEmail)) throw new Error('invalid_schoolEmail');
    row.schoolEmail = row.schoolEmail.toLowerCase();
    return row;
}
export function studentProjection(row) {
    return { ...Object.fromEntries(FIELDS.map(key => [key, row[key] || ''])), revision: row.revision || 0, hasCard: !!row.cardHash };
}
export function rosterProjection(rows) {
    return rows.filter(row => row.cardHash).map(row => ({ studentId: row.studentId, givenName: row.givenName, surname: row.surname, cardHash: row.cardHash }));
}
export function importPlan(rawRows, existing) {
    if (!Array.isArray(rawRows) || !rawRows.length || rawRows.length > MAX_IMPORT) throw new AccessError(400, 'invalid_row_count');
    const seen = new Set(), rows = [], summary = { create: 0, update: 0, skip: 0, reject: 0 };
    const emails = new Map(existing.filter(row => row.schoolEmail).map(row => [row.schoolEmail, row.studentId]));
    for (const [index, raw] of rawRows.entries()) {
        try {
            const row = validateStudent(raw);
            if (seen.has(row.studentId)) throw new Error('duplicate_studentId');
            seen.add(row.studentId);
            if (row.schoolEmail && emails.has(row.schoolEmail) && emails.get(row.schoolEmail) !== row.studentId) throw new Error('duplicate_schoolEmail');
            if (row.schoolEmail) emails.set(row.schoolEmail, row.studentId);
            const prior = existing.find(item => item.studentId === row.studentId);
            const action = !prior ? 'create' : FIELDS.every(key => row[key] === (prior[key] || '')) ? 'skip' : 'update';
            summary[action]++;
            rows.push({ line: index + 2, action, row, revision: prior?.revision || 0 });
        } catch (error) { summary.reject++; rows.push({ line: index + 2, action: 'reject', reason: error.message }); }
    }
    if (existing.length + summary.create > MAX_STUDENTS) throw new AccessError(400, 'roster_limit');
    return { rows, summary, digest: hash(JSON.stringify(rows)) };
}
