import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// Execute the real page dispatch; rendering is exercised separately in Chromium.
const html = await readFile(new URL('../student/first-aid-guide.html', import.meta.url), 'utf8');
// ตัดเอาเฉพาะตัว startTreatment ออกมารัน — จบที่ประกาศ `let` ตัวถัดไป ไม่ผูกกับชื่อตัวแปร
// ของเดิมผูกกับชื่อ `isDemoSession` พอมันถูกลบ indexOf คืน -1 แล้ว slice ลากไปถึง </script>
// เทสจึงพังด้วย SyntaxError ที่ชี้ไปคนละที่กับต้นเหตุ
const dispatchStart = html.indexOf('        async function startTreatment()');
const dispatchEnd = html.indexOf('\n        let ', dispatchStart);
assert.ok(dispatchStart > -1 && dispatchEnd > dispatchStart,
    'หา startTreatment ในหน้า guide ไม่เจอ — ตัวตัดโค้ดของเทสตกยุคแล้ว ไม่ใช่โค้ดพัง');
const dispatch = html.slice(dispatchStart, dispatchEnd);
assert.doesNotMatch(dispatch, /<\/script>/, 'ตัดโค้ดเลยขอบ <script> ไปแล้ว');
const timer = html.slice(html.indexOf('        function startDispensingTimer()'), html.indexOf('\n        function ', html.indexOf('        function startDispensingTimer()') + 10));
function page(openCompartment) {
    const elements = new Map();
    let ticks;
    let stopped = false;
    let now = 0;
    const context = vm.createContext({
        document: { getElementById(id) {
            if (!elements.has(id)) elements.set(id, { disabled: false, style: {}, textContent: '', innerHTML: '' });
            return elements.get(id);
        } },
        Date: { now: () => now },
        setInterval(fn) { ticks = fn; return 1; }, clearInterval() { stopped = true; },
        console: { error() {} },
        ApiBridge: { openCompartment }, NotificationService: { showToast() {} },
        matchedAllergiesForCurrentStudent: () => [], showDispensingView() {}, hideDispensingView() {},
        showStepsView() { context.stepsShown = true; }, escapeHtml: s => s,
        drawerOpened: false, wound: { id: 'cut_abrasion' }
    });
    // ต้องมี \n คั่น — ถ้าชิ้นแรกจบด้วยบรรทัดคอมเมนต์ `//` การต่อตรงๆ จะกลืนทั้งฟังก์ชันถัดไป
    // เข้าไปในคอมเมนต์ แล้วพังเป็น "Illegal return statement" ที่ชี้ไปคนละที่กับต้นเหตุ
    vm.runInContext(`${dispatch}\n${timer}`, context);
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

test('uncertain failures remain disabled, while explicitly unsent commands can be retried', async () => {
    for (const retrySafe of [true, false, undefined]) {
        const p = page(async () => ({ success: false, retrySafe, error: 'test failure' }));
        await p.context.startTreatment();
        assert.equal(p.context.drawerOpened, false);
        assert.notEqual(p.context.stepsShown, true);
        assert.equal(p.elements.get('manual-open-drawer-btn').disabled, retrySafe !== true);
        assert.equal(p.stopped(), true);
    }
});
