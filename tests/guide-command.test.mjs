import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// โหลด js/wound-data.js แบบเดียวกับที่เบราว์เซอร์โหลด คือรันเป็นสคริปต์ ไม่ใช่ require
// (เรพนี้ `"type": "module"` ⇒ require ไฟล์ .js คืนออบเจ็กต์ว่างโดยไม่ error — ยืนยัน 2026-09-19)
// ทำแบบนี้เพื่อให้เทสวัดของที่ส่งขึ้นเว็บจริง ไม่ใช่สำเนาที่เทสเขียนเอง
const woundData = vm.createContext({});
vm.runInContext(await readFile(new URL('../js/wound-data.js', import.meta.url), 'utf8'), woundData);
const { woundTriageBlockReason, woundTriageFor } = woundData;
assert.equal(typeof woundTriageBlockReason, 'function',
    'หา woundTriageBlockReason ใน js/wound-data.js ไม่เจอ — เกตคัดกรองหายไปจากไฟล์ที่เว็บโหลดจริง');

// รันฟังก์ชันจริงของหน้านั้น ส่วนการแสดงผลทดสอบแยกด้วย Chromium
const html = await readFile(new URL('../student/first-aid-guide.html', import.meta.url), 'utf8');
// ตัดเอาเฉพาะตัว startTreatment ออกมารัน — จบที่ประกาศ `let` ตัวถัดไป ไม่ผูกกับชื่อตัวแปร
// ของเดิมผูกกับชื่อ `isDemoSession` พอมันถูกลบ indexOf คืน -1 แล้ว slice ลากไปถึง </script>
// เทสจึงพังด้วย SyntaxError ที่ชี้ไปคนละที่กับต้นเหตุ
const dispatchStart = html.indexOf('        async function startTreatment()');
const dispatchEnd = html.indexOf('\n        let ', dispatchStart);
assert.ok(dispatchStart > -1 && dispatchEnd > dispatchStart,
    'หา startTreatment ในหน้า guide ไม่เจอ — ตัวตัดโค้ดของเทสตกยุคแล้ว ไม่ใช่โค้ดพัง');
const dispatch = html.slice(dispatchStart, dispatchEnd);
const screening = html.slice(html.indexOf('        function renderTriage()'), dispatchStart);
assert.doesNotMatch(dispatch, /<\/script>/, 'ตัดโค้ดเลยขอบ <script> ไปแล้ว');
const timer = html.slice(html.indexOf('        function startDispensingTimer()'), html.indexOf('\n        function ', html.indexOf('        function startDispensingTimer()') + 10));
// ค่าเริ่มต้นคือ "ตอบแล้วว่าไม่เคยแพ้" เพราะเทสสองใบเดิมวัดเรื่องการรอตู้ ไม่ใช่เรื่องเกต
function page(openCompartment, { woundId = 'cut_abrasion', triageAnswer = 'no' } = {}) {
    const elements = new Map();
    let ticks;
    let stopped = false;
    let now = 0;
    const context = vm.createContext({
        document: { createElement() {
            return { dataset: {}, setAttribute() {}, addEventListener() {} };
        }, getElementById(id) {
            if (!elements.has(id)) elements.set(id, { disabled: false, style: {}, dataset: {}, textContent: '', innerHTML: '', replaceChildren() {} });
            return elements.get(id);
        } },
        Date: { now: () => now },
        setInterval(fn) { ticks = fn; return 1; }, clearInterval() { stopped = true; },
        console: { error() {} },
        ApiBridge: { openCompartment }, NotificationService: { showToast() {} },
        matchedAllergiesForCurrentStudent: () => [], showDispensingView() {}, hideDispensingView() {},
        showStepsView() { context.stepsShown = true; }, escapeHtml: s => s,
        // ใช้ตัวจริงจาก js/wound-data.js ไม่ใช่ stub — เกตนี้คือสิ่งที่กันไม่ให้เด็กที่แพ้ได้ยา
        // ถ้า stub ไว้ เทสจะเขียวต่อไปแม้เกตถูกลบออกจากหน้าเว็บ
        woundTriageBlockReason, woundTriageFor,
        WOUND_TRIAGE_DEFAULT: vm.runInContext('WOUND_TRIAGE_DEFAULT', woundData),
        drawerOpened: false, dispatchLocked: false, wound: { id: woundId }, triageAnswer
    });
    // ต้องมี \n คั่น — ถ้าชิ้นแรกจบด้วยบรรทัดคอมเมนต์ `//` การต่อตรงๆ จะกลืนทั้งฟังก์ชันถัดไป
    // เข้าไปในคอมเมนต์ แล้วพังเป็น "Illegal return statement" ที่ชี้ไปคนละที่กับต้นเหตุ
    vm.runInContext(`${screening}\n${dispatch}\n${timer}`, context);
    return { context, elements, elapsed(ms) { now = ms; ticks(); }, stopped: () => stopped };
}

test('guide keeps waiting past seven seconds and blocks a second click until exact success', async () => {
    let resolve, calls = 0;
    const p = page(() => { calls++; return new Promise(r => { resolve = r; }); });
    const pending = p.context.startTreatment();
    p.elapsed(10000);
    await p.context.startTreatment();
    assert.equal(calls, 1);
    assert.equal(p.elements.get('dispensing-countdown-num').textContent, 10);
    assert.equal(p.context.drawerOpened, false);
    assert.notEqual(p.context.stepsShown, true);
    assert.equal(p.stopped(), false);
    resolve({ success: true });
    await pending;
    assert.equal(p.context.drawerOpened, true);
    assert.equal(p.context.stepsShown, true);
    assert.equal(p.stopped(), true);
});

// เกตคัดกรองบนหน้าเว็บ — ของเดิมมีแต่บนจอตู้ หน้าเว็บจ่ายให้ทุกคนโดยไม่ถามอะไรเลย (แก้ 2026-09-19)
test('the web refuses to dispense until the screening question is answered safely', async () => {
    const blocked = [
        // แผลทั่วไป: ยังไม่ตอบ / เคยแพ้ / ไม่แน่ใจ
        ['cut_abrasion', null], ['cut_abrasion', 'yes'], ['cut_abrasion', 'unsure'],
        // แมลงกัดต่อย: ยังไม่ตอบ / บวม / แน่นหน้าอก
        ['insect', null], ['insect', 'swelling'], ['insect', 'chest_tightness'],
        // ค่าที่ไม่อยู่ในรายการของแผลนั้น ต้องนับเป็น "ยังไม่ตอบ" ไม่ใช่ปล่อยผ่าน
        ['insect', 'no'], ['cut_abrasion', 'none'], ['cut_abrasion', 'ไม่เคยแพ้']
    ];
    for (const [woundId, triageAnswer] of blocked) {
        let calls = 0;
        const p = page(() => { calls++; return Promise.resolve({ success: true }); }, { woundId, triageAnswer });
        await p.context.startTreatment();
        assert.equal(calls, 0, `${woundId}/${triageAnswer} ต้องไม่ยิงคำสั่งไปที่ตู้เลย`);
        assert.equal(p.context.drawerOpened, false);
        assert.notEqual(p.context.stepsShown, true);
        assert.match(p.elements.get('hardware-log').textContent, /\S/, 'ต้องบอกเหตุผลบนจอ ไม่ใช่เงียบ');
    }
});

test('a safe answer lets the command through, for both question sets', async () => {
    for (const [woundId, triageAnswer] of [['cut_abrasion', 'no'], ['insect', 'none']]) {
        let calls = 0;
        const p = page(() => { calls++; return Promise.resolve({ success: true }); }, { woundId, triageAnswer });
        await p.context.startTreatment();
        assert.equal(calls, 1, `${woundId}/${triageAnswer} ตอบปลอดภัยแล้วต้องสั่งตู้ได้`);
        assert.equal(p.context.drawerOpened, true);
    }
});

test('uncertain failures remain disabled, while explicitly unsent commands can be retried', async () => {
    for (const retrySafe of [true, false, undefined]) {
        const p = page(async () => ({ success: false, retrySafe, error: 'test failure' }));
        await p.context.startTreatment();
        assert.equal(p.context.drawerOpened, false);
        assert.notEqual(p.context.stepsShown, true);
        assert.equal(p.elements.get('manual-open-drawer-btn').disabled, retrySafe !== true);
        p.context.answerTriage({ value: 'no' });
        assert.equal(p.elements.get('manual-open-drawer-btn').disabled, retrySafe !== true,
            'Changing the answer must not release an uncertain command');
        assert.equal(p.stopped(), true);
    }
});

test('unlock stays disabled until a safe answer and disables again when that answer changes', () => {
    for (const [woundId, safeAnswer, blockedAnswer] of [
        ['cut_abrasion', 'no', 'unsure'], ['insect', 'none', 'swelling']
    ]) {
        const p = page(() => assert.fail('Rendering screening must not send a command'), { woundId, triageAnswer: null });
        const button = p.context.document.getElementById('manual-open-drawer-btn');
        p.context.renderTriage();
        assert.equal(button.disabled, true, 'Unanswered screening must disable unlock');
        assert.match(p.elements.get('unlock-hint').textContent, /ตอบคำถาม/);
        p.context.triageAnswer = safeAnswer;
        p.context.renderTriage();
        assert.equal(button.disabled, false, 'A safe answer enables unlock');
        p.context.triageAnswer = blockedAnswer;
        p.context.renderTriage();
        assert.equal(button.disabled, true, 'An unsafe answer disables unlock again');
        assert.match(p.elements.get('unlock-hint').textContent, /ครูพยาบาล/);
    }
});
