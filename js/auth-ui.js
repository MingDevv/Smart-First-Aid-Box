(() => {
    const inAppBrowser = /Line\/|FBAN|FBAV|Instagram/i.test(navigator.userAgent);
    const openBrowserCopy = 'เบราว์เซอร์ในแอปไม่รองรับการเข้าสู่ระบบ Google กรุณาเปิดลิงก์นี้ใน Safari/Chrome';
    const signInErrorCopy = error => {
        if (inAppBrowser) return openBrowserCopy;
        const code = error?.code || '';
        if (code === 'auth/popup-blocked') return 'เบราว์เซอร์บล็อกหน้าต่างเข้าสู่ระบบ กรุณาอนุญาตป๊อปอัปแล้วลองอีกครั้ง';
        if (code === 'auth/unauthorized-domain') return 'เว็บไซต์นี้ยังไม่ได้รับอนุญาตให้เข้าสู่ระบบ กรุณาแจ้งครูผู้ดูแลระบบ';
        if (code.startsWith('auth/operation-not-supported-')) return 'เบราว์เซอร์นี้ไม่รองรับการเข้าสู่ระบบ กรุณาเปิดลิงก์นี้ใน Safari/Chrome';
        if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') return 'ยกเลิกการเข้าสู่ระบบแล้ว กดเข้าสู่ระบบด้วย Google เมื่อต้องการลองอีกครั้ง';
        return 'เข้าสู่ระบบไม่สำเร็จ ลองอีกครั้งด้วยบัญชี @tesaban6.ac.th';
    };
    const start = () => {
        if (window.SFAB_RUNTIME?.transport === 'pi-local') { document.body.dataset.localKiosk = 'true'; return; }
        const panel = document.createElement('section');
        panel.id = 'auth-panel';
        panel.setAttribute('aria-label', 'School account');
        panel.innerHTML = '<div><strong>บัญชีโรงเรียน</strong><p id="auth-status" role="status" aria-live="polite">กำลังตรวจสอบบัญชี…</p></div><div class="auth-actions"><button id="google-sign-in" type="button">เข้าสู่ระบบด้วย Google</button><button id="google-sign-out" type="button" hidden>ออกจากระบบ</button><button id="auth-retry" type="button" hidden>ลองอีกครั้ง</button><a href="/student/wound-select">คู่มือปฐมพยาบาล</a></div>';
        document.body.prepend(panel);
        const signIn = panel.querySelector('#google-sign-in'), signOut = panel.querySelector('#google-sign-out');
        const status = panel.querySelector('#auth-status'), retry = panel.querySelector('#auth-retry');
        const action = async (button, fn) => {
            button.disabled = true;
            try { await fn(); } catch (error) { status.textContent = signInErrorCopy(error); }
            finally { button.disabled = false; }
        };
        signIn.onclick = () => action(signIn, () => {
            if (inAppBrowser) { status.textContent = openBrowserCopy; return; }
            return AuthService.signIn();
        });
        signOut.onclick = () => action(signOut, () => AuthService.signOut());
        retry.onclick = () => location.reload();
        AuthService.subscribe(state => {
            const ready = state.status === 'ready';
            const staff = AuthService.isStaff();
            const required = document.body.dataset.authRequired;
            document.body.dataset.authReady = String(ready && (required !== 'staff' || staff));
            document.body.dataset.staff = String(staff);
            signIn.hidden = ready;
            signOut.hidden = !ready;
            signIn.disabled = state.status === 'loading';
            retry.hidden = state.status !== 'unavailable';
            status.textContent = ready
                ? `${state.user.name || state.user.email}${required === 'staff' && !staff ? ' · บัญชีนี้ไม่มีสิทธิ์สำหรับครู' : ''}`
                : state.status === 'loading' ? 'กำลังตรวจสอบบัญชี…'
                : state.status === 'unavailable' ? 'ระบบบัญชียังไม่พร้อม กรุณาลองอีกครั้ง หรือเรียกครูใกล้ที่สุด'
                : inAppBrowser ? openBrowserCopy : 'ใช้บัญชี Google @tesaban6.ac.th ที่ยืนยันอีเมลแล้ว';
        });
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
})();
