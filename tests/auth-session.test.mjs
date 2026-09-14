// หน้าใหม่ต้องไม่ทำให้ผู้ใช้รอเครือข่ายเพื่อรู้ว่าตัวเองเป็นใคร
//
// เทสชุดนี้ปักพฤติกรรมของ `js/auth.js` ซึ่งทำงานทุกหน้า และปักเส้นที่ห้ามข้าม:
// **แคชนี้เร่งการแสดงผลได้ แต่ต้องยอมเซิร์ฟเวอร์ทันทีที่เซิร์ฟเวอร์ตอบ**
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const ORIGINAL = await readFile(new URL('../js/auth.js', import.meta.url), 'utf8');
const IMPORT_CALL = "import('./firebase-sdk.js')";
// เทสนี้แทนที่เฉพาะกลไกโหลดโมดูล ไม่ได้แตะตรรกะที่กำลังตรวจ — ถ้าบรรทัดนั้นถูกเขียนใหม่ ต้องรู้ ไม่ใช่เงียบ
assert.ok(ORIGINAL.includes(IMPORT_CALL), 'js/auth.js ต้องโหลด SDK แบบ dynamic import — เทสนี้พึ่งรูปนั้น');
const SOURCE = ORIGINAL.replace(IMPORT_CALL, '__importSdk()');

const USER = { uid: 'u-1', email: 'student@tesaban6.ac.th', emailVerified: true, getIdToken: async () => 'synthetic-id-token' };
const ME = { uid: 'u-1', email: USER.email, name: 'First Surname', role: 'student' };

function page({ seed = null, currentUser = USER, me = ME, meStatus = 200, meFails = false,
    configPending = null, importPending = null } = {}) {
    const store = new Map();
    if (seed) store.set('sfab.identity.v1', JSON.stringify(seed));
    const calls = { me: 0, config: 0, sdkImport: 0, signOut: 0 };
    const listeners = {};
    let authObject = null, tokenListener = null;

    const sdk = {
        initializeApp: config => ({ config }),
        initializeAuth: () => (authObject = { currentUser }),
        indexedDBLocalPersistence: 1, inMemoryPersistence: 2, browserPopupRedirectResolver: 3,
        onIdTokenChanged: (_auth, fn) => { tokenListener = fn; fn(); },
        signOut: async () => { calls.signOut++; if (authObject) authObject.currentUser = null; },
        GoogleAuthProvider: class { setCustomParameters() {} },
        signInWithPopup: async () => { if (authObject) authObject.currentUser = currentUser; },
        connectAuthEmulator: () => {}
    };

    const context = vm.createContext({
        console,
        AbortSignal,
        CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
        Headers,
        URL,
        location: { href: 'https://sfab.test/dashboard/', origin: 'https://sfab.test', hostname: 'sfab.test' },
        sessionStorage: {
            getItem: key => (store.has(key) ? store.get(key) : null),
            setItem: (key, value) => store.set(key, value),
            removeItem: key => store.delete(key)
        },
        __importSdk: async () => { calls.sdkImport++; if (importPending) await importPending; return sdk; },
        fetch: async url => {
            if (String(url).includes('/api/firebase-config')) {
                calls.config++;
                if (configPending) await configPending;
                return { ok: true, status: 200, json: async () => ({ config: { projectId: 'p' } }) };
            }
            calls.me++;
            if (meFails) throw new Error('synthetic network failure');
            return { ok: meStatus === 200, status: meStatus, json: async () => me };
        },
        window: {
            addEventListener: (type, fn) => { listeners[type] = fn; },
            dispatchEvent: () => {}
        }
    });
    context.window.SFAB_RUNTIME = undefined;
    vm.runInContext(SOURCE, context);
    return { service: context.window.AuthService, calls, store,
        fireFocus: () => listeners.focus?.(), retoken: () => tokenListener?.(),
        setUser: value => { if (authObject) authObject.currentUser = value; } };
}

const fresh = (extra = {}) => ({ user: ME, role: 'student', ts: Date.now(), ...extra });

// จุดที่ผู้ใช้รู้สึกจริง: เปิดหน้าใหม่แล้วชื่อขึ้นทันที ไม่ใช่ขึ้นคำว่ากำลังตรวจสอบก่อน
test('a page that already knows who you are starts ready, before any network call', () => {
    const p = page({ seed: fresh() });
    assert.equal(p.service.state.status, 'ready', 'ต้องพร้อมตั้งแต่บรรทัดแรก ไม่ใช่หลัง await');
    assert.equal(p.service.state.user.name, 'First Surname');
    // Firebase ยังเริ่มโหลดอยู่เบื้องหลังตามปกติ — ที่ต้องไม่เกิดคือ "รอ" มันก่อนจะแสดงผลได้
    assert.equal(p.calls.me, 0, 'ยังไม่มีการถามตัวตนกับเซิร์ฟเวอร์เลยในจังหวะที่หน้าแสดงผลแล้ว');

    const cold = page();
    assert.equal(cold.service.state.status, 'loading', 'ไม่มีแคช ก็ยังต้องบอกตามตรงว่ากำลังตรวจสอบ');
});

test('the SDK download starts without waiting for the config round trip', async () => {
    // ปลดล็อก config ได้ก็ต่อเมื่อ import ถูกเรียกแล้วเท่านั้น ⇒ ถ้าโค้ดกลับไปทำแบบเรียงกัน เทสนี้จะค้าง
    let unlock;
    const configPending = new Promise(resolve => { unlock = resolve; });
    const p = page({ configPending });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(p.calls.sdkImport, 1, 'SDK ต้องเริ่มโหลดทั้งที่ config ยังไม่กลับมา');
    unlock();
    await p.service.ready;
    assert.equal(p.service.state.status, 'ready');
});

test('a cached identity is still re-checked against the server in the background', async () => {
    const p = page({ seed: fresh({ role: 'admin' }) });
    assert.equal(p.service.state.role, 'admin', 'แสดงจากแคชก่อน');
    await p.service.ready;
    assert.equal(p.calls.me, 1, 'แล้วต้องไปถามเซิร์ฟเวอร์จริงเสมอ');
    assert.equal(p.service.state.role, 'student', 'คำตอบของเซิร์ฟเวอร์ชนะแคชเสมอ');
    assert.equal(JSON.parse(p.store.get('sfab.identity.v1')).role, 'student');
});

// เน็ตสะดุดไม่ใช่การถูกปฏิเสธ — session ที่ยืนยันแล้วต้องไม่หายไปต่อหน้าเพราะสัญญาณตก
test('a failed re-check keeps a verified session instead of dropping it', async () => {
    const p = page({ seed: fresh(), meFails: true });
    await p.service.ready;
    assert.equal(p.calls.me, 1);
    assert.equal(p.service.state.status, 'ready', 'ยังใช้งานต่อได้');
    assert.ok(p.store.has('sfab.identity.v1'), 'แคชต้องไม่ถูกล้างเพราะเน็ตล่ม');

    const cold = page({ meFails: true });
    await cold.service.ready;
    assert.equal(cold.status, undefined);
    assert.equal(cold.service.state.status, 'unavailable', 'ไม่มีของเก่าให้ยึด ก็ต้องบอกว่าไม่พร้อม');
});

// เซิร์ฟเวอร์ปฏิเสธ = คำตัดสิน ไม่ใช่สัญญาณรบกวน ⇒ ต้องล้างของที่แคชไว้ทันที
test('a server refusal clears the cached identity', async () => {
    const p = page({ seed: fresh({ role: 'admin' }), meStatus: 403 });
    await p.service.ready;
    assert.equal(p.service.state.status, 'forbidden');
    assert.equal(p.service.state.role, null);
    assert.equal(p.store.has('sfab.identity.v1'), false, 'บทบาทที่ถูกถอนแล้วต้องไม่ค้างอยู่');
});

test('signing out leaves nothing behind for the next page to read', async () => {
    const p = page({ seed: fresh() });
    await p.service.ready;
    assert.ok(p.store.has('sfab.identity.v1'));
    await p.service.signOut();
    assert.equal(p.store.has('sfab.identity.v1'), false);
    assert.equal(p.service.state.status, 'signed-out');
    assert.equal(p.calls.signOut, 1);
});

// `focus` ยิงถี่มากบนมือถือ ทุกครั้งที่สลับแอปกลับมา — ถ้าผูก /api/me ไว้กับ focus จะยิงซ้ำทุกครั้ง
test('returning to the tab does not hammer the server once the session is verified', async () => {
    const p = page({ seed: fresh() });
    await p.service.ready;
    assert.equal(p.calls.me, 1);
    for (let i = 0; i < 5; i++) { p.fireFocus(); await p.service.ready; }
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(p.calls.me, 1, 'ยืนยันไปแล้วเมื่อกี้ ไม่ต้องถามซ้ำทุกครั้งที่กลับมาที่แท็บ');
});

test('signing out and back in re-asks the server rather than trusting the old answer', async () => {
    const p = page({ seed: fresh() });
    await p.service.ready;
    const before = p.calls.me;
    await p.service.signIn();
    assert.ok(p.calls.me > before, 'การเข้าสู่ระบบใหม่ต้องผ่านเซิร์ฟเวอร์เสมอ');
    assert.equal(p.service.state.status, 'ready');
});

test('a cache entry belonging to someone else is never shown', async () => {
    const p = page({ seed: fresh({ user: { ...ME, uid: 'someone-else' } }) });
    // อ่านตอน boot ยังไม่รู้ว่าใคร จึงยอมให้ขึ้นก่อนได้ แต่พอ Firebase บอกว่าเป็นคนละ uid ต้องถูกแทนที่
    await p.service.ready;
    assert.equal(p.service.state.user.uid, 'u-1');
    assert.equal(p.calls.me, 1);
});

test('an expired cache entry is ignored', () => {
    const stale = page({ seed: fresh({ ts: Date.now() - 31 * 60 * 1000 }) });
    assert.equal(stale.service.state.status, 'loading', 'ของเก่าเกิน 30 นาทีต้องไม่ถูกใช้');
});

// โหมดส่วนตัวของเบราว์เซอร์โยน error ตอนแตะ sessionStorage — ต้องทำงานต่อได้ ไม่ใช่หน้าขาว
test('a browser that refuses storage still signs in normally', async () => {
    const context = { calls: 0 };
    const p = page({ seed: null });
    p.store.set = () => { context.calls++; throw new Error('storage disabled'); };
    await p.service.ready;
    assert.equal(p.service.state.status, 'ready');
});
