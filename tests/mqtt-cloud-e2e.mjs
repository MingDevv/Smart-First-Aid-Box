import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CloudBridge } from '../edge/mqtt-cloud.mjs';

// End to end over a real broker: the UNCHANGED Vercel handler (api/command.js) on one side,
// the Pi bridge on the other, a stub controller standing in for the micro:bit. Proves the
// two speak the same protocol-2 dialect the ESP32 used. Needs a loopback broker, like
// tests/mqtt-e2e.mjs:  mosquitto -p 18884   (never point this at the cabinet's real topic).
const brokerUrl = process.env.SFAB_TEST_MQTT_URL || 'mqtt://127.0.0.1:18884';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function fakeResponse() {
    const out = { status: null, body: null, headers: {} };
    const res = {
        setHeader(k, v) { out.headers[k] = v; },
        status(code) { out.status = code; return res; },
        json(body) { out.body = body; return res; },
        end() { return res; }
    };
    return { res, out };
}

async function fixture(t, { deviceMode = 'real', outcome } = {}) {
    const runId = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const base = `crms6/firstaidbox/integration/${runId}`;
    process.env.MQTT_URL = brokerUrl;
    process.env.MQTT_BASE_TOPIC = base;
    delete process.env.MQTT_USERNAME;
    delete process.env.MQTT_PASSWORD;
    const api = await import(`../api/command.js?e2e=${runId}`);
    const calls = [];
    const controller = {
        async status() {
            return { connected: true, ready: true, ackTimeoutMs: 30000, commandTimeoutMs: 33000,
                reason: '', deviceMode, unresolved: null, mode: 'pi-local', configured: true };
        },
        async command(command) {
            calls.push(command);
            if (outcome) return outcome(command);
            return { status: 200, body: { success: true, mode: 'pi-local', commandId: command.id,
                ack: { protocol: 2, event: command.action === 'open' ? 'drawer_opened' : 'buzzer_set', id: command.id } } };
        }
    };
    const bridge = new CloudBridge({ controller, url: brokerUrl, baseTopic: base, statusIntervalMs: 250,
        log: { log() {}, error: (...a) => console.error(...a) } }).start();
    t.after(async () => {
        await api.closeMqttClientForTests();
        await bridge.close();
    });
    // Let the bridge connect and publish its first retained status before the cloud asks.
    for (let i = 0; i < 40 && !bridge.client.connected; i++) await delay(50);
    await delay(300);
    const call = async (method, body) => {
        const { res, out } = fakeResponse();
        await api.default({ method, headers: {}, socket: { remoteAddress: '127.0.0.1' }, body }, res);
        return out;
    };
    return { call, calls };
}

test('Vercel sees the Pi as a connected, ready protocol-2 cabinet from the retained status', async t => {
    const { call } = await fixture(t);
    const out = await call('GET');
    assert.equal(out.status, 200);
    assert.equal(out.body.mqttConnected, true);
    assert.equal(out.body.connected, true, JSON.stringify(out.body));
    assert.equal(out.body.ready, true);
    assert.equal(out.body.ackTimeoutMs, 30000);
    assert.equal(out.body.commandTimeoutMs, 40000);
});

test('an open published by the unchanged Vercel handler is executed by the Pi and acknowledged', async t => {
    const { call, calls } = await fixture(t);
    const out = await call('POST', { action: 'open', drawer: 1, id: 'c-e2e-open-00001' });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(out.body.success, true);
    assert.equal(out.body.mode, 'mqtt');
    assert.deepEqual(out.body.ack, { protocol: 2, event: 'drawer_opened', id: 'c-e2e-open-00001', drawer: 1 });
    assert.deepEqual(calls, [{ action: 'open', drawer: 1, id: 'c-e2e-open-00001' }]);
});

test('a buzzer command round-trips with its state', async t => {
    const { call } = await fixture(t);
    const out = await call('POST', { action: 'buzzer', state: 'on', id: 'c-e2e-buzz-00001' });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.deepEqual(out.body.ack, { protocol: 2, event: 'buzzer_set', id: 'c-e2e-buzz-00001', state: 'on' });
});

test('a cabinet in Demo mode is reported not ready, so Vercel refuses before publishing', async t => {
    const { call, calls } = await fixture(t, { deviceMode: 'demo' });
    const status = await call('GET');
    assert.equal(status.body.connected, true);
    assert.equal(status.body.ready, false);
    const out = await call('POST', { action: 'open', drawer: 1, id: 'c-e2e-demo-00001' });
    assert.equal(out.status, 503);
    assert.equal(out.body.retrySafe, true);
    assert.deepEqual(calls, [], 'nothing reached the controller');
});

test('a controller refusal becomes cmd_rejected and Vercel answers 409', async t => {
    const { call } = await fixture(t, { outcome: () => ({ status: 409, body: { success: false } }) });
    const out = await call('POST', { action: 'open', drawer: 2, id: 'c-e2e-rej-000001' });
    assert.equal(out.status, 409, JSON.stringify(out.body));
    assert.equal(out.body.success, false);
});
