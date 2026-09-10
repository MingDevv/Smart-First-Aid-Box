import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// Execute the real page dispatch; rendering is exercised separately in Chromium.
const html = await readFile(new URL('../student/first-aid-guide.html', import.meta.url), 'utf8');
const dispatch = html.slice(html.indexOf('        async function startTreatment()'), html.indexOf('        let isDemoSession'));
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
    vm.runInContext(dispatch + timer, context);
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
