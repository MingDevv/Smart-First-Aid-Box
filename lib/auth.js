import { firebaseServices } from './firebase-admin.js';

export const STAFF_ROLES = Object.freeze(['nurse', 'teacher', 'admin']);
export const CLINICAL_ROLES = STAFF_ROLES;
export class AccessError extends Error {
    constructor(status, code) { super(code); this.status = status; this.code = code; }
}
export function isSchoolIdentity(token) {
    return token?.email_verified === true && typeof token.email === 'string' &&
        /^[^@\s]+@tesaban6\.ac\.th$/.test(token.email);
}
export function createAuthorizer(services = firebaseServices) {
    return async function authorize(req, { staffOnly = false } = {}) {
        const header = req.headers?.authorization;
        const match = typeof header === 'string' && /^Bearer ([^\s]+)$/i.exec(header);
        if (!match) throw new AccessError(401, 'sign_in_required');
        let auth, db;
        try { ({ auth, db } = services()); }
        catch { throw new AccessError(503, 'auth_unavailable'); }
        let token;
        try {
            // Includes disabled-user and revocation checks; a cached UI role cannot extend access.
            token = await auth.verifyIdToken(match[1], true);
        } catch (error) {
            const invalid = ['auth/argument-error', 'auth/invalid-id-token', 'auth/id-token-expired',
                'auth/id-token-revoked', 'auth/user-disabled', 'auth/user-not-found'];
            throw new AccessError(invalid.includes(error.code) ? 401 : 503,
                invalid.includes(error.code) ? 'invalid_token' : 'auth_unavailable');
        }
        if (!Number.isInteger(token.iat) || token.iat <= 0 || token.iat >= token.exp ||
            token.iat > Math.floor(Date.now() / 1000) + 30) throw new AccessError(401, 'invalid_token');
        if (!isSchoolIdentity(token)) throw new AccessError(403, 'school_account_required');
        let role;
        try {
            const snap = await db.doc(`roles/${token.uid}`).get();
            const storedRole = snap.exists ? snap.data().role : undefined;
            role = STAFF_ROLES.includes(storedRole) ? storedRole : 'student';
        } catch { throw new AccessError(503, 'roles_unavailable'); }
        if (staffOnly && !STAFF_ROLES.includes(role)) throw new AccessError(403, 'staff_role_required');
        return { token, role, db };
    };
}
export const authorize = createAuthorizer();
export function accessFailure(res, error) {
    const known = error instanceof AccessError;
    return res.status(known ? error.status : 503).json({
        success: false, error: known ? error.code : 'service_unavailable', retrySafe: true
    });
}
export function apiHeaders(res, methods) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Access-Control-Allow-Methods', methods);
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}
