// หน้าตาของบัญชีโรงเรียน — ชิปมุมจอ + กล่องโต้ตอบหนึ่งตัวที่ทำสองหน้าที่
//
// ของเดิมเป็น `<section>` ก้อนเดียวที่ prepend เข้า body ทุกหน้า ⇒ กลายเป็นบล็อกแรกของหน้าและ
// **กินพื้นที่เลย์เอาต์จริง** หน้าแรกที่เป็นสามคอลัมน์เลยถูกดันจนเสียองค์ประกอบ
// (Bank เห็นเองบน production 2026-09-14)
//
// โครงใหม่มีสองชิ้น ตามบทบาทที่ต่างกันจริง:
//   • ชิปมุมขวาบน — บอกว่าตอนนี้เป็นใคร · `position: fixed` จึงไม่กินเลย์เอาต์เลย
//   • `<dialog>` ตัวเดียว ใช้ทั้ง (ก) หน้าที่ `data-auth-required` ซึ่งเข้าไม่ได้ถ้าไม่ล็อกอิน
//     และ (ข) ตอนกดปุ่มที่ต้องล็อกอินก่อน เช่น เลือกประเภทแผล — เด้งบอกแล้วพาไปล็อกอินตรงนั้น
//     แทนที่จะปล่อยให้เดินไปชนกำแพงข้างหน้า · ใช้ `<dialog>` ของเบราว์เซอร์เพื่อให้ได้ focus trap
//     ปุ่ม Escape และ backdrop มาฟรี แทนที่จะเขียนเองแล้วพลาดเรื่องคีย์บอร์ด
(() => {
    const inAppBrowser = /Line\/|FBAN|FBAV|Instagram/i.test(navigator.userAgent);
    const openBrowserCopy = 'เบราว์เซอร์ในแอปไม่รองรับการเข้าสู่ระบบ Google กรุณาเปิดลิงก์นี้ใน Safari/Chrome';
    const ROLE_TH = { teacher: 'ครู', admin: 'ผู้ดูแลระบบ', student: 'นักเรียน' };

    // โลโก้ Google ตัวจริงตามชุดสีทางการ ไม่ใช่ไอคอนวาดเอง และไม่ใช่ emoji
    // แนวทางแบรนด์ของ Google กำหนดว่าปุ่มต้องมีโลโก้นี้ พื้นขาว ขอบเทา และข้อความว่า "ลงชื่อเข้าใช้ด้วย Google"
    const GOOGLE_MARK = '<svg class="google-mark" viewBox="0 0 48 48" width="20" height="20" aria-hidden="true" focusable="false">'
        + '<path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>'
        + '<path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>'
        + '<path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>'
        + '<path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>';

    const signInErrorCopy = error => {
        if (inAppBrowser) return openBrowserCopy;
        const code = error?.code || '';
        if (code === 'auth/popup-blocked') return 'เบราว์เซอร์บล็อกหน้าต่างเข้าสู่ระบบ กรุณาอนุญาตป๊อปอัปแล้วลองอีกครั้ง';
        if (code === 'auth/unauthorized-domain') return 'เว็บไซต์นี้ยังไม่ได้รับอนุญาตให้เข้าสู่ระบบ กรุณาแจ้งครูผู้ดูแลระบบ';
        if (code.startsWith('auth/operation-not-supported-')) return 'เบราว์เซอร์นี้ไม่รองรับการเข้าสู่ระบบ กรุณาเปิดลิงก์นี้ใน Safari/Chrome';
        if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') return 'ยกเลิกการเข้าสู่ระบบแล้ว กดปุ่มลงชื่อเข้าใช้อีกครั้งได้เลย';
        return 'เข้าสู่ระบบไม่สำเร็จ ลองอีกครั้งด้วยบัญชี @tesaban6.ac.th';
    };
    // ชิปมีที่แคบและชื่อเต็มของครูไทยยาวเกินเสมอ · ชิปโชว์คำแรก เมนูโชว์ชื่อกับอีเมลเต็ม
    const shortName = user => (user?.name || user?.email || '').trim().split(/\s+/)[0] || 'บัญชีโรงเรียน';

    const start = () => {
        if (window.SFAB_RUNTIME?.transport === 'pi-local') { document.body.dataset.localKiosk = 'true'; return; }
        const gated = document.body.dataset.authRequired !== undefined;

        const chip = document.createElement('div');
        chip.id = 'auth-chip';
        chip.dataset.state = 'loading';
        chip.innerHTML =
            '<button id="auth-chip-button" type="button" aria-haspopup="menu" aria-expanded="false" aria-controls="auth-menu">'
            + '<span class="auth-dot" aria-hidden="true"></span><span class="auth-chip-label">กำลังตรวจสอบบัญชี</span></button>'
            + '<div id="auth-menu" role="menu" hidden>'
            + '<p class="auth-menu-name"></p><p class="auth-menu-email"></p><p class="auth-menu-role"></p>'
            + '<button id="google-sign-out" type="button" role="menuitem">ออกจากระบบ</button></div>';
        document.body.appendChild(chip);

        const dialog = document.createElement('dialog');
        dialog.id = 'auth-dialog';
        dialog.setAttribute('aria-labelledby', 'auth-dialog-title');
        dialog.innerHTML =
            '<form method="dialog" class="auth-dialog-dismiss"><button type="submit" aria-label="ปิด">'
            + '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">'
            + '<path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>'
            + '</button></form>'
            // path เริ่มด้วย / เพราะกล่องนี้ถูกแทรกจากหน้าที่อยู่คนละชั้น (/, /student/, /dashboard/)
            + '<img class="auth-dialog-logo" src="/images/logo_first_aid.webp" width="56" height="56" alt="">'
            + '<h2 id="auth-dialog-title">เข้าสู่ระบบก่อนใช้งาน</h2>'
            + '<p id="auth-dialog-reason"></p>'
            + '<button id="auth-dialog-sign-in" class="google-button" type="button">' + GOOGLE_MARK
            + '<span>ลงชื่อเข้าใช้ด้วย Google</span></button>'
            + '<p id="auth-dialog-status" role="status" aria-live="polite"></p>'
            + '<p class="auth-dialog-hint">ใช้บัญชีของโรงเรียนที่ลงท้ายด้วย <b>@tesaban6.ac.th</b></p>'
            // ทางถอยชี้หน้าแรก ซึ่งเข้าได้เสมอโดยไม่ต้องล็อกอิน
            // (ของเดิมชี้ไปหน้าเลือกแผล ซึ่งตอนนี้ก็ต้องล็อกอินเหมือนกัน = ทางตันที่ดูเหมือนทางออก)
            + '<a class="auth-dialog-escape" href="/">กลับหน้าแรก</a>';
        document.body.appendChild(dialog);

        const chipButton = chip.querySelector('#auth-chip-button');
        const chipLabel = chip.querySelector('.auth-chip-label');
        const menu = chip.querySelector('#auth-menu');
        const signOutButton = chip.querySelector('#google-sign-out');
        const dialogButton = dialog.querySelector('#auth-dialog-sign-in');
        const dialogReason = dialog.querySelector('#auth-dialog-reason');
        const dialogStatus = dialog.querySelector('#auth-dialog-status');
        const dialogDismiss = dialog.querySelector('.auth-dialog-dismiss');

        const closeMenu = () => { menu.hidden = true; chipButton.setAttribute('aria-expanded', 'false'); };
        const toggleMenu = () => {
            const open = menu.hidden;
            menu.hidden = !open;
            chipButton.setAttribute('aria-expanded', String(open));
            if (open) signOutButton.focus();
        };
        // เมนูที่ปิดไม่ได้คือกับดัก โดยเฉพาะบนจอสัมผัส — ปิดได้ทั้งแตะนอกและ Escape
        document.addEventListener('click', event => { if (!chip.contains(event.target)) closeMenu(); });
        document.addEventListener('keydown', event => {
            if (event.key === 'Escape' && !menu.hidden) { closeMenu(); chipButton.focus(); }
        });

        const openDialog = (reason, { dismissible = true } = {}) => {
            dialogReason.textContent = reason;
            dialogStatus.textContent = '';
            // หน้าที่เข้าไม่ได้เลยถ้าไม่ล็อกอิน ไม่ควรมีปุ่มปิดที่พาไปหน้าว่างเปล่า
            dialogDismiss.hidden = !dismissible;
            if (!dialog.open) dialog.showModal();
            dialogButton.focus();
        };
        // กันปิดด้วย Escape เฉพาะกรณีที่ปิดแล้วไม่เหลืออะไรให้ดู
        dialog.addEventListener('cancel', event => { if (dialogDismiss.hidden) event.preventDefault(); });

        // ข้อความ error ไปไว้ติดกับปุ่มที่เพิ่งกด — คนอ่านตรงที่มือเพิ่งแตะ ไม่ใช่หัวหน้าจอ
        const run = async (button, fn, report) => {
            button.disabled = true;
            try { await fn(); } catch (error) { report(signInErrorCopy(error)); }
            finally { button.disabled = false; }
        };
        const doSignIn = (button, report) => run(button, () => {
            if (inAppBrowser) { report(openBrowserCopy); return; }
            return AuthService.signIn();
        }, report);

        chipButton.onclick = () => {
            const state = chip.dataset.state;
            if (state === 'ready') return toggleMenu();
            if (state === 'unavailable') return location.reload();
            return openDialog('กรุณาเข้าสู่ระบบด้วยบัญชีโรงเรียนก่อนใช้งาน');
        };
        signOutButton.onclick = () => { closeMenu(); return run(signOutButton, () => AuthService.signOut(), () => {}); };
        dialogButton.onclick = () => doSignIn(dialogButton, message => { dialogStatus.textContent = message; });

        // ทางเรียกจากโค้ดอื่น (เช่นปุ่ม SOS ที่ต้องล็อกอินก่อน) — ให้ hook ที่มีชื่อ แทนที่จะให้เขา
        // ไปหา element ด้วย id เอง · ของเดิม `getElementById('google-sign-in')?.focus()` พังเงียบทันที
        // ที่หน้าตาเปลี่ยน และเทสก็ยังเขียวเพราะ stub สร้าง element ปลอมให้
        window.AuthUI = { promptSignIn: reason => openDialog(reason || 'กรุณาเข้าสู่ระบบด้วยบัญชีโรงเรียนก่อนใช้งาน') };

        // ปุ่มที่ต้องล็อกอินก่อน ประกาศด้วย `data-requires-auth` ในหน้า ไม่ใช่เดาจาก URL ในนี้
        // ค่าของแอตทริบิวต์คือเหตุผลที่จะบอกผู้ใช้ — เขียนให้ตรงกับปุ่มที่เพิ่งกด ไม่ใช่ข้อความกลางๆ
        // ดักที่ capture phase เพราะการ์ดแผลผูก onclick ไว้บนตัวเอง ถ้ารอ bubble มันจะวิ่งไปแล้ว
        document.addEventListener('click', event => {
            const trigger = event.target.closest?.('[data-requires-auth]');
            if (!trigger || document.body.dataset.authReady === 'true') return;
            if (chip.dataset.state === 'loading') return;   // ยังไม่รู้ว่าล็อกอินอยู่ไหม อย่าเพิ่งขวาง
            event.preventDefault();
            event.stopPropagation();
            openDialog(trigger.dataset.requiresAuth || 'กรุณาเข้าสู่ระบบด้วยบัญชีโรงเรียนก่อนใช้งาน');
        }, true);

        AuthService.subscribe(state => {
            const ready = state.status === 'ready';
            const staff = AuthService.isStaff();
            const required = document.body.dataset.authRequired;
            document.body.dataset.authReady = String(ready && (required !== 'staff' || staff));
            document.body.dataset.staff = String(staff);
            // บทบาทที่ละเอียดกว่า `staff` — เมนูบางอันเป็นของ admin เท่านั้น
            // ซ่อนสิ่งที่กดไปก็ทำไม่ได้ ดีกว่าปล่อยให้กดแล้วเจอ 403
            document.body.dataset.role = ready ? (state.role || '') : '';
            chip.dataset.state = state.status;
            if (!ready) closeMenu();

            if (ready) {
                chipLabel.textContent = shortName(state.user);
                chip.querySelector('.auth-menu-name').textContent = state.user.name || '';
                chip.querySelector('.auth-menu-email').textContent = state.user.email || '';
                chip.querySelector('.auth-menu-role').textContent = ROLE_TH[state.role] || state.role || '';
            } else {
                chipLabel.textContent = state.status === 'loading' ? 'กำลังตรวจสอบบัญชี'
                    : state.status === 'unavailable' ? 'ลองอีกครั้ง'
                    : inAppBrowser ? 'เปิดใน Safari/Chrome'
                    : 'เข้าสู่ระบบ';
            }

            if (document.body.dataset.authReady === 'true') { if (dialog.open) dialog.close(); return; }
            if (!gated || state.status === 'loading') return;
            // หน้านี้เข้าไม่ได้จนกว่าจะล็อกอิน กล่องจึงเปิดค้างและปิดไม่ได้ — ปิดแล้วเหลือหน้าว่าง
            openDialog(
                ready && required === 'staff' && !staff
                    ? `${state.user.email} ยังไม่มีสิทธิ์สำหรับครู กรุณาแจ้งครูผู้ดูแลระบบเพื่อขอสิทธิ์`
                    : state.status === 'unavailable' ? 'ระบบบัญชียังไม่พร้อม กรุณาลองอีกครั้ง หรือเรียกครูที่อยู่ใกล้ที่สุด'
                    : state.status === 'forbidden' ? 'ต้องใช้บัญชี Google ของโรงเรียนที่ยืนยันอีเมลแล้ว'
                    : 'กรุณาเข้าสู่ระบบด้วยบัญชีโรงเรียนก่อนใช้งาน',
                { dismissible: false });
        });
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
})();
