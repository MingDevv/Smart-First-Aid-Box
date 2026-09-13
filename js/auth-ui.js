(() => {
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
            try { await fn(); } catch { status.textContent = 'เข้าสู่ระบบไม่สำเร็จ ลองอีกครั้งด้วยบัญชี @tesaban6.ac.th'; }
            finally { button.disabled = false; }
        };
        signIn.onclick = () => action(signIn, () => AuthService.signIn());
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
                : 'ใช้บัญชี Google @tesaban6.ac.th ที่ยืนยันอีเมลแล้ว';
        });
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
})();
