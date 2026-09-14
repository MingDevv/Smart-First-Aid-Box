import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../js/auth-ui.js', import.meta.url), 'utf8');
function page({ code, userAgent = 'Mozilla/5.0 Safari/Chrome', local = false } = {}) {
    const elements = new Map(), body = { dataset: {}, prepend() {} };
    let calls = 0;
    const element = selector => {
        if (!elements.has(selector)) elements.set(selector, {});
        return elements.get(selector);
    };
    const context = vm.createContext({ navigator: { userAgent },
        window: { SFAB_RUNTIME: local ? { transport: 'pi-local' } : undefined },
        document: { body, readyState: 'complete', createElement() {
            return { setAttribute() {}, querySelector: element };
        } },
        AuthService: { isStaff: () => false, subscribe: fn => fn({ status: 'signed-out' }),
            async signIn() { calls++; if (code) throw { code }; }, async signOut() {} },
        location: { reload() {} }
    });
    vm.runInContext(source, context);
    return { elements, body, calls: () => calls };
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
        const button = p.elements.get('#google-sign-in');
        await button.onclick();
        const text = p.elements.get('#auth-status').textContent;
        assert.match(text, expected, code);
        copy.add(text);
        assert.equal(button.disabled, false);
        assert.equal(p.calls(), 1);
    }
    assert.equal(copy.size, 5, 'each failure needs its own recovery instruction');
});

test('in-app browsers show Safari/Chrome guidance before trying Google popup', async () => {
    for (const userAgent of ['Mozilla Line/16.1', 'Mozilla FBAN/FBIOS', 'Mozilla FBAV/300', 'Mozilla Instagram 20']) {
        const p = page({ userAgent });
        assert.match(p.elements.get('#auth-status').textContent, /เบราว์เซอร์ในแอป.*Safari\/Chrome/);
        await p.elements.get('#google-sign-in').onclick();
        assert.equal(p.calls(), 0, 'do not start OAuth inside the unsupported webview');
        assert.match(p.elements.get('#auth-status').textContent, /เปิดลิงก์นี้ใน Safari\/Chrome/);
    }
    const local = page({ local: true, userAgent: 'Line/16.1' });
    assert.equal(local.elements.size, 0, 'local kiosk does not acquire a sign-in panel');
    assert.equal(local.body.dataset.localKiosk, 'true');
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
