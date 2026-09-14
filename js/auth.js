// Firebase owns session persistence; application identity and roles stay in memory.
(() => {
    const staff = ['nurse', 'teacher', 'admin'];
    let sdk, auth, revision = 0;
    let state = { status: 'loading', user: null, role: null };
    const listeners = new Set();

    // ตัวตนที่รู้แล้ว เก็บไว้ให้หน้าถัดไปใช้ทันที
    //
    // เว็บนี้เป็นหลายหน้าแยกกัน ไม่ใช่ SPA ⇒ ทุกครั้งที่เปลี่ยนหน้า ทุกอย่างเริ่มใหม่หมด และของเดิม
    // ต้องรอครบสามต่อเรียงกันก่อนจะรู้ว่าใครล็อกอินอยู่: `/api/firebase-config` → โหลด SDK 137KB →
    // `/api/me` · Bank เห็นเป็น "กำลังตรวจสอบบัญชี" ค้างทุกหน้าและบอกว่าเว็บช้า (2026-09-14)
    //
    // **ค่าที่แคชนี้เป็นเรื่องหน้าตาล้วน ไม่ใช่สิทธิ์** — ทุก API ตรวจ ID token ฝั่งเซิร์ฟเวอร์เองทุกครั้ง
    // (`authorize()`), กฎ Firestore ก็ไม่เชื่อเบราว์เซอร์ ⇒ บทบาทที่ค้างอยู่ทำได้แค่โชว์เมนูผิด
    // ไม่เคยเปิดประตูให้ใคร · และ `authorizedFetch` ลดสถานะทันทีที่เซิร์ฟเวอร์ตอบ 403
    // เก็บใน sessionStorage ไม่ใช่ localStorage — ปิดแท็บแล้วหายไปกับมัน
    const CACHE_KEY = 'sfab.identity.v1';
    const CACHE_TTL_MS = 30 * 60 * 1000;
    const REVALIDATE_MS = 60 * 1000;
    let verifiedAt = 0;
    const readCache = uid => {
        try {
            const entry = JSON.parse(sessionStorage.getItem(CACHE_KEY) || 'null');
            if (!entry || !entry.user?.uid || Date.now() - entry.ts > CACHE_TTL_MS) return null;
            return uid === undefined || entry.user.uid === uid ? entry : null;
        } catch { return null; }
    };
    const writeCache = (user, role) => {
        try { sessionStorage.setItem(CACHE_KEY, JSON.stringify({ user, role, ts: Date.now() })); } catch { /* โหมดส่วนตัวปิดกั้นได้ ไม่ใช่ความผิดพลาด */ }
    };
    const clearCache = () => { try { sessionStorage.removeItem(CACHE_KEY); } catch { /* เหมือนกัน */ } };
    const publish = next => {
        state = Object.freeze(next);
        for (const listener of listeners) listener(state);
        window.dispatchEvent(new CustomEvent('sfab-auth', { detail: state }));
    };
    async function refresh({ force = false } = {}) {
        const run = ++revision, user = auth?.currentUser;
        if (!user) { clearCache(); publish({ status: 'signed-out', user: null, role: null }); return; }
        // การตรวจซ้ำคนเดิม ต้องไม่ล้างตัวตนที่รู้อยู่แล้วทิ้ง
        //
        // `onIdTokenChanged` ยิง refresh() ทุกครั้งที่ token ต่ออายุ (Firebase ทำเองราวชั่วโมงละครั้ง
        // และตอนโหลดหน้า) · ของเดิม publish `loading` พร้อม user:null ทุกรอบ ⇒ หน้าจอตกกลับไปเป็น
        // "ยังไม่ล็อกอิน" ตลอดช่วงที่รอ /api/me แล้วค่อยเด้งกลับมาเป็นชื่อ = กะพริบติดๆ ดับๆ
        // (Bank เห็นเองบน production 2026-09-14) · ตอนนี้แสดง loading เฉพาะตอนที่ยังไม่รู้ว่าใคร
        const cached = readCache(user.uid);
        if (cached) publish({ status: 'ready', user: cached.user, role: cached.role });
        else if (!(state.status === 'ready' && state.user?.uid === user.uid)) {
            publish({ status: 'loading', user: null, role: null });
        }
        if (!user.emailVerified || !/^[^@\s]+@tesaban6\.ac\.th$/.test(user.email || '')) {
            clearCache();
            await sdk.signOut(auth);
            publish({ status: 'forbidden', user: null, role: null });
            return;
        }
        // แสดงจากแคชแล้ว และเพิ่งถามเซิร์ฟเวอร์ไปไม่นาน — อย่าถามซ้ำ
        // `focus` ยิง refresh() ทุกครั้งที่กลับมาที่แท็บ ซึ่งบนมือถือเกิดบ่อยมาก
        if (cached && !force && Date.now() - verifiedAt < REVALIDATE_MS) return;
        try {
            const token = await user.getIdToken();
            const response = await fetch('/api/me', { headers: { Authorization: `Bearer ${token}` },
                signal: AbortSignal.timeout(10000), cache: 'no-store' });
            if (!response.ok) throw new Error(response.status === 403 ? 'forbidden' : 'unavailable');
            const me = await response.json();
            if (run !== revision || auth.currentUser?.uid !== user.uid) return;
            if (me.uid !== user.uid || !['student', ...staff].includes(me.role)) throw new Error('unavailable');
            verifiedAt = Date.now();
            writeCache(me, me.role);
            publish({ status: 'ready', user: me, role: me.role });
        } catch (error) {
            if (run !== revision) return;
            if (error.message === 'forbidden') { clearCache(); publish({ status: 'forbidden', user: null, role: null }); return; }
            // เซิร์ฟเวอร์ไม่ตอบ ไม่ใช่เซิร์ฟเวอร์ปฏิเสธ — เน็ตสะดุดต้องไม่ทำให้ session ที่ใช้อยู่หายไปต่อหน้า
            // มีคำตอบเมื่อไหร่ค่อยเชื่อคำตอบนั้น ระหว่างนี้ถือของเดิมที่เคยยืนยันแล้วไว้ก่อน
            if (cached) return;
            publish({ status: 'unavailable', user: null, role: null });
        }
    }
    async function initialize() {
        if (window.SFAB_RUNTIME?.transport === 'pi-local') {
            publish({ status: 'local', user: null, role: null }); return;
        }
        // SDK ไม่ได้ต้องใช้ config ตอนดาวน์โหลด มันต้องใช้ตอน `initializeApp` เท่านั้น
        // ของเดิมรอ config จบก่อนแล้วค่อยเริ่มโหลด 137KB = สองต่อเรียงกันโดยไม่จำเป็น
        const [response, module] = await Promise.all([
            fetch('/api/firebase-config', { signal: AbortSignal.timeout(10000) }),
            import('./firebase-sdk.js')
        ]);
        if (!response.ok) throw new Error('unavailable');
        const config = await response.json();
        sdk = module;
        auth = sdk.initializeAuth(sdk.initializeApp(config.config), {
            persistence: [sdk.indexedDBLocalPersistence, sdk.inMemoryPersistence],
            popupRedirectResolver: sdk.browserPopupRedirectResolver
        });
        if (config.emulators) {
            if (!['127.0.0.1', 'localhost'].includes(location.hostname)) throw new Error('unavailable');
            sdk.connectAuthEmulator(auth, `http://${config.emulators.auth}`, { disableWarnings: true });
        }
        await new Promise(resolve => sdk.onIdTokenChanged(auth, async () => { await refresh(); resolve(); }));
    }
    const service = {
        get state() { return state; },
        isStaff() { return state.status === 'ready' && staff.includes(state.role); },
        subscribe(callback) { listeners.add(callback); callback(state); return () => listeners.delete(callback); },
        async signIn() {
            await service.ready;
            if (!auth) throw new Error('Sign-in is not configured yet.');
            const provider = new sdk.GoogleAuthProvider();
            provider.setCustomParameters({ hd: 'tesaban6.ac.th', prompt: 'select_account' });
            await sdk.signInWithPopup(auth, provider);
            clearCache();
            await refresh({ force: true });
        },
        async signOut() {
            revision++;
            verifiedAt = 0;
            clearCache();
            publish({ status: 'signed-out', user: null, role: null });
            if (auth) await sdk.signOut(auth);
        },
        // ไม่ force — ตัวเรียกเดียวคือ `focus` ซึ่งบนมือถือยิงถี่มาก ให้ตัวหน่วงใน refresh() คุมจังหวะ
        async refresh() { await service.ready; if (auth) await refresh(); },
        async authorizedFetch(url, options = {}) {
            await service.ready;
            if (new URL(url, location.href).origin !== location.origin) throw new Error('Same-origin API required');
            const user = auth?.currentUser;
            if (!user) throw new Error('Sign in with your school Google account first.');
            const headers = new Headers(options.headers);
            headers.set('Authorization', `Bearer ${await user.getIdToken()}`);
            const response = await fetch(url, { ...options, headers, cache: 'no-store' });
            if (response.status === 401) await service.signOut();
            else if (response.status === 403) {
                // เซิร์ฟเวอร์เพิ่งบอกว่าสิทธิ์ไม่ตรง ⇒ ของที่แคชไว้ตกยุคแน่นอน ต้องไปถามใหม่ ไม่ใช่รอหมดอายุ
                clearCache();
                verifiedAt = 0;
                publish({ status: 'forbidden', user: null, role: null });
                void refresh({ force: true });
            }
            return response;
        }
    };
    window.AuthService = service;
    // เริ่มหน้าใหม่ด้วยคำตอบที่รู้อยู่แล้ว แทนที่จะเริ่มด้วยคำว่า "กำลังตรวจสอบ"
    //
    // นี่คือจุดที่ผู้ใช้รู้สึกจริง: ถ้าไม่ทำ ชิปจะขึ้น "กำลังตรวจสอบบัญชี" ไปจนกว่า Firebase จะโหลด
    // SDK เสร็จและกู้ session จาก IndexedDB ได้ — ทุกหน้า ทุกครั้ง แม้จะรู้คำตอบอยู่แล้วตั้งแต่หน้าก่อน
    // ตั้งค่า `state` ตรงๆ ไม่ผ่าน publish เพราะยังไม่มีใคร subscribe และ `subscribe()` ส่งค่าปัจจุบัน
    // ให้ทันทีอยู่แล้ว · ถ้า Firebase กู้มาแล้วเป็นคนละคนหรือไม่มีใคร refresh() จะแก้ให้เองในไม่กี่ร้อย ms
    const booted = window.SFAB_RUNTIME?.transport === 'pi-local' ? null : readCache();
    if (booted) state = Object.freeze({ status: 'ready', user: booted.user, role: booted.role });
    service.ready = initialize().catch(() => publish({ status: 'unavailable', user: null, role: null }));
    window.addEventListener('focus', () => { void service.refresh(); });
})();
