import { spawn } from 'node:child_process';
const env = { ...process.env, FIREBASE_PROJECT_ID: 'demo-sfab', SFAB_USE_FIREBASE_EMULATORS: 'true',
    FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099', FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
    CI: 'true' };
// These tests must never inherit real credentials or external delivery configuration.
for (const key of Object.keys(env)) if (/^(LINE_|MQTT_|FIREBASE_PRIVATE_KEY|FIREBASE_CLIENT_EMAIL|GOOGLE_APPLICATION_CREDENTIALS)/.test(key)) delete env[key];
const child = spawn(process.execPath, ['node_modules/firebase-tools/lib/bin/firebase.js', 'emulators:exec',
    '--project', 'demo-sfab', '--only', 'auth,firestore',
    'node --test tests/firebase-rules.test.mjs tests/firebase-api.test.mjs'], { env, stdio: 'inherit' });
child.on('exit', code => { process.exitCode = code ?? 1; });
