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
    // เทสชุดนี้ตรวจชั้นขนส่งกับสมุดคำสั่ง ไม่ได้ตรวจเกตโหมด จึงตั้งเป็น real ให้ผ่านเกตไป
    // เกตโหมดมีเทสของตัวเองอยู่ข้างล่าง (ครบทั้งสามค่า พร้อมนับจำนวนครั้งที่ ESP32 ถูกเรียก)
    const controller = new LocalController({ esp32Url, database, timeoutMs: 1000, pollMs: 5, mode: 'real', ...options });
    t.after(async () => { await controller.close(); await close(esp); await rm(dir, { recursive: true }); });
    return { controller, database, esp32Url, requests };
}
// รัน bootstrap ที่เสิร์ฟมาจริงแล้วคืนค่าเป็นอ็อบเจ็กต์ธรรมดา
// ต้อง JSON round-trip เพราะอ็อบเจ็กต์ที่เกิดใน vm context อยู่คนละ realm
// deepStrictEqual จะฟ้องว่า prototype ไม่ตรงทั้งที่ค่าเหมือนกันทุกฟิลด์
function runBootstrap(source) {
    const ctx = vm.createContext({ window: {} });
    vm.runInContext(source, ctx);
    return JSON.parse(JSON.stringify(ctx.window.SFAB_RUNTIME));
}
const ready = [200, { protocol: 2, microbit: 'connected', ready: true, ackTimeoutMs: 30000 }];
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
    const recovered = new LocalController({ esp32Url, database, mode: 'real' });
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

test('a pending buzzer never blocks opening and a reused ID cannot change buzzer state', async t => {
    const buzzer = { action: 'buzzer', state: 'on', id: 'c-edge-buzzer-01' };
    const { controller, requests } = await fixture(t, url => {
        if (url.pathname === '/status') return ready;
        if (url.pathname === '/buzzer') return pending;
        if (url.pathname === '/open') return [200, ack(command)];
        return [200, { success: true, protocol: 2, event: 'buzzer_set', id: buzzer.id, state: 'on' }];
    });
    const active = controller.command(buzzer);
    assert.equal((await controller.command(command)).body.success, true);
    assert.equal((await active).body.success, true, JSON.stringify(requests.map(u => u.pathname)));
    assert.equal((await controller.command({ ...buzzer, state: 'off' })).status, 409);
    assert.equal(requests.filter(u => u.pathname === '/buzzer').length, 1);
});

test('SOS is dispatched while an open command is still waiting for acknowledgement', async t => {
    const buzzer = { action: 'buzzer', state: 'on', id: 'c-sos-during-open' };
    const { controller, requests } = await fixture(t, url => {
        if (url.pathname === '/status') return ready;
        if (url.pathname === '/buzzer' || url.searchParams.get('id') === buzzer.id) {
            return [200, { success: true, protocol: 2, event: 'buzzer_set', id: buzzer.id, state: 'on' }];
        }
        return pending;
    }, { timeoutMs: 150 });
    const opening = controller.command(command);
    assert.equal((await controller.command(buzzer)).body.success, true);
    assert.ok(requests.some(u => u.pathname === '/buzzer'));
    assert.equal((await opening).status, 504);
});

test('only explicit matching not-actuated evidence becomes rejection; bare HTTP errors stay uncertain', async t => {
    for (const proven of [true, false]) {
        const { controller } = await fixture(t, url => url.pathname === '/status' ? ready :
            [409, { success: false, ...(proven ? { actuated: false, id: command.id } : {}) }], { timeoutMs: 60 });
        const result = await controller.command(command);
        assert.equal(result.status, proven ? 409 : 504);
        assert.equal(controller.history()[0].state, proven ? 'rejected' : 'uncertain');
    }
});

test('firmware ACK budget determines the outer command deadline and unknown budgets fail closed', async t => {
    for (const ackTimeoutMs of [30000, 60000, null, 200000]) {
        const { controller, requests } = await fixture(t, () => [200, { ...ready[1], ackTimeoutMs }]);
        const status = await controller.status();
        const valid = ackTimeoutMs === 30000 || ackTimeoutMs === 60000;
        assert.equal(status.connected, valid);
        assert.equal(status.commandTimeoutMs, valid ? ackTimeoutMs + 3000 : null);
        if (!valid) {
            assert.equal((await controller.command(command)).status, 503);
            assert.ok(requests.every(r => r.pathname === '/status'));
        }
    }
});

// ───────── คำสั่งค้างที่ไม่รู้ผล = เกตถาวร ไม่ใช่สถานะบนหน้าจอ ─────────
// ทางหนีที่นัยทำซ้ำได้: คำสั่งจบแบบ uncertain แล้วหน้าจอถูกรีเซ็ต/นับถอยหลัง/รีโหลด
// ใบใหม่จึงมี id ใหม่เอี่ยม ตัวกันซ้ำราย id มองไม่เห็น แล้ว ESP32 ก็ได้รับ /open อีกใบ
// ทั้งที่ลิ้นชักใบเดิมยังไม่มีใครไปดูว่าเปิดค้างอยู่หรือมอเตอร์ค้างกลางทาง

test('คำสั่งที่ส่งแล้วไม่ได้ ACK จบเป็น uncertain และกลายเป็นคำสั่งค้างที่ unresolved() เห็น', async t => {
    const buzzer = { action: 'buzzer', state: 'on', id: 'c-hold-buzzer-001' };
    const { controller, requests } = await fixture(t, url => {
        if (url.pathname === '/status') return ready;
        if (url.pathname === '/buzzer' || url.searchParams.get('id') === buzzer.id) {
            return [200, { success: true, protocol: 2, event: 'buzzer_set', id: buzzer.id, state: 'on' }];
        }
        return pending;   // /open ตอบรับ แต่ไม่เคยยืนยัน และ /command-status ก็ไม่ยืนยัน
    }, { timeoutMs: 150 });

    const stuck = await controller.command(command);
    assert.equal(stuck.status, 504);
    assert.equal(stuck.body.success, false);
    assert.equal(controller.history()[0].state, 'uncertain');
    const held = controller.unresolved();
    assert.equal(held.id, command.id);
    assert.equal(held.drawer, command.drawer);
    const opens = requests.filter(u => u.pathname === '/open').length;
    assert.equal(opens, 1);

    // id ใหม่เอี่ยม: ไม่ชนกับใบเดิม ตัวกันซ้ำราย id ปล่อยผ่านแน่นอน สิ่งที่กันคือ journal
    const fresh = { ...command, id: 'c-edge-fresh-0002' };
    const refused = await controller.command(fresh);
    assert.equal(refused.status, 409);
    assert.equal(refused.body.success, false);
    assert.equal(refused.body.commandId, fresh.id);
    // ตัวเลขนี้คือหลักฐานว่าทางหนีปิดแล้ว ไม่ใช่แค่ HTTP ตอบ 409 สวยๆ
    assert.equal(requests.filter(u => u.pathname === '/open').length, opens,
        'ESP32 ได้รับ /open ใบใหม่ทั้งที่ยังมีคำสั่งค้าง');
    assert.equal(controller.history().find(row => row.id === fresh.id), undefined,
        'ใบที่ถูกปฏิเสธต้องไม่ถูกจดลงสมุดคำสั่ง');
    assert.equal(controller.unresolved().id, command.id);

    // ออดต้องไม่ถูกกั้น — การเรียกครูห้ามติดอยู่กับลิ้นชักที่ค้าง
    assert.equal((await controller.command(buzzer)).body.success, true);
    assert.ok(requests.some(u => u.pathname === '/buzzer'));
    assert.equal(controller.unresolved().id, command.id, 'ออดที่สำเร็จต้องไม่ไปล้างคำสั่งค้าง');
});

test('status() รายงานคำสั่งค้างครบทั้งสามกิ่ง: ต่อติด ต่อไม่ติด และยังไม่ได้ตั้งค่า ESP32', async t => {
    const { controller, database, esp32Url } = await fixture(t, url =>
        url.pathname === '/status' ? ready : pending, { timeoutMs: 120 });
    await controller.command(command);
    assert.equal(controller.unresolved().id, command.id);

    // 1. กิ่งต่อติด
    const connected = await controller.status();
    assert.equal(connected.connected, true);
    assert.equal(connected.unresolved.id, command.id);

    // 2. กิ่งต่อไม่ติด — ชี้ไปพอร์ตที่เพิ่งปิด (ปิด esp ของ fixture ไม่ได้ เพราะเทสอื่นยังใช้)
    //    ตู้ที่หลุดไปตอนคำสั่งยังคาอยู่ คือกรณีที่ห้ามบอกผู้เรียกว่าว่างให้สั่งใหม่ที่สุด
    const vanished = createServer(() => {});
    const deadUrl = await listen(vanished);
    await close(vanished);
    const offline = new LocalController({ esp32Url: deadUrl, database, mode: 'real' });
    t.after(() => offline.close());
    const unreachable = await offline.status();
    assert.equal(unreachable.connected, false);
    assert.equal(unreachable.configured, true);
    assert.equal(unreachable.unresolved.id, command.id);

    // 3. กิ่งยังไม่ได้ตั้งค่า (ไม่มี esp32Url) — return ก่อนแตะเครือข่ายเลย
    const unconfigured = new LocalController({ database, mode: 'real' });
    t.after(() => unconfigured.close());
    const idle = await unconfigured.status();
    assert.equal(idle.configured, false);
    assert.equal(idle.connected, false);
    assert.equal(idle.unresolved.id, command.id);
    assert.ok(esp32Url.startsWith('http://127.0.0.1:'));
});

test('คำสั่งค้างอยู่ในไฟล์ ไม่ใช่ในหน่วยความจำ: controller ตัวใหม่บนฐานข้อมูลเดิมยังกั้นอยู่', async t => {
    // นี่คือสิ่งที่สถานะบนหน้าจอทำไม่ได้: รีโหลดหน้า จบ session หรือรีสตาร์ทโพรเซสแล้วยังกั้น
    const { controller, database, esp32Url, requests } = await fixture(t, url =>
        url.pathname === '/status' ? ready : pending, { timeoutMs: 120 });
    await controller.command(command);
    const before = requests.filter(u => u.pathname === '/open').length;
    assert.equal(before, 1);

    const restarted = new LocalController({ esp32Url, database, timeoutMs: 120, mode: 'real' });
    t.after(() => restarted.close());
    assert.equal(restarted.unresolved().id, command.id);
    const refused = await restarted.command({ ...command, id: 'c-after-restart-01' });
    assert.equal(refused.status, 409);
    assert.equal(requests.filter(u => u.pathname === '/open').length, before);
});

test('เคลียร์ด้วย edge/resolve.mjs ตัวจริงแล้ว เปิดช่องใหม่ได้อีกครั้ง และประวัติยังอยู่ครบ', async t => {
    // spawn/fileURLToPath ใช้ที่เทสนี้ที่เดียว เลย import แบบ dynamic ตามแบบเทส /kiosk ข้างล่าง
    const { execFile } = await import('node:child_process');
    const { fileURLToPath } = await import('node:url');
    const cliPath = fileURLToPath(new URL('../edge/resolve.mjs', import.meta.url));

    let acknowledging = false;
    const fresh = { ...command, id: 'c-after-resolve-01' };
    const { controller, database, requests } = await fixture(t, url => {
        if (url.pathname === '/status') return ready;
        return acknowledging ? [200, ack(fresh)] : pending;
    }, { timeoutMs: 150 });
    await controller.command(command);
    assert.equal(controller.unresolved().id, command.id);
    assert.equal((await controller.command(fresh)).status, 409, 'ต้องถูกกั้นอยู่ก่อนเคลียร์');
    assert.equal(requests.filter(u => u.pathname === '/open').length, 1);

    const cli = args => new Promise(resolve => execFile(process.execPath, [cliPath, ...args],
        { env: { ...process.env, SFAB_DATABASE: database } },
        (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr })));

    const listed = await cli(['--list']);
    assert.equal(listed.code, 0, listed.stderr);
    assert.match(listed.stdout, new RegExp(command.id));
    const cleared = await cli(['--check-cabinet', command.id]);
    assert.equal(cleared.code, 0, cleared.stderr);

    assert.equal(controller.unresolved(), null);
    acknowledging = true;
    assert.equal((await controller.command(fresh)).body.success, true);
    assert.equal(requests.filter(u => u.pathname === '/open').length, 2);
    // ใบเดิมถูกเปลี่ยนสถานะ ไม่ได้ถูกลบ — สมุดคำสั่งเป็นประวัติ ไม่ใช่คิวงาน
    assert.equal(controller.history().find(row => row.id === command.id).state, 'resolved_by_operator');
    assert.equal((await cli(['--check-cabinet', command.id])).code, 1, 'ใบที่เคลียร์แล้วต้องเคลียร์ซ้ำไม่ได้');
});

test('local HTTP adapter executes real analyze and notify handlers with no provider credentials', async t => {
    const keys = ['LINE_NOTIFY_TOKEN', 'LINE_TOKEN', 'Line Token', 'LINE_CHANNEL_ACCESS_TOKEN',
        'GEMINI_API_KEY', 'GEMINI_KEY', 'Gemini Key'];
    const saved = new Map(keys.map(k => [k, process.env[k]]));
    keys.forEach(k => delete process.env[k]);
    t.after(() => saved.forEach((value, key) => { if (value !== undefined) process.env[key] = value; }));
    const { controller } = await fixture(t, () => ready);
    const server = await createLocalServer({ controller, mode: 'real' });
    const origin = await listen(server);
    t.after(() => close(server));
    for (const [path, body, expected] of [['notify', { message: 'synthetic test' }, 'LINE_CHANNEL_ACCESS_TOKEN'],
        ['analyze', { image: 'synthetic test' }, 'ระบบ AI วิเคราะห์แผลขัดข้อง']]) {
        const response = await fetch(`${origin}/api/${path}`, { method: 'POST',
            headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        assert.equal(response.status, 500);
        const result = await response.json();
        assert.equal(result.success, false);
        assert.ok(result.error.includes(expected));
        assert.notEqual(result.error, 'Local service error');
    }
});

test('local server serves all kiosk routes, suppresses MQTT, and protects source and command origins', async t => {
    const { controller } = await fixture(t, url => url.pathname === '/status' ? ready : [200, ack(command)]);
    const server = await createLocalServer({ controller, mode: 'real' });
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
    // modeProvisionedAt = ครูเลือกโหมดไว้แล้ว ถ้าไม่มีตราประทับนี้ demoMode:false ยังแปลว่า
    // "ยังไม่ตั้งโหมด" ไม่ใช่ "โหมดจริง" และ openCompartment จะตอบ unprovisioned ตั้งแต่ยังไม่ถึง transport
    const settings = { demoMode: false, modeProvisionedAt: '2026-09-11T09:00:00.000Z',
        esp32Url: 'http://must-not-contact.invalid', mqttWsUrl: 'wss://must-not-contact.invalid' };
    const window = { SFAB_RUNTIME: { transport: 'pi-local', mode: 'real' }, StorageService: { getSettings: () => settings } };
    const context = vm.createContext({ window, console, AbortController, setTimeout, clearTimeout, Map, Set,
        fetch: async (url, opts) => {
            if (url === '/api/local/status') return { ok: true, json: async () => ({ commandTimeoutMs: 33000 }) };
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
    window.SFAB_RUNTIME.mode = 'demo';
    assert.equal((await window.ApiBridge.openCompartment('cut')).mode, 'simulation');
    assert.equal(calls, 2);

    // โปรไฟล์ที่ยังไม่มีใครเลือกโหมด (ไม่มีตราประทับ) — demoMode:true ที่ติดมากับค่าเริ่มต้นเก่า
    // แยกไม่ออกจากการที่ครูตั้งใจเลือก จึงต้องไม่ถูกนับเป็นโหมดสาธิต และต้องไม่สั่งจริงด้วย
    window.SFAB_RUNTIME.mode = 'unset';
    for (const demoMode of [true, false]) {
        settings.demoMode = demoMode;
        const blocked = await window.ApiBridge.openCompartment('cut');
        assert.equal(blocked.mode, 'unprovisioned', `demoMode=${demoMode}`);
        assert.equal(blocked.success, false);
        assert.equal(blocked.retrySafe, true);   // ไม่ได้ส่งอะไรออกไป ตั้งโหมดแล้วกดใหม่ได้
        assert.equal(calls, 2, 'โหมดที่ยังไม่ได้ตั้ง ต้องหยุดก่อนแตะเครือข่าย');
    }
});

test('browser status failure is safe to retry and command requests use a separate abort signal', async () => {
    const source = await readFile(new URL('../js/api-bridge.js', import.meta.url), 'utf8');
    for (const state of ['unconfigured', 'expired-status', 'ready']) {
        const signals = [];
        const timers = [];
        const window = { SFAB_RUNTIME: { transport: 'pi-local' } };
        const context = vm.createContext({ window, console, AbortController,
            setTimeout: fn => { timers.push(fn); return timers.length; }, clearTimeout() {},
            fetch: async (url, options) => {
                signals.push(options.signal);
                if (url === '/api/local/status') return { ok: true, json: async () => {
                    if (state === 'expired-status') timers[0]();
                    return state === 'unconfigured' ? {} : { commandTimeoutMs: 33000 };
                } };
                assert.notEqual(options.signal, signals[0]);
                assert.equal(options.signal.aborted, false);
                return { ok: true, json: async () => ({ success: true, mode: 'pi-local', ack: ack(command) }) };
            } });
        vm.runInContext(source, context);
        const result = await window.ApiBridge.sendLocalCommand(command);
        assert.equal(result.success, state === 'ready');
        if (state !== 'ready') {
            assert.equal(result.retrySafe, true);
            assert.equal(signals.length, 1);
            assert.ok(!result.error.includes('ห้ามสั่งจ่ายซ้ำ'));
        }
    }
});

test('หน้าตู้ /kiosk ขึ้นครบทั้งหน้าแบบออฟไลน์ และ allowlist ที่กว้างขึ้นไม่ได้เปิดทางออกนอก web root', async t => {
    // readdir อยู่ในเทสนี้ที่เดียว เลย import แบบ dynamic แทนที่จะไปแก้บรรทัด import ด้านบนของไฟล์
    const { readdir } = await import('node:fs/promises');
    const { controller } = await fixture(t, url => url.pathname === '/status' ? ready : [200, ack(command)]);
    const server = await createLocalServer({ controller, mode: 'real' });
    await listen(server);
    t.after(() => close(server));

    // ต้องยิงด้วย node:http ตรงๆ ไม่ใช่ fetch(): fetch ย่อ `..` ทิ้งตั้งแต่ตอนแปลง URL ก่อนส่ง
    // (`/kiosk/../.env` ออกจาก fetch เป็น `/.env`) เซิร์ฟเวอร์จึงไม่เคยเห็น path ดิบที่เราตั้งใจทดสอบ
    const raw = path => new Promise((resolve, reject) => {
        const req = httpRequest({ hostname: '127.0.0.1', port: server.address().port, path, method: 'GET' }, res => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'],
                body: Buffer.concat(chunks).toString() }));
        });
        req.on('error', reject);
        req.end();
    });

    // 1. ทั้งสองรูปของเส้นทางเดียวกัน: /kiosk มาจาก rewrite ใน vercel.json ส่วน /kiosk/ มาจากกฎ
    //    route.endsWith('/') ใน server.mjs — ตัวหลังไม่มีใน vercel.json ลูปของเทสเดิมจึงมองไม่เห็น
    for (const route of ['/kiosk', '/kiosk/']) {
        const page = await raw(route);
        assert.equal(page.status, 200, route);
        assert.equal(page.type, 'text/html; charset=utf-8', route);
        // ตรวจ "ความหมายตอนรัน" ไม่ใช่รูปร่างของสตริง — รัน bootstrap จริงแล้วดูอ็อบเจ็กต์ที่ได้
        // เทสเดิมเทียบสตริงดิบ ⇒ การเพิ่มฟิลด์ใหม่ที่ถูกต้องก็ทำให้แดง และการเรียงคำที่ต่างออกไป
        // ก็ทำให้แดงทั้งที่พฤติกรรมเหมือนเดิม (นัยติงไว้ใน R3)
        // สิ่งที่ยังต้องยืนยัน: bootstrap อยู่ติดกับ <head> พอดี = kiosk/index.html ยังเป็น <head>
        // เปล่าไม่มี attribute · server.mjs แทนที่ /<head>/i เท่านั้น ถ้าใครเขียน <head lang="th">
        // มันจะไม่ฉีดอะไรเลยแบบเงียบๆ แล้วหน้าตู้จะหล่นไปใช้ transport ของคลาวด์โดยไม่มีใครรู้
        const boot = page.body.match(/<head><script>([\s\S]*?)<\/script>/);
        assert.ok(boot, `${route} ไม่มี bootstrap ต่อท้าย <head> พอดี — สงสัยว่า <head> มี attribute`);
        const runtime = runBootstrap(boot[1]);
        assert.equal(runtime.transport, 'pi-local', route);
        assert.equal(runtime.mode, 'real', `${route} ต้องประกาศโหมดของเครื่อง`);
    }
    const html = (await raw('/kiosk')).body;

    // 2. ห้ามพึ่ง CDN/Google Fonts — ตู้ต้องขึ้นได้ตอนเน็ตโรงเรียนล่ม
    //    เช็คเฉพาะชื่อโฮสต์ ไม่เช็ค https:// ลอยๆ เพราะ inline SVG มี xmlns=http://www.w3.org/2000/svg ได้
    const HOSTS = ['cdn.jsdelivr.net', 'unpkg.com', 'cdnjs.cloudflare.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];
    const externals = text => HOSTS.filter(host => text.includes(host));
    // control: ตัวตรวจต้องจับของปลอมได้จริง ผลว่างจะได้ไม่ใช่เพราะตัวตรวจพัง
    assert.deepEqual(externals('<script src="https://cdn.jsdelivr.net/npm/mqtt@5.15.2/dist/mqtt.min.js"></script>'),
        ['cdn.jsdelivr.net']);
    assert.deepEqual(externals(html), [], 'HTML ของหน้าตู้อ้างโฮสต์ภายนอก');

    // 3. ไฟล์ประกอบทุกตัวที่หน้าตู้เรียกจริง ต้องเสิร์ฟได้จาก Pi — อ่านรายการจาก HTML ที่เสิร์ฟออกมา ไม่ใช่เดา
    const assets = [...new Set([...html.matchAll(/(?:src|href)="(\.\.\/[^"]+)"/g)]
        .map(match => new URL(match[1], 'http://pi/kiosk/').pathname))];
    for (const required of ['/css/kiosk.css', '/js/kiosk-session.js', '/js/kiosk-app.js']) {
        assert.ok(assets.includes(required), `/kiosk ไม่ได้เรียก ${required}`);
    }
    const served = new Map();
    for (const path of assets) {
        const asset = await raw(path);
        assert.equal(asset.status, 200, `Pi เสิร์ฟ ${path} ไม่ได้`);
        served.set(path, asset.body);
    }
    assert.deepEqual(externals([...served.values()].join('\n')), [], 'ไฟล์ประกอบอ้างโฮสต์ภายนอก');

    // 4. ฟอนต์ self-hosted: ชื่อไฟล์จริงมาจากไดเรกทอรี fonts/ เทียบกับที่ @font-face เรียก แล้วต้องเสิร์ฟได้
    const onDisk = (await readdir(new URL('../fonts/', import.meta.url))).filter(name => name.endsWith('.woff2'));
    assert.ok(onDisk.length > 0, 'fonts/ ไม่มีไฟล์ .woff2 เลย');
    const wanted = [...new Set([...served.get('/css/kiosk.css').matchAll(/url\(['"]?([^'")]+\.woff2)['"]?\)/g)]
        .map(match => new URL(match[1], 'http://pi/css/').pathname))];
    assert.ok(wanted.length > 0, 'css/kiosk.css ไม่มี @font-face ที่ชี้ไฟล์ในเครื่อง');
    for (const path of wanted) {
        assert.ok(onDisk.includes(path.slice('/fonts/'.length)), `${path} ที่ CSS เรียก ไม่มีอยู่จริงใน fonts/`);
        const font = await raw(path);
        assert.equal(font.status, 200, path);
        assert.equal(font.type, 'font/woff2', path);
    }

    // 5. เติม kiosk ลง allowlist แล้วต้องไม่มีทางออกนอก web root
    //    control ก่อน: ตัวยิง raw ต้องได้ 200 กับ path ที่ดี ไม่งั้น 404 ทุกอันข้างล่างไม่ได้พิสูจน์อะไร
    assert.equal((await raw('/kiosk')).status, 200, 'control พัง — raw() ยิงไม่ถึงเซิร์ฟเวอร์');
    for (const path of ['/kiosk/../.env', '/kiosk/../../etc/passwd', '/kiosk/../edge/server.mjs',
        '/kiosk/../package.json', '/kiosk/..%2f.env', '/kiosk/..%2f..%2fetc/passwd',
        '/kiosk/..%2fdashboard/index.html', '/kiosk/sub/page.html', '/kiosk/index.js']) {
        assert.equal((await raw(path)).status, 404, path);
    }
    // ⚠️ /kiosk/../dashboard/index.html ไม่ใช่ 404 และไม่ควรคาดหวังให้เป็น: ทั้ง fetch() และ
    //    new URL() ใน server.mjs ย่อ `..` ทิ้งก่อนถึง allowlist มันจึงเหลือ /dashboard/index.html
    //    ซึ่งเป็นหน้าสาธารณะอยู่แล้ว สิ่งที่ต้องยืนยันคือ "ไม่ได้ของใหม่" ไม่ใช่สถานะ 404
    //    (รูปที่ย่อไม่ได้ คือ ..%2f ข้างบน ถูกปิดตายไปแล้ว)
    const collapsed = await raw('/kiosk/../dashboard/index.html');
    const dashboard = await raw('/dashboard');
    assert.equal(collapsed.status, 200);
    assert.equal(dashboard.status, 200);
    assert.equal(collapsed.body, dashboard.body, 'path ที่ถูกย่อ อ่านไฟล์คนละตัวกับหน้า dashboard ปกติ');
});

// ── เกตโหมดที่ขอบการสั่งจริง ─────────────────────────────────────────────
// R3-2: เดิมโหมดถูกบังคับใช้ฝั่งเบราว์เซอร์อย่างเดียว เซิร์ฟเวอร์ไม่เคยเห็นมัน
// ⇒ POST ตรงในโหมด demo/unset ยังสั่งมอเตอร์จริงได้และคืน ACK เหมือนของจริง
// เทสนี้จึงนับ "จำนวนครั้งที่ ESP32 ถูกเรียก" เป็นหลัก ไม่ใช่ดูแค่ค่าที่คืนกลับมา
test('เกตโหมดอยู่ที่เซิร์ฟเวอร์: เฉพาะ real เท่านั้นที่ถึงฮาร์ดแวร์ได้ demo/unset ต้องไม่มี /open สักครั้ง', async t => {
    for (const [mode, expectedOpens] of [['real', 1], ['demo', 0], ['unset', 0], ['typo', 0], ['', 0]]) {
        const id = `c-mode-${mode || 'empty'}-0001`;
        const { controller, requests } = await fixture(t, url => url.pathname === '/status' ? ready
            : [200, { success: true, protocol: 2, event: 'drawer_opened',
                id: url.searchParams.get('id'), drawer: Number(url.searchParams.get('drawer')) }], { mode });
        const result = await controller.command({ ...command, id });
        const opens = requests.filter(u => u.pathname === '/open').length;

        assert.equal(opens, expectedOpens, `mode=${mode} ยิง /open ${opens} ครั้ง ควรเป็น ${expectedOpens}`);
        if (expectedOpens === 0) {
            assert.equal(result.status, 503, `mode=${mode} ต้องปฏิเสธด้วย 503`);
            assert.equal(result.body.success, false);
            // ยังไม่ได้ส่งอะไรออกไป ⇒ ลองใหม่ได้หลังตั้งโหมด
            assert.equal(result.body.retrySafe, true, `mode=${mode} ต้อง retrySafe`);
            assert.ok(!result.body.ack, `mode=${mode} ต้องไม่คืน ACK ของฮาร์ดแวร์`);
            // ถูกปฏิเสธก่อนแตะสมุด ⇒ ไม่ทิ้งแถวไว้ให้กลายเป็นคำสั่งค้าง
            assert.equal(controller.history().length, 0, `mode=${mode} ต้องไม่เขียนสมุดคำสั่ง`);
            assert.equal(controller.unresolved(), null, `mode=${mode} ต้องไม่สร้าง hold`);
        } else {
            assert.equal(result.body.success, true, 'mode=real ต้องผ่านและได้ ACK');
        }
    }
});

test('P11: local buzzer remains available in demo and unset while opening stays gated', async t => {
    for (const mode of ['demo', 'unset']) {
        const { controller, requests } = await fixture(t,
            url => url.pathname === '/status' ? ready : [200, { success: true, protocol: 2,
                event: 'buzzer_set', id: `c-buzz-${mode}-01`, state: 'on' }], { mode });
        const result = await controller.command({ action: 'buzzer', state: 'on', id: `c-buzz-${mode}-01` });
        assert.equal(requests.filter(u => u.pathname === '/buzzer').length, 1, `mode=${mode}`);
        assert.equal(result.status, 200);
        assert.equal(result.body.ack.event, 'buzzer_set');
        assert.equal((await controller.command(command)).status, 503);
        assert.equal(requests.filter(u => u.pathname === '/open').length, 0);
    }
});

test('หน้าเว็บที่โหลดค้างไว้ตอน real ยิงไม่ผ่านหลังผู้ดูแลสลับเป็น demo', async t => {
    // จำลอง client เก่า: id ใหม่ทุกครั้ง ยิงเข้าเซิร์ฟเวอร์ตัวที่โหมดถูกสลับแล้ว
    // เซิร์ฟเวอร์ไม่ได้ดูว่าใครยิงมา ดูแต่โหมดของเครื่องตัวเอง ซึ่งเป็นประเด็นทั้งหมด
    const dir = await mkdtemp(join(tmpdir(), 'sfab-stale-'));
    const requests = [];
    const esp = createServer((req, res) => {
        const url = new URL(req.url, 'http://device');
        requests.push(url);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (url.pathname === '/status') return res.end(JSON.stringify(ready[1]));
        // สะท้อน id ที่ขอมาจริง ไม่งั้น ACK ไม่ตรงแล้วเทสจะไปค้างรอ timeout
        res.end(JSON.stringify({ success: true, protocol: 2, event: 'drawer_opened',
            id: url.searchParams.get('id'), drawer: Number(url.searchParams.get('drawer')) }));
    });
    const esp32Url = await listen(esp);
    const database = join(dir, 'c.sqlite');
    let realCtl, demoCtl;
    // ทำความสะอาดต้องลงทะเบียนก่อน assert ตัวแรก ไม่งั้น assert ที่ล้มจะทิ้ง handle ค้างไว้
    // แล้ว node --test จะแขวนแทนที่จะรายงานว่าเทสตก (เจอมาแล้วตอนเขียนเทสนี้)
    t.after(async () => {
        await realCtl?.close(); await demoCtl?.close();
        await close(esp); await rm(dir, { recursive: true });
    });

    realCtl = new LocalController({ esp32Url, database, timeoutMs: 1000, pollMs: 5, mode: 'real' });
    const first = await realCtl.command({ ...command, id: 'c-stale-real-0001' });
    assert.equal(first.body.success, true, 'ตอนเป็น real ต้องผ่าน');
    const opensAfterReal = requests.filter(u => u.pathname === '/open').length;
    assert.equal(opensAfterReal, 1);
    await realCtl.close(); realCtl = null;

    // ผู้ดูแลสลับเป็น demo แล้วบริการรีสตาร์ท — ฐานข้อมูลเดิม โหมดใหม่
    demoCtl = new LocalController({ esp32Url, database, timeoutMs: 1000, pollMs: 5, mode: 'demo' });
    const second = await demoCtl.command({ ...command, id: 'c-stale-demo-0002' });
    assert.equal(second.status, 503, 'หลังสลับเป็น demo ต้องปฏิเสธ');
    assert.equal(requests.filter(u => u.pathname === '/open').length, opensAfterReal,
        'ต้องไม่มี /open เพิ่มหลังสลับโหมด');
    assert.equal(demoCtl.history().length, 1, 'ประวัติคำสั่งเดิมต้องยังอยู่');
});

test('หน้าที่เสิร์ฟประกาศโหมดของเครื่องเสมอ ทั้งสามค่า และค่าที่ไม่รู้จักกลายเป็น unset', async t => {
    for (const [configured, expected] of [['real', 'real'], ['demo', 'demo'], ['', 'unset'],
                                          ['typo', 'unset'], ['</script><script>x', 'unset']]) {
        const { controller } = await fixture(t, url => url.pathname === '/status' ? ready : [200, ack(command)]);
        const server = await createLocalServer({ controller, mode: configured });
        t.after(() => close(server));
        const origin = await listen(server);
        const html = await (await fetch(origin + '/kiosk')).text();
        // ตรวจความหมายตอนรัน ไม่ใช่เทียบสตริงดิบ — รัน bootstrap จริงแล้วดูอ็อบเจ็กต์ที่ได้
        const bootstrap = html.match(/<script>([\s\S]*?)<\/script>/)[1];
        assert.deepEqual(runBootstrap(bootstrap), { transport: 'pi-local', mode: expected },
            `SFAB_MODE=${JSON.stringify(configured)}`);
        // ค่าที่เป็นอันตรายต้องไม่หลุดออกมาในหน้าเลย
        assert.ok(!html.includes('<script>x'), 'ค่าที่ไม่รู้จักต้องไม่ถูกเขียนลงหน้า');
    }
});
