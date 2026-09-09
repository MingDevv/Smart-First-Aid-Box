import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { LocalController } from '../edge/controller.mjs';
import { createLocalServer } from '../edge/server.mjs';

const command = { action: 'open', drawer: 1, id: 'c-edge-test-0001' };
const ack = body => ({ success: true, protocol: 2, event: 'drawer_opened', id: body.id, drawer: body.drawer });
const listen = async server => {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${server.address().port}`;
};
const close = server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });

async function fixture(t, reply, options = {}) {
    const dir = await mkdtemp(join(tmpdir(), 'sfab-edge-'));
    const requests = [];
    const esp = createServer(async (req, res) => {
        const url = new URL(req.url, 'http://device');
        requests.push(url);
        const result = await reply(url, req, res);
        if (result && !res.destroyed) {
            res.writeHead(result[0], { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result[1]));
        }
    });
    const esp32Url = await listen(esp);
    const database = join(dir, 'commands.sqlite');
    const controller = new LocalController({ esp32Url, database, timeoutMs: 1000, pollMs: 5, ...options });
    t.after(async () => { await controller.close(); await close(esp); await rm(dir, { recursive: true }); });
    return { controller, database, esp32Url, requests };
}
const ready = [200, { protocol: 2, microbit: 'connected', ready: true }];
const pending = [202, { success: false, accepted: true }];

test('Pi waits for matching hardware ACK, journals first, and executes duplicate requests only once', async t => {
    let opens = 0;
    const { controller } = await fixture(t, url => {
        if (url.pathname === '/status') return ready;
        if (url.pathname === '/open') {
            opens++;
            assert.equal(controller.history()[0].state, 'pending');
            return pending;
        }
        return [200, ack(command)];
    });
    const first = controller.command(command);
    const duplicate = controller.command(command);
    assert.equal((await controller.command({ ...command, drawer: 2 })).status, 409);
    assert.equal((await first).body.success, true);
    assert.deepEqual(await duplicate, await first);
    assert.deepEqual(await controller.command(command), await first);
    assert.equal(opens, 1);
    assert.equal(controller.history().length, 1);
    assert.equal(controller.history()[0].state, 'confirmed');
    assert.ok(controller.history()[0].confirmed_at);
});

test('wrong id, drawer, old firmware ACK and acceptance never become success', async t => {
    for (const wrong of [{ ...ack(command), id: 'c-other-command' },
        { ...ack(command), drawer: 2 }, { ...ack(command), protocol: 1 },
        { success: true, accepted: true }]) {
        const { controller, requests } = await fixture(t, url => url.pathname === '/status' ? ready : [200, wrong]);
        const result = await controller.command(command);
        assert.equal(result.status, 504);
        assert.equal(result.body.success, false);
        assert.equal(controller.history()[0].state, 'uncertain');
        await controller.command(command);
        assert.equal(requests.filter(u => u.pathname === '/open').length, 1);
    }
});

test('lost HTTP open response is recovered by status polling without resending the actuator command', async t => {
    const { controller, requests } = await fixture(t, (url, req, res) => {
        if (url.pathname === '/status') return ready;
        if (url.pathname === '/open') { res.destroy(); return null; }
        return [200, ack(command)];
    });
    const result = await controller.command(command);
    assert.equal(result.body.success, true, JSON.stringify({ result, paths: requests.map(u => u.pathname) }));
    assert.equal(requests.filter(u => u.pathname === '/open').length, 1);
});

test('restart retains completed and uncertain IDs without replaying commands', async t => {
    const fixtureData = await fixture(t, url => url.pathname === '/status' ? ready : [200, ack(command)]);
    const { controller, database, esp32Url, requests } = fixtureData;
    await controller.command(command);
    controller.db.prepare("INSERT INTO commands(id, drawer, state, created_at) VALUES (?, 2, 'pending', 'test')")
        .run('c-crash-after-send');
    const recovered = new LocalController({ esp32Url, database });
    t.after(() => recovered.close());
    const before = requests.length;
    assert.equal((await recovered.command(command)).body.success, true);
    assert.equal((await recovered.command({ ...command, drawer: 2, id: 'c-crash-after-send' })).status, 409);
    assert.equal(requests.length, before);
});

test('unconfigured, busy or older firmware never receives an open request', async t => {
    for (const status of [{ microbit: 'connected', ready: true },
        { protocol: 2, microbit: 'connected', ready: false },
        { protocol: 2, microbit: 'unknown', ready: true }]) {
        const { controller, requests } = await fixture(t, () => [200, status]);
        assert.equal((await controller.command(command)).status, 503);
        assert.ok(requests.every(u => u.pathname === '/status'));
    }
});

test('concurrent different commands are rejected and a reused ID cannot change buzzer state', async t => {
    const buzzer = { action: 'buzzer', state: 'on', id: 'c-edge-buzzer-01' };
    const { controller, requests } = await fixture(t, url => {
        if (url.pathname === '/status') return ready;
        if (url.pathname === '/buzzer') return pending;
        return [200, { success: true, protocol: 2, event: 'buzzer_set', id: buzzer.id, state: 'on' }];
    });
    const active = controller.command(buzzer);
    assert.equal((await controller.command(command)).status, 409);
    assert.equal((await active).body.success, true, JSON.stringify(requests.map(u => u.pathname)));
    assert.equal((await controller.command({ ...buzzer, state: 'off' })).status, 409);
    assert.equal(requests.filter(u => u.pathname === '/buzzer').length, 1);
});

test('local server serves all kiosk routes, suppresses MQTT, and protects source and command origins', async t => {
    const { controller } = await fixture(t, url => url.pathname === '/status' ? ready : [200, ack(command)]);
    const server = await createLocalServer({ controller });
    const origin = await listen(server);
    t.after(() => close(server));
    const routing = JSON.parse(await readFile(new URL('../vercel.json', import.meta.url)));
    for (const route of ['/', '/student/', ...routing.rewrites.map(r => r.source)]) {
        const response = await fetch(origin + route);
        assert.equal(response.status, 200, route);
        const html = await response.text();
        assert.ok(html.includes('window.SFAB_RUNTIME = { transport: "pi-local" }'), route);
        assert.ok(!html.includes('npm/mqtt@'), route);
    }
    for (const path of ['/.env', '/edge/server.mjs', '/api/command.js', '/firmware/esp32_smart_box.ino',
        '/package.json', '/js/../.git/config', '/js/%2e%2e%2f.env']) {
        assert.equal((await fetch(origin + path)).status, 404, path);
    }
    assert.equal((await fetch(origin + '/api/local/status')).status, 200);
    assert.equal((await fetch(origin + '/api/command')).status, 405);
    assert.equal((await fetch(origin + '/api/command', { method: 'POST', body: '{}' })).status, 415);
    assert.equal((await fetch(origin + '/api/command', { method: 'POST', headers: {
        'Content-Type': 'application/json', Origin: 'https://unrelated.invalid' }, body: JSON.stringify(command) })).status, 403);
    const badHostStatus = await new Promise((resolve, reject) => {
        const req = httpRequest(origin, { headers: { Host: 'unrelated.invalid' } }, res => {
            res.resume(); resolve(res.statusCode);
        });
        req.on('error', reject); req.end();
    });
    assert.equal(badHostStatus, 403);
    const result = await fetch(origin + '/api/command', { method: 'POST', headers: {
        'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(command) });
    assert.equal((await result.json()).success, true);
    assert.equal((await (await fetch(origin + '/api/local/history')).json()).commands.length, 1);
});

test('Pi browser ignores stored MQTT/LAN settings and fails closed; explicit demo makes no hardware request', async () => {
    const source = await readFile(new URL('../js/api-bridge.js', import.meta.url), 'utf8');
    const mqttSource = await readFile(new URL('../js/mqtt-bridge.js', import.meta.url), 'utf8');
    let fail = false;
    let calls = 0;
    const settings = { demoMode: false, esp32Url: 'http://must-not-contact.invalid', mqttWsUrl: 'wss://must-not-contact.invalid' };
    const window = { SFAB_RUNTIME: { transport: 'pi-local' }, StorageService: { getSettings: () => settings } };
    const context = vm.createContext({ window, console, AbortController, setTimeout, clearTimeout, Map, Set,
        fetch: async (url, opts) => {
            calls++;
            assert.equal(url, '/api/command');
            if (fail) throw new Error('connection lost');
            const body = JSON.parse(opts.body);
            return { ok: true, json: async () => ({ success: true, mode: 'pi-local', ack: ack(body) }) };
        } });
    vm.runInContext(mqttSource, context);
    vm.runInContext(source, context);
    assert.equal(window.MqttBridge.isConfigured(), false);
    assert.equal(window.MqttBridge.connect(), null);
    assert.equal((await window.ApiBridge.openCompartment('cut')).mode, 'pi-local');
    fail = true;
    assert.equal((await window.ApiBridge.openCompartment('insect')).success, false);
    assert.equal(calls, 2);
    assert.equal((await window.ApiBridge.openCompartment('unsupported')).success, false);
    assert.equal(calls, 2);
    settings.demoMode = true;
    assert.equal((await window.ApiBridge.openCompartment('cut')).mode, 'simulation');
    assert.equal(calls, 2);
});
