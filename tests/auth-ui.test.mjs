import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../js/auth-ui.js', import.meta.url), 'utf8');
function page({ code, userAgent = 'Mozilla/5.0 Safari/Chrome', local = false } = {}) {
    const elements = new Map(), body = { dataset: {}, prepend() {}, appendChild() {}, contains: () => false };
    const created = [];
    let calls = 0, modalOpens = 0;
    const element = selector => {
        if (!elements.has(selector)) elements.set(selector, { dataset: {}, focus() {}, setAttribute() {} });
        return elements.get(selector);
    };
    const context = vm.createContext({ navigator: { userAgent },
        window: { SFAB_RUNTIME: local ? { transport: 'pi-local' } : undefined },
        document: { body, readyState: 'complete', addEventListener() {}, createElement() {
            const node = { dataset: {}, setAttribute() {}, addEventListener() {}, querySelector: element,
                contains: () => false, focus() {}, get open() { return modalOpens > 0; },
                showModal() { modalOpens++; }, close() { modalOpens = 0; } };
            created.push(node);
            return node;
        } },
        AuthService: { isStaff: () => false, subscribe: fn => fn({ status: 'signed-out' }),
            async signIn() { calls++; if (code) throw { code }; }, async signOut() {} },
        location: { reload() {} }
    });
    vm.runInContext(source, context);
    return { elements, body, created, calls: () => calls, modalOpens: () => modalOpens };
}

test('sign-in failures explain popup blocking, domain setup, unsupported browsers and cancellation', async () => {
    const copy = new Set();
    for (const [code, expected] of [
        ['auth/popup-blocked', /อนุญาตป๊อปอัป/],
        ['auth/unauthorized-domain', /แจ้งครูผู้ดูแลระบบ/],
        ['auth/operation-not-supported-in-this-environment', /เปิดลิงก์นี้ใน Safari\/Chrome/],
        ['auth/popup-closed-by-user', /ยกเลิกการเข้าสู่ระบบ/],
        ['auth/unknown', /บัญชี @tesaban6.ac.th/]
    ]) {
        const p = page({ code });
        const button = p.elements.get('#auth-dialog-sign-in');
        await button.onclick();
        const text = p.elements.get('#auth-dialog-status').textContent;
        assert.match(text, expected, code);
        copy.add(text);
        assert.equal(button.disabled, false);
        assert.equal(p.calls(), 1);
    }
    assert.equal(copy.size, 5, 'each failure needs its own recovery instruction');
});

// ข้อความ error ต้องอยู่ติดปุ่มที่เพิ่งกด ไม่ใช่ไปโผล่บนชิปมุมจอที่คนไม่ได้มอง
test('the chip opens the dialog instead of starting sign-in from the corner', async () => {
    const p = page({});
    await p.elements.get('#auth-chip-button').onclick();
    assert.equal(p.calls(), 0, 'the corner chip must not start OAuth by itself');
    assert.equal(p.modalOpens(), 1, 'it opens the dialog where the Google button lives');
    assert.match(p.elements.get('#auth-dialog-reason').textContent, /บัญชีโรงเรียน/);
});

test('in-app browsers show Safari/Chrome guidance before trying Google popup', async () => {
    for (const userAgent of ['Mozilla Line/16.1', 'Mozilla FBAN/FBIOS', 'Mozilla FBAV/300', 'Mozilla Instagram 20']) {
        const p = page({ userAgent });
        assert.match(p.elements.get('.auth-chip-label').textContent, /Safari\/Chrome/);
        await p.elements.get('#auth-dialog-sign-in').onclick();
        assert.equal(p.calls(), 0, 'do not start OAuth inside the unsupported webview');
        assert.match(p.elements.get('#auth-dialog-status').textContent, /เปิดลิงก์นี้ใน Safari\/Chrome/);
    }
    const local = page({ local: true, userAgent: 'Line/16.1' });
    assert.equal(local.created.length, 0, 'local kiosk does not acquire a sign-in panel');
    assert.equal(local.body.dataset.localKiosk, 'true');
});

// ปุ่ม Google ต้องใช้โลโก้จริง ไม่ใช่ตัวอักษร G หรือ emoji และต้องเป็น SVG ที่มีสีทางการครบสี่สี
test('the Google button carries the real four-colour mark, not a letter or an emoji', () => {
    assert.match(source, /<svg class="google-mark"/);
    for (const hex of ['#EA4335', '#4285F4', '#FBBC05', '#34A853']) assert.ok(source.includes(hex), hex);
    assert.match(source, /ลงชื่อเข้าใช้ด้วย Google/);
    assert.ok(!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(source), 'no emoji anywhere in the auth UI');
});

test('scanner allows a verified student and starts the camera only after school sign-in', async () => {
    const html = await readFile(new URL('../student/wound-scan.html', import.meta.url), 'utf8');
    assert.match(html, /<body\s+data-auth-required="school"/);
    const start = html.indexOf("        document.addEventListener('DOMContentLoaded'");
    assert.notEqual(start, -1);
    const bootstrap = html.slice(start, html.indexOf('        function showToast', start));
    for (const local of [false, true]) {
        let starts = 0, stops = 0;
        vm.runInNewContext(bootstrap, {
            window: { SFAB_RUNTIME: local ? { transport: 'pi-local' } : undefined },
            document: { addEventListener: (_event, fn) => fn() },
            AuthService: { isStaff: () => false, subscribe: fn => {
                for (const status of ['loading', 'ready', 'signed-out']) fn({ status, role: 'student' });
            } }, startCamera: () => starts++, stopCamera: () => stops++
        });
        assert.equal(starts, 1, local ? 'local camera stays ungated' : 'school student can start camera');
        assert.equal(stops, local ? 0 : 2);
    }
});
