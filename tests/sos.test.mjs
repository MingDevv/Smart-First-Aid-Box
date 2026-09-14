import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import notify from '../edge/notify.mjs';

const read = name => readFile(new URL(`../${name}`, import.meta.url), 'utf8');
const source = await read('js/notification.js');
// โหลด js/storage.js กับ js/api-bridge.js ตัวจริงเข้าไปในคอนเท็กซ์ ไม่ใช้สตับ
// โหมดการทำงานเป็นข้อตกลงร่วมของสามไฟล์นี้ ('demo' | 'real' | 'unset') ถ้าเทสปลอม
// getOperatingMode หรือ triggerBuzzer ขึ้นมาเอง มันจะเขียวต่อไปแม้เกต "ยังไม่ตั้งโหมด" หายทั้งอัน
// — ซึ่งเป็นรูปเดียวกับบั๊กที่ทำให้ window.StorageService ไม่เคยมีอยู่จริงแล้วไม่มีเทสไหนเห็น
const storageSource = await read('js/storage.js');
const bridgeSource = await read('js/api-bridge.js');
const reply = (data, status = 200) => ({ ok: status < 300, status, json: async () => data });
// พอให้ js/storage.js ตัวจริงรันได้โดยไม่ต้องมีเบราว์เซอร์ (localStorage/sessionStorage)
const webStorage = () => {
    const map = new Map();
    return { getItem: key => (map.has(key) ? map.get(key) : null),
        setItem: (key, value) => { map.set(key, String(value)); },
        removeItem: key => { map.delete(key); } };
};

// demoMode: true / 'true' = โปรไฟล์ที่ครู "เลือกโหมดสาธิตแล้วจริงๆ"
// demoMode: false        = เลือกโหมดจริงแล้ว
// demoMode: null         = ยังไม่มีใครเลือก (ตู้ใหม่ และโปรไฟล์เก่าที่แยกไม่ออกว่าใครตั้ง)
// ตราประทับ modeProvisionedAt มาจาก StorageService.saveSettings ตัวจริง ไม่ได้เขียนมือลงไป
// ⇒ ถ้ากติกาการประทับเปลี่ยน fixture เปลี่ยนตาม ไม่ใช่ค้างเขียวอยู่กับกติกาเก่า
// buzzer: null = ใช้ ApiBridge.triggerBuzzer ตัวจริง (ใช้ตอนทดสอบเกตฮาร์ดแวร์)
function browser({ demoMode = false, fetch = async () => reply({ success: false }, 503),
    buzzer = async () => ({ success: false }), timeoutMs, local = true, authStatus = 'ready' } = {}) {
    const notices = [], mocks = [], prompts = [], elements = new Map();
    const window = { SFAB_RUNTIME: local ? {transport:'pi-local', mode:demoMode === null ? 'unset' : demoMode ? 'demo' : 'real'} : undefined, AuthService:{state:{user:null,status:authStatus}, isStaff:()=>false, authorizedFetch:fetch}, AuthUI:{ promptSignIn: reason => prompts.push(reason) } };
    const localStorage = webStorage(), sessionStorage = webStorage();
    const context = vm.createContext({ window, fetch, AbortController, clearTimeout,
        setTimeout: (fn, ms) => setTimeout(fn, timeoutMs ?? ms), console: { log() {}, warn() {}, error() {} },
        localStorage, sessionStorage, confirm: () => true,
        document: { getElementById(id) {
            if (!elements.has(id)) elements.set(id, { disabled: false, textContent: '',
                focus() { this.focused = true; }, setAttribute() {}, removeAttribute() {}, querySelector() { return this; } });
            return elements.get(id);
        } } });
    vm.runInContext(storageSource, context);
    const storage = window.StorageService;
    if (demoMode !== null) {
        storage.saveSettings({ demoMode: demoMode === true || demoMode === 'true' });
        // บางโปรไฟล์เก็บค่าเป็นสตริง ประทับตราด้วยบูลีนไปแล้วข้างบน ตรงนี้แค่ทับค่าที่เก็บ
        if (typeof demoMode === 'string') storage.saveSettings({ demoMode });
    }
    vm.runInContext(bridgeSource, context);
    if (buzzer) window.ApiBridge.triggerBuzzer = buzzer;
    vm.runInContext(source, context);
    const service = window.NotificationService;
    service.showToast = (message, type) => notices.push({ message, type });
    service.showLineMockModal = data => mocks.push(data);
    return { service, context, notices, mocks, prompts, elements, storage, localStorage };
}

test('missing local journal stays failure through the browser helper', async () => {
    const keys = ['LINE_NOTIFY_TOKEN', 'LINE_TOKEN', 'Line Token', 'LINE_CHANNEL_ACCESS_TOKEN', 'LINE_GROUP_ID', 'LINE_USER_ID'];
    const saved = keys.map(key => process.env[key]);
    keys.forEach(key => { delete process.env[key]; });
    let body, status;
    try {
        await notify({ method: 'POST', headers: {}, body: { message: 'synthetic test' } }, {
            setHeader() {}, status(code) { status = code; return this; }, json(data) { body = data; }
        });
    } finally {
        keys.forEach((key, i) => { if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i]; });
    }
    assert.equal(status, 503);
    assert.equal(body.success, false);
    const b = browser({ fetch: async () => reply(body, status) });
    assert.equal((await b.service.sendLineNotification('synthetic test')).success, false);
    assert.equal(b.mocks.length, 0, 'real failure must never open a Demo modal');
});

test('local SOS LINE is never simulated by Demo or unset mode', async () => {
    for (const demoMode of [true, null, false]) {
        let requests = 0;
        const b = browser({ demoMode, fetch: async () => { requests++; return reply({ success: true }); } });
        assert.equal((await b.service.sendLineNotification('SOS')).success, true);
        assert.equal(requests, 1);
        assert.equal(b.mocks.length, 0);
    }
});

test('LINE failures and stalled JSON bodies remain bounded, unsuccessful and unsimulated', async () => {
    for (const fetch of [async () => { throw new Error('offline'); },
        async () => reply({ success: false }), async () => reply({ success: true, mode: 'simulation' }),
        async (_url, options) => ({ ok: true, json: () => new Promise((_resolve, reject) => {
            options.signal.addEventListener('abort', () => reject(new Error('timeout')));
        }) })]) {
        const b = browser({ fetch, timeoutMs: 10 });
        assert.equal((await b.service.sendLineNotification('test')).success, false);
        assert.equal(b.mocks.length, 0);
    }
});

test('all four real SOS buttons distinguish total failure, partial success and Demo', async () => {
    for (const [file, name] of [['index.html', 'triggerHomeSos'], ['student/index.html', 'triggerSOS'],
        ['student/kiosk.html', 'triggerKioskSos'], ['student/wound-select.html', 'triggerSelectSos']]) {
        const html = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
        const dispatch = html.slice(html.indexOf(`        async function ${name}()`), html.indexOf('    </script>', html.indexOf(`        async function ${name}()`)));
        for (const [line, sound, expected] of [[false, false, 'danger'], [false, true, 'warning'], [true, false, 'warning'], [true, true, 'success']]) {
            const b = browser({ fetch: async () => reply({ success: line }, line ? 200 : 503), buzzer: async () => ({ success: sound }) });
            vm.runInContext(dispatch, b.context);
            await b.context[name]();
            assert.equal(b.notices.at(-1).type, expected, `${file}: line=${line}, buzzer=${sound}`);
            if (!line) assert.doesNotMatch(b.notices.at(-1).message, /ส่ง.*(?:ถึงครู|ผ่าน LINE แล้ว)/);
            assert.equal(b.mocks.length, 0);
        }

    }
});

test('student web SOS sends only the constrained event and never calls the buzzer', async () => {
    let buzzers = 0;
    const requests = [];
    const b = browser({ local: false,
        fetch: async (url, options) => { requests.push([url, JSON.parse(options.body)]); return reply({success:true}); },
        buzzer: async () => { buzzers++; return {success:true}; }
    });
    b.localStorage.setItem('smart_first_aid_settings', JSON.stringify({demoMode:true,dashboard_auth:true}));
    const result = await b.service.sendSos({name:'forged',messages:[{}]});
    assert.deepEqual(requests,[['/api/notify',{event:'sos'}]]);
    assert.equal(buzzers,0);
    assert.equal(result.buzzer.mode,'not-requested');
    assert.equal(b.notices.at(-1).type,'success');
    assert.equal(b.mocks.length,0);
});

test('one rejected SOS channel preserves the other channel result', async () => {
    const b = browser({ fetch: async () => reply({ success: true }), buzzer: async () => { throw new Error('offline'); } });
    await b.service.sendSos('synthetic');
    assert.equal(b.notices.at(-1).type, 'warning');
    assert.match(b.notices.at(-1).message, /แจ้งครูพยาบาลแล้ว/, 'ออดล้มเหลวต้องไม่ลบผลสำเร็จของการแจ้งครู');
});

test('dashboard stop waits for off completion, prevents double click, and exposes uncertainty', async () => {
    const html = await readFile(new URL('../dashboard/index.html', import.meta.url), 'utf8');
    const start = html.indexOf('        async function stopSosBuzzer()');
    assert.notEqual(start, -1, 'teacher must have an actual stop control');
    // `indexOf` คืน -1 เงียบๆ แล้ว slice ลากยาวไปทั้งไฟล์จนติด HTML เข้ามาใน vm
    // ⇒ ยืนยันขอบเขตทั้งสองด้าน ไม่ใช่แค่ด้านเริ่ม เพื่อให้การย้ายโค้ดครั้งหน้าแดงแทนที่จะพังลึก
    const end = html.indexOf("        document.addEventListener('DOMContentLoaded'", start);
    assert.notEqual(end, -1, 'ต้องหาปลายของบล็อกสคริปต์เจอ ไม่งั้นกำลังรัน HTML เป็น JavaScript');
    const dispatch = html.slice(start, end);
    assert.doesNotMatch(dispatch, /<\/?[a-z]/i, 'สิ่งที่ตัดมาต้องเป็น JavaScript ล้วน');
    for (const result of [{ success: true }, { success: false }, { success: true, mode: 'simulation' }]) {
        let resolve, calls = 0;
        const b = browser({ buzzer: state => { assert.equal(state, 'off'); calls++; return new Promise(r => { resolve = r; }); } });
        vm.runInContext(dispatch, b.context);
        const pending = b.context.stopSosBuzzer();
        await b.context.stopSosBuzzer();
        assert.equal(calls, 1);
        const button = b.elements.get('stop-sos-button'), status = b.elements.get('stop-sos-status');
        assert.equal(button.disabled, true);
        assert.doesNotMatch(status.textContent, /ยืนยันหยุดเสียงแล้ว/);
        resolve(result);
        await pending;
        assert.equal(button.disabled, false);
        assert.match(status.textContent, result.mode === 'simulation' ? /โหมดสาธิต/
            : result.success ? /ยืนยันหยุดเสียงแล้ว/ : /ยังยืนยันการหยุดเสียงไม่ได้/);
    }
});


// การเรียกครูต้องไม่ถูกเกตด้วยการล็อกอิน — ถ้าใส่เกต เด็กที่ยังไม่ล็อกอินจะเรียกครูไม่ได้เลย
// SOS/ออด/คู่มือ/LINE ไม่ถูกเกตด้วยตัวตน โหมด นาฬิกา หรือเน็ต · ตัวตนกลายเป็นของแถมที่ทำให้
// ข้อความมีชื่อ ไม่ใช่เงื่อนไขก่อนส่ง
test('home SOS reaches the teacher whether or not the student signed in', async () => {
    const html = await read('index.html');
    const start = html.indexOf('        async function triggerHomeSos()');
    const dispatch = html.slice(start, html.indexOf('    </script>', start));
    for (const status of ['loading', 'signed-out', 'forbidden', 'unavailable', 'ready']) {
        let calls = 0, confirms = 0;
        const b = browser({local:false,fetch:async()=>{calls++;return reply({success:true});}});
        b.context.window.AuthService.state.status = status;
        b.context.confirm = () => { confirms++; return true; };
        vm.runInContext(dispatch, b.context);
        await b.context.triggerHomeSos();
        assert.equal(calls,1,`${status}: เรียกครูต้องส่งถึงเสมอ`);
        assert.equal(confirms,1,`${status}: ยังต้องถามยืนยันก่อนส่ง`);
        assert.equal(b.prompts.length,0,`${status}: ห้ามเด้งกล่องล็อกอินมาขวางการเรียกครู`);
    }
});


test('shared cloud SOS delivers for anonymous callers too, and never blocks on identity', async () => {
    for (const status of ['loading', 'signed-out', 'forbidden', 'unavailable', undefined]) {
        let calls=0;
        const b=browser({local:false,authStatus:status,
            fetch:async()=>{calls++;return reply({success:true});}});
        if(status===undefined)delete b.context.window.AuthService;
        const result=await b.service.sendSos({event:'sos'});
        assert.equal(calls,1,`${status}: ต้องยิงถึง API จริง`);
        assert.equal(result.line.success,true,String(status));
        assert.equal(b.prompts.length,0,`${status}: ห้ามเด้งกล่องล็อกอิน`);
    }
});

test('all four cloud SOS callers deliver without demanding a sign-in first', async () => {
    for (const [file,name] of [['index.html','triggerHomeSos'],['student/index.html','triggerSOS'],
        ['student/kiosk.html','triggerKioskSos'],['student/wound-select.html','triggerSelectSos']]) {
        const html=await read(file);
        const start=html.indexOf(`        async function ${name}()`);
        assert.notEqual(start,-1);
        const dispatch=html.slice(start,html.indexOf('    </script>',start));
        let calls=0;
        const b=browser({local:false,authStatus:'signed-out',fetch:async()=>{calls++;return reply({success:true});}});
        vm.runInContext(dispatch,b.context);
        await b.context[name]();
        assert.equal(calls,1,`${file}: เรียกครูต้องถึง API แม้ยังไม่ล็อกอิน`);
        assert.equal(b.prompts.length,0,file);
    }
});

// จอตู้มีคนอ่านคนเดียวคือเด็กที่เพิ่งเจ็บ
//
// ตู้ไม่ยิง LINE เอง มันบันทึกลง outbox ให้คลาวด์ส่งต่อ ⇒ `queued` คือทางปกติ
// ที่สำเร็จ ไม่ใช่ทางที่พลาด · ข้อกังวลที่แท้จริงคือ **ห้ามอ้างว่า LINE ส่งถึงแล้ว**
const sosOverlay = async (b) => {
    const kiosk = await read('js/kiosk-app.js');
    const start = kiosk.indexOf('    async function sendSos(');
    const end = kiosk.indexOf('    function onIdleWarning',start);
    assert.ok(start>=0 && end>start);
    vm.runInContext('let sosBusy=false; const el=id=>document.getElementById(id); const storage=()=>null;'+kiosk.slice(start,end),b.context);
    await b.context.sendSos();
    return { title: b.elements.get('sos-overlay-title').textContent,
        body: b.elements.get('sos-overlay-text').textContent };
};

test('a queued SOS reads as done to the student, without claiming LINE was delivered', async () => {
    const b = browser({fetch:async()=>reply({success:true,mode:'queued',lineDelivered:false},202),
        buzzer:async()=>({success:true,mode:'pi-local'})});
    const { title, body } = await sosOverlay(b);
    assert.equal(title,'แจ้งครูพยาบาลแล้ว','queued คือทางปกติหลัง WP2 ไม่ใช่ความล้มเหลว');
    assert.equal(body,'รอครูสักครู่นะ');
    for (const claim of [/LINE/i,/ส่งถึงครูแล้ว/,/delivered/i])
        assert.doesNotMatch(title+' '+body,claim,'ห้ามอ้างว่า LINE ส่งถึงแล้วทั้งที่ยังอยู่ในคิว');
});

test('a student who cannot be helped by the screen is told to go find a teacher', async () => {
    const b = browser({fetch:async()=>reply({success:false},503),buzzer:async()=>({success:false})});
    const { title, body } = await sosOverlay(b);
    assert.equal(title,'ยังแจ้งครูไม่ได้');
    assert.match(body,/ไปตามครูที่อยู่ใกล้ที่สุด/);
});

// จอนี้เด็กอ่าน ไม่ใช่คนดูแลระบบ — ห้ามมีอังกฤษ ห้ามมีศัพท์ระบบ และต้องสั้นพอที่จะอ่านจบตอนเจ็บ
test('the cabinet screen speaks Thai a child can act on, with no system jargon', async () => {
    for (const [label, opts] of [
        ['queued', {fetch:async()=>reply({success:true,mode:'queued'},202),buzzer:async()=>({success:true,mode:'pi-local'})}],
        ['failed', {fetch:async()=>reply({success:false},503),buzzer:async()=>({success:false})}],
        ['demo',   {fetch:async()=>reply({success:true,mode:'simulation'},200),buzzer:async()=>({success:true,mode:'simulation'})}]
    ]) {
        const { title, body } = await sosOverlay(browser(opts));
        const seen = title+' '+body;
        assert.doesNotMatch(seen,/[A-Za-z]/,`${label}: ห้ามมีตัวอักษรภาษาอังกฤษบนจอตู้`);
        for (const jargon of [/ยืนยันไม่ได้ทั้งหมด/,/pending/i,/queued/i,/mode/i,/ACK/i])
            assert.doesNotMatch(seen,jargon,`${label}: "${jargon}" เป็นศัพท์ของคนทำระบบ ไม่ใช่ของเด็ก`);
        assert.ok(title.length <= 24,`${label}: หัวเรื่องยาวเกินไป (${title.length})`);
        assert.ok(body.length <= 40,`${label}: คำอธิบายยาวเกินไป (${body.length})`);
    }
});

// โหมดสาธิตต้องไม่บอกเด็กว่าเรียกครูแล้ว ทั้งที่ไม่มีใครถูกเรียก
test('demo mode says plainly that no teacher was called', async () => {
    const b = browser({fetch:async()=>reply({success:true,mode:'simulation'},200),
        buzzer:async()=>({success:true,mode:'simulation'})});
    const { title, body } = await sosOverlay(b);
    assert.equal(title,'โหมดสาธิต');
    assert.match(body,/ยังไม่ได้เรียกครูจริง/);
});
