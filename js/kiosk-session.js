// JS/KIOSK-SESSION.JS — ตัวคุมรอบการใช้งานของหน้าตู้
//
// ไฟล์นี้ตั้งใจไม่แตะ DOM เลย เพื่อให้เทสเรียกฟังก์ชันจริงได้ใน Node ไม่ใช่ regex หา
// สตริงในซอร์ส (กับดักที่ทำให้บั๊ก SOS false-success หลุดมาถึง production เมื่อ 2026-09-10)
//
// ⚠️ วิธีโหลดใน Node: ใช้ vm ป้อน `module` กับ `window` ให้ตัวห่อเอง แบบเดียวกับ
// tests/local.test.mjs และ tests/edge.test.mjs ทำกับ js/api-bridge.js
// **ห้ามใช้ createRequire** — package.json ตั้ง "type": "module" ไว้ Node จึงโหลด .js
// นี้เป็น ESM ซึ่งไม่มีทั้ง `module` และ `window` ⇒ สองบรรทัดล่างไม่ทำงานสักบรรทัด
// แล้ว require() คืน {} เปล่าโดยไม่ throw — เทสจะ "ผ่าน" ทั้งที่ทดสอบอ็อบเจ็กต์ว่าง
// ตัวอย่างการโหลดที่ถูกอยู่ใน tests/kiosk-session.test.mjs
//
// สองกฎที่ทั้งไฟล์นี้มีอยู่เพื่อบังคับ:
//   1. คำสั่งที่ส่งไปแล้วผลไม่ชัด ห้ามส่งซ้ำ และห้ามให้ timer เปิดรอบใหม่ทับ
//   2. จบรอบต้องล้างข้อมูลของผู้ใช้คนนั้น แต่ห้ามล้างประวัติคำสั่ง (กันเล่นซ้ำ)

(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (root) root.KioskSession = api;
}(typeof window !== 'undefined' ? window : null, function () {
    'use strict';

    // เวลาว่างก่อนรีเซ็ต — ค่าเริ่มต้นตามแผน §4 ปรับได้หลังทดลองกับผู้ใช้จริง
    const IDLE_MS = {
        // เลือก/กรอก: 60 วินาที เตือนล่วงหน้า 15 วินาที
        interactive: 60000,
        // อ่านวิธีทำแผล: ให้เวลานานขึ้น ไม่ตัดกลางคำแนะนำ
        reading: 180000
    };
    const WARNING_MS = 15000;

    // ผลของคำสั่งฮาร์ดแวร์ แยก "ยังไม่ได้ส่ง" ออกจาก "ส่งแล้วไม่รู้ผล" ให้ขาด
    //   idle      — ยังไม่เคยสั่งในรอบนี้
    //   sending   — ส่งแล้ว กำลังรอคำตอบ
    //   confirmed — ตู้ ACK ตรงคำสั่ง (ยังไม่ใช่หลักฐานว่าของออกมาจริง)
    //   rejected  — ยังไม่ได้ส่งหรือตู้ปฏิเสธ ⇒ ลองใหม่ได้อย่างปลอดภัย
    //   uncertain — ส่งไปแล้วแต่ยืนยันผลไม่ได้ ⇒ ห้ามสั่งซ้ำเด็ดขาด
    const DISPATCH = ['idle', 'sending', 'confirmed', 'rejected', 'uncertain'];

    function emptyState() {
        return {
            view: 'start',
            method: null,       // 'ai-scan' | 'manual'
            woundId: null,
            aiResult: null,     // { woundId, confidence, description }
            photo: null,        // data URL ของรอบนี้ ล้างทุกครั้งที่จบรอบ
            dispatch: { state: 'idle', commandId: null, error: null, drawer: null },
            dispensedOnce: false
        };
    }

    function create(options) {
        const opts = options || {};
        const now = opts.now || (() => Date.now());
        const setTimer = opts.setTimer || ((fn, ms) => setTimeout(fn, ms));
        const clearTimer = opts.clearTimer || (id => clearTimeout(id));
        const onWarn = opts.onIdleWarning || (() => {});
        const onExpire = opts.onIdleExpired || (() => {});
        const onReset = opts.onReset || (() => {});

        let state = emptyState();
        let idleMode = 'interactive';
        let idleSuspended = false;
        let warnTimer = null;
        let expireTimer = null;
        let warned = false;
        let deadlineAt = 0;

        function clearTimers() {
            if (warnTimer !== null) clearTimer(warnTimer);
            if (expireTimer !== null) clearTimer(expireTimer);
            warnTimer = null;
            expireTimer = null;
        }

        function armTimers() {
            clearTimers();
            warned = false;
            if (idleSuspended) {
                deadlineAt = 0;
                return;
            }
            const total = IDLE_MS[idleMode] || IDLE_MS.interactive;
            const warnIn = Math.max(0, total - WARNING_MS);
            deadlineAt = now() + total;
            warnTimer = setTimer(() => {
                warned = true;
                onWarn({ remainingMs: WARNING_MS, mode: idleMode });
            }, warnIn);
            expireTimer = setTimer(() => {
                // กันเผลอ: ถ้าระหว่างนั้นมีคำสั่งค้าง ห้ามรีเซ็ตทับ
                if (idleSuspended) return;
                onExpire({ mode: idleMode });
            }, total);
        }

        const session = {
            IDLE_MS,
            WARNING_MS,
            DISPATCH_STATES: DISPATCH,

            get state() {
                return state;
            },

            snapshot() {
                return JSON.parse(JSON.stringify(state));
            },

            // ── นาฬิกาว่าง ────────────────────────────────────────────────

            start() {
                armTimers();
                return session;
            },

            // แตะจอ = ต่ออายุ แต่ไม่ปลุกนาฬิกาที่ถูกพักไว้ระหว่างรอตู้
            touch() {
                if (idleSuspended) return false;
                armTimers();
                return true;
            },

            // ปุ่ม "ใช้งานต่อ" บนหน้าเตือนหมดเวลา
            extend() {
                armTimers();
                return session;
            },

            setIdleMode(mode) {
                idleMode = IDLE_MS[mode] ? mode : 'interactive';
                armTimers();
                return idleMode;
            },

            idleMode() {
                return idleMode;
            },

            isIdleSuspended() {
                return idleSuspended;
            },

            hasWarned() {
                return warned;
            },

            remainingMs() {
                if (idleSuspended || !deadlineAt) return null;
                return Math.max(0, deadlineAt - now());
            },

            // ── ความคืบหน้าของรอบ ────────────────────────────────────────

            setView(view) {
                state.view = view;
                // อ่านคำแนะนำใช้เวลานานกว่าเลือกเมนู ให้เวลาต่างกันตามแผน §4
                session.setIdleMode(view === 'steps' ? 'reading' : 'interactive');
                return state.view;
            },

            setMethod(method) {
                state.method = method === 'ai-scan' ? 'ai-scan' : 'manual';
                return state.method;
            },

            setPhoto(dataUrl) {
                state.photo = dataUrl || null;
                return state.photo;
            },

            setAiResult(result) {
                state.aiResult = result || null;
                return state.aiResult;
            },

            setWound(woundId) {
                state.woundId = woundId || null;
                return state.woundId;
            },

            // ── คำสั่งฮาร์ดแวร์ ───────────────────────────────────────────

            // จริงเมื่อยังไม่เคยสั่งสำเร็จในรอบนี้ และไม่มีคำสั่งค้างอยู่
            canDispatch() {
                const s = state.dispatch.state;
                return !state.dispensedOnce && (s === 'idle' || s === 'rejected');
            },

            // คืน false ถ้าถูกกดซ้ำหรือสถานะไม่อนุญาต — ผู้เรียกต้องไม่ยิงต่อ
            beginDispatch(commandId, drawer) {
                if (!session.canDispatch()) return false;
                state.dispatch = {
                    state: 'sending',
                    commandId: commandId || null,
                    error: null,
                    drawer: typeof drawer === 'number' ? drawer : null
                };
                // ระหว่างรอตู้ ห้ามนาฬิกาว่างรีเซ็ตหน้าจอทิ้งคำสั่งที่ค้างอยู่
                idleSuspended = true;
                clearTimers();
                deadlineAt = 0;
                return true;
            },

            // แปลงผลจาก ApiBridge เป็นสถานะที่ UI ใช้ตัดสินใจได้
            // ApiBridge สัญญาไว้ว่า retrySafe === true แปลว่า "ยังไม่ได้ส่งคำสั่งออกไป"
            settleDispatch(result) {
                const res = result || {};
                let next;
                if (res.success === true) next = 'confirmed';
                else if (res.retrySafe === true) next = 'rejected';
                else next = 'uncertain';

                state.dispatch = {
                    state: next,
                    commandId: res.commandId || state.dispatch.commandId || null,
                    error: next === 'confirmed' ? null : (res.error || 'ยังยืนยันผลจากตู้ไม่ได้'),
                    drawer: state.dispatch.drawer
                };
                if (next === 'confirmed') state.dispensedOnce = true;

                // ปลดล็อกนาฬิกาได้เฉพาะเมื่อผลชัดแล้วว่ายังไม่ได้ส่ง
                // ส่งไปแล้วไม่รู้ผล = ค้างหน้าจอไว้ให้คนมาดู ไม่รีเซ็ตเองเงียบๆ
                idleSuspended = next === 'uncertain';
                if (!idleSuspended) armTimers();
                return next;
            },

            dispatchState() {
                return state.dispatch.state;
            },

            // หน้าจอกำลังรอผลที่ยังไม่ชัด — ปุ่มสั่งจ่ายต้องไม่กลับมากดได้
            isDispatchPending() {
                return state.dispatch.state === 'sending';
            },

            isDispatchUncertain() {
                return state.dispatch.state === 'uncertain';
            },

            // ── จบรอบ ────────────────────────────────────────────────────

            // ล้างข้อมูลของผู้ใช้รอบนี้: รูป ผล AI แผลที่เลือก วิธีเข้า
            // ไม่แตะคลังยาและไม่แตะประวัติคำสั่งของ Pi ซึ่งเป็นกลไกกัน replay
            reset(reason) {
                if (session.isDispatchPending()) return false;
                const wasUncertain = session.isDispatchUncertain();
                state = emptyState();
                idleMode = 'interactive';
                idleSuspended = false;
                armTimers();
                onReset({ reason: reason || 'manual', afterUncertain: wasUncertain });
                return true;
            },

            // ใช้ตอนปิดหน้า ไม่ให้ timer ค้างในเทส
            stop() {
                clearTimers();
                deadlineAt = 0;
                return session;
            }
        };

        return session;
    }

    return { create, IDLE_MS, WARNING_MS, DISPATCH_STATES: DISPATCH };
}));
