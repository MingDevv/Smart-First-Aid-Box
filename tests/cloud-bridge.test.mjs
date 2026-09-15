import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../js/api-bridge.js', import.meta.url), 'utf8');
const storageSource = await readFile(new URL('../js/storage.js', import.meta.url), 'utf8');
const ready = { mqttConfigured: true, protocol: 2, connected: true, ready: true,
    ackTimeoutMs: 30000, commandTimeoutMs: 40000 };
const reply = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data });
const ack = body => ({ protocol: 2, id: body.id, ...(body.action === 'open'
    ? { event: 'drawer_opened', drawer: body.drawer } : { event: 'buzzer_set', state: body.state }) });

// โหมดการทำงานมีสามค่า 'demo' | 'real' | 'unset' และ 'unset' แปลว่าห้ามสั่งฮาร์ดแวร์
// modeProvisionedAt คือหลักฐานว่าคนเลือกโหมดนี้ ไม่ใช่ค่าเริ่มต้นเก่าที่ติดมากับโปรไฟล์
const PROVISIONED_AT = '2026-09-11T10:00:00.000Z';
const realMode = (extra = {}) => ({ demoMode: false, modeProvisionedAt: PROVISIONED_AT, ...extra });
const demoMode = (extra = {}) => ({ demoMode: true, modeProvisionedAt: PROVISIONED_AT, ...extra });

function storageStub(seed = {}) {
    const store = new Map(Object.entries(seed).map(([key, value]) => [key, JSON.stringify(value)]));
    return {
        getItem: key => (store.has(key) ? store.get(key) : null),
        setItem(key, value) { store.set(key, String(value)); },
        removeItem(key) { store.delete(key); },
        clear() { store.clear(); }
    };
}

// js/storage.js ตัวจริงถูกโหลดเข้า context เดียวกับ js/api-bridge.js เหมือนสองแท็ก <script>
// บนหน้าเว็บจริง แทนการปลอม window.StorageService — ของปลอมคือสิ่งที่ปิดตาเราไม่ให้เห็น
// ว่าไฟล์จริงไม่เคยแขวนตัวเองไว้บน window มาตลอด
function browser(fetch, settings = realMode(), protocol = 'https:', { staff = true, signedIn = true, runtime } = {}) {
    const deadlines = [];
    const window = { location: { protocol }, SFAB_RUNTIME: runtime,
        // `isStaff` ของจริงต้องผ่าน status==='ready' ก่อนเสมอ ⇒ สถานะ "เป็นครูแต่ยังไม่ล็อกอิน"
        // ไม่มีอยู่จริง · ผูกไว้ที่นี่ด้วย เพื่อไม่ให้เทสสร้างโลกที่โค้ดจริงสร้างไม่ได้
        AuthService: { isStaff: () => staff && signedIn, isSignedIn: () => signedIn, authorizedFetch: fetch },
        crypto: { randomUUID: () => '12345678-1234-1234-1234-123456789abc' } };
    const context = vm.createContext({ window, fetch, AbortController, console, clearTimeout,
        localStorage: storageStub({ smart_first_aid_settings: settings }), sessionStorage: storageStub(),
        setTimeout(fn, ms) { deadlines.push(ms); return setTimeout(fn, ms); } });
    vm.runInContext(storageSource, context, { filename: 'js/storage.js' });
    vm.runInContext(source, context, { filename: 'js/api-bridge.js' });
    return { api: window.ApiBridge, deadlines, storage: window.StorageService };
}

test('fresh Vercel browser uses server readiness and hardware budget without listener credentials', async () => {
    const requests = [];
    const { api, deadlines } = browser(async (url, options) => {
        requests.push({ url, options });
        if (!options.body) return reply(ready);
        const body = JSON.parse(options.body);
        assert.equal(body.ackTimeoutMs, 30000);
        return reply({ success: true, ack: ack(body) });
    });
    assert.equal((await api.openCompartment('cut')).success, true);
    assert.deepEqual(requests.map(r => r.url), ['/api/command', '/api/command']);
    assert.deepEqual(deadlines, [8000, 45000]);
    assert.notEqual(requests[0].options.signal, requests[1].options.signal);
    assert.equal((await api.getHardwareStatus()).connected, true);
});

test('offline, busy, old protocol, invalid budget and failed preflight do not publish', async () => {
    for (const change of [{ connected: false }, { ready: false }, { protocol: 1 },
        { ackTimeoutMs: 200000 }, { commandTimeoutMs: 9500 }]) {
        let posts = 0;
        const { api } = browser(async (_url, options) => {
            if (options.body) posts++;
            return reply({ ...ready, ...change });
        }, realMode({ esp32Url: 'http://cabinet' }));
        const result = await api.openCompartment('cut');
        assert.equal(result.success, false);
        assert.equal(result.retrySafe, true);
        assert.equal(posts, 0);
    }
});

test('PUBACK, old protocol, wrong ID/drawer/state cannot become UI success', async () => {
    for (const action of ['open', 'buzzer']) {
        for (const wrong of [{}, { protocol: 1 }, { id: 'c-other-command' },
            action === 'open' ? { drawer: 2 } : { state: 'off' }]) {
            const calls = [];
            const { api } = browser(async (url, options) => {
                calls.push(url);
                if (!options.body) return reply(ready);
                const body = JSON.parse(options.body);
                return reply({ success: true, ack: Object.keys(wrong).length ? { ...ack(body), ...wrong } : undefined });
            }, realMode({ esp32Url: 'http://cabinet' }));
            const result = await (action === 'open' ? api.openCompartment('cut') : api.triggerBuzzer('on'));
            assert.equal(result.success, false);
            assert.deepEqual(calls, ['/api/command', '/api/command']);
        }
    }
});

test('busy motor does not block acknowledged SOS, and both buzzer states need exact ACK', async () => {
    for (const state of ['on', 'off']) {
        const { api } = browser(async (_url, options) => !options.body ? reply({ ...ready, ready: false })
            : reply({ success: true, ack: ack(JSON.parse(options.body)) }));
        assert.equal((await api.triggerBuzzer(state)).success, true);
    }
});

test('lost response or explicit refusal never falls back to another actuator transport', async () => {
    for (const fail of [() => { throw new Error('lost response'); }, () => reply({ success: false }, 409)]) {
        const calls = [];
        const { api } = browser(async (url, options) => {
            calls.push(url);
            return options.body ? fail() : reply(ready);
        }, realMode({ esp32Url: 'http://cabinet' }));
        assert.equal((await api.openCompartment('cut')).success, false);
        assert.deepEqual(calls, ['/api/command', '/api/command']);
    }
});

test('missing MQTT or an authorization refusal never falls back to browser-configured LAN', async () => {
    for (const protocol of ['http:', 'https:']) {
        for (const response of [reply({ mqttConfigured: false }), reply({}, 401), reply({}, 403)]) {
            const calls = [];
            const { api } = browser(async url => { calls.push(url); return response; }, realMode({ esp32Url: 'http://cabinet' }), protocol);
            assert.equal((await api.openCompartment('cut')).success, false);
            assert.deepEqual(calls, ['/api/command']);
        }
    }
});

test('status body remains subject to deadline and cannot dispatch after expiration', async () => {
    let posts = 0;
    const { api } = browser(async (_url, options) => {
        if (options.body) posts++;
        return { ok: true, async json() {
            await new Promise(resolve => setTimeout(resolve, 35));
            return ready;
        } };
    });
    api.MQTT_STATUS_TIMEOUT_MS = 10;
    assert.equal((await api.openCompartment('cut')).retrySafe, true);
    assert.equal(posts, 0);
});

test('local Demo simulates dispensing; unsupported cloud wounds never become drawer 1', async () => {
    let calls = 0;
    const fetch = async () => { calls++; throw new Error('should not fetch'); };
    const demo = browser(fetch, {}, 'http:', { runtime: {transport:'pi-local', mode:'demo'} }).api;
    assert.equal((await demo.openCompartment('cut')).mode, 'simulation');
    assert.equal((await browser(fetch).api.openCompartment('unsupported')).success, false);
    assert.equal(calls, 0);
});

// ตู้ปฏิเสธชัดๆ (401 = ยังไม่ได้ส่งคำสั่งออกไปเลย) ต้องไปถึงคีออสก์ว่า "ชัดเจน" ไม่ใช่ "ไม่แน่ใจ"
//
// `settleDispatch()` ใน js/kiosk-session.js แปล "ไม่มี retrySafe" เป็น uncertain ซึ่งบนจอแปลว่า
// "ไม่แน่ใจว่าตู้จ่ายของออกมาหรือยัง" + ซ่อนปุ่มลองใหม่ + ค้างจอไว้ให้คนมาดู
// ⇒ การทำ field นี้หายระหว่างทางคือการบอกครูว่าลิ้นชักอาจเปิดไปแล้ว ทั้งที่ไม่มีอะไรถูกส่ง
test('a definite refusal from the Pi stays definite — retrySafe survives the bridge', async () => {
    const { api } = browser(async (url) => {
        if (url === '/api/local/status') return reply({ connected: true, ready: true, commandTimeoutMs: 33000 });
        return reply({ success: false, retrySafe: true, error: 'รอบนี้หมดอายุแล้ว กรุณาถ่ายรูปใบหน้าอีกครั้ง' }, 401);
    }, realMode(), 'http:', { runtime: { transport: 'pi-local', mode: 'real' } });

    const result = await api.openCompartment('cut');
    assert.equal(result.success, false);
    assert.equal(result.retrySafe, true, 'ทิ้ง retrySafe = คำปฏิเสธที่ชัดเจนกลายเป็น uncertain บนจอตู้');
    assert.match(result.error, /ถ่ายรูปใบหน้า/, 'ต้องส่งข้อความของตู้ต่อ ไม่ใช่กลบด้วยข้อความกลางๆ');
});

// เน็ตขาดกลางคันคือกรณีที่ "ไม่รู้จริงๆ" — ตรงนี้ต้องไม่ถูกอัปเป็น retrySafe เพื่อความสะดวก
test('a broken connection stays uncertain, because nobody knows if the command landed', async () => {
    const { api } = browser(async (url) => {
        if (url === '/api/local/status') return reply({ connected: true, ready: true, commandTimeoutMs: 33000 });
        throw new Error('socket hang up');
    }, realMode(), 'http:', { runtime: { transport: 'pi-local', mode: 'real' } });

    const result = await api.openCompartment('cut');
    assert.equal(result.success, false);
    assert.notEqual(result.retrySafe, true);
});

test('anonymous browser cannot actuate even with forged old settings', async () => {
    for (const settings of [realMode(), demoMode(), {dashboardPin:'1234', dashboard_auth:true}]) {
        let calls = 0;
        const { api, storage } = browser(async () => { calls++; }, settings, 'https:', {staff:false, signedIn:false});
        assert.equal(storage.getOperatingMode(), 'unset');
        assert.equal(api.operatingMode(), 'unset');
        for (const result of [await api.openCompartment('cut'), await api.triggerBuzzer('on')]) {
            assert.equal(result.success, false);
            assert.equal(result.mode, 'unauthorized');
            assert.equal(result.retrySafe, true);
        }
        assert.equal(calls, 0);
    }
});

// Bank เคาะ 2026-09-15: คนที่เจ็บคือคนที่ต้องกดเปิดช่องยา ⇒ เกตของ open คือ "ล็อกอินหรือยัง"
// ไม่ใช่บทบาท · ออดยังเป็นของครู เพราะมันเรียกคนทั้งห้องพยาบาล
// เคสนี้คือเคสที่หน้าเว็บพังจริงเมื่อ 2026-09-15 (นักเรียนล็อกอินแล้วแต่ไม่มีปุ่มให้กด)
test('signed-in student opens a drawer but still cannot ring the buzzer', async () => {
    const requests = [];
    const { api } = browser(async (url, options) => {
        requests.push({ url, options });
        if (!options.body) return reply(ready);
        return reply({ success: true, ack: ack(JSON.parse(options.body)) });
    }, realMode(), 'https:', { staff: false, signedIn: true });

    assert.equal((await api.openCompartment('cut')).success, true);
    assert.equal((await api.getHardwareStatus()).connected, true);

    const buzzer = await api.triggerBuzzer('on');
    assert.equal(buzzer.success, false);
    assert.equal(buzzer.mode, 'unauthorized');
    // ปุ่มที่กดไม่ได้ต้องไม่แตะเครือข่ายเลย ไม่ใช่ยิงไปให้เซิร์ฟเวอร์ปฏิเสธแล้วค่อยบอกทีหลัง
    assert.equal(requests.filter(r => r.options.body && JSON.parse(r.options.body).action === 'buzzer').length, 0);
});

const listenerSource = await readFile(new URL('../js/mqtt-bridge.js', import.meta.url), 'utf8');
test('browser status rejects stale/legacy metadata, shows busy separately, and expires without a new heartbeat', () => {
    const window = {};
    let expiration;
    vm.runInNewContext(listenerSource, { window, console, Date,
        setTimeout(fn) { expiration = fn; return 1; }, clearTimeout() {} });
    const bridge = window.MqttBridge;
    bridge.client = { connected: true, end() {} };
    const hardware = { online: true, protocol: 2, microbit: 'connected', ready: true, ackTimeoutMs: 30000, ts: Date.now() };
    for (const change of [{ protocol: 1 }, { ts: Date.now() - 6000 }, { microbit: 'unknown' }]) {
        bridge.updateStatus({ ...hardware, ...change });
        assert.equal(bridge.isOnline(), false);
    }
    bridge.updateStatus({ ...hardware, ready: false });
    assert.equal(bridge.isOnline(), true);
    assert.equal(bridge.lastStatus.ready, false);
    expiration();
    assert.equal(bridge.isOnline(), false);
    bridge.disconnect();
});
