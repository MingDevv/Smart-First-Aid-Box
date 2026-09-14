import { authorize, accessFailure, apiHeaders } from '../lib/auth.js';
export default async function handler(req, res) {
    apiHeaders(res, 'GET, OPTIONS');
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });
    try {
        const { token, role, db } = await authorize(req);
        const student = await db.doc(`students/${token.uid}`).get();
        const data = student.exists ? student.data() : {};
        // Firestore reads cannot redact fields. Never spread the clinical document here.
        return res.status(200).json({
            uid: token.uid, email: token.email, name: typeof token.name === 'string' ? token.name : '',
            role, profile: { active: typeof data.active === 'boolean' ? data.active : null }
        });
    } catch (error) { return accessFailure(res, error); }
}
