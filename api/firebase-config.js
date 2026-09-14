import { firebaseEnvironment } from '../lib/firebase-admin.js';

// ค่าในนี้เป็นค่าสาธารณะโดยการออกแบบของ Firebase — `apiKey` ของเว็บไม่ใช่ความลับ มันคือตัวชี้โปรเจ็ค
// และทุกเว็บ Firebase ฝังมันไว้ใน HTML อยู่แล้ว การกันมันไม่ให้ถูกแคชจึงไม่ได้ซื้อความปลอดภัยอะไรเลย
// แต่ซื้อความช้า: `no-store` ทำให้ทุกการเปิดหน้าต้องปลุก lambda (วัดจริงบน production 2026-09-14
// ได้ 0.42–1.70 วิ ต่อหน้า, `x-vercel-cache: MISS` ทุกครั้ง) แล้วการโหลด SDK ถึงจะเริ่มได้
// ⇒ ให้ขอบเครือข่ายเก็บไว้ ส่วนเบราว์เซอร์ถือสั้นๆ พอให้การเปลี่ยนค่าไม่ต้องรอนาน
const PUBLIC_CACHE = 'public, max-age=300, s-maxage=86400, stale-while-revalidate=604800';

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
        // ตั้งหลังผ่านการตรวจครบแล้วเท่านั้น ไม่งั้น 503 ที่หลุดออกไปจะถูกแคชค้างไว้ทั้งวัน
        // โหมด emulator ตอบคนละค่ากับของจริงและใช้เฉพาะบนเครื่อง ห้ามให้ค่านั้นไปค้างที่ขอบเครือข่าย
        if (!emulator) res.setHeader('Cache-Control', PUBLIC_CACHE);
        return res.status(200).json({ config, ...(emulator ? { emulators: {
            auth: process.env.FIREBASE_AUTH_EMULATOR_HOST,
            firestore: process.env.FIRESTORE_EMULATOR_HOST
        } } : {}) });
    } catch { return res.status(503).json({ error: 'firebase_not_configured' }); }
}
