import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { LocalController } from '../edge/controller.mjs';
import { createLocalServer } from '../edge/server.mjs';
import { authenticateCabinet, signedHeaders } from '../lib/cabinet-protocol.js';

const secret = 'synthetic-cabinet-secret-not-for-production';
const env = { SFAB_CABINET_SECRET: secret, SFAB_CABINET_ID: 'box1' };
export function fakeSerial() {
    let opens = 0;
    return { device: 'synthetic', get opens() { return opens; }, async close() {}, async request(path) {
        const url = new URL(path, 'http://device');
        if (url.pathname === '/status') return { status: 200, data: { protocol: 2, microbit: 'connected', ready: true, ackTimeoutMs: 3000 } };
        if (url.pathname === '/open') opens++;
        return { status: 200, data: { success: true, protocol: 2, id: url.searchParams.get('id'),
            ...(url.pathname === '/open' ? { event: 'drawer_opened', drawer: Number(url.searchParams.get('drawer')) } : { event: 'buzzer_set', state: 'on' }) } };
    } };
}
test('HMAC binds method, endpoint, cabinet and exact bytes; rejects stale/future and absent secrets', () => {
    const now = Date.now(), body = '{"events":[]}';
    const req = { method: 'POST', headers: signedHeaders(secret, 'POST', '/api/ingest', 'box1', body, now) };
    assert.equal(authenticateCabinet(req, body, '/api/ingest', env, now).cabinetId, 'box1');
    for (const [request, raw, path, time] of [[req, body+' ', '/api/ingest', now], [req, body, '/api/sync', now],
        [{ ...req, method: 'GET' }, body, '/api/ingest', now], [req, body, '/api/ingest', now+30001],
        [req, body, '/api/ingest', now-2001], [{ ...req, headers: { ...req.headers, 'x-sfab-cabinet': 'box2' } }, body, '/api/ingest', now]]) {
        assert.throws(() => authenticateCabinet(request, raw, path, env, time), { status: 401 });
    }
    assert.throws(() => authenticateCabinet(req, body, '/api/ingest', {}, now), { status: 503 });
});
test('journal completion and outbox insertion roll back together on a write failure', async () => {
    const controller = new LocalController({ database: ':memory:', mode: 'real' });
    controller.db.prepare("INSERT INTO commands (id,drawer,state,created_at) VALUES ('atomic-command',1,'pending',?)").run(new Date().toISOString());
    controller.db.exec("CREATE TRIGGER fail_outbox BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT, 'synthetic outbox failure'); END;");
    assert.throws(() => controller.finish({id:'atomic-command'}, {body:{success:true}}, 'confirmed'), /synthetic outbox failure/);
    assert.equal(controller.history()[0].state, 'pending');
    assert.equal(controller.outbox.pending().length, 0);
    await controller.close();
});
test('restart retains outbox IDs; old journal backfill is idempotent and suppresses historical LINE', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sfab-wp2-'));
    const database = join(dir, 'commands.sqlite');
    const legacy = new DatabaseSync(database);
    legacy.exec("CREATE TABLE commands (id TEXT PRIMARY KEY, drawer INTEGER, state TEXT, created_at TEXT, confirmed_at TEXT, response TEXT)");
    legacy.prepare("INSERT INTO commands (id,drawer,state,created_at) VALUES ('old-command-001',2,'confirmed',?)").run(new Date().toISOString());
    legacy.close();
    let controller = new LocalController({ database, mode: 'real', serial: fakeSerial() });
    await controller.command({ id: 'restart-command', action: 'open', drawer: 1 });
    const before = controller.outbox.pending();
    await controller.close();
    controller = new LocalController({ database, mode: 'real', serial: fakeSerial() });
    assert.deepEqual(controller.outbox.pending()[0], before[0]);
    assert.equal(controller.outbox.pending().length, 2);
    assert.equal(controller.outbox.pending()[0].historical, true);
    assert.equal(controller.outbox.pending()[1].historical, false);
    await controller.command({ id: 'restart-command', action: 'open', drawer: 1 });
    assert.equal(controller.serial.opens, 0);
    await controller.close();
});
test('local SOS is durably queued in unset mode with no hardware, network or LINE credentials', async () => {
    const controller = new LocalController({ database: ':memory:', mode: 'unset' });
    const server = await createLocalServer({ controller, mode: 'unset' });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    try {
        for (let i = 0; i < 2; i++) {
            const response = await fetch(url+'/api/notify', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ event: 'sos', eventId: 'offline-sos-0001', name: 'must not persist' }) });
            assert.equal(response.status, 202);
            const data = await response.json(); assert.equal(data.mode, 'queued'); assert.equal(data.lineDelivered, false);
        }
        assert.equal(controller.outbox.pending().length, 1);
        assert.equal(controller.outbox.pending()[0].uid, null);
        assert.equal(JSON.stringify(controller.outbox.pending()).includes('must not persist'), false);
    } finally { await new Promise(resolve => server.close(resolve)); await controller.close(); }
});

test('a crash after upgrade queues an uncertain event for LINE and never opens again', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sfab-wp2-crash-'));
    const database = join(dir,'commands.sqlite');
    let controller = new LocalController({database,mode:'real',serial:fakeSerial()});
    controller.db.prepare("INSERT INTO commands (id,drawer,state,created_at) VALUES ('crash-new-command',1,'pending',?)").run(new Date().toISOString());
    await controller.close();
    controller = new LocalController({database,mode:'real',serial:fakeSerial()});
    const row = controller.outbox.pending()[0];
    assert.equal(row.uncertain,true); assert.equal(row.historical,false);
    assert.equal((await controller.command({id:'crash-new-command',drawer:1,action:'open'})).status,409);
    assert.equal(controller.serial.opens,0);
    await controller.close();
});
test('SOS IDs cannot be reused to actuate a drawer, and stored delivery retries do not starve new events', async () => {
    const controller = new LocalController({database:':memory:',mode:'real',serial:fakeSerial()});
    controller.outbox.queueSos('collision-sos-001');
    assert.equal((await controller.command({id:'collision-sos-001',drawer:1,action:'open'})).status,409);
    assert.equal(controller.serial.opens,0);
    controller.outbox.acknowledge([{id:'collision-sos-001',stored:true,line:'pending'}]);
    controller.outbox.queueSos('fresh-sos-event');
    assert.deepEqual(controller.outbox.pending().map(row=>row.id),['fresh-sos-event']);
    assert.equal(controller.outbox.pending(20,Date.now()+61000).length,2);
    await controller.close();
});
