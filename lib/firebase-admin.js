import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

const EMULATORS = ['FIREBASE_AUTH_EMULATOR_HOST', 'FIRESTORE_EMULATOR_HOST'];
export function firebaseEnvironment(env = process.env) {
    const emulator = env.SFAB_USE_FIREBASE_EMULATORS === 'true';
    const hasEmulator = emulator || EMULATORS.some(key => env[key]);
    const projectId = env.FIREBASE_PROJECT_ID?.trim();
    if (hasEmulator && (env.VERCEL || env.NODE_ENV === 'production' || !emulator ||
        !/^demo-[a-z0-9-]+$/.test(projectId || '') ||
        EMULATORS.some(key => !/^127\.0\.0\.1:[0-9]{2,5}$/.test(env[key] || '')))) {
        throw new Error('Unsafe emulator configuration');
    }
    if (!projectId || (!emulator && projectId.startsWith('demo-'))) throw new Error('Firebase is not configured');
    return { projectId, emulator };
}

export function firebaseServices() {
    const { projectId, emulator } = firebaseEnvironment();
    let app = getApps().find(app => app.name === 'sfab');
    if (!app) {
        if (!emulator && (!process.env.FIREBASE_CLIENT_EMAIL || !process.env.FIREBASE_PRIVATE_KEY)) {
            throw new Error('Firebase is not configured');
        }
        app = initializeApp({
            projectId,
            ...(emulator ? {} : { credential: cert({
                projectId, clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
                privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
            }) })
        }, 'sfab');
    }
    return { auth: getAuth(app), db: getFirestore(app) };
}
