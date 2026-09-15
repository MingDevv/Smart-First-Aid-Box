import assert from 'node:assert/strict';
import { test } from 'node:test';
import mqtt from 'mqtt';

// Use an isolated loopback broker by default; never send test commands to the real cabinet topic.
const brokerUrl = process.env.SFAB_TEST_MQTT_URL || 'mqtt://127.0.0.1:18884';
const ack = c => ({ protocol: 2, id: c.id, ...(c.action === 'open'
    ? { event: 'drawer_opened', drawer: c.drawer } : { event: 'buzzer_set', state: c.state }) });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fixture(t, onCommand, status = {}) {
    const runId = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const base = `crms6/firstaidbox/integration/${runId}`;
    process.env.MQTT_URL = brokerUrl;
    process.env.MQTT_BASE_TOPIC = base;
    delete process.env.MQTT_USERNAME;
    delete process.env.MQTT_PASSWORD;
    const api = await import(`../api/command.js?test=${runId}`);
    const device = mqtt.connect(brokerUrl, { clientId: `test-device-${runId}`, clean: true,
        reconnectPeriod: 0, connectTimeout: 2000 });
    const timers = new Set();
    let heartbeat;
    const publishing = new Set();
    t.after(async () => {
        clearInterval(heartbeat);
        for (const timer of timers) clearTimeout(timer);
        await Promise.allSettled([...publishing]);
        await api.closeMqttClientForTests();
        await new Promise(resolve => device.end(true, {}, resolve));
    });
    await new Promise((resolve, reject) => {
        device.once('connect', resolve);
        device.once('error', reject);
    });
    const send = (topic, data, retain = false) => {
        const task = new Promise((resolve, reject) => device.publish(
            `${base}/${topic}`, JSON.stringify(data), { qos: 1, retain }, err => err ? reject(err) : resolve()));
        publishing.add(task);
        task.then(() => publishing.delete(task), () => publishing.delete(task));
        return task;
    };
    const event = data => send('evt', data);
    const later = (ms, data) => {
        const timer = setTimeout(() => { timers.delete(timer); void event(data); }, ms);
        timers.add(timer);
    };
    let hardware = { online: true, protocol: 2, microbit: 'connected', ready: true, ackTimeoutMs: 3000, ...status };
    const advertise = () => send('status', { ts: Date.now(), ...hardware }, true);
    const commands = [];
    device.on('message', (topic, bytes, packet) => {
        if (topic !== `${base}/cmd`) return;
        const command = JSON.parse(bytes.toString());
        assert.equal(packet.retain, false);
        assert.equal(command.protocol, 2);
        commands.push(command);
        onCommand?.(command, { event, later, advertise });
    });
    await new Promise((resolve, reject) => device.subscribe(`${base}/cmd`, { qos: 1 }, err => err ? reject(err) : resolve()));
    await advertise();
    heartbeat = setInterval(() => { void advertise(); }, 500);
    let requestNumber = 0;
    const invoke = (body) => new Promise((resolve, reject) => {
        const req = { method: body ? 'POST' : 'GET', body,
            headers: { 'x-forwarded-for': `test-${++requestNumber}` } };
        const res = { statusCode: 200, setHeader() {}, status(code) { this.statusCode = code; return this; },
            json(body) { resolve({ status: this.statusCode, body }); }, end() { resolve({ status: this.statusCode }); } };
        // uid ต่างกันทุกคำขอด้วยเหตุผลเดียวกับที่ x-forwarded-for ต่างกัน: ถังจำกัดอัตรานับต่อ uid
        // ด้วยแล้ว การใช้ uid เดียวทั้งไฟล์จะทำให้เคสกลางๆ ล้มด้วย 429 ที่ไม่เกี่ยวกับสิ่งที่ตรวจ
        Promise.resolve(api.createCommandHandler(async () => ({ role: 'teacher', token: { uid: `test-${requestNumber}` } }))(req, res)).catch(reject);
    });
    return { invoke, commands, api, event, async setStatus(change) {
        hardware = { ...hardware, ...change }; await advertise(); await delay(60);
    } };
}

test('MQTT waits beyond legacy browser deadline and ignores wrong ID, drawer, and old protocol', async t => {
    const f = await fixture(t, (c, { event, later }) => {
        void event({ ...ack(c), id: 'c-unrelated-command' });
        void event({ ...ack(c), drawer: 2 });
        void event({ ...ack(c), protocol: 1 });
        later(10000, ack(c));
    }, { ackTimeoutMs: 12000 });
    const status = (await f.invoke()).body;
    assert.equal(status.connected, true);
    assert.equal(status.commandTimeoutMs, 22000);
    const began = Date.now();
    const result = await f.invoke({ action: 'open', drawer: 1, id: 'c-long-motor-command', ackTimeoutMs: 12000 });
    assert.equal(result.status, 200);
    assert.ok(Date.now() - began >= 9800, 'must not finish on mismatched/old ACK');
    assert.equal(f.commands.length, 1);
});

test('matching buzzer on/off UART events are required, and SOS can run while a motor waits', async t => {
    const f = await fixture(t, (c, { event, later }) => {
        if (c.action === 'open') later(700, ack(c));
        else { void event({ ...ack(c), state: c.state === 'on' ? 'off' : 'on' }); later(200, ack(c)); }
    });
    const motor = f.invoke({ action: 'open', drawer: 1, id: 'c-motor-busy-test' });
    await delay(100);
    await f.setStatus({ ready: false });
    for (const state of ['on', 'off']) {
        const began = Date.now();
        const result = await f.invoke({ action: 'buzzer', state, id: `c-buzzer-test-${state}` });
        assert.equal(result.status, 200);
        assert.equal(result.body.ack.state, state);
        assert.ok(Date.now() - began >= 150, 'broker acceptance is not buzzer completion');
    }
    assert.equal((await motor).status, 200);
    assert.equal(f.commands.length, 3);
});

test('broker acceptance without device ACK times out; explicit UART timeout and rejection fail', async t => {
    const f = await fixture(t, (c, { later }) => {
        if (c.id.includes('reject')) later(100, { protocol: 2, event: 'cmd_rejected', id: c.id });
        if (c.id.includes('uart')) later(100, { protocol: 2, event: 'ack_timeout', id: c.id });
    });
    const began = Date.now();
    const silent = await f.invoke({ action: 'buzzer', state: 'on', id: 'c-silent-buzzer' });
    assert.equal(silent.status, 504);
    assert.ok(Date.now() - began >= 5900);
    for (const [id, expected] of [['c-explicit-reject', 409], ['c-explicit-uart', 504]]) {
        const result = await f.invoke({ action: 'open', drawer: 1, id });
        assert.equal(result.status, expected);
        assert.equal(result.body.success, false);
    }
});

test('stale/offline/busy/legacy status and changed timing budget prevent publishing', async t => {
    const f = await fixture(t);
    for (const change of [{ ts: Date.now() - 30000 }, { online: false }, { ready: false },
        { protocol: 1 }, { ackTimeoutMs: 200000 }, { microbit: 'unknown' }]) {
        await f.setStatus({ ts: Date.now(), online: true, ready: true, protocol: 2,
            ackTimeoutMs: 3000, microbit: 'connected', ...change });
        const result = await f.invoke({ action: 'open', drawer: 1, id: 'c-never-dispatched' });
        assert.equal(result.status, 503);
        assert.equal(result.body.retrySafe, true);
    }
    await f.setStatus({ ts: Date.now(), online: true, ready: true, protocol: 2, ackTimeoutMs: 3000, microbit: 'connected' });
    assert.equal((await f.invoke({ action: 'open', drawer: 1, id: 'c-budget-change', ackTimeoutMs: 30000 })).status, 503);
    assert.equal(f.commands.length, 0);
});

test('concurrent requests share one warm MQTT connection and keep their exact ACKs separate', async t => {
    const f = await fixture(t, (c, { later }) => later(100, ack(c)));
    const results = await Promise.all([1, 2].map(drawer => f.invoke({
        action: 'open', drawer, id: `c-concurrent-${drawer}` })));
    assert.deepEqual(results.map(r => r.body.ack.drawer), [1, 2]);
    assert.equal(f.api.mqttClientStatsForTests().created, 1);
    assert.equal(f.commands.length, 2);
});
