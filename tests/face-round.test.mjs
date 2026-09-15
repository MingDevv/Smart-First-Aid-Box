// รอบที่ไม่มีบัตร: ถ่ายรูปใบหน้า → เปิดลิ้นชักได้ → รูปขึ้นคลาวด์ก่อนเหตุการณ์ถูกส่ง
//
// เทสชุดนี้เดินฟังก์ชันจริงทั้งเส้น ไม่ได้ match สตริงในซอร์ส เพราะความผิดที่เคยหลุดมาในเรพนี้
// เป็นชนิดที่ regex มองไม่เห็น: ตรรกะ OR ที่นับความสำเร็จของช่องทางหนึ่งเป็นของอีกช่องทาง

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { CabinetPhotos, RETENTION_MS, MAX_BASE64 } from '../edge/photos.mjs';
import { StudentSession } from '../edge/student-session.mjs';
import { CabinetOutbox } from '../edge/outbox.mjs';
import { LocalController } from '../edge/controller.mjs';
import { createLocalServer } from '../edge/server.mjs';
import { CabinetSync } from '../edge/sync.mjs';
import { validateEvent } from '../lib/cabinet-events.js';
import { authenticateCabinet, responseSignature } from '../lib/cabinet-protocol.js';

const secret = 'synthetic-cabinet-secret-not-for-production';
const jpeg = 'A'.repeat(2048);

// สำเนาในไฟล์ ไม่ import จาก cabinet-sync.test.mjs — การ import ไฟล์เทสจะรัน `test()`
// ของมันซ้ำอีกรอบในรายงานของไฟล์นี้ ทำให้จำนวนที่เห็นไม่ตรงกับที่ไฟล์นี้ตรวจจริง
function fakeSerial() {
    let opens = 0;
    return { device: 'synthetic', get opens() { return opens; }, async close() {}, async request(path) {
        const url = new URL(path, 'http://device');
        if (url.pathname === '/status') return { status: 200, data: { protocol: 2, microbit: 'connected', ready: true, ackTimeoutMs: 3000 } };
        if (url.pathname === '/open') opens++;
        return { status: 200, data: { success: true, protocol: 2, id: url.searchParams.get('id'),
            ...(url.pathname === '/open' ? { event: 'drawer_opened', drawer: Number(url.searchParams.get('drawer')) } : { event: 'buzzer_set', state: 'on' }) } };
    } };
}

test('the photo queue accepts only what the cloud would accept, and forgets on demand', () => {
    const db = new DatabaseSync(':memory:');
    const photos = new CabinetPhotos(db);

    assert.equal(photos.store('round-0001', jpeg), true);
    assert.equal(photos.has('round-0001'), true);

    // ปฏิเสธที่ต้นทาง ไม่ใช่ปล่อยให้ไปพังตอนอัปโหลด: id ผิดรูป · สั้นเกินกว่าจะเป็นรูป ·
    // เกินเพดานของปลายทาง · และ data URL ที่ยังไม่ได้ตัดหัว ซึ่งเป็นความผิดที่เกิดง่ายที่สุด
    for (const [id, payload] of [['สั้น', jpeg], ['round-0002', 'AAA'], ['round-0003', 'A'.repeat(MAX_BASE64 + 1)],
        ['round-0004', `data:image/jpeg;base64,${jpeg}`]]) {
        assert.equal(photos.store(id, payload), false);
        assert.equal(photos.has(id), false);
    }

    // รูปของเหตุการณ์เดิมเขียนทับไม่ได้ ด้วยกติกาเดียวกับที่ฝั่งคลาวด์ใช้ create ไม่ใช่ set
    photos.store('round-0001', 'B'.repeat(2048));
    assert.equal(photos.pending()[0].jpegBase64[0], 'A');

    photos.forget('round-0001');
    assert.equal(photos.has('round-0001'), false);
    db.close();
});

test('the photo of the event about to be ingested goes first, and stale photos are pruned', () => {
    const db = new DatabaseSync(':memory:');
    const photos = new CabinetPhotos(db);
    const now = Date.UTC(2026, 8, 15);

    photos.store('round-older', jpeg, now);
    photos.store('round-newer', jpeg, now);
    // เรียงตาม rowid ปกติจะได้ older ก่อน · การส่ง newer เข้ามาเป็นรายการที่กำลังจะ ingest
    // ต้องดันมันขึ้นหัวคิว เพราะการ์ด LINE ของมันถูกแช่แข็งตอน ingest และแก้ทีหลังไม่ได้
    assert.equal(photos.pending()[0].eventId, 'round-older');
    assert.equal(photos.pending(['round-newer'])[0].eventId, 'round-newer');

    assert.equal(photos.prune(now), 0);
    assert.equal(photos.prune(now + RETENTION_MS + 1), 2);
    assert.equal(photos.pending().length, 0);
    db.close();
});

test('a photo round opens only for the command it was taken for, and survives the upload deleting the photo', () => {
    const db = new DatabaseSync(':memory:');
    const outbox = new CabinetOutbox(db);
    const photos = new CabinetPhotos(db);
    let now = 1000;
    const session = new StudentSession(outbox, () => now, photos);

    // ไม่มีรูป = ไม่มีรอบ · ถ้าข้อนี้หลุด เกตตัวตนของตู้หายไปทั้งใบ เพราะใครก็ขอเปิดรอบได้เฉยๆ
    assert.equal(session.beginPhotoRound('round-0001'), null);

    photos.store('round-0001', jpeg);
    const round = session.beginPhotoRound('round-0001');
    assert.ok(round.sessionId);
    assert.equal(round.studentId, undefined, 'ตั๋วของรอบต้องไม่พกตัวตนใดๆ ติดออกไป');

    assert.equal(session.identify('ตั๋วมั่ว', 'round-0001'), null);
    assert.equal(session.identify(round.sessionId, 'round-อื่น'), null, 'รูปหนึ่งใบใช้ได้กับคำสั่งเดียว');

    const identity = session.identify(round.sessionId, 'round-0001');
    assert.deepEqual(identity, { studentId: null, badgeId: null, verifiedBy: 'cabinet_photo' });

    // ⚠️ เคสนี้เคย assert กลับด้าน และนั่นคือบั๊กที่ทำให้ "ไม่มีบัตร" ใช้ไม่ได้จริงเมื่อเน็ตดี
    //
    // `/api/local/photo` ปลุก sync ทันทีที่เก็บรูป · อัปสำเร็จแล้ว `forget()` ลบรูปตามกติกา PDPA
    // ระหว่างที่เด็กเลือกประเภทแผลอยู่ ⇒ ถ้าตั๋วตายตอนรูปถูกลบ ก็ไม่มีใครกดรับยาทันเลย
    // เว้นแต่จะกดเร็วกว่ารอบ sync
    //
    // ตั๋วยังต้องผูกกับคำสั่งเดิมใบเดียวเหมือนเดิม — ข้อนั้นทดสอบไว้แล้วที่บรรทัด 'รูปหนึ่งใบใช้ได้กับคำสั่งเดียว'
    // ซึ่งคือสิ่งที่กันรอบใหม่จริงๆ ไม่ใช่การมีไฟล์ค้างอยู่ในเครื่อง
    photos.forget('round-0001');
    assert.deepEqual(session.identify(round.sessionId, 'round-0001'),
        { studentId: null, badgeId: null, verifiedBy: 'cabinet_photo' },
        'รูปถูกอัปขึ้นคลาวด์แล้วลบทิ้ง ไม่ได้แปลว่ารอบนี้ใช้ไม่ได้ — ครูได้เห็นรูปแล้วด้วยซ้ำ');
    assert.equal(session.identify(round.sessionId, 'round-อื่น'), null,
        'แต่ตั๋วเดิมต้องยังเปิดคำสั่งใบอื่นไม่ได้ ถึงรูปจะไม่อยู่ในเครื่องแล้ว');

    now += 600001;
    assert.equal(session.identify(round.sessionId, 'round-0001'), null, 'ตั๋วต้องหมดอายุเหมือนรอบที่ใช้บัตร');
    db.close();
});

test('a dispense with no badge reaches LINE as its own kind, not as a cloud command', () => {
    const db = new DatabaseSync(':memory:');
    const outbox = new CabinetOutbox(db);
    outbox.record({ id: 'round-0001', drawer: 1, state: 'confirmed', created_at: new Date().toISOString(),
        student_identity: JSON.stringify({ studentId: null, badgeId: null, verifiedBy: 'cabinet_photo' }) },
        { body: { ack: true } });

    const event = outbox.pending()[0];
    assert.equal(event.verifiedBy, 'cabinet_photo');
    assert.equal(event.uid, null);
    assert.equal(event.studentId, null);

    // validateEvent เป็น whitelist ที่ประกอบเหตุการณ์ขึ้นใหม่ — ค่าที่ไม่อยู่ในรายการถูกทิ้งเงียบๆ
    const validated = validateEvent(event, 'box1');
    assert.equal(validated.verifiedBy, 'cabinet_photo');

    // แถวเก่าที่บันทึกไว้ก่อนมีฟิลด์นี้ ต้องยังอ่านเป็นรอบที่ใช้บัตรเหมือนเดิม
    outbox.record({ id: 'round-0002', drawer: 1, state: 'confirmed', created_at: new Date().toISOString(),
        student_identity: JSON.stringify({ studentId: '0001', badgeId: 'a'.repeat(64) }) }, { body: { ack: true } });
    assert.equal(outbox.pending().find(item => item.id === 'round-0002').verifiedBy, 'cabinet_card');
    db.close();
});

test('the cabinet opens a drawer for someone with no card, and refuses the same command twice', async t => {
    const serial = fakeSerial();
    const controller = new LocalController({ database: ':memory:', mode: 'real', serial });
    const server = await createLocalServer({ controller, mode: 'real' });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); await controller.close(); });
    const origin = 'http://127.0.0.1:' + server.address().port;
    const post = (path, body) => fetch(origin + path, { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

    const command = { id: 'round-no-card-1', action: 'open', drawer: 1 };
    assert.equal((await post('/api/command', command)).status, 401, 'control: ไม่มีอะไรเลยยังต้องถูกปฏิเสธ');
    assert.equal(serial.opens, 0);

    assert.equal((await fetch(origin + '/api/local/photo', { method: 'GET' })).status, 405);
    assert.equal((await fetch(origin + '/api/local/photo', { method: 'POST', body: 'x' })).status, 415);
    assert.equal((await post('/api/local/photo', { eventId: 'round-no-card-1', jpegBase64: 'AAA' })).status, 400);

    const round = await (await post('/api/local/photo', { eventId: 'round-no-card-1', jpegBase64: jpeg })).json();
    assert.ok(round.sessionId);

    assert.equal((await post('/api/command', { ...command, studentSession: round.sessionId })).status, 200);
    assert.equal(serial.opens, 1);

    const event = controller.outbox.pending()[0];
    assert.equal(event.verifiedBy, 'cabinet_photo');
    assert.equal(event.uid, null);

    // ตั๋วใบเดิมต้องเปิดคำสั่งใบใหม่ไม่ได้ เหมือนรอบที่ใช้บัตร
    assert.equal((await post('/api/command', { ...command, id: 'round-no-card-2', studentSession: round.sessionId })).status, 401);
    assert.equal(serial.opens, 1);
});

/** ตัวปลอมของ Vercel: เซ็นคำตอบให้ถูกต้องเสมอ และให้ตัวเทสสั่งได้ว่า /api/photo จะตอบอะไร */
function cloudDouble({ photoStatus = () => 200 } = {}) {
    const seen = { photos: [], ingestAt: null, photoAt: null };
    let clock = 0;
    const fetchImpl = async (url, options) => {
        const path = new URL(url).pathname;
        const body = options.body || '';
        const auth = authenticateCabinet({ method: options.method, headers: options.headers }, body, path,
            { SFAB_CABINET_SECRET: secret, SFAB_CABINET_ID: 'box1' });
        clock += 1;
        if (path === '/api/photo') {
            seen.photos.push({ eventId: options.headers['x-sfab-event'], bytes: body, at: clock });
            seen.photoAt = clock;
            const status = photoStatus(seen.photos.length);
            if (status !== 200) return new Response('{}', { status });
            const text = JSON.stringify({ success: true, viewToken: 'token', expiresAt: 0 });
            return new Response(text, { status: 200, headers: {
                'x-sfab-signature': responseSignature(secret, options.headers['x-sfab-signature'], 200, '', text) } });
        }
        if (path === '/api/ingest') {
            seen.ingestAt = clock;
            const text = JSON.stringify({ acks: JSON.parse(body).events.map(event => ({ id: event.id, stored: true, line: 'delivered' })) });
            return new Response(text, { status: 200, headers: {
                'x-sfab-signature': responseSignature(secret, options.headers['x-sfab-signature'], 200, '', text) } });
        }
        const text = JSON.stringify({ cabinetId: 'box1', version: 1 });
        return new Response(text, { status: 200, headers: { etag: 'W/"1"',
            'x-sfab-signature': responseSignature(secret, options.headers['x-sfab-signature'], 200, 'W/"1"', text) } });
    };
    return { seen, fetchImpl };
}

function syncFixture(cloud, photos) {
    const controller = new LocalController({ database: ':memory:', mode: 'real', serial: fakeSerial() });
    const sync = new CabinetSync({ controller, origin: 'https://cabinet.invalid', secret,
        fetchImpl: cloud.fetchImpl, photos: photos?.(controller) ?? null });
    return { controller, sync };
}

test('the photo is uploaded before the event is ingested, because the LINE card freezes at ingest', async () => {
    const cloud = cloudDouble();
    const { controller, sync } = syncFixture(cloud, ctl => {
        const photos = new CabinetPhotos(ctl.outbox.db);
        photos.store('round-0001', jpeg);
        return photos;
    });
    controller.outbox.record({ id: 'round-0001', drawer: 1, state: 'confirmed', created_at: new Date().toISOString(),
        student_identity: JSON.stringify({ studentId: null, badgeId: null, verifiedBy: 'cabinet_photo' }) }, { body: { ack: true } });

    await sync.cycle();

    assert.equal(cloud.seen.photos.length, 1);
    assert.equal(cloud.seen.photos[0].eventId, 'round-0001');
    assert.equal(cloud.seen.photos[0].bytes, jpeg, 'ต้องส่ง base64 ดิบ ไม่ใช่ห่อ JSON — ลายเซ็นคิดจากไบต์ที่ส่งจริง');
    assert.ok(cloud.seen.photoAt < cloud.seen.ingestAt, 'รูปต้องถึงคลาวด์ก่อน ingest');
    await controller.close();
});

test('a duplicate photo is success, not failure — the cabinet stops carrying it', async () => {
    const cloud = cloudDouble({ photoStatus: () => 409 });
    let photos;
    const { controller, sync } = syncFixture(cloud, ctl => {
        photos = new CabinetPhotos(ctl.outbox.db);
        photos.store('round-0001', jpeg);
        return photos;
    });

    await sync.cycle();

    assert.equal(photos.has('round-0001'), false, '409 แปลว่ามีอยู่แล้ว ไม่ใช่ส่งไม่สำเร็จ');
    assert.ok(cloud.seen.ingestAt, 'และต้องไม่ทำให้ ingest ไม่เกิดขึ้น');
    await controller.close();
});

test('a photo that will not upload keeps the cabinet working and stays queued for later', async () => {
    const cloud = cloudDouble({ photoStatus: () => 503 });
    let photos;
    const { controller, sync } = syncFixture(cloud, ctl => {
        photos = new CabinetPhotos(ctl.outbox.db);
        photos.store('round-0001', jpeg);
        return photos;
    });
    controller.outbox.record({ id: 'round-0001', drawer: 1, state: 'confirmed', created_at: new Date().toISOString(),
        student_identity: JSON.stringify({ studentId: null, badgeId: null, verifiedBy: 'cabinet_photo' }) }, { body: { ack: true } });

    await sync.cycle();

    assert.equal(photos.has('round-0001'), true, 'รูปที่ส่งไม่ขึ้นต้องอยู่ในคิวรอรอบหน้า');
    assert.ok(cloud.seen.ingestAt, 'เหตุการณ์ต้องถูกส่งต่อไป ไม่ถูกบล็อกด้วยรูปที่อัปไม่ขึ้น');
    await controller.close();
});

test('a cabinet with no photo queue behaves exactly as it did before', async () => {
    const cloud = cloudDouble();
    const { controller, sync } = syncFixture(cloud, null);
    await sync.cycle();
    assert.equal(cloud.seen.photos.length, 0);
    assert.ok(cloud.seen.ingestAt);
    await controller.close();
});
