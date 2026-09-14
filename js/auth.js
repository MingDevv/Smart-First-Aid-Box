// Firebase owns session persistence; application identity and roles stay in memory.
(() => {
    const staff = ['teacher', 'admin'];   // ต้องตรงกับ STAFF_ROLES ใน lib/auth.js และ staff() ใน firestore.rules
    let sdk, auth, revision = 0;
    let state = { status: 'loading', user: null, role: null };
    const listeners = new Set();
    const publish = next => {
        state = Object.freeze(next);
        for (const listener of listeners) listener(state);
        window.dispatchEvent(new CustomEvent('sfab-auth', { detail: state }));
    };
    async function refresh() {
        const run = ++revision, user = auth?.currentUser;
        if (!user) { publish({ status: 'signed-out', user: null, role: null }); return; }
        // การตรวจซ้ำคนเดิม ต้องไม่ล้างตัวตนที่รู้อยู่แล้วทิ้ง
        //
        // `onIdTokenChanged` ยิง refresh() ทุกครั้งที่ token ต่ออายุ (Firebase ทำเองราวชั่วโมงละครั้ง
        // และตอนโหลดหน้า) · ของเดิม publish `loading` พร้อม user:null ทุกรอบ ⇒ หน้าจอตกกลับไปเป็น
        // "ยังไม่ล็อกอิน" ตลอดช่วงที่รอ /api/me แล้วค่อยเด้งกลับมาเป็นชื่อ = กะพริบติดๆ ดับๆ
        // (Bank เห็นเองบน production 2026-09-14) · ตอนนี้แสดง loading เฉพาะตอนที่ยังไม่รู้ว่าใคร
        if (!(state.status === 'ready' && state.user?.uid === user.uid)) {
            publish({ status: 'loading', user: null, role: null });
        }
        if (!user.emailVerified || !/^[^@\s]+@tesaban6\.ac\.th$/.test(user.email || '')) {
            await sdk.signOut(auth);
            publish({ status: 'forbidden', user: null, role: null });
            return;
        }
        try {
            const token = await user.getIdToken();
            const response = await fetch('/api/me', { headers: { Authorization: `Bearer ${token}` },
                signal: AbortSignal.timeout(10000), cache: 'no-store' });
            if (!response.ok) throw new Error(response.status === 403 ? 'forbidden' : 'unavailable');
            const me = await response.json();
            if (run !== revision || auth.currentUser?.uid !== user.uid) return;
            if (me.uid !== user.uid || !['student', ...staff].includes(me.role)) throw new Error('unavailable');
            publish({ status: 'ready', user: me, role: me.role });
        } catch (error) {
            if (run === revision) publish({ status: error.message === 'forbidden' ? 'forbidden' : 'unavailable', user: null, role: null });
        }
    }
    async function initialize() {
        if (window.SFAB_RUNTIME?.transport === 'pi-local') {
            publish({ status: 'local', user: null, role: null }); return;
        }
        const response = await fetch('/api/firebase-config', { signal: AbortSignal.timeout(10000), cache: 'no-store' });
        if (!response.ok) throw new Error('unavailable');
        const config = await response.json();
        sdk = await import('./firebase-sdk.js');
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
            await refresh();
        },
        async signOut() {
            revision++;
            publish({ status: 'signed-out', user: null, role: null });
            if (auth) await sdk.signOut(auth);
        },
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
                publish({ status: 'forbidden', user: null, role: null });
                void refresh();
            }
            return response;
        }
    };
    window.AuthService = service;
    service.ready = initialize().catch(() => publish({ status: 'unavailable', user: null, role: null }));
    window.addEventListener('focus', () => { void service.refresh(); });
})();
