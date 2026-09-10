import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../js/api-bridge.js', import.meta.url), 'utf8');
const ready = { mqttConfigured: true, protocol: 2, connected: true, ready: true,
    ackTimeoutMs: 30000, commandTimeoutMs: 40000 };
const reply = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data });
const ack = body => ({ protocol: 2, id: body.id, ...(body.action === 'open'
    ? { event: 'drawer_opened', drawer: body.drawer } : { event: 'buzzer_set', state: body.state }) });
function browser(fetch, settings = {}, protocol = 'https:') {
    const deadlines = [];
    const window = { location: { protocol }, StorageService: { getSettings: () => settings },
        crypto: { randomUUID: () => '12345678-1234-1234-1234-123456789abc' } };
    vm.runInNewContext(source, { window, fetch, AbortController, console, clearTimeout,
        setTimeout(fn, ms) { deadlines.push(ms); return setTimeout(fn, ms); } });
    return { api: window.ApiBridge, deadlines };
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
        }, { esp32Url: 'http://cabinet' });
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
            }, { esp32Url: 'http://cabinet' });
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
        }, { esp32Url: 'http://cabinet' });
        assert.equal((await api.openCompartment('cut')).success, false);
        assert.deepEqual(calls, ['/api/command', '/api/command']);
    }
});

test('HTTPS with no MQTT never attempts mixed-content LAN; HTTP LAN waits for protocol-2 completion', async () => {
    const cloud = browser(async () => reply({ mqttConfigured: false }), { esp32Url: 'http://cabinet' });
    const blocked = await cloud.api.openCompartment('cut');
    assert.equal(blocked.success, false);
    assert.match(blocked.error, /HTTPS/);
    for (const action of ['open', 'buzzer']) {
        let sentId, actuations = 0;
        const { api } = browser(async (url) => {
            if (url === '/api/command') return reply({ mqttConfigured: false });
            const parsed = new URL(url);
            if (parsed.pathname === '/status') return reply({ ...ready, microbit: 'connected' });
            if (parsed.pathname === '/open' || parsed.pathname === '/buzzer') {
                actuations++;
                sentId = parsed.searchParams.get('id');
                return reply({ accepted: true }, 202);
            }
            return reply({ success: true, ...ack({ id: sentId, action, drawer: 1, state: 'on' }) });
        }, { esp32Url: 'http://cabinet' }, 'http:');
        assert.equal((await (action === 'open' ? api.openCompartment('cut') : api.triggerBuzzer('on'))).success, true);
        assert.equal(actuations, 1);
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

test('Demo makes no hardware calls and unsupported real wound never becomes drawer 1', async () => {
    let calls = 0;
    const fetch = async () => { calls++; throw new Error('should not fetch'); };
    const demo = browser(fetch, { demoMode: true }).api;
    assert.equal((await demo.openCompartment('cut')).mode, 'simulation');
    assert.equal((await demo.triggerBuzzer('on')).mode, 'simulation');
    assert.equal((await browser(fetch).api.openCompartment('unsupported')).success, false);
    assert.equal(calls, 0);
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
