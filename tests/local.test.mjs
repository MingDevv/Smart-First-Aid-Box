import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
const apiBridgeSource = await readFile(new URL('js/api-bridge.js', root), 'utf8');
const mqttBridgeSource = await readFile(new URL('js/mqtt-bridge.js', root), 'utf8');
const firmwareSource = await readFile(new URL('firmware/esp32_smart_box.ino', root), 'utf8');
const commandHistorySource = await readFile(new URL('firmware/command_history.h', root), 'utf8');
const commandApiSource = await readFile(new URL('api/command.js', root), 'utf8');

function response(status, data) {
    return {
        status,
        ok: status >= 200 && status < 300,
        async json() { return data; }
    };
}

function loadApiBridge(settings, fetchImpl, mqttBridge = null) {
    const window = {
        StorageService: { getSettings: () => settings },
        MqttBridge: mqttBridge,
        crypto: { randomUUID: () => '12345678-1234-1234-1234-123456789abc' }
    };
    const context = vm.createContext({
        window,
        fetch: fetchImpl,
        AbortController,
        setTimeout,
        clearTimeout,
        console,
        Date,
        Math,
        encodeURIComponent
    });
    vm.runInContext(apiBridgeSource, context, { filename: 'js/api-bridge.js' });
    return window.ApiBridge;
}

// Fresh browser: local MQTT listener is unconfigured, but downlink still asks the server.
{
    let calls = 0;
    const api = loadApiBridge(
        { esp32Url: '', mqttWsUrl: '' },
        async (url, options) => {
            calls++;
            assert.equal(url, '/api/command');
            const command = JSON.parse(options.body);
            return response(200, {
                success: true,
                mqttConfigured: true,
                compartment: command.drawer,
                commandId: command.id,
                ack: { event: 'drawer_opened', id: command.id, drawer: command.drawer }
            });
        }
    );

    assert.ok(api.BROWSER_COMMAND_TIMEOUT_MS > 2500 + 5500);
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
        { esp32Url: '', mqttWsUrl: '' },
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

// MQTT timeout falls through to LAN with the same id and waits for LAN UART completion.
{
    let commandId;
    let lanOpenId;
    let statusPolls = 0;
    const api = loadApiBridge(
        { esp32Url: 'http://smart-box', mqttWsUrl: '' },
        async (url, options = {}) => {
            if (url === '/api/command') {
                const command = JSON.parse(options.body);
                commandId = command.id;
                return response(504, { success: false, mqttConfigured: true, commandId, error: 'ACK timeout' });
            }
            if (url.startsWith('http://smart-box/open?')) {
                lanOpenId = new URL(url).searchParams.get('id');
                return response(202, { success: false, accepted: true, id: lanOpenId, drawer: 1 });
            }
            if (url.startsWith('http://smart-box/command-status?')) {
                statusPolls++;
                const id = new URL(url).searchParams.get('id');
                return response(200, { success: true, event: 'drawer_opened', id, drawer: 1 });
            }
            throw new Error(`unexpected URL: ${url}`);
        }
    );

    const result = await api.openCompartment('abrasion');
    assert.equal(result.success, true);
    assert.equal(result.mode, 'production');
    assert.equal(lanOpenId, commandId);
    assert.equal(statusPolls, 1);
}

// Direct browser MQTT listener resolves only an exact id + drawer event.
{
    const window = {
        StorageService: {
            getSettings: () => ({
                mqttWsUrl: 'wss://example.invalid/mqtt',
                mqttBaseTopic: 'test/box'
            })
        }
    };
    const context = vm.createContext({ window, console, setTimeout, clearTimeout, Map, Set });
    vm.runInContext(mqttBridgeSource, context, { filename: 'js/mqtt-bridge.js' });
    const bridge = window.MqttBridge;
    bridge.connect = () => ({ connected: true });

    let resolved = false;
    const waiter = bridge.waitForDrawerOpened('c-command-123', 2, 1000).then((value) => {
        resolved = true;
        return value;
    });
    bridge.settleDrawerOpened({ event: 'drawer_opened', id: 'c-command-123', drawer: 1 });
    await Promise.resolve();
    assert.equal(resolved, false);
    bridge.settleDrawerOpened({ event: 'drawer_opened', id: 'c-command-123', drawer: 2 });
    assert.equal((await waiter).drawer, 2);
}

// These are static firmware invariants only; the Arduino sketch is not compiled by this test.
assert.match(commandHistorySource, /COMMAND_HISTORY_SIZE = 8/);
assert.match(commandHistorySource, /offset < COMMAND_HISTORY_SIZE/);
assert.match(commandHistorySource, /record->expired = true/);
assert.match(firmwareSource, /COMMAND_ACK_TIMEOUT_MS = 15000/);
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
assert.match(commandApiSource, /MQTT_CONNECT_TIMEOUT_MS = 2500/);
assert.match(commandApiSource, /DEFAULT_DRAWER_ACK_TIMEOUT_MS = 5500/);
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
