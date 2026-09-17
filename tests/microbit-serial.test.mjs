import test from 'node:test';
import assert from 'node:assert/strict';
import { MicrobitSerial, ReadinessLatch } from '../edge/microbit-serial.mjs';
import { LocalController } from '../edge/controller.mjs';

// ไม่ใช้พอร์ตจริง ป้อนไบต์ที่บอร์ดจะส่งเข้า feed() แล้วดักสิ่งที่เขียนออกไป
function fake({ ackTimeoutMs = 30000 } = {}) {
    let clock = 1_000_000;
    const serial = new MicrobitSerial({ device: '/dev/fake', ackTimeoutMs, now: () => clock });
    const sent = [];
    serial.write = async frame => { sent.push(frame); };
    const board = text => serial.feed(Buffer.from(text));
    return { serial, sent, board, tick: ms => { clock += ms; } };
}

test('heartbeat drives connected/ready; silence for 1.5 s disconnects', () => {
    const { serial, board, tick } = fake();
    assert.deepEqual(serial.status().data, { protocol: 2, microbit: 'disconnected', ready: false, ackTimeoutMs: 30000, reason: '' });
    board('READY:1\n');
    assert.equal(serial.status().data.microbit, 'connected');
    assert.equal(serial.status().data.ready, true);
    board('BUSY\n');
    assert.equal(serial.status().data.ready, false);
    board('READY:1\n');
    tick(1600);
    assert.equal(serial.status().data.microbit, 'disconnected');
    assert.equal(serial.status().data.ready, false);
});

test('open sends OPEN<d>:<id>:<epoch>, stays pending, then DONE<d>:<id> becomes a drawer_opened ack', async () => {
    const { serial, sent, board } = fake();
    board('READY:7\n');
    const opened = await serial.request('/open?drawer=2&id=c-serial-test-0001');
    assert.equal(opened.status, 202);
    // BASE ต้องมาก่อน OPEN เสมอ บอร์ดจะได้วัดถาดว่างก่อนที่ของรอบนี้จะตกลงมา
    assert.deepEqual(sent, ['BASE:c-serial-test-0001', 'OPEN2:c-serial-test-0001:7']);
    assert.equal(serial.status().data.ready, false, 'consumed: no second open until the board proves a new epoch');
    assert.equal((await serial.request('/command-status?id=c-serial-test-0001')).status, 202);
    board('DONE1:c-serial-test-0001\n');   // wrong drawer: must not complete
    assert.equal((await serial.request('/command-status?id=c-serial-test-0001')).status, 202);
    board('DONE2:c-serial-test-0001\n');
    const done = await serial.request('/command-status?id=c-serial-test-0001');
    assert.equal(done.status, 200);
    // ไม่มีเฟรม DROP/BASE กลับมาเลย ⇒ ต้องเป็น unknown ห้ามเดาว่าไม่มีของ
    assert.deepEqual(done.data, { success: true, protocol: 2, event: 'drawer_opened', id: 'c-serial-test-0001', drawer: 2,
        dropCheck: 'unknown', dropNearMm: null, dropEmptyMm: null });
});

// --- หลักฐานจากเซนเซอร์วัดระยะ (2026-09-17) ---

// ยิงคำสั่งเปิดหนึ่งใบ แล้วป้อนสิ่งที่บอร์ดจะตอบกลับตามลำดับจริง
async function dispenseWith(frames) {
    const { serial, board } = fake();
    board('READY:7\n');
    await serial.request('/open?drawer=1&id=c-drop-case-0001');
    for (const frame of frames) board(frame.replace('<id>', 'c-drop-case-0001') + '\n');
    board('DONE1:c-drop-case-0001\n');
    return (await serial.request('/command-status?id=c-drop-case-0001')).data;
}

test('a blocked beam seen more than once is proof the item fell', async () => {
    const data = await dispenseWith(['BASE:<id>:250', 'DROP:<id>:120:3']);
    assert.equal(data.dropCheck, 'confirmed');
    assert.equal(data.dropNearMm, 120);
    assert.equal(data.dropEmptyMm, 250);
});

test('one lone reading is not proof — ringing echo looks exactly like that', async () => {
    const data = await dispenseWith(['BASE:<id>:250', 'DROP:<id>:120:1']);
    assert.equal(data.dropCheck, 'not_found');
});

test('a beam that stayed clear the whole time means no item fell', async () => {
    const data = await dispenseWith(['BASE:<id>:250', 'DROP:<id>:250:0']);
    assert.equal(data.dropCheck, 'not_found');
});

// ข้อสำคัญที่สุดของชุดนี้ · สายหลุดต้องไม่กลายเป็นคำกล่าวหาว่าตู้ไม่จ่ายของ
test('a sensor that never answers is unknown, never not_found', async () => {
    // สายหลุดตั้งแต่ต้น ไม่เห็นแม้แต่ผนังฝั่งตรงข้าม
    const dead = await dispenseWith(['BASE:<id>:9999', 'DROP:<id>:9999:0']);
    assert.equal(dead.dropCheck, 'unknown');
    // วัดถาดว่างได้ แล้วเงียบไปตอนกำลังจ่าย — เคสนี้หน้าตาเหมือน "ไม่มีของ" เป๊ะ
    // ถ้าไม่แยก สายที่หลุดกลางทางจะกลายเป็นข้อกล่าวหาว่าตู้ไม่จ่ายของ
    const wentSilent = await dispenseWith(['BASE:<id>:250', 'DROP:<id>:9999:0']);
    assert.equal(wentSilent.dropCheck, 'unknown');
    const noBaseline = await dispenseWith(['DROP:<id>:120:5']);
    assert.equal(noBaseline.dropCheck, 'unknown', 'ไม่มีค่าถาดว่างให้เทียบ = ยังไม่รู้');
    const noFrames = await dispenseWith([]);
    assert.equal(noFrames.dropCheck, 'unknown', 'เฟิร์มแวร์รุ่นก่อนมีเซนเซอร์ก็ต้องเดินต่อได้');
});

test('sensor frames for an id the board never got must not crash or leak into another command', async () => {
    const { serial, board } = fake();
    board('READY:7\n');
    board('DROP:c-never-sent-001:120:9\n');
    board('BASE:c-never-sent-001:250\n');
    await serial.request('/open?drawer=1&id=c-real-command-01');
    board('DONE1:c-real-command-01\n');
    const data = (await serial.request('/command-status?id=c-real-command-01')).data;
    assert.equal(data.dropCheck, 'unknown');
    assert.equal(data.dropNearMm, null);
});

test('the latch waits for a NEW epoch after a dispense, and reports awaiting_new_ready_epoch until it comes', async () => {
    const { serial, board } = fake();
    board('READY:3\n');
    await serial.request('/open?drawer=1&id=c-serial-test-0002');
    board('DONE1:c-serial-test-0002\n');
    board('READY:3\n');   // board did not bump — same epoch
    assert.equal(serial.status().data.ready, false);
    assert.equal(serial.status().data.reason, 'awaiting_new_ready_epoch');
    board('READY:4\n');
    assert.equal(serial.status().data.ready, true);
    assert.equal(serial.status().data.reason, '');
});

test('REJECT:<id> for the consumed command is a definite not-actuated result and releases the latch', async () => {
    const { serial, board } = fake();
    board('READY:9\n');
    await serial.request('/open?drawer=1&id=c-serial-test-0003');
    board('REJECT:c-serial-test-0003\n');
    const status = await serial.request('/command-status?id=c-serial-test-0003');
    assert.equal(status.status, 409);
    assert.deepEqual(status.data, { success: false, actuated: false, id: 'c-serial-test-0003' });
    board('READY:9\n');
    assert.equal(serial.status().data.ready, true, 'rejected frame never ran, so the same epoch is still valid');
});

test('open while not ready never writes a frame and is retry-safe; unknown ids are 404', async () => {
    const { serial, sent, board } = fake();
    const refused = await serial.request('/open?drawer=1&id=c-serial-test-0004');
    assert.equal(refused.status, 409);
    assert.equal(refused.data.actuated, false);
    assert.deepEqual(sent, []);
    board('BUSY\n');
    assert.equal((await serial.request('/open?drawer=1&id=c-serial-test-0005')).status, 409);
    assert.deepEqual(sent, []);
    assert.equal((await serial.request('/command-status?id=c-serial-test-0006')).status, 404);
    assert.equal((await serial.request('/open?drawer=3&id=c-serial-test-0007')).status, 400);
    assert.equal((await serial.request('/open?drawer=1&id=short')).status, 400);
});

test('buzzer frames do not touch the latch and ack only with the matching state', async () => {
    const { serial, sent, board } = fake();
    board('READY:2\n');
    const on = await serial.request('/buzzer?state=1&id=c-serial-test-0008');
    assert.equal(on.status, 202);
    assert.deepEqual(sent, ['BUZZ1:c-serial-test-0008']);
    assert.equal(serial.status().data.ready, true, 'asking for help must not block a dispense');
    board('BUZZ_DONE0:c-serial-test-0008\n');   // wrong state
    assert.equal((await serial.request('/command-status?id=c-serial-test-0008')).status, 202);
    board('BUZZ_DONE1:c-serial-test-0008\n');
    const done = await serial.request('/command-status?id=c-serial-test-0008');
    assert.deepEqual(done.data, { success: true, protocol: 2, event: 'buzzer_set', id: 'c-serial-test-0008', state: 'on' });
});

test('an unanswered command times out to ack_timeout, never to success', async () => {
    const { serial, board, tick } = fake({ ackTimeoutMs: 5000 });
    board('READY:1\n');
    await serial.request('/open?drawer=1&id=c-serial-test-0009');
    tick(5001);
    const late = await serial.request('/command-status?id=c-serial-test-0009');
    assert.equal(late.status, 504);
    assert.equal(late.data.success, false);
});

test('framing: CR ignored, fragments joined, over-long lines dropped whole, bad ids ignored', async () => {
    const { serial, board } = fake();
    board('REA'); board('DY:1'); board('\r\n');
    assert.equal(serial.status().data.microbit, 'connected');
    await serial.request('/open?drawer=1&id=c-serial-test-0010');
    board('x'.repeat(130) + '\n');                 // overflow: dropped
    board('DONE1:c-serial-test-0010\n');
    assert.equal((await serial.request('/command-status?id=c-serial-test-0010')).status, 200);
    board('DONE1:not valid!\n');                    // ignored, no throw
});

test('LocalController over serial: mode gate, journal, hold and confirmed ack all survive the transport swap', async t => {
    const { serial, sent, board } = fake();
    const controller = new LocalController({ serial, database: ':memory:', mode: 'real', pollMs: 1 });
    t.after(() => controller.close());
    board('READY:1\n');
    const status = await controller.status();
    assert.equal(status.connected, true);
    assert.equal(status.ready, true);
    assert.equal(status.configured, true);
    // ตอบกลับทีหลังแบบที่บอร์ดจริงทำ คือหลังคำสั่งออกไปแล้ว
    const task = controller.command({ action: 'open', drawer: 1, id: 'c-ctrl-serial-0001' });
    await new Promise(r => setTimeout(r, 5));
    assert.deepEqual(sent, ['BASE:c-ctrl-serial-0001', 'OPEN1:c-ctrl-serial-0001:1']);
    board('DONE1:c-ctrl-serial-0001\n');
    const result = await task;
    assert.equal(result.status, 200);
    assert.equal(result.body.ack.event, 'drawer_opened');
    assert.equal(controller.history()[0].state, 'confirmed');
    // id เดิมอีกครั้ง สมุดคำสั่งตอบให้เอง ไม่ส่งคำสั่งซ้ำ
    const replay = await controller.command({ action: 'open', drawer: 1, id: 'c-ctrl-serial-0001' });
    assert.equal(replay.status, 200);
    assert.deepEqual(sent, ['BASE:c-ctrl-serial-0001', 'OPEN1:c-ctrl-serial-0001:1'], 'ไม่มีเฟรมใหม่ออกไปเลย');
    // id ใหม่แต่บอร์ดยังไม่ยืนยันว่าพร้อมรอบใหม่ ต้องปฏิเสธก่อนส่งอะไรออกไป
    board('READY:1\n');
    const early = await controller.command({ action: 'open', drawer: 2, id: 'c-ctrl-serial-0002' });
    assert.equal(early.status, 503);
    assert.deepEqual(sent, ['BASE:c-ctrl-serial-0001', 'OPEN1:c-ctrl-serial-0001:1'], 'ไม่มีเฟรมใหม่ออกไปเลย');
    assert.equal(controller.history()[0].state, 'rejected');
});

test('ReadinessLatch mirrors the ESP32 header rules', () => {
    const l = new ReadinessLatch();
    assert.equal(l.canOpen(0), false);
    l.ready(5, 1000);
    assert.equal(l.canOpen(1000), true);
    l.consume('c-latch-test-0001');
    assert.equal(l.canOpen(1000), false);
    assert.equal(l.reject('c-other-id-0000'), false);
    l.ready(5, 1200);
    assert.equal(l.needsResync(), true);
    l.ready(6, 1400);
    assert.equal(l.needsResync(), false);
    assert.equal(l.canOpen(1400), true);
});

test('REMOTE_SOS fires the handler once per id and never disturbs the latch', () => {
    const { serial, board } = fake();
    const fired = [];
    serial.onRemoteSos = id => fired.push(id);
    board('READY:4\n');
    board('REMOTE_SOS:rsos-7-123456\n');
    board('REMOTE_SOS:rsos-7-123456\n');   // บอร์ดยิงซ้ำได้ ครูต้องไม่ได้ LINE สองใบ
    assert.deepEqual(fired, ['rsos-7-123456']);
    assert.equal(serial.status().data.ready, true, 'ปุ่มฉุกเฉินต้องไม่ทำให้ตู้ดูเหมือนไม่พร้อมจ่ายยา');
    board('REMOTE_SOS:rsos-8-123999\n');
    assert.deepEqual(fired, ['rsos-7-123456', 'rsos-8-123999']);
});

test('a throwing REMOTE_SOS handler does not kill the serial reader', () => {
    const { serial, board } = fake();
    serial.onRemoteSos = () => { throw new Error('journal down'); };
    board('REMOTE_SOS:rsos-1-100000\n');
    board('READY:9\n');
    assert.equal(serial.status().data.ready, true, 'frame ถัดไปต้องยังถูกอ่านต่อ');
});
