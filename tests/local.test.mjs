import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
const apiBridgeSource = await readFile(new URL('js/api-bridge.js', root), 'utf8');
const storageSource = await readFile(new URL('js/storage.js', root), 'utf8');
const mqttBridgeSource = await readFile(new URL('js/mqtt-bridge.js', root), 'utf8');
const firmwareSource = await readFile(new URL('firmware/esp32_smart_box/esp32_smart_box.ino', root), 'utf8');
const commandHistorySource = await readFile(new URL('firmware/esp32_smart_box/command_history.h', root), 'utf8');
const commandApiSource = await readFile(new URL('api/command.js', root), 'utf8');

function response(status, data) {
    return {
        status,
        ok: status >= 200 && status < 300,
        async json() { return data; }
    };
}

// โหมดการทำงานมีสามค่า: 'demo' | 'real' | 'unset' — และ 'unset' คือค่าที่ห้ามสั่งฮาร์ดแวร์
// ตราประทับ modeProvisionedAt คือหลักฐานว่า "คน" เลือกโหมดนี้ ไม่ใช่ค่าเริ่มต้นเก่าที่ติดมากับโปรไฟล์
const PROVISIONED_AT = '2026-09-11T10:00:00.000Z';
const realModeSettings = (extra = {}) => ({ demoMode: false, modeProvisionedAt: PROVISIONED_AT, ...extra });
const demoModeSettings = (extra = {}) => ({ demoMode: true, modeProvisionedAt: PROVISIONED_AT, ...extra });

function storageStub(seed = {}) {
    const store = new Map(Object.entries(seed).map(([key, value]) => [key, JSON.stringify(value)]));
    return {
        getItem: key => (store.has(key) ? store.get(key) : null),
        setItem(key, value) { store.set(key, String(value)); },
        removeItem(key) { store.delete(key); },
        clear() { store.clear(); }
    };
}

const READY_STATUS = { mqttConfigured: true, protocol: 2, connected: true, ready: true,
    ackTimeoutMs: 30000, commandTimeoutMs: 40000 };

// โหลด js/storage.js ตัวจริงเข้า context เดียวกับ js/api-bridge.js เหมือนหน้าเว็บที่มีแท็ก <script>
// สองตัวใช้ global ร่วมกัน แทนที่จะปลอม window.StorageService ขึ้นมาเอง — เพราะบั๊กตัวจริงที่เพิ่งแก้
// คือ "ไฟล์จริงไม่เคยแขวนตัวเองไว้บน window" ซึ่งเป็นสิ่งเดียวที่ของปลอมมองไม่เห็นตลอดมา
// (localStorage สตับพอแล้ว: storage.js แตะแค่ storage ตอนโหลด ไม่ได้ยิงเน็ตเอง)
function loadBridge({ settings = {}, fetchImpl = null, mqttBridge = null, attachStorage = true } = {}) {
    const fetchCalls = [];
    const localStorage = storageStub({ smart_first_aid_settings: settings });
    const window = {
        MqttBridge: mqttBridge,
        crypto: { randomUUID: () => '12345678-1234-1234-1234-123456789abc' }
    };
    const context = vm.createContext({
        window,
        localStorage,
        sessionStorage: storageStub(),
        fetch: (url, options = {}) => {
            fetchCalls.push({ url, method: options.method || 'GET' });
            if (url === '/api/command' && options.method !== 'POST') {
                return Promise.resolve(response(200, { ...READY_STATUS }));
            }
            if (!fetchImpl) return Promise.reject(new Error(`unexpected fetch: ${url}`));
            return fetchImpl(url, options);
        },
        AbortController,
        setTimeout,
        clearTimeout,
        console,
        Date,
        Math,
        encodeURIComponent
    });
    vm.runInContext(storageSource, context, { filename: 'js/storage.js' });
    const storage = window.StorageService;
    // เส้นทางสำรองของ ApiBridge.operatingMode() ต้องถูกทดสอบด้วย ไม่ใช่เฉพาะตอนมี StorageService
    if (!attachStorage) delete window.StorageService;
    vm.runInContext(apiBridgeSource, context, { filename: 'js/api-bridge.js' });
    return { api: window.ApiBridge, storage, fetchCalls, localStorage, window };
}

function loadApiBridge(settings, fetchImpl, mqttBridge = null) {
    return loadBridge({ settings, fetchImpl, mqttBridge }).api;
}

// Fresh browser: local MQTT listener is unconfigured, but downlink still asks the server.
{
    let calls = 0;
    const api = loadApiBridge(
        realModeSettings({ esp32Url: '', mqttWsUrl: '' }),
        async (url, options) => {
            calls++;
            assert.equal(url, '/api/command');
            const command = JSON.parse(options.body);
            return response(200, {
                success: true,
                mqttConfigured: true,
                compartment: command.drawer,
                commandId: command.id,
                ack: { protocol: 2, event: 'drawer_opened', id: command.id, drawer: command.drawer }
            });
        }
    );


    const result = await api.openCompartment('cut');
    assert.deepEqual(
        { success: result.success, mode: result.mode, compartment: result.compartment },
        { success: true, mode: 'mqtt', compartment: 1 }
    );
    assert.equal(calls, 1);
}

// A PUBACK-shaped success response without drawer_opened must not become UI success.
{
    const api = loadApiBridge(
        realModeSettings({ esp32Url: '', mqttWsUrl: '' }),
        async (_url, options) => {
            const command = JSON.parse(options.body);
            return response(200, {
                success: true,
                mqttConfigured: true,
                commandId: command.id
            });
        }
    );

    const result = await api.openCompartment('insect');
    assert.equal(result.success, false);
    assert.notEqual(result.mode, 'simulation');
}

// MQTT timeout never causes a second actuator dispatch through LAN.
{
    const calls = [];
    const api = loadApiBridge(realModeSettings({ esp32Url: 'http://smart-box' }), async (url) => {
        calls.push(url);
        return response(504, { success: false, mqttConfigured: true, error: 'ACK timeout' });
    });
    const result = await api.openCompartment('abrasion');
    assert.equal(result.success, false);
    assert.equal(result.retrySafe, false);
    assert.deepEqual(calls, ['/api/command']);
}

// Direct browser MQTT listener resolves only an exact id + drawer event.
{
    const window = {};
    const context = vm.createContext({
        window, console, setTimeout, clearTimeout, Map, Set,
        localStorage: storageStub({
            smart_first_aid_settings: { mqttWsUrl: 'wss://example.invalid/mqtt', mqttBaseTopic: 'test/box' }
        }),
        sessionStorage: storageStub()
    });
    vm.runInContext(storageSource, context, { filename: 'js/storage.js' });
    vm.runInContext(mqttBridgeSource, context, { filename: 'js/mqtt-bridge.js' });
    assert.equal(window.StorageService.getSettings().mqttBaseTopic, 'test/box');
    const bridge = window.MqttBridge;
    bridge.connect = () => ({ connected: true });

    let resolved = false;
    const waiter = bridge.waitForDrawerOpened('c-command-123', 2, 1000).then((value) => {
        resolved = true;
        return value;
    });
    bridge.settleDrawerOpened({ protocol: 2, event: 'drawer_opened', id: 'c-command-123', drawer: 1 });
    await Promise.resolve();
    assert.equal(resolved, false);
    bridge.settleDrawerOpened({ protocol: 2, event: 'drawer_opened', id: 'c-command-123', drawer: 2 });
    assert.equal((await waiter).drawer, 2);
}

// js/storage.js ต้องแขวนตัวเองไว้บน window จริงๆ ไม่งั้น ApiBridge อ่านค่าที่ครูตั้งไว้ไม่เห็นเลย
// (บั๊กเดิม: const ระดับบนสุดของสคริปต์ธรรมดาไม่ใช่ property ของ window — วัดด้วย Chromium จริง 2026-09-11)
{
    const { window, api, fetchCalls } = loadBridge({ settings: demoModeSettings() });
    assert.equal(typeof window.StorageService?.getSettings, 'function');
    assert.equal(typeof window.StorageService?.getOperatingMode, 'function');
    assert.equal(api.getSettings().demoMode, true);
    assert.equal(api.isDemoMode(), true);
    assert.equal((await api.openCompartment('cut')).mode, 'simulation');
    assert.deepEqual(fetchCalls, []);
}

// ยังไม่มีใครเลือกโหมด: เปิดลิ้นชักต้องหยุดก่อนแตะเครือข่าย ไม่ใช่หยุดหลังยิงไปแล้ว
{
    const { api, fetchCalls } = loadBridge({
        settings: { esp32Url: 'http://smart-box' },
        fetchImpl: async () => { throw new Error('unprovisioned cabinet must not reach the network'); }
    });
    const result = await api.openCompartment('cut');
    assert.equal(result.success, false);
    assert.equal(result.mode, 'unprovisioned');
    assert.equal(result.retrySafe, true);
    assert.ok(result.commandId, 'ต้องมีเลขคำสั่งไว้อ้างอิงแม้ไม่ได้ส่งอะไรออกไป');
    assert.deepEqual(fetchCalls, [], 'โหมดที่ยังไม่ตั้งต้องไม่มี request สักใบ');
}

// ออดก็เป็นฮาร์ดแวร์เหมือนกัน กฎ fail-closed จึงครอบ triggerBuzzer ด้วย
{
    const { api, fetchCalls } = loadBridge({
        settings: { esp32Url: 'http://smart-box' },
        fetchImpl: async () => { throw new Error('unprovisioned cabinet must not reach the network'); }
    });
    const result = await api.triggerBuzzer('on');
    assert.equal(result.success, false);
    assert.equal(result.mode, 'unprovisioned');
    assert.equal(result.retrySafe, true);
    assert.deepEqual(fetchCalls, [], 'โหมดที่ยังไม่ตั้งต้องไม่มี request สักใบ');
}

// กฎการย้ายข้อมูล: demoMode: true ที่ไม่มีตราประทับ = ยังไม่ได้ตั้ง ไม่ใช่ demo
// โปรไฟล์เก่าทุกใบมีค่านี้ติดมาจากค่าเริ่มต้นเดิม ซึ่งแยกไม่ออกว่าใครเป็นคนเลือก
{
    const { api, storage, fetchCalls } = loadBridge({
        settings: { demoMode: true },
        fetchImpl: async () => { throw new Error('inherited demoMode must not actuate anything'); }
    });
    assert.equal(storage.getOperatingMode(), 'unset');
    assert.equal(storage.getSettings().demoMode, true);
    assert.equal(api.operatingMode(), 'unset');
    assert.equal(api.isDemoMode(), false);
    const opened = await api.openCompartment('cut');
    assert.equal(opened.mode, 'unprovisioned');
    assert.notEqual(opened.mode, 'simulation');
    assert.equal(opened.success, false);
    assert.deepEqual(fetchCalls, []);
}

// ครูเลือกโหมดเมื่อไร saveSettings ต้องประทับตราให้ทันทีในการเรียกครั้งเดียวกัน
{
    const { api, storage, localStorage } = loadBridge({ settings: { demoMode: true } });
    assert.equal(storage.getOperatingMode(), 'unset');

    storage.saveSettings({ demoMode: false });
    assert.equal(typeof storage.getSettings().modeProvisionedAt, 'string');
    assert.equal(storage.getOperatingMode(), 'real');
    assert.equal(api.operatingMode(), 'real');
    assert.equal(api.isDemoMode(), false);
    assert.ok(JSON.parse(localStorage.getItem('smart_first_aid_settings')).modeProvisionedAt,
        'ตราประทับต้องถูกเขียนลง storage จริง ไม่ใช่ค้างในหน่วยความจำ');

    storage.saveSettings({ demoMode: true });
    assert.equal(storage.getOperatingMode(), 'demo');
    assert.equal(api.operatingMode(), 'demo');
    assert.equal(api.isDemoMode(), true);
}

// บันทึกค่าอื่นต้องไม่ประทับตราโหมดให้โดยบังเอิญ ไม่งั้นกฎ fail-closed หลุดเงียบๆ
{
    const { storage } = loadBridge({ settings: { demoMode: true } });
    storage.saveSettings({ lineToken: 'x-token', esp32Url: 'http://smart-box' });
    assert.equal(storage.getSettings().lineToken, 'x-token');
    assert.equal(storage.getOperatingMode(), 'unset');
}

// ApiBridge กับ StorageService คือคนอ่านค่าเดียวกันสองคน ห้ามอ่านไม่ตรงกันแม้แต่อินพุตเดียว
// ทดสอบทั้งตอนมี StorageService (delegate) และตอนไม่มี (ApiBridge คำนวณเอง)
{
    const cases = [
        [{}, 'unset'],
        [{ demoMode: null, modeProvisionedAt: null }, 'unset'],
        [{ demoMode: true }, 'unset'],
        [{ demoMode: false }, 'unset'],
        [{ modeProvisionedAt: PROVISIONED_AT }, 'unset'],
        [{ demoMode: true, modeProvisionedAt: '' }, 'unset'],
        [{ demoMode: 'maybe', modeProvisionedAt: PROVISIONED_AT }, 'unset'],
        [{ demoMode: 1, modeProvisionedAt: PROVISIONED_AT }, 'unset'],
        [{ demoMode: true, modeProvisionedAt: PROVISIONED_AT }, 'demo'],
        [{ demoMode: 'true', modeProvisionedAt: PROVISIONED_AT }, 'demo'],
        [{ demoMode: false, modeProvisionedAt: PROVISIONED_AT }, 'real'],
        [{ demoMode: 'false', modeProvisionedAt: PROVISIONED_AT }, 'real']
    ];
    const delegating = loadBridge({ settings: {} });
    const standalone = loadBridge({ settings: {}, attachStorage: false });
    assert.equal(standalone.window.StorageService, undefined);
    for (const [settings, expected] of cases) {
        const label = JSON.stringify(settings);
        assert.equal(delegating.storage.getOperatingMode(settings), expected, `StorageService: ${label}`);
        assert.equal(delegating.api.operatingMode(settings), expected, `ApiBridge delegate: ${label}`);
        assert.equal(standalone.api.operatingMode(settings), expected, `ApiBridge fallback: ${label}`);
        assert.equal(delegating.api.isDemoMode(settings), expected === 'demo', `isDemoMode: ${label}`);
        assert.equal(standalone.api.isDemoMode(settings), expected === 'demo', `isDemoMode fallback: ${label}`);
    }
}

// These are static firmware invariants only; the Arduino sketch is not compiled by this test.
assert.match(commandHistorySource, /COMMAND_HISTORY_SIZE = 8/);
assert.match(commandHistorySource, /offset < COMMAND_HISTORY_SIZE/);
assert.match(commandHistorySource, /record->expired = true/);
assert.match(firmwareSource, /COMMAND_ACK_TIMEOUT_MS = SFAB_COMMAND_ACK_TIMEOUT_MS/);
assert.match(firmwareSource, /enqueueEvent\("ack_timeout"/);
assert.match(firmwareSource, /POST_SUBSCRIBE_GUARD_MS = 500/);
assert.match(firmwareSource, /if \(!doc\["ts"\]\.is<uint64_t>\(\)\)/);
assert.match(firmwareSource, /if \(cmdMs > nowMs\)/);
assert.match(firmwareSource, /if \(WiFi\.status\(\) != WL_CONNECTED\) return;/);
assert.match(firmwareSource, /mqtt\.setSocketTimeout\(2\)/);
assert.match(firmwareSource, /Serial2\.setTimeout\(100\)/);
assert.match(firmwareSource, /configTime\(7 \* 3600, 0, "pool\.ntp\.org", "time\.google\.com"\)/);

const callbackBody = firmwareSource.slice(
    firmwareSource.indexOf('void onMqttMessage'),
    firmwareSource.indexOf('// PubSubClient::connect')
);
assert.doesNotMatch(callbackBody, /publishEvent\s*\(/);
assert.match(callbackBody, /enqueueEvent\s*\(/);
assert.match(commandApiSource, /if \(activeClientState === state\) activeClientState = null/);
assert.match(commandApiSource, /reconnectPeriod: 0/);
assert.match(commandApiSource, /MQTT_CONNECT_TIMEOUT_MS = 4500/);

assert.match(commandApiSource, /'ack_timeout'/);

for (const page of ['student/first-aid-guide.html', 'student/index.html', 'student/kiosk.html']) {
    const html = await readFile(new URL(page, root), 'utf8');
    const mqttCdn = html.indexOf('mqtt@5.15.2/dist/mqtt.min.js');
    const bridge = html.indexOf('../js/mqtt-bridge.js');
    assert.ok(mqttCdn >= 0 && mqttCdn < bridge, `${page} must load mqtt.js before mqtt-bridge.js`);
}

// Server reports configuration itself even when the browser has no saved MQTT settings.
delete process.env.MQTT_URL;
const { default: commandHandler } = await import('../api/command.js');

function invokeApi(method, body = {}) {
    return new Promise((resolve, reject) => {
        const req = { method, body, headers: {}, socket: { remoteAddress: 'local-test' } };
        const res = {
            statusCode: 200,
            setHeader() {},
            status(code) {
                this.statusCode = code;
                return this;
            },
            json(payload) {
                resolve({ status: this.statusCode, body: payload });
                return this;
            },
            end() {
                resolve({ status: this.statusCode, body: null });
            }
        };
        Promise.resolve(commandHandler(req, res)).catch(reject);
    });
}

const availability = await invokeApi('GET');
assert.equal(availability.body.mqttConfigured, false);
const unconfigured = await invokeApi('POST', {
    action: 'open',
    drawer: 1,
    id: 'c-local-test-001'
});
assert.equal(unconfigured.status, 503);
assert.equal(unconfigured.body.mqttConfigured, false);

console.log('local tests passed');
