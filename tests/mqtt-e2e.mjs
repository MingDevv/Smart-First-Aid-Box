import assert from 'node:assert/strict';
import mqtt from 'mqtt';

const brokerUrl = process.env.SFAB_TEST_MQTT_URL || 'mqtt://broker.emqx.io:1883';
const runId = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
const baseTopic = `crms6/firstaidbox/integration/${runId}`;

process.env.MQTT_URL = brokerUrl;
process.env.MQTT_BASE_TOPIC = baseTopic;
process.env.MQTT_DRAWER_ACK_TIMEOUT_MS = '1800';

const {
    default: commandHandler,
    closeMqttClientForTests,
    mqttClientStatsForTests
} = await import('../api/command.js');

const device = mqtt.connect(brokerUrl, {
    clientId: `sfab-test-device-${runId}`,
    clean: true,
    reconnectPeriod: 0,
    connectTimeout: 6000
});

function waitForConnect(client) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('test device connect timeout')), 7000);
        client.once('connect', () => {
            clearTimeout(timer);
            resolve();
        });
        client.once('error', (err) => {
            clearTimeout(timer);
            reject(err);
        });
    });
}

function subscribe(client, topic) {
    return new Promise((resolve, reject) => {
        client.subscribe(topic, { qos: 1 }, (err) => (err ? reject(err) : resolve()));
    });
}

function publishEvent(event) {
    return new Promise((resolve, reject) => {
        device.publish(
            `${baseTopic}/evt`,
            JSON.stringify(event),
            { qos: 0, retain: false },
            (err) => (err ? reject(err) : resolve())
        );
    });
}

let requestNumber = 0;
function invoke(method, body = {}) {
    requestNumber++;
    return new Promise((resolve, reject) => {
        const req = {
            method,
            body,
            headers: { 'x-forwarded-for': `integration-${requestNumber}` },
            socket: { remoteAddress: `integration-${requestNumber}` }
        };
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

const actuations = new Map();
const ignoredIds = new Set();
const wrongDrawerFirstIds = new Set();

device.on('message', (_topic, bytes) => {
    const command = JSON.parse(bytes.toString());
    console.log(`[test device] received ${command.id}`);
    if (command.action !== 'open' || ignoredIds.has(command.id)) return;

    const seen = actuations.get(command.id) || 0;
    if (seen === 0) actuations.set(command.id, 1);

    if (seen > 0) {
        setTimeout(() => {
            void publishEvent({ event: 'drawer_opened', id: command.id, drawer: command.drawer, ts: Date.now() });
        }, 30);
        return;
    }

    if (wrongDrawerFirstIds.has(command.id)) {
        setTimeout(() => {
            void publishEvent({
                event: 'drawer_opened',
                id: command.id,
                drawer: command.drawer === 1 ? 2 : 1,
                ts: Date.now()
            });
        }, 40);
        setTimeout(() => {
            void publishEvent({ event: 'drawer_opened', id: command.id, drawer: command.drawer, ts: Date.now() });
        }, 260);
        return;
    }

    setTimeout(() => {
        void publishEvent({ event: 'drawer_opened', id: command.id, drawer: command.drawer, ts: Date.now() });
    }, 140);
});

try {
    await waitForConnect(device);
    await subscribe(device, `${baseTopic}/cmd`);

    const availabilityBefore = await invoke('GET');
    assert.equal(availabilityBefore.body.mqttConfigured, true);

    const firstId = 'c-e2e-dedupe-001';
    const firstStarted = Date.now();
    const first = await invoke('POST', { action: 'open', drawer: 1, id: firstId });
    assert.equal(first.status, 200);
    assert.deepEqual(first.body.ack, { event: 'drawer_opened', id: firstId, drawer: 1 });
    assert.ok(Date.now() - firstStarted >= 100, 'API returned before device ACK');
    assert.equal(actuations.get(firstId), 1);

    // Model the firmware ring: duplicate id re-ACKs but does not actuate again.
    const duplicate = await invoke('POST', { action: 'open', drawer: 1, id: firstId });
    assert.equal(duplicate.status, 200);
    assert.equal(actuations.get(firstId), 1);

    const wrongDrawerId = 'c-e2e-drawer-002';
    wrongDrawerFirstIds.add(wrongDrawerId);
    const wrongStarted = Date.now();
    const rightAck = await invoke('POST', { action: 'open', drawer: 2, id: wrongDrawerId });
    assert.equal(rightAck.status, 200);
    assert.equal(rightAck.body.ack.drawer, 2);
    assert.ok(Date.now() - wrongStarted >= 220, 'wrong-drawer event incorrectly satisfied the waiter');

    const timeoutId = 'c-e2e-timeout-003';
    ignoredIds.add(timeoutId);
    const timeoutStarted = Date.now();
    const timedOut = await invoke('POST', { action: 'open', drawer: 1, id: timeoutId });
    assert.equal(timedOut.status, 504);
    assert.equal(timedOut.body.success, false);
    assert.ok(Date.now() - timeoutStarted >= 1700, 'ACK timeout returned too early');

    const concurrentIds = ['c-e2e-concurrent-004', 'c-e2e-concurrent-005'];
    const concurrent = await Promise.all(concurrentIds.map((id, index) => (
        invoke('POST', { action: 'open', drawer: index + 1, id })
    )));
    assert.deepEqual(concurrent.map((result) => result.status), [200, 200]);
    assert.deepEqual(concurrent.map((result) => result.body.ack.id), concurrentIds);

    const availabilityAfter = await invoke('GET');
    assert.equal(availabilityAfter.body.mqttConnected, true);
    assert.deepEqual(mqttClientStatsForTests(), {
        created: 1,
        active: true,
        connecting: false,
        retiring: false
    });
    console.log('real broker MQTT integration passed');
} finally {
    await closeMqttClientForTests();
    await new Promise((resolve) => device.end(true, {}, resolve));
}
