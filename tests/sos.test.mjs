import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import notify from '../api/notify.js';

const source = await readFile(new URL('../js/notification.js', import.meta.url), 'utf8');
const reply = (data, status = 200) => ({ ok: status < 300, status, json: async () => data });
function browser({ demoMode = false, fetch = async () => reply({ success: false }, 503),
    buzzer = async () => ({ success: false }), timeoutMs } = {}) {
    const notices = [], mocks = [], elements = new Map();
    const storage = { getSettings: () => ({ demoMode }), getCurrentStudent: () => null, addHistoryEntry() {} };
    const window = { StorageService: storage, ApiBridge: { triggerBuzzer: buzzer } };
    const context = vm.createContext({ window, fetch, AbortController, clearTimeout,
        setTimeout: (fn, ms) => setTimeout(fn, timeoutMs ?? ms), console: { log() {}, warn() {}, error() {} },
        StorageService: storage, ApiBridge: window.ApiBridge, confirm: () => true,
        document: { getElementById(id) {
            if (!elements.has(id)) elements.set(id, { disabled: false, textContent: '',
                setAttribute() {}, removeAttribute() {}, querySelector() { return this; } });
            return elements.get(id);
        } } });
    vm.runInContext(source, context);
    const service = window.NotificationService;
    service.showToast = (message, type) => notices.push({ message, type });
    service.showLineMockModal = data => mocks.push(data);
    return { service, context, notices, mocks, elements };
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
