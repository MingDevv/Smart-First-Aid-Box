import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { firebaseServices } from '../lib/firebase-admin.js';
import { createIngestHandler } from '../api/ingest.js';
import { createSyncHandler } from '../api/sync.js';
import { createHistoryHandler } from '../api/history.js';
import { LocalController } from '../edge/controller.mjs';
import { CabinetSync } from '../edge/sync.mjs';
import { signedHeaders } from '../lib/cabinet-protocol.js';
import { RETRY_HORIZON_MS, pushLine } from '../lib/cabinet-line.js';

const secret = 'synthetic-cabinet-secret-not-for-production';
const env = { SFAB_CABINET_SECRET: secret, SFAB_CABINET_ID: 'syncbox',
    LINE_CHANNEL_ACCESS_TOKEN: 'synthetic-never-sent', LINE_GROUP_ID: 'synthetic-room' };
let db, auth;
before(() => { ({ db, auth } = firebaseServices()); });
after(() => db.terminate());
const heartbeat = { mode: 'real', clockTrust: 'untrusted', unresolved: null };
function event(id, patch = {}) { return { id, kind: 'dispense', cabinetId: 'syncbox', uid: null, ts: new Date().toISOString(),
    historical: false, clockTrust: 'untrusted', drawer: 1, badgeId: null, verifiedBy: 'unidentified',
    woundType: 'cut_abrasion', itemsUsed: [], ack: 'confirmed', uncertain: false, ...patch }; }
async function invoke(handler, { method = 'POST', body = '', headers = {}, url } = {}) {
    let status = 200, result = '', responseHeaders = new Headers();
    await handler({ method, headers, body, url }, { setHeader(key, value) { responseHeaders.set(key, value); },
        status(code) { status = code; return this; }, end(value = '') { result = value; return this; },
        json(value) { result = JSON.stringify(value); return this; } });
    return new Response(status === 304 ? null : result, { status, headers: responseHeaders });
}
async function ingest(handler, events, now = Date.now()) {
    const body = JSON.stringify({ events, heartbeat });
    return invoke(handler, { body, headers: signedHeaders(secret, 'POST', '/api/ingest', 'syncbox', body, now) });
}
function serial() {
    let opens = 0;
    return { device: 'synthetic', get opens() { return opens; }, async close() {}, async request(path) {
        const url = new URL(path, 'http://device');
        if (url.pathname === '/status') return { status: 200, data: { protocol: 2, microbit: 'connected', ready: true, ackTimeoutMs: 3000 } };
        opens++;
        return { status: 200, data: { success: true, protocol: 2, event: 'drawer_opened',
            id: url.searchParams.get('id'), drawer: Number(url.searchParams.get('drawer')) } };
    } };
}
test('offline twice, reconnect, lose ingest response, restart: exactly two Firestore rows and LINE acceptances', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sfab-emulator-sync-'));
    const database = join(dir, 'commands.sqlite');
    const accepted = new Set(); let pushes = 0, online = false, loseReply = true;
    const handler = createIngestHandler({ env, send: async (_payload, key) => { pushes++; accepted.add(key); return true; } });
    const syncHandler = createSyncHandler({ env });
    const transport = async (url, options) => {
        if (!online) throw new Error('synthetic LAN unplugged');
        const path = new URL(url).pathname;
        const headers = Object.fromEntries(new Headers(options.headers));
        if (path === '/api/ingest') assert.equal(headers['content-type'], 'application/octet-stream');
        const response = await invoke(path === '/api/ingest' ? handler : syncHandler,
            { ...options, headers, body: Buffer.from(options.body || '') });
        if (path === '/api/ingest' && loseReply) { loseReply = false; throw new Error('synthetic lost HTTP response after commit'); }
        return response;
    };
    let controller = new LocalController({ database, serial: serial(), mode: 'real', cabinetId: 'syncbox' });
    let worker = new CabinetSync({ controller, origin: 'https://synthetic.invalid', cabinetId: 'syncbox', secret, fetchImpl: transport });
    await assert.rejects(worker.run(), /LAN unplugged/);
    for (const [id, drawer] of [['offline-first', 1], ['offline-second', 2]]) {
        assert.equal((await controller.command({ action: 'open', id, drawer })).status, 200);
    }
    assert.equal(controller.serial.opens, 2); assert.equal(controller.outbox.pending().length, 2);
    online = true;
    await assert.rejects(worker.run(), /lost HTTP response/);
    assert.equal(controller.outbox.pending().length, 2);
    await controller.close();
    controller = new LocalController({ database, serial: serial(), mode: 'real', cabinetId: 'syncbox' });
    worker = new CabinetSync({ controller, origin: 'https://synthetic.invalid', cabinetId: 'syncbox', secret, fetchImpl: transport });
    await worker.run(); await worker.run();
    assert.equal(controller.outbox.pending().length, 0);
    assert.equal(controller.serial.opens, 0, 'sync never replays an actuator command');
    const rows = await db.collection('dispenses').where('cabinetId', '==', 'syncbox').get();
    assert.equal(rows.size, 2); assert.equal(pushes, 2); assert.equal(accepted.size, 2);
    assert.equal(controller.outbox.cache().cabinetId, 'syncbox');
    await controller.close();
});
test('LINE timeout after acceptance retries the same key, including concurrent requests', async () => {
    const delivered = new Set(), keys = []; let loseFirst = true;
    const handler = createIngestHandler({ env, send: async (_payload, key) => {
        keys.push(key); delivered.add(key);
        if (loseFirst) { loseFirst = false; return false; }
        return true;
    } });
    const row = event('line-response-lost');
    const first = await ingest(handler, [row]); assert.equal(first.status, 200);
    assert.equal((await first.json()).acks[0].line, 'pending');
    const replies = await Promise.all([ingest(handler, [row]), ingest(handler, [row]), ingest(handler, [row])]);
    for (const response of replies) assert.equal(response.status, 200);
    assert.equal(delivered.size, 1); assert.equal(new Set(keys).size, 1);
    assert.equal((await db.doc('dispenses/syncbox~line-response-lost').get()).data().lineDelivered, true);
});
test('retry horizon stops ambiguous LINE resend; 409 only succeeds with accepted request evidence', async () => {
    let time = Date.now(), sends = 0;
    const handler = createIngestHandler({ env, now: () => time, send: async () => { sends++; return false; } });
    const row = event('line-old-uncertain');
    await ingest(handler, [row], time);
    time += RETRY_HORIZON_MS + 1;
    const response = await ingest(handler, [row], time);
    assert.equal((await response.json()).acks[0].line, 'manual_review'); assert.equal(sends, 1);
    for (const [headers, expected] of [[{}, false], [{ 'x-line-accepted-request-id': 'synthetic' }, true]]) {
        assert.equal(await pushLine({}, 'synthetic', env, async () => new Response('', {status:409,headers})), expected);
    }
});
test('changed payload, cross-kind ID reuse, bad HMAC, forged identity and oversize input never write', async () => {
    const handler = createIngestHandler({ env, send: async () => true });
    const row = event('immutable-event');
    assert.equal((await ingest(handler, [row])).status, 200);
    assert.equal((await ingest(handler, [{...row, drawer:2, woundType:'insect'}])).status, 409);
    assert.equal((await ingest(handler, [event(row.id, {kind:'sos',buzzerAck:null})])).status, 409);
    assert.equal((await ingest(handler, [event('forged-identity', {uid:'real-user'})])).status, 400);
    const raw = JSON.stringify({events:[event('bad-hmac-event')],heartbeat});
    const headers = signedHeaders(secret, 'POST', '/api/ingest', 'syncbox', raw);
    assert.equal((await invoke(handler, { body: raw+' ', headers })).status, 401);
    assert.equal((await invoke(handler, { body: 'x'.repeat(65537), headers })).status, 413);
    assert.equal((await db.doc('dispenses/syncbox~bad-hmac-event').get()).exists, false);
    assert.equal((await db.doc('dispenses/syncbox~forged-identity').get()).exists, false);
});
test('signed sync is cabinet-scoped, caches clear state and stock, and does not leak roster/private fields', async () => {
    await db.doc('inventory/syncbox').set({ counts:{drawer1:7,drawer2:2},targets:{drawer1:10,drawer2:5},privateNote:'never disclose' });
    await db.doc('cabinets/syncbox').set({ clearRequests:[{commandId:'held-command-001',decisionId:'decision-001',checkedBy:'teacher',checkedAt:new Date().toISOString(),secret:'hidden'}], roster:['hidden'] },{merge:true});
    const handler = createSyncHandler({ env });
    const headers = signedHeaders(secret, 'GET', '/api/sync', 'syncbox');
    const response = await invoke(handler, {method:'GET',headers});
    const bundle = await response.json();
    assert.equal(bundle.inventory.counts.drawer1, 7); assert.equal(bundle.clearing.length,1);
    assert.equal(JSON.stringify(bundle).includes('hidden'),false);
    assert.equal(JSON.stringify(bundle).includes('never disclose'),false);
    const cached = await invoke(handler, {method:'GET',headers:{...headers,'if-none-match':response.headers.get('etag')}});
    assert.equal(cached.status,304); assert.ok(cached.headers.get('x-sfab-signature'));
    const controller = new LocalController({database:':memory:',cabinetId:'syncbox'});
    const worker = new CabinetSync({controller,secret,cabinetId:'syncbox',origin:'https://synthetic.invalid',fetchImpl:async()=>new Response('{"acks":[]}',{status:200})});
    await assert.rejects(worker.run(), /Invalid sync response signature/);
    assert.equal(controller.outbox.cache(),null); await controller.close();
});
async function tokenFor(role) {
    const uid = 'sync-'+role;
    await auth.createUser({uid,email:uid+'@tesaban6.ac.th',emailVerified:true});
    if (role !== 'student') await db.doc('roles/'+uid).set({role});
    const custom = await auth.createCustomToken(uid);
    const response = await fetch('http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=demo', {
        method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:custom,returnSecureToken:true}) });
    return (await response.json()).idToken;
}
test('actual school tokens give all staff identical history and inventory; students and revoked roles are denied', async () => {
    const handler = createHistoryHandler();
    assert.equal((await invoke(handler,{method:'GET'})).status,401);
    const student = await tokenFor('student');
    assert.equal((await invoke(handler,{method:'GET',headers:{authorization:'Bearer '+student}})).status,403);
    const batch = db.batch();
    for(let i=0;i<105;i++)batch.set(db.doc('dispenses/syncbox~page-event-'+String(i).padStart(4,'0')),
        {...event('page-event-'+i),uid:'private-user',syncedAt:new Date().toISOString(),lineStatus:'pending'});
    await batch.commit();
    let staffProjection;
    for(const role of ['teacher','admin']) {
        const token = await tokenFor(role), headers = {authorization:'Bearer '+token};
        const first = await (await invoke(handler,{method:'GET',headers})).json();
        assert.equal(first.rows.length,100); assert.ok(first.nextCursor);
        assert.equal(Object.hasOwn(first.rows[0],'uid'),true);
        assert.ok(Array.isArray(first.inventory));
        const projection = { rows: first.rows, inventory: first.inventory, cabinets: first.cabinets };
        if (staffProjection) assert.deepEqual(projection, staffProjection); else staffProjection = projection;
        const second = await (await invoke(handler,{method:'GET',headers,url:'/api/history?cursor='+first.nextCursor})).json();
        assert.equal(new Set([...first.rows,...second.rows].map(row=>row.eventId)).size,first.rows.length+second.rows.length);
        if(role==='teacher') {
            await db.doc('roles/sync-teacher').delete();
            assert.equal((await invoke(handler,{method:'GET',headers})).status,403);
        }
    }
});

test('anonymous web SOS persists without identity; heartbeat retries share one LINE key and no client payload', async () => {
    const { createWebSosSender } = await import('../lib/web-sos.js');
    const { createNotifyHandler } = await import('../api/notify.js');
    const accepted = new Set(), bodies = []; let attempts = 0;
    const send = async (body, key) => { accepted.add(key); bodies.push(body); attempts++; return attempts > 1; };
    const sender = createWebSosSender({env,send});
    const notify = createNotifyHandler({ authorizeRequest: async () => { throw new Error('anonymous'); }, send: sender });
    const first = await invoke(notify, {body:{event:'sos',name:'forged surname',uid:'forged-user'},headers:{'x-forwarded-for':'192.0.2.99'}});
    assert.equal(first.status,503);
    const pending = await db.collection('sos').where('cabinetId','==','web').get();
    assert.equal(pending.size,1); assert.equal(pending.docs[0].data().uid,null);
    const ingestHandler = createIngestHandler({env,send});
    assert.equal((await ingest(ingestHandler,[])).status,200);
    assert.equal(accepted.size,1); assert.equal(attempts,2);
    const retry = await invoke(notify, {body:{event:'sos'},headers:{'x-forwarded-for':'192.0.2.99'}});
    assert.equal(retry.status,200); assert.equal(attempts,2);
    assert.equal(JSON.stringify(bodies).includes('forged'),false);
    assert.equal(JSON.stringify(bodies).includes('192.0.2.99'),false);
});

// เส้นทางจริงของ SOS จากเว็บ: notify → createWebSosSender → deliverEvent → pushLine
// เดิมเส้นนี้ส่ง `{type:'text'}` ภาษาอังกฤษ ขณะที่การ์ด Flex ไทยถูกทดสอบผ่านฟังก์ชันที่ไม่มีใครเรียก
// ⇒ เทสต้องอยู่บนเส้นที่ผู้ใช้เดินจริง ไม่ใช่เส้นที่อ่านแล้วสบายใจ (แก้ 2026-09-19)
test('a web SOS reaches the teacher as the same Thai Flex card the cabinet sends, carrying the symptom', async () => {
    const { createWebSosSender } = await import('../lib/web-sos.js');
    const { createNotifyHandler } = await import('../api/notify.js');
    const bodies = [];
    const send = async body => { bodies.push(body); return true; };
    const notify = createNotifyHandler({ authorizeRequest: async () => { throw new Error('anonymous'); },
        send: createWebSosSender({ env, send }) });

    assert.equal((await invoke(notify, { body: { event: 'sos', symptom: 'chest_tightness' },
        headers: { 'x-forwarded-for': '192.0.2.77' } })).status, 200);

    const message = bodies.at(-1).messages[0];
    assert.equal(message.type, 'flex', 'ต้องเป็นการ์ด ไม่ใช่ข้อความเปล่า');
    const rendered = JSON.stringify(message);
    assert.match(message.altText, /เรียกครูพยาบาล/, 'ครูต้องอ่านออกจากแถบแจ้งเตือนโดยไม่ต้องเปิดการ์ด');
    assert.match(rendered, /กดจากเว็บ/, 'ครูต้องรู้ว่ากดมาจากเว็บ ไม่ใช่ที่หน้าตู้ เพราะสิ่งที่ต้องทำต่างกัน');
    assert.match(rendered, /แน่นหน้าอก/, 'อาการที่เด็กตอบต้องไปถึงครู');
    assert.doesNotMatch(rendered, /chest_tightness/, 'ค่าดิบต้องไม่โผล่ให้ครูเห็น');
    // ภาษาอังกฤษของเดิมต้องไม่หลงเหลือบนเส้นทางนี้อีก
    for (const leftover of [/Please contact the student/, /not signed in/, /School user/])
        assert.doesNotMatch(rendered, leftover, 'ยังมีข้อความอังกฤษของเดิมหลงเหลืออยู่');

    // อาการที่ไม่อยู่ใน enum ต้องถูกปัดทิ้ง แต่การเรียกครูต้องไม่หาย — เหตุผลหายได้ ความช่วยเหลือห้ามหาย
    assert.equal((await invoke(notify, { body: { event: 'sos', symptom: 'ข้อความอิสระถึงกลุ่มครู' },
        headers: { 'x-forwarded-for': '192.0.2.78' } })).status, 200);
    const freeform = JSON.stringify(bodies.at(-1).messages[0]);
    assert.equal(freeform.includes('ข้อความอิสระถึงกลุ่มครู'), false,
        'ข้อความอิสระต้องไม่เดินทางเข้ากลุ่ม LINE ของครู');
    assert.match(JSON.parse(freeform).altText, /เรียกครูพยาบาล/);
});
