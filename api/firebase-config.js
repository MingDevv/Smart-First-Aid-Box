import { firebaseEnvironment } from '../lib/firebase-admin.js';
export default function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });
    try {
        const { projectId, emulator } = firebaseEnvironment();
        const config = {
            projectId,
            apiKey: emulator ? 'demo-sfab-api-key' : process.env.FIREBASE_WEB_API_KEY,
            authDomain: emulator ? 'demo-sfab.firebaseapp.com' : process.env.FIREBASE_AUTH_DOMAIN,
            appId: emulator ? 'demo-sfab-app' : process.env.FIREBASE_WEB_APP_ID
        };
        if (!config.apiKey || !config.authDomain || !config.appId) throw new Error();
        return res.status(200).json({ config, ...(emulator ? { emulators: {
            auth: process.env.FIREBASE_AUTH_EMULATOR_HOST,
            firestore: process.env.FIRESTORE_EMULATOR_HOST
        } } : {}) });
    } catch { return res.status(503).json({ error: 'firebase_not_configured' }); }
}
