import { randomUUID } from 'node:crypto';
import { FieldPath } from 'firebase-admin/firestore';
import { authorize, apiHeaders, accessFailure, AccessError } from '../lib/auth.js';
import { MAX_STUDENTS, STUDENT_ID, importPlan, studentProjection, hash, newCard } from '../lib/students.js';
import { parseCsv, exportCsv } from '../lib/student-csv.js';
export function createStudentsHandler({ authorizeRequest = authorize, now = Date.now } = {}) {
    return async (req, res) => {
        apiHeaders(res, 'GET, POST');
        try {
            if (!['GET', 'POST'].includes(req.method)) throw new AccessError(405, 'method_not_allowed');
            const { db, token, role } = await authorizeRequest(req);
            const query = new URL(req.url, 'https://sfab.invalid').searchParams;
            const staff = ['teacher', 'admin'].includes(role);
            if (req.method === 'GET' && query.get('action') === 'me') {
                const mine = await db.collection('students').where('schoolEmail', '==', token.email.toLowerCase()).limit(2).get();
                if (mine.size !== 1) throw new AccessError(404, 'student_not_linked');
                return res.status(200).json({ student: studentProjection(mine.docs[0].data()), history: await history(db, mine.docs[0].id, query.get('cursor')) });
            }
            if (!staff) throw new AccessError(403, 'staff_role_required');
            if (req.method === 'GET') {
                const action = query.get('action');
                if (action === 'history') {
                    const id = query.get('studentId');
                    if (!STUDENT_ID.test(id || '')) throw new AccessError(400, 'invalid_studentId');
                    return res.status(200).json({ history: await history(db, id, query.get('cursor')) });
                }
                if (action === 'export') {
                    const at = now();
                    await db.runTransaction(async tx => {
                        const ref = db.doc('_studentExportLimits/' + hash(token.uid)), snap = await tx.get(ref);
                        if (snap.exists && at - snap.data().at < 60000) throw new AccessError(429, 'export_rate_limited');
                        tx.set(ref, { at });
                        tx.create(db.doc('_studentAudit/' + randomUUID()), { action: 'export', actor: token.uid, at: new Date(at).toISOString() });
                    });
                    const roster = await db.collection('students').orderBy('studentId').limit(MAX_STUDENTS + 1).get();
                    if (roster.size > MAX_STUDENTS) throw new AccessError(409, 'roster_limit');
                    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
                    res.setHeader('Content-Disposition', 'attachment; filename="sfab-students.csv"');
                    return res.status(200).send(exportCsv(roster.docs.map(doc => doc.data())));
                }
                const roster = await db.collection('students').orderBy('studentId').limit(MAX_STUDENTS + 1).get();
                if (roster.size > MAX_STUDENTS) throw new AccessError(409, 'roster_limit');
                return res.status(200).json({ students: roster.docs.map(doc => studentProjection(doc.data())) });
            }
            let body = req.body;
            if (Buffer.isBuffer(body) || typeof body === 'string') {
                if (Buffer.byteLength(body) > 2 * 1024 * 1024) throw new AccessError(413, 'body_too_large');
                try { body = JSON.parse(body.toString()); } catch { throw new AccessError(400, 'invalid_json'); }
            }
            if (!body || Buffer.byteLength(JSON.stringify(body)) > 2 * 1024 * 1024) throw new AccessError(413, 'body_too_large');
            if (body.action === 'card' || body.action === 'replace-card') {
                if (!STUDENT_ID.test(body.studentId || '')) throw new AccessError(400, 'invalid_studentId');
                const card = await db.runTransaction(async tx => {
                    const ref = db.doc('students/' + body.studentId), snap = await tx.get(ref);
                    if (!snap.exists) throw new AccessError(404, 'student_not_found');
                    const code = body.action === 'card' && snap.data().cardCode || newCard();
                    if (code !== snap.data().cardCode) {
                        tx.update(ref, { cardCode: code, cardHash: hash(code), revision: (snap.data().revision || 0) + 1 });
                        tx.create(db.doc('_studentAudit/' + randomUUID()), { action: body.action, studentId: body.studentId, actor: token.uid, at: new Date(now()).toISOString() });
                    }
                    return { code, student: studentProjection(snap.data()) };
                });
                return res.status(200).json(card);
            }
            if (!['preview', 'import'].includes(body.action)) throw new AccessError(400, 'invalid_action');
            let rows;
            try { rows = typeof body.csv === 'string' ? parseCsv(body.csv) : body.rows; } catch { throw new AccessError(400, 'invalid_csv'); }
            const result = await db.runTransaction(async tx => {
                const roster = await tx.get(db.collection('students').limit(MAX_STUDENTS + 1));
                const plan = importPlan(rows, roster.docs.map(doc => doc.data()));
                if (body.action === 'import') {
                    if (typeof body.digest !== 'string' || body.digest !== plan.digest) throw new AccessError(409, 'preview_changed');
                    if (plan.summary.reject) throw new AccessError(400, 'fix_rejected_rows');
                    for (const item of plan.rows.filter(item => ['create', 'update'].includes(item.action))) {
                        tx.set(db.doc('students/' + item.row.studentId), { ...item.row, name: item.row.givenName + ' ' + item.row.surname, revision: item.revision + 1, updatedAt: new Date(now()).toISOString() }, { merge: true });
                    }
                    tx.create(db.doc('_studentAudit/' + randomUUID()), { action: 'import', actor: token.uid, at: new Date(now()).toISOString(), summary: plan.summary });
                }
                return plan;
            });
            return res.status(200).json(result);
        } catch (error) { return accessFailure(res, error); }
    };
}
async function history(db, studentId, cursor) {
    let q = db.collection('dispenses').where('studentId', '==', studentId).orderBy('syncedAt', 'desc').orderBy(FieldPath.documentId(), 'desc');
    if (cursor) {
        let value;
        try { value = JSON.parse(Buffer.from(cursor, 'base64url').toString()); } catch { /* validate below */ }
        if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== 'string' || !Number.isFinite(Date.parse(value[0])) || typeof value[1] !== 'string' || !/^[a-zA-Z0-9_-]{1,48}~[a-zA-Z0-9_-]{8,80}$/.test(value[1])) throw new AccessError(400, 'invalid_cursor');
        q = q.startAfter(...value);
    }
    const rows = await q.limit(101).get(), docs = rows.docs.slice(0, 100), last = docs.at(-1);
    return { rows: docs.map(doc => { const value = doc.data(); return { eventId: doc.id, ts: value.ts, syncedAt: value.syncedAt, drawer: value.drawer, ack: value.ack, uncertain: value.uncertain, clockTrust: value.clockTrust }; }), nextCursor: rows.size > 100 ? Buffer.from(JSON.stringify([last.data().syncedAt, last.id])).toString('base64url') : null };
}
export default createStudentsHandler();
