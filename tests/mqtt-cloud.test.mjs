import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { CloudBridge, startCloudBridge } from '../edge/mqtt-cloud.mjs';

const BASE = 'crms6/firstaidbox/box1';
const NOW = 1_800_000_000_000;

// broker ปลอม จดสิ่งที่ Pi ส่งขึ้นมา และให้เทสยัดข้อความลงไปได้
class FakeClient extends EventEmitter {
    constructor() {
        super();
        this.connected = false;
        this.published = [];
        this.subscriptions = [];
        this.ended = null;
    }
    subscribe(topic, opts, cb) { this.subscriptions.push({ topic, opts }); cb(null, [{ topic, qos: opts.qos }]); }
    publish(topic, payload, opts, cb) { this.published.push({ topic, doc: JSON.parse(payload), opts }); cb?.(); }
    end(force, opts, cb) { this.ended = force ? 'forced' : 'graceful'; this.connected = false; cb?.(); }
    // broker ส่งคำสั่งลงมา ธง retained เลียนแบบที่ mqtt.js บอกเวลาเจอข้อความค้าง
    deliver(doc, { retain = false, topic = `${BASE}/cmd` } = {}) {
        this.emit('message', topic, Buffer.from(typeof doc === 'string' ? doc : JSON.stringify(doc)), { retain });
    }
}

const readyHardware = { connected: true, ready: true, ackTimeoutMs: 30000, commandTimeoutMs: 33000,
    reason: '', deviceMode: 'real', unresolved: null, mode: 'pi-local', configured: true };
const quiet = { log() {}, error() {} };

function fixture({ hardware = readyHardware, result, now = () => NOW, cloudActions } = {}) {
    const calls = [];
    const controller = {
        async status() { return hardware; },
        async command(command) {
            calls.push(command);
            if (result) return result(command);
            return { status: 200, body: { success: true, mode: 'pi-local', commandId: command.id,
                ack: { protocol: 2, event: command.action === 'open' ? 'drawer_opened' : 'buzzer_set', id: command.id } } };
        }
    };
    let client;
    const bridge = new CloudBridge({ controller, url: 'mqtts://broker.test:8883', username: 'pi', password: 'secret',
        baseTopic: BASE, connect: () => { client = new FakeClient(); return client; }, now, statusIntervalMs: 0,
        log: quiet, ...(cloudActions !== undefined ? { cloudActions } : {}) }).start();
    client.connected = true;
    client.emit('connect');
    return { bridge, client, calls, controller };
}

const tick = () => new Promise(resolve => setImmediate(resolve));
const events = client => client.published.filter(p => p.topic === `${BASE}/evt`).map(p => p.doc);
const statuses = client => client.published.filter(p => p.topic === `${BASE}/status`);
const good = { protocol: 2, action: 'open', drawer: 1, id: 'c-cloud-000003', ts: NOW };

test('connecting subscribes to cmd and publishes a retained protocol-2 status the cloud can read', async () => {
    const { client } = fixture();
    await tick();
    assert.deepEqual(client.subscriptions, [{ topic: `${BASE}/cmd`, opts: { qos: 1 } }]);
    const [status] = statuses(client);
    assert.deepEqual(status.opts, { qos: 0, retain: true }, 'heartbeat is retained at QoS 0 like the firmware');
    assert.deepEqual(status.doc, { protocol: 2, online: true, transport: 'pi', microbit: 'connected',
        ready: true, ackTimeoutMs: 30000, reason: '', ts: NOW });
});

test('the will announces offline, retained, on the status topic', () => {
    let options;
    new CloudBridge({ controller: {}, url: 'mqtt://x', connect: (url, o) => { options = o; return new FakeClient(); },
        statusIntervalMs: 0, log: quiet }).start();
    assert.equal(options.will.topic, `${BASE}/status`);
    assert.equal(options.will.retain, true);
    assert.deepEqual(JSON.parse(options.will.payload), { protocol: 2, online: false });
    assert.equal(options.clean, true);
    assert.equal(options.keepalive, 30);
    assert.ok(options.reconnectPeriod > 0);
});

test('a cloud open command goes through the controller and comes back as drawer_opened', async () => {
    const { client, calls } = fixture();
    client.deliver({ protocol: 2, action: 'open', drawer: 2, id: 'c-cloud-000001', ts: NOW - 500 });
    await tick(); await tick();
    assert.deepEqual(calls, [{ action: 'open', drawer: 2, id: 'c-cloud-000001' }]);
    const [evt] = events(client);
    assert.deepEqual(evt, { protocol: 2, event: 'drawer_opened', id: 'c-cloud-000001', drawer: 2, ts: NOW });
    const evtPublish = client.published.find(p => p.topic === `${BASE}/evt`);
    assert.deepEqual(evtPublish.opts, { qos: 1, retain: false }, 'an ACK must never be retained');
    assert.ok(statuses(client).length >= 2, 'status is republished after a command');
});

test('buzzer commands echo the requested state so the cloud waiter matches', async () => {
    const { client, calls } = fixture();
    client.deliver({ protocol: 2, action: 'buzzer', state: 'off', id: 'c-cloud-000002', ts: NOW });
    await tick(); await tick();
    assert.deepEqual(calls, [{ action: 'buzzer', state: 'off', id: 'c-cloud-000002' }]);
    assert.deepEqual(events(client)[0], { protocol: 2, event: 'buzzer_set', id: 'c-cloud-000002', state: 'off', ts: NOW });
});

test('retained, malformed, stale, future and foreign commands never reach the controller', async () => {
    const { client, calls } = fixture();
    client.deliver(good, { retain: true });
    client.deliver('{not json');
    client.deliver({ ...good, id: 'short' });
    client.deliver({ ...good, protocol: 1 });
    client.deliver({ ...good, action: 'open', drawer: 3 });
    client.deliver({ ...good, ts: 'now' });
    client.deliver({ ...good, ts: NOW - 30001 });
    client.deliver({ ...good, ts: NOW + 2001 });
    client.deliver({ ...good, ts: Number.MAX_SAFE_INTEGER });
    client.deliver(good, { topic: `${BASE}/status` });
    await tick(); await tick();
    assert.deepEqual(calls, []);
    assert.deepEqual(events(client).map(e => [e.event, e.reason, e.id ?? null]), [
        ['cmd_rejected', 'retained', 'c-cloud-000003'],
        ['cmd_rejected', 'invalid_json', null],
        ['cmd_rejected', 'invalid_id', null],
        ['cmd_rejected', 'unsupported_protocol', 'c-cloud-000003'],
        ['cmd_rejected', 'invalid_action', 'c-cloud-000003'],
        ['cmd_rejected', 'invalid_ts', 'c-cloud-000003'],
        ['cmd_rejected', 'stale', 'c-cloud-000003'],
        ['cmd_rejected', 'future_ts', 'c-cloud-000003'],
        ['cmd_rejected', 'future_ts', 'c-cloud-000003']
    ]);
});

test('a Pi whose clock has not synced refuses every command instead of guessing', async () => {
    const { client, calls } = fixture({ now: () => 1000 });
    client.deliver({ ...good, ts: 1000 });
    await tick(); await tick();
    assert.deepEqual(calls, []);
    assert.deepEqual(events(client).map(e => e.reason), ['clock_not_ready']);
});

test('SFAB_CLOUD_ACTIONS=buzzer lets the website call for help but not open a drawer, and says so in status', async () => {
    const { client, calls } = fixture({ cloudActions: 'buzzer' });
    await tick();
    const status = statuses(client)[0].doc;
    assert.equal(status.ready, false);
    assert.equal(status.reason, 'cloud_open_disabled');
    assert.equal(status.microbit, 'connected');
    client.deliver(good);
    client.deliver({ protocol: 2, action: 'buzzer', state: 'on', id: 'c-cloud-000009', ts: NOW });
    await tick(); await tick();
    assert.deepEqual(calls, [{ action: 'buzzer', state: 'on', id: 'c-cloud-000009' }]);
    assert.deepEqual(events(client).map(e => [e.event, e.reason ?? e.state]), [['cmd_rejected', 'cloud_open_disabled'], ['buzzer_set', 'on']]);
});

test('controller refusals map onto the firmware event names the cloud already understands', async () => {
    const outcomes = {
        'c-cloud-mode-0001': { status: 503, body: { success: false, deviceMode: 'demo', retrySafe: true } },
        'c-cloud-mode-0002': { status: 503, body: { success: false, deviceMode: 'unset', retrySafe: true } },
        'c-cloud-busy-0003': { status: 409, body: { success: false } },
        'c-cloud-down-0004': { status: 503, body: { success: false } },
        'c-cloud-lost-0005': { status: 504, body: { success: false } },
        'c-cloud-unkn-0006': { status: 409, body: { success: false, uncertain: true } }
    };
    const { client } = fixture({ result: command => outcomes[command.id] });
    for (const id of Object.keys(outcomes)) {
        client.deliver({ protocol: 2, action: 'open', drawer: 1, id, ts: NOW });
    }
    await tick(); await tick(); await tick();
    assert.deepEqual(events(client).map(e => [e.id, e.event, e.reason]), [
        ['c-cloud-mode-0001', 'cmd_rejected', 'mode_demo'],
        ['c-cloud-mode-0002', 'cmd_rejected', 'mode_unset'],
        ['c-cloud-busy-0003', 'cmd_rejected', 'rejected'],
        ['c-cloud-down-0004', 'cmd_rejected', 'not_ready'],
        ['c-cloud-lost-0005', 'ack_timeout', 'uart_timeout'],
        ['c-cloud-unkn-0006', 'ack_timeout', 'uart_timeout']
    ]);
    assert.equal(events(client)[4].drawer, 1);
});

test('status reports not-ready when the board is unplugged, the cabinet is not in Real mode, or a hold is pending', async () => {
    const unplugged = fixture({ hardware: { ...readyHardware, connected: false, ready: false, ackTimeoutMs: null } });
    await tick();
    assert.deepEqual(statuses(unplugged.client)[0].doc, { protocol: 2, online: true, transport: 'pi',
        microbit: 'unknown', ready: false, ackTimeoutMs: null, reason: '', ts: NOW });
    const demo = fixture({ hardware: { ...readyHardware, deviceMode: 'demo' } });
    await tick();
    let doc = statuses(demo.client)[0].doc;
    assert.equal(doc.microbit, 'connected');
    assert.equal(doc.ready, false);
    assert.equal(doc.reason, 'mode_demo');
    assert.equal(doc.ackTimeoutMs, 30000);
    const held = fixture({ hardware: { ...readyHardware, unresolved: { id: 'c-old', drawer: 2 } } });
    await tick();
    doc = statuses(held.client)[0].doc;
    assert.equal(doc.ready, false);
    assert.equal(doc.reason, 'unresolved_hold');
});

test('close publishes offline retained, ends the client, and refuses commands that arrive afterwards', async () => {
    const { bridge, client } = fixture();
    await tick();
    await bridge.close();
    const last = statuses(client).at(-1);
    assert.deepEqual(last.doc, { protocol: 2, online: false, ts: NOW });
    assert.deepEqual(last.opts, { qos: 1, retain: true });
    assert.equal(client.ended, 'graceful');
    client.deliver(good);
    await tick(); await tick();
    assert.deepEqual(events(client).map(e => e.reason), ['shutting_down']);
});

test('close is bounded when the broker never answers: forced end within the deadlines', async () => {
    const { bridge, client } = fixture();
    await tick();
    client.publish = () => {};                       // PUBACK never comes
    client.end = (force, opts, cb) => { client.ended = force ? 'forced' : 'pending'; if (force) cb?.(); };
    const started = Date.now();
    await bridge.close();
    assert.ok(Date.now() - started < 6000, `close took ${Date.now() - started} ms`);
    assert.equal(client.ended, 'forced');
});

test('startCloudBridge never throws: no URL, a bad scheme or a bad URL disable the cloud path only', async () => {
    const seen = [];
    const log = { log: m => seen.push(m), error: m => seen.push(m) };
    assert.equal(await startCloudBridge({}, {}, { log }), null);
    assert.equal(await startCloudBridge({ MQTT_URL: 'garbage' }, {}, { log }), null);
    assert.equal(await startCloudBridge({ MQTT_URL: 'https://broker:8883' }, {}, { log }), null);
    assert.equal(await startCloudBridge({ MQTT_URL: 'mqtts://' }, {}, { log }), null);
    assert.match(seen[0], /MQTT_URL not set/);
    assert.match(seen[1], /disabled: MQTT_URL must start with/);
    assert.match(seen[2], /disabled: MQTT_URL must start with/);
    assert.match(seen[3], /disabled:/);
});

test('startCloudBridge reads the same variable names as Vercel plus the action allowlist', async () => {
    let seen;
    const bridge = await startCloudBridge({ MQTT_URL: ' mqtts://b:8883 ', MQTT_USERNAME: 'u', MQTT_PASSWORD: 'p',
        MQTT_BASE_TOPIC: 'crms6/firstaidbox/box9/', SFAB_CLOUD_ACTIONS: 'buzzer' }, {},
    { connect: (url, o) => { seen = { url, o }; return new FakeClient(); }, statusIntervalMs: 0, log: quiet });
    assert.equal(seen.url, 'mqtts://b:8883');
    assert.equal(seen.o.username, 'u');
    assert.equal(seen.o.password, 'p');
    assert.equal(bridge.topics.cmd, 'crms6/firstaidbox/box9/cmd');
    assert.deepEqual([...bridge.cloudActions], ['buzzer']);
});
