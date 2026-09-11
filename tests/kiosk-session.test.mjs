// TESTS/KIOSK-SESSION.TEST.MJS — เทสตัวคุมรอบการใช้งานของหน้าตู้ (js/kiosk-session.js)
//
// เทสนี้เรียกฟังก์ชันจริงทุกข้อ ไม่มีการ regex หาสตริงในซอร์สแม้แต่ข้อเดียว
// ยกเว้นข้อ "รูปร่างของ state" ซึ่งเป็น negative invariant (พิสูจน์ว่า "ไม่มี"
// ฟิลด์คลังยา/ประวัติคำสั่งอยู่ในสิ่งที่ reset() ล้าง) และตรวจจาก snapshot() จริง
//
// สองกฎที่ไฟล์นี้ค้ำ:
//   1. คำสั่งที่ส่งไปแล้วผลไม่ชัด (uncertain) ห้ามส่งซ้ำ และห้ามให้นาฬิกาว่างรีเซ็ตทับ
//   2. จบรอบล้างข้อมูลของผู้ใช้คนนั้น แต่ไม่แตะคลังยา/ประวัติคำสั่งกัน replay

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

// โหลดซอร์สจริงของโมดูล แล้วป้อน `module` กับ `window` ให้ตัวห่อ UMD เอง
// ใช้ runInThisContext เพื่อให้ object ที่ได้อยู่ realm เดียวกับเทส — ถ้าใช้
// runInNewContext ตัว Array/Object จะคนละ prototype แล้ว deepEqual ฟ้อง
// "same structure but not reference-equal" ทั้งที่ค่าตรงกัน
//
// ⚠️ ห้ามเปลี่ยนไปใช้ createRequire('../js/kiosk-session.js') — package.json ตั้ง
// "type": "module" ไว้ Node จึงโหลดไฟล์ .js นั้นเป็น ESM ตัวห่อ UMD เลยไม่เห็นทั้ง
// `module` และ `window` แล้ว require() คืน {} เปล่าๆ แบบเงียบๆ ไม่ throw
// (ยืนยันด้วยมือบน Node v26.8.2: require('../js/kiosk-session.js') -> {} keys: 0)
// เทสที่เผลอใช้ทางนั้นจะกลายเป็นการยืนยัน object ว่างแทนที่จะเป็นตรรกะจริง
const source = readFileSync(fileURLToPath(new URL('../js/kiosk-session.js', import.meta.url)), 'utf8');
const loadKioskSession = vm.runInThisContext(
    `(function (module, window) {\n${source}\n})`,
    { filename: 'js/kiosk-session.js' }
);
const nodeModule = { exports: {} };
const browserWindow = {};
loadKioskSession(nodeModule, browserWindow);
const KioskSession = nodeModule.exports;

assert.equal(typeof KioskSession.create, 'function',
    'โหลด js/kiosk-session.js ไม่ติด — เทสทั้งไฟล์นี้จะกลายเป็นการทดสอบ object ว่าง');
assert.equal(browserWindow.KioskSession, KioskSession,
    'ตัวห่อ UMD ต้องให้ของชิ้นเดียวกันทั้งฝั่งเบราว์เซอร์ (window.KioskSession) และฝั่ง Node');

const { IDLE_MS, WARNING_MS } = KioskSession;

// ── นาฬิกาปลอม ──────────────────────────────────────────────────────────────
// เดินด้วยมือล้วนๆ ไม่มี setTimeout จริง เทสจึงเร็วและไม่ขึ้นกับความเร็วเครื่อง
// advance() ยิง callback ตามลำดับเวลาที่ครบกำหนดจริง และ callback ที่ไปตั้ง
// timer ใหม่ (armTimers) ภายในหน้าต่างเดียวกันก็ถูกยิงต่อ เหมือน event loop จริง

function createClock(startAt = 1_700_000_000_000) {
    let currentMs = startAt;
    let nextId = 0;
    const timers = new Map();

    return {
        now: () => currentMs,
        setTimer(fn, ms) {
            const id = ++nextId;
            timers.set(id, { at: currentMs + Math.max(0, Number(ms) || 0), fn });
            return id;
        },
        clearTimer(id) {
            timers.delete(id);
        },
        pendingCount: () => timers.size,
        advance(ms) {
            const target = currentMs + ms;
            for (;;) {
                let dueId = null;
                let dueAt = Infinity;
                for (const [id, timer] of timers) {
                    if (timer.at <= target && (timer.at < dueAt || (timer.at === dueAt && id < dueId))) {
                        dueAt = timer.at;
                        dueId = id;
                    }
                }
                if (dueId === null) break;
                const timer = timers.get(dueId);
                timers.delete(dueId);
                currentMs = timer.at;
                timer.fn();
            }
            currentMs = target;
        }
    };
}

function setup(t, options) {
    const clock = createClock();
    const events = { warn: [], expire: [], reset: [] };
    const session = KioskSession.create(Object.assign({
        now: clock.now,
        setTimer: clock.setTimer,
        clearTimer: clock.clearTimer,
        onIdleWarning: info => events.warn.push(info),
        onIdleExpired: info => events.expire.push(info),
        onReset: info => events.reset.push(info)
    }, options || {}));

    t.after(() => {
        session.stop();
        assert.equal(clock.pendingCount(), 0, 'เทสต้องไม่ทิ้ง timer ค้างไว้หลังเรียก stop()');
    });

    return { clock, session, events };
}

// ── กดปุ่มจ่ายยาซ้ำ ─────────────────────────────────────────────────────────

test('beginDispatch ครั้งที่สองคืน false และสถานะยังเป็น sending — ปุ่มยิงซ้ำไม่ได้', t => {
    const { session } = setup(t);
    session.start();

    assert.equal(session.beginDispatch('cmd-1', 2), true);
    assert.equal(session.dispatchState(), 'sending');
    assert.equal(session.isDispatchPending(), true);
    assert.equal(session.canDispatch(), false);

    // กดรัวอีกสามที (จอสัมผัส resistive กดติดง่าย) ต้องไม่ผ่านสักที
    assert.equal(session.beginDispatch('cmd-2', 1), false);
    assert.equal(session.beginDispatch('cmd-3', 1), false);
    assert.equal(session.beginDispatch(), false);

    assert.equal(session.dispatchState(), 'sending');
    // และต้องไม่ทับ commandId/drawer ของคำสั่งแรกที่ยังบินอยู่
    assert.equal(session.state.dispatch.commandId, 'cmd-1');
    assert.equal(session.state.dispatch.drawer, 2);
});

// ── ผลลัพธ์สามแบบจาก ApiBridge ──────────────────────────────────────────────

test('settleDispatch({success:true}) => confirmed ตั้ง dispensedOnce และห้ามสั่งซ้ำตลอดรอบ', t => {
    const { session, clock } = setup(t);
    session.start();
    session.setWound('cut_abrasion');
    assert.equal(session.beginDispatch('cmd-1', 2), true);

    assert.equal(session.settleDispatch({ success: true, commandId: 'cmd-1' }), 'confirmed');
    assert.equal(session.dispatchState(), 'confirmed');
    assert.equal(session.state.dispensedOnce, true);
    assert.equal(session.state.dispatch.error, null);
    assert.equal(session.state.dispatch.drawer, 2, 'ต้องจำช่องเดิมไว้สำหรับหน้ารับของ');

    // หนึ่งรอบ = หนึ่งลิ้นชัก ห้ามมีครั้งที่สองไม่ว่าจะเดินหน้าจอต่อไปทางไหน
    assert.equal(session.canDispatch(), false);
    assert.equal(session.beginDispatch('cmd-2', 2), false);
    session.setView('steps');
    session.touch();
    clock.advance(IDLE_MS.reading - 1);
    assert.equal(session.canDispatch(), false, 'ผ่านไปเกือบสามนาทีก็ยังสั่งซ้ำไม่ได้');
    assert.equal(session.beginDispatch('cmd-3', 2), false);
    assert.equal(session.dispatchState(), 'confirmed');
});

test('settleDispatch({success:false, retrySafe:true}) => rejected และลองใหม่ได้จริง', t => {
    const { session } = setup(t);
    session.start();
    assert.equal(session.beginDispatch('cmd-1', 2), true);

    assert.equal(session.settleDispatch({ success: false, retrySafe: true, error: 'คิวของตู้เต็ม' }), 'rejected');
    assert.equal(session.dispatchState(), 'rejected');
    assert.equal(session.state.dispensedOnce, false);
    assert.equal(session.state.dispatch.error, 'คิวของตู้เต็ม');

    // ยังไม่ได้ส่งอะไรออกไป ⇒ กดใหม่ได้อย่างปลอดภัย และเริ่มคำสั่งใหม่ได้จริง
    assert.equal(session.canDispatch(), true);
    assert.equal(session.beginDispatch('cmd-2', 2), true);
    assert.equal(session.dispatchState(), 'sending');
    assert.equal(session.state.dispatch.commandId, 'cmd-2');
});

test('settleDispatch ที่ไม่มี retrySafe === true => uncertain และห้ามสั่งซ้ำ', t => {
    const { session } = setup(t);
    session.start();
    assert.equal(session.beginDispatch('cmd-1', 2), true);

    assert.equal(session.settleDispatch({ success: false, error: 'ตู้ไม่ตอบภายในเวลา' }), 'uncertain');
    assert.equal(session.dispatchState(), 'uncertain');
    assert.equal(session.isDispatchUncertain(), true);
    assert.equal(session.isDispatchPending(), false, 'ไม่ pending แล้ว แต่ก็ยังห้ามสั่งซ้ำ');
    assert.equal(session.state.dispensedOnce, false);
    assert.equal(session.state.dispatch.error, 'ตู้ไม่ตอบภายในเวลา');
    assert.equal(session.canDispatch(), false);
    assert.equal(session.beginDispatch('cmd-2', 2), false);
});

test('เฉพาะ retrySafe === true เท่านั้นที่ปลอดภัย ค่าคล้ายจริงอื่นๆ ต้องตกเป็น uncertain', t => {
    // ApiBridge สัญญาว่า retrySafe === true แปลว่า "ยังไม่ได้ส่ง" ค่าที่แค่ truthy
    // (สตริง '1', เลข 1, undefined) ต้องไม่ถูกอนุโลม ไม่งั้นกฎห้ามส่งซ้ำรั่วทันที
    const notProven = [
        { success: false, retrySafe: 'true' },
        { success: false, retrySafe: 1 },
        { success: false, retrySafe: {} },
        { success: false },
        { success: 'true' },
        {},
        undefined
    ];
    for (const result of notProven) {
        const { session } = setup(t);
        session.start();
        assert.equal(session.beginDispatch('cmd-1', 2), true);
        assert.equal(
            session.settleDispatch(result), 'uncertain',
            `ผลลัพธ์ ${JSON.stringify(result) || 'undefined'} ต้องถือว่าไม่ชัด`
        );
        assert.equal(session.canDispatch(), false);
        assert.ok(session.state.dispatch.error, 'ต้องมีข้อความบอกว่ายังยืนยันผลไม่ได้');
    }
});

test('ACK ไม่ใช่หลักฐานว่าของออกมา — confirmed ตั้งได้เฉพาะ success === true', t => {
    const { session } = setup(t);
    session.start();
    session.beginDispatch('cmd-1', 2);
    // ส่งอะไรที่ไม่ใช่ true ตรงๆ มาแล้วกลายเป็น confirmed ไม่ได้เด็ดขาด
    assert.notEqual(session.settleDispatch({ success: 1, ack: true }), 'confirmed');
    assert.equal(session.state.dispensedOnce, false);
});

// ── นาฬิกาว่างระหว่างมีคำสั่งค้าง ───────────────────────────────────────────

test('ระหว่าง sending นาฬิกาว่างถูกพัก — เลยเวลาไปไกลก็ไม่ onIdleExpired และ touch() คืน false', t => {
    const { session, clock, events } = setup(t);
    session.start();
    assert.equal(clock.pendingCount(), 2, 'เริ่มรอบต้องมีทั้ง timer เตือนและ timer หมดเวลา');

    session.beginDispatch('cmd-1', 2);
    assert.equal(session.isIdleSuspended(), true);
    assert.equal(clock.pendingCount(), 0, 'ตอนสั่งตู้ต้องถอน timer ทิ้ง ไม่ใช่แค่ไม่สนใจมัน');
    assert.equal(session.remainingMs(), null);

    clock.advance(IDLE_MS.reading * 5);
    assert.deepEqual(events.expire, [], 'ห้ามรีเซ็ตหน้าจอทับคำสั่งที่ยังรอผล');
    assert.deepEqual(events.warn, []);

    // แตะจอระหว่างรอ ต้องไม่ปลุกนาฬิกากลับมา
    assert.equal(session.touch(), false);
    assert.equal(clock.pendingCount(), 0, 'touch() ห้ามตั้ง timer ใหม่ตอนนาฬิกาถูกพัก');
    clock.advance(IDLE_MS.interactive * 3);
    assert.deepEqual(events.expire, []);
});

test('หลัง settle เป็น uncertain นาฬิกายังพักอยู่ — จอต้องไม่รีเซ็ตตัวเองทับคำสั่งที่ไม่รู้ผล', t => {
    const { session, clock, events } = setup(t);
    session.start();
    session.setWound('cut_abrasion');
    session.beginDispatch('cmd-1', 2);
    session.settleDispatch({ success: false, error: 'ไม่ได้ยินคำตอบจากตู้' });

    assert.equal(session.isIdleSuspended(), true);
    assert.equal(clock.pendingCount(), 0);
    assert.equal(session.remainingMs(), null);

    clock.advance(IDLE_MS.reading * 10);
    assert.deepEqual(events.expire, [], 'รอบที่ผลไม่ชัดต้องค้างจอไว้ให้คนมาดู');
    assert.deepEqual(events.reset, [], 'และต้องไม่เปิดรอบใหม่ให้ใครเอง');
    assert.equal(session.touch(), false);
    assert.equal(session.state.woundId, 'cut_abrasion', 'ข้อมูลรอบเดิมยังอยู่ให้ครูดู');

    // เปลี่ยนหน้าไปดูวิธีทำแผลก็ต้องไม่ปลุกนาฬิกากลับมาเอง
    session.setView('steps');
    assert.equal(clock.pendingCount(), 0);
    clock.advance(IDLE_MS.reading * 2);
    assert.deepEqual(events.expire, []);
});

test('หลัง settle เป็น rejected นาฬิกาว่างกลับมาเดินตามปกติ', t => {
    const { session, clock, events } = setup(t);
    session.start();
    session.beginDispatch('cmd-1', 2);
    session.settleDispatch({ success: false, retrySafe: true, error: 'ตู้ปฏิเสธคำสั่ง' });

    assert.equal(session.isIdleSuspended(), false);
    assert.equal(session.touch(), true);
    assert.equal(session.remainingMs(), IDLE_MS.interactive);

    clock.advance(IDLE_MS.interactive - WARNING_MS);
    assert.equal(events.warn.length, 1);
    assert.deepEqual(events.expire, []);
    clock.advance(WARNING_MS);
    assert.equal(events.expire.length, 1);
    assert.equal(events.expire[0].mode, 'interactive');
});

// ── จบรอบ ───────────────────────────────────────────────────────────────────

test('reset() คืน false ระหว่างมีคำสั่งค้าง และสำเร็จเมื่อไม่มี พร้อมล้างข้อมูลผู้ใช้', t => {
    const { session, clock, events } = setup(t);
    session.start();
    session.setMethod('ai-scan');
    session.setPhoto('data:image/jpeg;base64,AAAA');
    session.setAiResult({ woundId: 'cut_abrasion', confidence: 91, description: 'แผลถลอก' });
    session.setWound('cut_abrasion');
    session.setView('steps');

    session.beginDispatch('cmd-1', 2);
    assert.equal(session.reset('idle'), false, 'ห้ามล้างรอบทิ้งขณะคำสั่งยังบินอยู่');
    assert.deepEqual(events.reset, []);
    assert.equal(session.state.photo, 'data:image/jpeg;base64,AAAA', 'ของรอบเดิมต้องยังอยู่ครบ');
    assert.equal(session.dispatchState(), 'sending');

    session.settleDispatch({ success: true });
    assert.equal(session.reset('done'), true);

    const after = session.snapshot();
    assert.equal(after.woundId, null);
    assert.equal(after.photo, null);
    assert.equal(after.aiResult, null);
    assert.equal(after.method, null);
    assert.equal(after.view, 'start');
    assert.equal(after.dispensedOnce, false);
    assert.deepEqual(after.dispatch, { state: 'idle', commandId: null, error: null, drawer: null });
    assert.equal(session.idleMode(), 'interactive', 'รอบใหม่ต้องกลับไปใช้งบเวลาแบบเลือกเมนู');
    assert.equal(session.isIdleSuspended(), false);
    assert.equal(clock.pendingCount(), 2, 'รอบใหม่ต้องตั้งนาฬิกาว่างใหม่ให้เอง');
    assert.equal(session.canDispatch(), true, 'รอบใหม่สั่งตู้ได้ตามปกติ');
});

test('reset() ล้างเฉพาะข้อมูลของรอบ — ไม่มีคลังยาหรือประวัติคำสั่งอยู่ใน state ให้ล้าง', t => {
    const { session } = setup(t);
    session.setWound('insect');
    session.reset('manual');
    // negative invariant: สิ่งที่ reset() ล้างคือ object นี้ทั้งก้อน ถ้าวันหนึ่งมีใคร
    // ย้ายคลังยา/ประวัติคำสั่งเข้ามาไว้ในนี้ เทสข้อนี้ต้องแดงก่อนของจริงหาย
    assert.deepEqual(
        Object.keys(session.snapshot()).sort(),
        ['aiResult', 'dispatch', 'dispensedOnce', 'method', 'photo', 'view', 'woundId']
    );
    for (const key of Object.keys(session.snapshot())) {
        assert.ok(!/stock|inventory|journal|history|command_log/i.test(key), `state ไม่ควรถือ ${key}`);
    }
});

test('onReset ได้ afterUncertain:true เมื่อออกจากรอบที่ผลไม่ชัด และ false เมื่อรอบปกติ', t => {
    const uncertainRound = setup(t);
    uncertainRound.session.start();
    uncertainRound.session.beginDispatch('cmd-1', 2);
    uncertainRound.session.settleDispatch({ success: false });
    assert.equal(uncertainRound.session.reset('manual'), true);
    assert.deepEqual(uncertainRound.events.reset, [{ reason: 'manual', afterUncertain: true }]);

    const goodRound = setup(t);
    goodRound.session.start();
    goodRound.session.beginDispatch('cmd-1', 2);
    goodRound.session.settleDispatch({ success: true });
    assert.equal(goodRound.session.reset('done-timeout'), true);
    assert.deepEqual(goodRound.events.reset, [{ reason: 'done-timeout', afterUncertain: false }]);

    const plainRound = setup(t);
    plainRound.session.start();
    assert.equal(plainRound.session.reset(), true);
    assert.deepEqual(plainRound.events.reset, [{ reason: 'manual', afterUncertain: false }]);
});

// ── งบเวลาว่างต่อหน้าจอ ─────────────────────────────────────────────────────

test("setView('steps') ใช้งบเวลา reading ส่วนหน้าอื่นใช้ interactive", t => {
    const { session, clock, events } = setup(t);

    assert.equal(session.setView('steps'), 'steps');
    assert.equal(session.state.view, 'steps');
    assert.equal(session.idleMode(), 'reading');
    assert.equal(session.remainingMs(), IDLE_MS.reading);

    // เลยงบของหน้าเลือกเมนูไปแล้ว แต่หน้าอ่านวิธีทำแผลต้องยังไม่ตัด
    clock.advance(IDLE_MS.interactive + 1);
    assert.deepEqual(events.expire, [], 'ห้ามตัดกลางคำแนะนำด้วยงบเวลาของหน้าเลือกเมนู');
    assert.deepEqual(events.warn, []);

    assert.equal(session.setView('confirm'), 'confirm');
    assert.equal(session.idleMode(), 'interactive');
    assert.equal(session.remainingMs(), IDLE_MS.interactive);
    clock.advance(IDLE_MS.interactive);
    assert.equal(events.warn.length, 1);
    assert.equal(events.warn[0].mode, 'interactive');
    assert.equal(events.expire.length, 1);
    assert.equal(events.expire[0].mode, 'interactive');

    // โหมดที่ไม่รู้จักต้องตกมาที่ interactive ไม่ใช่ NaN แล้วนาฬิกาพัง
    assert.equal(session.setIdleMode('bogus'), 'interactive');
    assert.equal(session.remainingMs(), IDLE_MS.interactive);
});

test('เตือนล่วงหน้า WARNING_MS ก่อนหมดเวลา และ extend() ตั้งนาฬิกาใหม่สะอาด', t => {
    const { session, clock, events } = setup(t);
    session.start();
    assert.equal(session.hasWarned(), false);

    clock.advance(IDLE_MS.interactive - WARNING_MS - 1);
    assert.deepEqual(events.warn, [], 'ยังไม่ถึงเวลาเตือน');

    clock.advance(1);
    assert.equal(events.warn.length, 1);
    assert.deepEqual(events.warn[0], { remainingMs: WARNING_MS, mode: 'interactive' });
    assert.equal(session.hasWarned(), true);
    assert.equal(session.remainingMs(), WARNING_MS, 'เตือนล่วงหน้าเท่ากับ WARNING_MS พอดี');
    assert.deepEqual(events.expire, []);

    // กด "ใช้งานต่อ" — ต้องถอนนาฬิกาเดิมทิ้ง ไม่ใช่ตั้งซ้อน
    session.extend();
    assert.equal(session.hasWarned(), false);
    assert.equal(clock.pendingCount(), 2, 'ต้องเหลือ timer สองตัว ไม่ใช่สี่');
    assert.equal(session.remainingMs(), IDLE_MS.interactive);

    clock.advance(WARNING_MS + 1);
    assert.deepEqual(events.expire, [], 'นาฬิกาเดิมต้องถูกถอน ไม่มาหมดเวลาตามกำหนดเก่า');
    assert.equal(events.warn.length, 1);

    clock.advance(IDLE_MS.interactive);
    assert.equal(events.warn.length, 2, 'รอบใหม่ต้องเตือนอีกครั้ง');
    assert.equal(events.expire.length, 1);
});

test('stop() ถอนนาฬิกาทั้งหมด ปิดจอแล้วต้องไม่มีอะไรยิงตามมา', t => {
    const { session, clock, events } = setup(t);
    session.start();
    session.stop();
    assert.equal(clock.pendingCount(), 0);
    assert.equal(session.remainingMs(), null);
    clock.advance(IDLE_MS.reading * 3);
    assert.deepEqual(events.warn, []);
    assert.deepEqual(events.expire, []);
});

// ── สัญญาของโมดูล ───────────────────────────────────────────────────────────

test('โมดูลเปิดค่าคงที่และรายชื่อสถานะให้ผู้เรียกใช้ตรงกัน', t => {
    const { session } = setup(t);
    assert.deepEqual(KioskSession.DISPATCH_STATES, ['idle', 'sending', 'confirmed', 'rejected', 'uncertain']);
    assert.equal(session.IDLE_MS, KioskSession.IDLE_MS);
    assert.equal(session.WARNING_MS, KioskSession.WARNING_MS);
    assert.ok(WARNING_MS < IDLE_MS.interactive, 'เตือนต้องมาก่อนหมดเวลา');
    assert.ok(IDLE_MS.interactive < IDLE_MS.reading, 'หน้าอ่านวิธีทำแผลต้องได้เวลามากกว่า');

    // ทุกสถานะที่ settleDispatch/beginDispatch ผลิตได้ ต้องอยู่ในรายชื่อที่ประกาศไว้
    for (const result of [{ success: true }, { success: false, retrySafe: true }, { success: false }]) {
        const round = setup(t);
        round.session.start();
        round.session.beginDispatch('cmd', 1);
        assert.ok(KioskSession.DISPATCH_STATES.includes(round.session.settleDispatch(result)));
    }
});
