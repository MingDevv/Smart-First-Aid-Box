import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import notify from '../api/notify.js';

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
    buzzer = async () => ({ success: false }), timeoutMs } = {}) {
    const notices = [], mocks = [], elements = new Map();
    const window = {};
    const localStorage = webStorage(), sessionStorage = webStorage();
    const context = vm.createContext({ window, fetch, AbortController, clearTimeout,
        setTimeout: (fn, ms) => setTimeout(fn, timeoutMs ?? ms), console: { log() {}, warn() {}, error() {} },
        localStorage, sessionStorage, confirm: () => true,
        document: { getElementById(id) {
            if (!elements.has(id)) elements.set(id, { disabled: false, textContent: '',
                setAttribute() {}, removeAttribute() {}, querySelector() { return this; } });
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
    return { service, context, notices, mocks, elements, storage, localStorage };
}

test('actual no-credentials notify response stays failure through the browser helper', async () => {
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
    assert.equal(status, 500);
    assert.equal(body.success, false);
    const b = browser({ fetch: async () => reply(body, status) });
    assert.equal((await b.service.sendLineNotification('synthetic test')).success, false);
    assert.equal(b.mocks.length, 0, 'real failure must never open a Demo modal');
});

test('only explicit Demo simulates LINE and never sends a network request', async () => {
    for (const demoMode of [true, 'true']) {
        let requests = 0;
        const b = browser({ demoMode, fetch: async () => { requests++; return reply({ success: true }); } });
        assert.equal((await b.service.sendLineNotification('demo')).mode, 'simulation');
        assert.equal(requests, 0);
        assert.equal(b.mocks.length, 1);
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
        const b = browser({ demoMode: true, buzzer: async () => ({ success: true, mode: 'simulation' }) });
        vm.runInContext(dispatch, b.context);
        await b.context[name]();
        assert.match(b.notices.at(-1).message, /โหมดสาธิต/);
        assert.notEqual(b.notices.at(-1).type, 'success');
    }
});

test('โหมดยังไม่ได้ตั้ง: SOS ยังส่ง LINE จริง ออดไม่ถูกสั่ง และ toast รายงานสองช่องทางแยกกัน', async () => {
    // ความไม่สมมาตรนี้ตั้งใจ: เกต fail-closed ครอบ "การสั่งฮาร์ดแวร์" (มอเตอร์/ออด)
    // ไม่ได้ครอบ "การขอความช่วยเหลือจากคน" ตู้ที่ยังไม่ถูกตั้งค่าต้องยังเรียกครูได้
    const urls = [];
    const b = browser({ demoMode: null, buzzer: null,
        fetch: async url => { urls.push(url); return reply({ success: true }); } });
    assert.equal(b.storage.getOperatingMode(), 'unset', 'fixture พัง — โปรไฟล์นี้ต้องยังไม่ถูกตั้งโหมด');

    const { line, buzzer } = await b.service.sendSos('ช่วยด้วย ขอครูพยาบาลด่วน');

    // 1. LINE ถูกยิงจริง และยิงครั้งเดียว — ไม่มี request ของออดปนมา
    assert.deepEqual(urls, ['/api/notify']);
    assert.equal(line.success, true);
    assert.equal(b.mocks.length, 0, 'ยังไม่ตั้งโหมด ไม่ใช่โหมดสาธิต ห้ามเปิดหน้าต่างจำลอง');

    // 2. ออดคือฮาร์ดแวร์ ต้องถูกกั้นตั้งแต่ก่อนแตะเครือข่าย และบอกว่ายังไม่ได้ส่ง
    assert.equal(buzzer.mode, 'unprovisioned');
    assert.equal(buzzer.success, false);
    assert.equal(buzzer.retrySafe, true);
    assert.notEqual(buzzer.mode, 'simulation');

    // 3. toast ใบเดียว ที่พูดถึงสองช่องทางแยกกัน และไม่อ้างว่าสำเร็จทั้งหมด
    assert.equal(b.notices.length, 1);
    const toast = b.notices.at(-1);
    assert.equal(toast.type, 'warning');
    assert.match(toast.message, /ผ่าน LINE แล้ว/);
    // ข้อความฝั่งออดต้องบอกว่า "ยังไม่ได้ตั้งโหมด" ไม่ใช่ "ยังยืนยันไม่ได้" แบบรวมๆ
    // สองอย่างนี้ครูทำต่างกันคนละเรื่อง: อย่างหนึ่งกดตั้งค่า อีกอย่างไปไล่สายไฟ
    assert.match(toast.message, /ยังไม่ได้ตั้งโหมด/);
    assert.doesNotMatch(toast.message, /ยังยืนยันเสียงที่ตู้ไม่ได้/);
    assert.match(toast.message, /เรียกครู/);
    assert.doesNotMatch(toast.message, /โหมดสาธิต/);
});

test('โปรไฟล์เก่าที่ demoMode:true แต่ไม่มีตราประทับ ถือว่ายังไม่ตั้งโหมด ไม่ใช่โหมดสาธิต', async () => {
    // ค่าเริ่มต้นเดิมคือ demoMode:true ทุกเครื่องจึงมีค่านี้ติดมาโดยไม่มีใครเลือก
    // แยกไม่ออกจากการตั้งใจเลือก ⇒ ต้องถือว่ายังไม่ตั้ง ไม่ใช่เดาให้เป็นโหมดสาธิต
    let requests = 0;
    const b = browser({ demoMode: null, fetch: async () => { requests++; return reply({ success: true }); } });
    b.localStorage.setItem('smart_first_aid_settings', JSON.stringify({ demoMode: true }));
    assert.equal(b.storage.getSettings().demoMode, true);
    assert.equal(b.storage.getOperatingMode(), 'unset');

    const result = await b.service.sendLineNotification('ทดสอบ');
    assert.notEqual(result.mode, 'simulation');
    assert.equal(b.mocks.length, 0);
    assert.equal(requests, 1, 'โปรไฟล์เก่าต้องส่งของจริง ไม่ใช่จำลองแล้วบอกว่าสำเร็จ');

    // ครูเลือกโหมดสาธิตเองหนึ่งครั้ง ค่าเดิมค่าเดียวกันนี้จึงกลายเป็นโหมดสาธิตจริง
    b.storage.saveSettings({ demoMode: true });
    assert.equal(b.storage.getOperatingMode(), 'demo');
    assert.equal((await b.service.sendLineNotification('ทดสอบ')).mode, 'simulation');
    assert.equal(requests, 1);
    assert.equal(b.mocks.length, 1);
});

test('one rejected SOS channel preserves the other channel result', async () => {
    const b = browser({ fetch: async () => reply({ success: true }), buzzer: async () => { throw new Error('offline'); } });
    await b.service.sendSos('synthetic');
    assert.equal(b.notices.at(-1).type, 'warning');
    assert.match(b.notices.at(-1).message, /ผ่าน LINE แล้ว/);
});

test('dashboard stop waits for off completion, prevents double click, and exposes uncertainty', async () => {
    const html = await readFile(new URL('../dashboard/index.html', import.meta.url), 'utf8');
    const start = html.indexOf('        async function stopSosBuzzer()');
    assert.notEqual(start, -1, 'teacher must have an actual stop control');
    const dispatch = html.slice(start, html.indexOf('        let currentPinInput', start));
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
