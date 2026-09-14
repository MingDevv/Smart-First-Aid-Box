// JS/KIOSK-APP.JS — ตัวควบคุมหน้าจอของหน้าตู้ (/kiosk)
//
// หน้านี้เป็นหน้าเดียวตลอดทั้งกระบวนการ ไม่มีการเปลี่ยน URL เลย เพราะ:
//   · การเปลี่ยนหน้าแต่ละครั้งคือโอกาสที่ผู้ใช้จะหลุดออกไปหน้าอื่นของเว็บ
//   · ข้อมูลของรอบ (รูป ผล AI แผลที่เลือก) ต้องล้างที่จุดเดียว ไม่ใช่หวังว่าทุกหน้าจะล้างเอง
//   · นาฬิกาว่างต้องครอบทั้งเส้นทาง ไม่ใช่เฉพาะหน้าแรกเหมือนของเดิม
//
// ตรรกะฮาร์ดแวร์ ข้อมูลบาดแผล และการแจ้งเตือน เรียกจากไฟล์ที่เว็บใช้ร่วมกัน
// ไฟล์นี้รับผิดชอบแค่ "หน้าตา + ลำดับ" ไม่ได้ตัดสินใจเรื่องการสั่งตู้เอง

(function () {
    'use strict';

    // ── ค่าคงที่ที่มีเหตุผลกำกับ ──────────────────────────────────────────

    // ต่ำกว่านี้ถือว่า AI ไม่มั่นใจพอจะให้เปิดลิ้นชัก ให้คนเลือกเอง
    // (ของเดิมฝังเลข 70 ไว้กลางเงื่อนไขในหน้า wound-scan โดยไม่มีชื่อ)
    const AI_MIN_CONFIDENCE = 70;

    // ฝั่งเซิร์ฟเวอร์ลองโมเดล 3 ตัว ตัวละ 15 วินาที = ค้างได้ถึง 45 วินาที
    // ของเดิมไม่มี timeout ฝั่งเบราว์เซอร์เลย จอตู้จึงค้างถาวรได้ถ้า Gemini ไม่ตอบ
    const ANALYZE_TIMEOUT_MS = 25000;

    // ย่อภาพก่อนส่ง ลดเวลารอและลดโอกาสชน limit 10MB ของ /api/analyze
    const PHOTO_MAX_EDGE = 800;
    const PHOTO_QUALITY = 0.85;

    const STATUS_POLL_MS = 5000;
    const DONE_RETURN_MS = 8000;

    // ตู้จ่ายได้จริงแค่ 2 ช่อง (ดู woundCompartmentMap ใน js/api-bridge.js)
    // แผลที่ติด comingSoon/locked ไม่แสดงบนหน้าตู้ — การ์ดที่กดแล้วบอกว่า
    // "เร็วๆ นี้" ไม่ช่วยคนที่กำลังเจ็บ ให้ไปทางเรียกครูแทน
    const KIOSK_WOUND_IDS = ['cut_abrasion', 'insect'];

    // ── อ้างอิง DOM ─────────────────────────────────────────────────────

    const el = id => document.getElementById(id);
    const views = {};
    let session = null;

    // สถานะระดับหน้าจอที่ไม่ได้อยู่ในรอบการใช้งาน
    let hardware = { connected: false, ready: false, mode: 'checking' };
    let statusTimer = null;
    let stream = null;
    let photoReady = false;
    let analyzeAbort = null;
    let stepIndex = 0;
    let dispenseStartedAt = 0;
    let dispenseTicker = null;
    let doneTicker = null;
    let idleTicker = null;
    let sosBusy = false;

    // หน้าแรกของตู้ ขึ้นกับว่ามีกล้องให้สแกนแผลไหม
    // ตู้ที่ไม่มีกล้อง ไม่ควรมีหน้าให้เลือกระหว่างสองอย่างทั้งที่เลือกได้อย่างเดียว
    // เด็กที่กำลังเจ็บควรเห็นรูปแผลให้แตะทันที ไม่ใช่แตะผ่านอีกชั้นหนึ่งก่อน
    let landingView = 'start';

    // คำตอบเรื่องแพ้ยาของรอบนี้: null | 'yes' | 'unsure' | 'no'
    // null คือยังไม่ตอบ ไม่ใช่ "ไม่แพ้" — ต้องแยกให้ขาด
    let allergyAnswer = null;

    // ตัวนับรุ่นของงานที่ทำค้างไว้ กล้อง การย่อภาพ และการวิเคราะห์เป็น async ทั้งหมด
    // ถ้าไม่มีตัวนี้ callback ของรอบก่อนที่เพิ่งกลับมา จะเขียนทับหน้าจอของรอบใหม่ได้
    // (นัย reproduce ได้จริงทั้งสองแบบ: getUserMedia ที่คืนมาหลังออกจากหน้าสแกน
    // และ callback ย่อภาพที่คืนมาหลังรีเซ็ต แล้วลากหน้าจอจาก start ไป confirm พร้อมรูปรอบเก่า)
    let generation = 0;

    const currentGeneration = () => generation;
    const isStale = token => token !== generation;
    function invalidateAsyncWork() {
        generation += 1;
        cancelAnalyze();
        stopCamera();
        clearPhoto();
    }

    // ── ยูทิลิตี้ ───────────────────────────────────────────────────────

    function currentWound() {
        const id = session && session.state.woundId;
        return id ? WOUND_DATA[id] : null;
    }

    // js/storage.js ประกาศ `const StorageService` ไว้เฉยๆ ไม่ได้แขวนไว้บน window
    // (ต่างจาก notification.js และ api-bridge.js ที่แขวนไว้) สคริปต์ธรรมดาด้วยกัน
    // เรียกด้วยชื่อเปล่าได้ แต่ `window.StorageService` เป็น undefined เสมอ
    // — ยืนยันด้วย Chromium จริงบนหน้า /kiosk, /student/kiosk และ /student/first-aid-guide
    // อย่าเช็คผ่าน window ที่นี่ ไม่งั้นโค้ดจะข้ามไปเงียบๆ ทุกครั้ง
    function storage() {
        return typeof StorageService !== 'undefined' ? StorageService : null;
    }

    function isDemo() {
        return mode() === 'demo';
    }

    // 'demo' | 'real' | 'unset' — ถามจาก ApiBridge เสมอ เพราะมันคือตัวที่ตัดสินจริงว่าจะส่งอะไรออกไป
    // ถ้าหน้าจออ่านจากที่อื่น ป้ายบนจอกับพฤติกรรมจริงจะหลอกกันได้
    function mode() {
        if (window.ApiBridge?.operatingMode) return ApiBridge.operatingMode();
        return 'unset';
    }

    // จริงเฉพาะตอนถูกเสิร์ฟจากบริการบน Pi ซึ่งเป็นที่เดียวที่มีสมุดคำสั่งถาวร
    // edge/server.mjs ฉีดค่านี้เข้าหน้าตอนเสิร์ฟ หน้าเดียวกันบน Vercel จะไม่มี
    function isPiLocal() {
        return !!(window.ApiBridge && ApiBridge.isPiLocal());
    }

    function toast(message, tone) {
        if (window.NotificationService) NotificationService.showToast(message, tone || 'info');
    }

    // แสดง view เดียว ปิดที่เหลือ — ไม่แตะ style.display เพราะ CSS ใช้ [hidden]
    function showView(name) {
        Object.keys(views).forEach(key => {
            views[key].hidden = key !== name;
        });
        if (session) session.setView(name);
        // ปุ่มเรียกครูอยู่ทุกหน้า รวมหน้าที่กำลังรอตู้ — ออดกับลิ้นชักเป็นคนละคำสั่ง
        // การขอความช่วยเหลือระหว่างที่ตู้ค้างคือกรณีที่ต้องการที่สุด
        el('sos-button').hidden = false;
    }

    function setNotice(node, textNode, tone, message) {
        if (!message) {
            node.hidden = true;
            return;
        }
        node.hidden = false;
        node.dataset.tone = tone;
        textNode.textContent = message;
    }

    // ── แถบสถานะตู้ ─────────────────────────────────────────────────────

    function renderHardware() {
        const badge = el('hw-status');
        // คำสั่งค้างมาก่อนทุกอย่าง เพราะมันแปลว่าตู้อยู่ในสภาพที่ไม่มีใครรู้ว่าเป็นยังไง
        if (hardware.unresolved) {
            badge.dataset.state = 'offline';
            badge.textContent = 'ตู้มีคำสั่งค้าง รอครูตรวจ';
            return;
        }
        if (mode() === 'unset') {
            badge.dataset.state = 'offline';
            badge.textContent = 'ยังไม่ได้ตั้งโหมด รอครูตั้งค่า';
            return;
        }
        if (!isPiLocal() && !isDemo()) {
            badge.dataset.state = 'offline';
            badge.textContent = 'ดูได้อย่างเดียว ไม่ได้อยู่ที่ตู้';
            return;
        }
        if (isDemo()) {
            badge.dataset.state = 'demo';
            badge.textContent = 'โหมดสาธิต ไม่ได้สั่งตู้จริง';
            return;
        }
        if (hardware.reason === 'awaiting_new_ready_epoch') {
            badge.dataset.state = 'offline';
            badge.textContent = 'ตู้รอครูตรวจสาย';
        } else if (hardware.connected && hardware.ready === false) {
            badge.dataset.state = 'busy';
            badge.textContent = 'ตู้กำลังทำงาน';
        } else if (hardware.connected) {
            badge.dataset.state = 'ready';
            badge.textContent = 'ตู้พร้อมใช้';
        } else if (hardware.mode === 'checking') {
            badge.dataset.state = 'checking';
            badge.textContent = 'กำลังตรวจสถานะตู้';
        } else {
            badge.dataset.state = 'offline';
            badge.textContent = 'ตู้ยังต่อไม่ได้';
        }
    }

    async function pollHardware() {
        // ระหว่างรอผลคำสั่ง อย่ายิง /status ซ้ำไปกวนคิวของ Pi
        if (session && session.isDispatchPending()) return;
        try {
            hardware = await ApiBridge.getHardwareStatus();
        } catch (error) {
            console.warn('[Kiosk] status failed:', error && error.message);
            hardware = { connected: false, mode: 'error' };
        }
        renderHardware();
        // หน้ายืนยันตัดสินใจตอนเปิดหน้าว่ากดรับอุปกรณ์ได้ไหม ถ้าไม่ทาสีใหม่ตามผลโพล
        // แถบสถานะจะขึ้น "ตู้พร้อมใช้" อยู่บนหน้าที่ปุ่มยังดับและบอกว่าตู้ไม่พร้อม
        if (session && session.state.view === 'confirm') refreshConfirmGate();
    }

    function startStatusPolling() {
        if (statusTimer !== null) clearInterval(statusTimer);
        pollHardware();
        statusTimer = setInterval(pollHardware, STATUS_POLL_MS);
    }

    // ── กล้อง ───────────────────────────────────────────────────────────

    async function startCamera() {
        stopCamera();
        photoReady = false;
        el('scan-preview').hidden = true;
        el('scan-video').hidden = false;
        el('scan-capture').disabled = true;
        el('scan-hint').textContent = 'กำลังเปิดกล้อง';

        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            return cameraUnavailable('เครื่องนี้ไม่มีกล้องที่ใช้ได้');
        }
        const token = currentGeneration();
        try {
            // ขอ {video:true} ตรงๆ ไม่ใช้ facingMode — กล้อง USB/CSI บน Pi มักไม่รายงาน
            // ด้านหน้า-หลัง แล้วจะถูกปฏิเสธด้วย OverconstrainedError เสียเที่ยวหนึ่ง
            //
            // ความละเอียดต้องขอ ไม่งั้น Chromium หยิบ 640x480 ให้ ซึ่งบนตู้ออกมามืดและรายละเอียดหาย
            // (วัดบนกล้องจริง 2026-09-14: ค่ากล้องเดิมทุกตัว เปลี่ยนแค่ความละเอียด แล้ว 1280x720
            // สว่างและคมกว่า 640x480 ชัดเจน ส่วนการดัน brightness/gain แทนทำให้ภาพขาวโพลนใช้ไม่ได้)
            // ใช้ ideal ไม่ใช่ exact/min — ideal เป็นค่าที่อยากได้เฉยๆ จึงไม่ทำให้เกิด
            // OverconstrainedError แบบที่คอมเมนต์ข้างบนระวังไว้ กล้องที่ทำไม่ได้จะลดให้เอง
            const granted = await navigator.mediaDevices.getUserMedia({
                video: { width: { ideal: 1280 }, height: { ideal: 720 } },
                audio: false
            });
            // ผู้ใช้อาจกดกลับไปแล้วระหว่างรอสิทธิ์กล้อง สตรีมที่เพิ่งได้มาต้องถูกปิดทันที
            // ไม่ใช่ปล่อยให้ไปเกาะ video ที่ซ่อนอยู่แล้วไฟกล้องติดค้างทั้งที่ไม่มีใครใช้
            if (isStale(token)) {
                granted.getTracks().forEach(track => track.stop());
                return;
            }
            stream = granted;
            const video = el('scan-video');
            video.srcObject = stream;
            // autoplay ที่เงียบๆ ไม่ทำงาน หน้าตาเหมือนกล้องเสีย จึงสั่ง play เองและจับ error
            await video.play();
            if (isStale(token)) return stopCamera();
            el('scan-capture').disabled = false;
            el('scan-hint').textContent = 'ให้แสงส่องถึงแผล อย่าให้เงามือบัง';
        } catch (error) {
            if (isStale(token)) return;
            console.warn('[Kiosk] camera failed:', error && error.name);
            cameraUnavailable('เปิดกล้องไม่ได้');
        }
    }

    // กล้องพังแล้วต้องไปทางเลือกเอง ห้ามเด้งไปหน้าอัปโหลดไฟล์เหมือนของเดิม
    function cameraUnavailable(reason) {
        stopCamera();
        el('scan-capture').disabled = true;
        el('scan-hint').textContent = `${reason} — กดปุ่ม "เลือกแผลเอง" ทางขวา`;
        el('scan-lead').textContent = 'ตอนนี้ใช้กล้องไม่ได้ เลือกประเภทแผลเองได้เลย';
    }

    function stopCamera() {
        if (stream) {
            stream.getTracks().forEach(track => track.stop());
            stream = null;
        }
        const video = el('scan-video');
        if (video) video.srcObject = null;
    }

    // ล้างรูปทั้งใน state และใน DOM — snapshot ที่ว่างไม่ได้พิสูจน์ว่าจอไม่ได้ค้างรูปไว้
    function clearPhoto() {
        photoReady = false;
        const preview = el('scan-preview');
        if (preview) {
            preview.removeAttribute('src');
            preview.hidden = true;
        }
        const video = el('scan-video');
        if (video) video.hidden = false;
    }

    function capturePhoto() {
        const video = el('scan-video');
        if (!stream || !video.videoWidth) return;
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
        const raw = canvas.toDataURL('image/jpeg', 0.92);
        stopCamera();
        video.hidden = true;

        // ย่อก่อนค่อยเปิดให้กดวิเคราะห์ — ของเดิมเปิดปุ่มทันทีแล้วส่งภาพเต็มความละเอียดได้
        const token = currentGeneration();
        shrinkPhoto(raw, shrunk => {
            // การถอดรหัสภาพใช้เวลา ผู้ใช้อาจกดกลับหรือรอบอาจถูกรีเซ็ตไปแล้ว
            // ถ้าไม่ตรวจตรงนี้ รูปของรอบก่อนจะถูกยัดเข้ารอบใหม่แล้วลากไปหน้ายืนยันเอง
            if (isStale(token)) return;
            session.setPhoto(shrunk);
            photoReady = true;
            const preview = el('scan-preview');
            preview.src = shrunk;
            preview.hidden = false;
            analyzePhoto(token);
        });
    }

    function shrinkPhoto(dataUrl, done) {
        const image = new Image();
        // ไม่มี onerror = callback ไม่ถูกเรียก แล้วหน้าจอค้างเงียบๆ (บั๊กของเดิม)
        image.onerror = () => done(dataUrl);
        image.onload = () => {
            const scale = Math.min(1, PHOTO_MAX_EDGE / Math.max(image.width, image.height));
            const canvas = document.createElement('canvas');
            canvas.width = Math.round(image.width * scale);
            canvas.height = Math.round(image.height * scale);
            canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
            done(canvas.toDataURL('image/jpeg', PHOTO_QUALITY));
        };
        image.src = dataUrl;
    }

    async function analyzePhoto(generationToken) {
        if (!photoReady) return;
        const token = generationToken === undefined ? currentGeneration() : generationToken;
        el('scan-lead').textContent = 'กำลังให้ AI ดูภาพ รอสักครู่';
        el('scan-hint').textContent = 'ถ้ารอนานเกินไป กดเลือกแผลเองได้เลย';

        // AbortController เป็นของการเรียกครั้งนี้ ไม่ใช่ของโมดูล ไม่งั้น cancelAnalyze()
        // ของรอบใหม่จะไปยกเลิกคำขอของรอบเก่าหรือกลับกัน แล้วแต่ว่าใครเขียนทับใครก่อน
        const abort = new AbortController();
        analyzeAbort = abort;
        const deadline = setTimeout(() => abort.abort(), ANALYZE_TIMEOUT_MS);
        const settle = () => {
            clearTimeout(deadline);
            if (analyzeAbort === abort) analyzeAbort = null;
        };
        let result;
        try {
            const response = await fetch('/api/analyze', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ image: session.state.photo }),
                signal: abort.signal
            });
            result = await response.json();
            if (!response.ok || !result || result.success !== true) {
                throw new Error((result && result.error) || 'วิเคราะห์ภาพไม่สำเร็จ');
            }
        } catch (error) {
            settle();
            if (isStale(token)) return;
            console.warn('[Kiosk] analyze failed:', error && error.message);
            el('scan-lead').textContent = 'ตอนนี้ AI ดูภาพให้ไม่ได้ เลือกประเภทแผลเองได้เลย';
            el('scan-hint').textContent = 'กดปุ่ม "เลือกแผลเอง" ทางขวา';
            return;
        }
        settle();
        // คำตอบมาถึงหลังผู้ใช้ไปแล้ว = ทิ้ง ห้ามลากหน้าจอกลับมา
        if (isStale(token)) return;

        session.setAiResult(result);
        goAiResult(result);
    }

    // ผลที่ AI เขียนต้องขึ้นจอเสมอ ไม่ว่าจะระบุแผลได้หรือไม่
    //
    // ของเดิมเก็บผลไว้ใน session แล้วเด้งไป goConfirm()/goSelect() ทันที ⇒ `description` กับ
    // `reasoning` ไม่เคยถูก render ที่ไหนเลยบนหน้าตู้ (ฝั่งมือถือแสดงครบมาตลอด) · รอบที่ระบุ
    // ไม่ได้คือรอบที่ข้อความสำคัญที่สุด เพราะเหตุผลที่ AI ให้อาจเป็นเรื่องที่ต้องไปหาครู
    // ไม่ใช่แค่ "ไม่รู้"
    function goAiResult(result) {
        // ไม่มั่นใจพอ หรือระบุไม่ได้ ⇒ ไม่เดาให้ และห้ามเขียนเลขช่องยาของแผลที่ระบุไม่ได้
        // (ของเดิมใช้ `drawer || 1` ⇒ โชว์ "ช่องที่ 1" ให้แผลที่ไม่รู้ว่าแผลอะไร)
        const usable = KIOSK_WOUND_IDS.includes(result.woundId) &&
            Number(result.confidence) >= AI_MIN_CONFIDENCE;
        const wound = usable ? WOUND_DATA[result.woundId] : null;

        el('airesult-title').textContent = wound ? wound.name_th : 'ยังบอกไม่ชัดว่าเป็นแผลแบบไหน';
        el('airesult-lead').textContent = wound
            ? `ตู้จะเปิดช่องที่ ${wound.drawer} ให้ ${wound.items.length} อย่าง ถ้ากดว่าใช่`
            : 'เลือกประเภทแผลเองได้เลย หรือถ่ายใหม่ให้เห็นแผลชัดขึ้น';

        const photo = el('airesult-photo');
        if (session.state.photo) photo.src = session.state.photo;
        else photo.removeAttribute('src');

        // textContent ไม่ใช่ innerHTML — ข้อความก้อนนี้มาจากโมเดลผ่านอินเทอร์เน็ต
        el('airesult-desc').textContent = result.description || 'AI ไม่ได้ให้คำอธิบายมา';
        const reasoning = el('airesult-reasoning');
        reasoning.textContent = result.reasoning || '';
        reasoning.hidden = !result.reasoning;

        const accept = el('airesult-accept');
        accept.hidden = !usable;
        if (usable) {
            session.setMethod('ai-scan');
            session.setWound(result.woundId);
            // เปลี่ยนแผล = เปลี่ยนรายการของ คำตอบเดิมเรื่องแพ้ยาใช้ไม่ได้แล้ว (กติกาเดียวกับ pick-wound)
            allergyAnswer = null;
        }
        showView('airesult');
    }

    function cancelAnalyze() {
        if (analyzeAbort) {
            analyzeAbort.abort();
            analyzeAbort = null;
        }
    }

    // ── หน้าเลือกแผลเอง ─────────────────────────────────────────────────

    function renderWoundGrid() {
        const grid = el('wound-grid');
        grid.textContent = '';
        KIOSK_WOUND_IDS.forEach(id => {
            const wound = WOUND_DATA[id];
            if (!wound) return;
            const card = document.createElement('button');
            card.type = 'button';
            card.className = 'wound-card';
            card.dataset.action = 'pick-wound';
            card.dataset.wound = id;

            const image = document.createElement('img');
            image.src = wound.image;
            image.alt = '';
            card.appendChild(image);

            const copy = document.createElement('span');
            const name = document.createElement('span');
            name.className = 'wound-card-name';
            name.textContent = wound.name_th;
            const note = document.createElement('span');
            note.className = 'wound-card-note';
            note.textContent = `${wound.items.length} อย่าง · ช่องที่ ${wound.drawer}`;
            copy.appendChild(name);
            copy.appendChild(note);
            card.appendChild(copy);

            grid.appendChild(card);
        });
    }

    function goSelect(lead) {
        // ออกจากหน้าสแกน = งานกล้อง/ย่อภาพ/วิเคราะห์ที่ค้างอยู่หมดอายุทันที
        invalidateAsyncWork();
        session.setMethod('manual');
        el('select-lead').textContent = lead || 'แตะรูปที่ใกล้เคียงที่สุด อาการอื่นให้กดเรียกครู';
        // ตู้ที่ไม่มีกล้อง หน้านี้คือหน้าแรก จึงไม่มีที่ให้ย้อนกลับไป
        el('select-back').hidden = landingView === 'select';
        showView('select');
    }

    // ไม่ถามสิทธิ์กล้อง แค่ถามว่ามีอุปกรณ์รับภาพอยู่ไหม — ตอบได้โดยไม่ต้องขออนุญาต
    // ระวัง: /dev/video* บน Pi ส่วนใหญ่เป็นโหนด codec/ISP ไม่ใช่กล้อง การนับไฟล์จึงตอบผิด
    // ต้องถามผ่าน enumerateDevices ซึ่งนับเฉพาะอุปกรณ์ที่จับภาพได้จริง
    async function hasCamera() {
        if (!navigator.mediaDevices?.enumerateDevices) return false;
        try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            return devices.some(device => device.kind === 'videoinput');
        } catch (error) {
            console.warn('[Kiosk] enumerateDevices failed:', error && error.message);
            return false;
        }
    }

    // ซ่อนทางสแกนแผลทั้งเส้นเมื่อไม่มีกล้อง แล้วให้หน้าเลือกแผลเป็นหน้าแรกแทน
    async function configureEntryPoint() {
        const camera = await hasCamera();
        const scanCard = document.querySelector('[data-action="go-scan"]');
        if (camera) {
            landingView = 'start';
            if (scanCard) scanCard.hidden = false;
            return;
        }
        landingView = 'select';
        if (scanCard) scanCard.hidden = true;
        // ปุ่ม "เลือกแผลเอง" บนหน้าสแกนก็ไม่มีความหมายแล้ว แต่ทั้งหน้าสแกนเข้าไม่ถึงอยู่ดี
        if (session.state.view === 'start') {
            goSelect('แตะรูปที่ใกล้เคียงที่สุด อาการอื่นให้กดปุ่มเรียกครูทางขวาล่าง');
        }
    }

    // ── หน้ายืนยัน ──────────────────────────────────────────────────────

    function renderSupplies(container, wound) {
        container.textContent = '';
        const details = wound.itemDetails || [];
        wound.items.forEach((item, index) => {
            const detail = details[index] || {};
            const box = document.createElement('div');
            box.className = 'supply-item';
            if (detail.image) {
                const image = document.createElement('img');
                image.src = detail.image;
                image.alt = '';
                box.appendChild(image);
            }
            const name = document.createElement('span');
            name.className = 'supply-item-name';
            name.textContent = String(detail.name || item).replace(/\s*\([^)]*\)/g, '').trim();
            box.appendChild(name);
            container.appendChild(box);
        });
    }

    // หน้าตู้ไม่มีแป้นพิมพ์ จึงไม่รู้ว่าใครยืนอยู่ตรงหน้า และไม่มีประวัติแพ้ยาให้ตรวจ
    // ถ้ามีการล็อกอินค้างไว้ (เช่นครูทดสอบ) ยังตรวจให้เหมือนเดิม
    function matchedAllergies(wound) {
        const store = storage();
        const student = store ? store.getCurrentStudent() : null;
        if (!student || !Array.isArray(student.allergies)) return [];
        const matches = new Set();
        wound.items.forEach(item => {
            student.allergies.forEach(allergy => {
                if (allergy === 'ไม่ทราบประวัติแพ้ยา') return;
                if (item.toLowerCase().includes(allergy.toLowerCase()) ||
                    allergy.toLowerCase().includes(item.toLowerCase())) matches.add(allergy);
            });
        });
        return [...matches];
    }

    function goConfirm() {
        const wound = currentWound();
        if (!wound) return goSelect();
        el('confirm-title').textContent = wound.name_th;
        el('confirm-lead').textContent = `ตู้จะเปิดช่องที่ ${wound.drawer} ให้ ${wound.items.length} อย่าง`;
        renderSupplies(el('confirm-supplies'), wound);
        refreshConfirmGate();
        showView('confirm');
    }

    // แยกออกมาเพราะสถานะตู้เปลี่ยนได้ระหว่างที่หน้ายืนยันเปิดค้างอยู่
    // ถูกเรียกทั้งตอนเปิดหน้า และทุกครั้งที่โพลสถานะกลับมา
    function renderAllergyGate() {
        const gate = el('allergy-gate');
        gate.dataset.answered = allergyAnswer || 'none';
        [...gate.querySelectorAll('[data-answer]')].forEach(button => {
            button.setAttribute('aria-pressed', String(button.dataset.answer === allergyAnswer));
        });
    }

    // เหตุผลเดียวที่ห้ามจ่าย คืนเป็นข้อความ หรือ null ถ้าจ่ายได้
    // แยกจากการวาดหน้าจอ เพื่อให้ dispense() เรียกซ้ำได้ตอนกดจริง ไม่ใช่เชื่อสถานะปุ่ม
    function dispenseBlockReason() {
        const wound = currentWound();
        if (!wound) return 'ยังไม่ได้เลือกประเภทแผล';
        const known = matchedAllergies(wound);
        if (known.length) return `ประวัติบอกว่าแพ้ ${known.join(', ')} — ต้องให้ครูดูก่อน`;
        if (allergyAnswer === null) return 'ตอบคำถามเรื่องแพ้ยาก่อน ตู้จะได้รู้ว่าจ่ายให้ได้ไหม';
        if (allergyAnswer === 'yes') return 'เคยแพ้ของพวกนี้ — ตู้จะไม่จ่ายให้ กดเรียกครูเลย';
        if (allergyAnswer === 'unsure') return 'ไม่แน่ใจว่าแพ้หรือเปล่า — ให้ครูดูก่อนปลอดภัยกว่า กดเรียกครู';
        if (!session.canDispatch()) return 'รอบนี้สั่งตู้ไปแล้ว ถ้าของยังไม่ออกมาให้กดเรียกครู อย่าสั่งซ้ำ';
        // ค้างจากคำสั่งก่อนหน้าที่ยังไม่มีใครเคลียร์ — อ่านจากสมุดคำสั่งของ Pi ไม่ใช่จากหน้าจอ
        if (hardware.unresolved) {
            return `ตู้มีคำสั่งค้างที่ยังไม่รู้ผล (ช่องที่ ${hardware.unresolved.drawer}) ต้องให้ครูตรวจตู้และเคลียร์ก่อน`;
        }
        if (isDemo()) return null;
        if (mode() === 'unset') return 'ตู้ยังไม่ได้ตั้งโหมดการทำงาน ให้ครูตั้งค่าที่หน้าครูก่อน';
        // หน้านี้เปิดจากที่ไหนก็ได้ แต่ hold ของคำสั่งที่ผลไม่ชัดอยู่ในสมุดคำสั่งของ Pi เท่านั้น
        // นอก Pi การรีเซ็ตเบราว์เซอร์แล้วสั่งใหม่ด้วย id ใหม่จึงยังเล็ดลอดได้อยู่
        // Bank เคาะ 2026-09-11: นอก Pi ให้ /kiosk ดูวิธีทำแผลกับโหมดสาธิตได้ แต่ไม่สั่งของจริง
        // จนกว่าฝั่งเซิร์ฟเวอร์จะมีกลไกกู้คืนแบบเดียวกัน · ปุ่มเรียกครูไม่ถูกกั้น เพราะการขอ
        // ความช่วยเหลือไม่ใช่การจ่ายของ และการสั่งออดซ้ำไม่ได้ทิ้งสภาพที่ต้องมาไล่กู้ทีหลัง
        if (!isPiLocal()) return 'หน้านี้บนเว็บใช้ดูวิธีทำแผลได้อย่างเดียว การรับของต้องทำที่หน้าจอของตู้';
        if (hardware.connected !== true || hardware.ready === false) {
            return 'ตอนนี้ตู้ยังไม่พร้อมจ่ายของ กดดูวิธีทำแผลได้ ถ้าต้องใช้ของให้กดเรียกครู';
        }
        return null;
    }

    function refreshConfirmGate() {
        const wound = currentWound();
        if (!wound) return;
        renderAllergyGate();
        const reason = dispenseBlockReason();
        const dispenseButton = el('confirm-dispense');
        dispenseButton.hidden = false;
        dispenseButton.disabled = reason !== null;
        if (reason && allergyAnswer === null) {
            // คำถามอยู่เหนือปุ่มอยู่แล้ว การขึ้นกล่องบอกซ้ำว่า "ตอบคำถามก่อน" คือข้อความซ้ำ
            // ที่กินที่บนจอ 480px และทำให้รายการของถูกบีบ ปล่อยให้คำถามพูดแทน
            setNotice(el('confirm-notice'), el('confirm-notice-text'), 'warning', '');
        } else if (reason) {
            setNotice(el('confirm-notice'), el('confirm-notice-text'), 'danger', reason);
        } else {
            setNotice(el('confirm-notice'), el('confirm-notice-text'), 'success',
                'ตอบว่าไม่เคยแพ้แล้ว กดรับอุปกรณ์ได้');
        }
    }

    function canDispenseNow() {
        return dispenseBlockReason() === null;
    }

    // ── สั่งตู้ ─────────────────────────────────────────────────────────

    async function dispense() {
        const wound = currentWound();
        if (!wound) return;
        // ตรวจซ้ำตรงจุดที่ยิงจริง ไม่เชื่อว่าปุ่มถูกปิดไว้แล้ว — ปุ่มถูกเปิดใหม่ได้จากโพลสถานะ
        // และ dispense() ยังถูกเรียกจากปุ่ม "ลองสั่งใหม่" บนหน้าปัญหาซึ่งไม่ผ่านหน้ายืนยัน
        const blocked = dispenseBlockReason();
        if (blocked) {
            refreshConfirmGate();
            toast(blocked, 'danger');
            return;
        }
        if (!session.beginDispatch(null, wound.drawer)) return;

        el('dispensing-title').textContent = `กำลังสั่งตู้เปิดช่องที่ ${wound.drawer}`;
        el('sos-button').hidden = false;
        showView('dispensing');
        startDispenseTicker();

        let result;
        try {
            result = await ApiBridge.openCompartment(wound.id);
        } catch (error) {
            console.error('[Kiosk] dispense threw:', error);
            // โยน error ออกมา = ไม่รู้ว่าส่งไปถึงตู้หรือยัง ⇒ ถือว่าไม่แน่นอน ห้ามลองใหม่
            result = { success: false, error: 'ยังยืนยันผลจากตู้ไม่ได้ กรุณาเรียกครู' };
        }
        stopDispenseTicker();

        const outcome = session.settleDispatch(result);
        if (outcome === 'confirmed') return goCollect(result);
        return goProblem(result, outcome);
    }

    function startDispenseTicker() {
        dispenseStartedAt = Date.now();
        el('dispensing-elapsed').textContent = '0';
        stopDispenseTicker();
        // นับเวลาที่รอ ไม่ใช่การทำนายว่ามอเตอร์จะเสร็จเมื่อไร
        dispenseTicker = setInterval(() => {
            el('dispensing-elapsed').textContent = String(Math.floor((Date.now() - dispenseStartedAt) / 1000));
        }, 1000);
    }

    function stopDispenseTicker() {
        if (dispenseTicker !== null) clearInterval(dispenseTicker);
        dispenseTicker = null;
    }

    function goCollect(result) {
        const wound = currentWound();
        // ACK ไม่ใช่หลักฐานว่าลิ้นชักเปิดหรือของออกมา ยังไม่มีเซนเซอร์ที่บอกได้
        el('collect-title').textContent = result && result.mode === 'simulation'
            ? `โหมดสาธิต: สมมติว่าสั่งเปิดช่องที่ ${wound.drawer}`
            : `ตู้รับคำสั่งเปิดช่องที่ ${wound.drawer} แล้ว`;
        renderSupplies(el('collect-supplies'), wound);
        showView('collect');
    }

    function goProblem(result, outcome) {
        el('problem-text').textContent = (result && result.error) ||
            'ยังยืนยันผลจากตู้ไม่ได้ กรุณาเรียกครู';
        el('problem-title').textContent = outcome === 'uncertain'
            ? 'ไม่แน่ใจว่าตู้จ่ายของออกมาหรือยัง'
            : 'ตู้ยังจ่ายของไม่ได้';
        // ลองใหม่ได้เฉพาะกรณีที่ ApiBridge ยืนยันว่ายังไม่ได้ส่งคำสั่งออกไป
        el('problem-retry').hidden = outcome !== 'rejected';
        showView('problem');
    }

    // ── ขั้นตอนทำแผล ────────────────────────────────────────────────────

    function goSteps() {
        const wound = currentWound();
        if (!wound || !wound.steps.length) return finishRound('no-steps');
        stepIndex = 0;
        renderStep();
        showView('steps');
    }

    function renderStep() {
        const wound = currentWound();
        const total = wound.steps.length;
        const detail = (wound.stepDetails || [])[stepIndex] || {};
        el('step-counter').textContent = `ขั้นที่ ${stepIndex + 1} จาก ${total}`;
        el('step-title').textContent = detail.title || `ขั้นที่ ${stepIndex + 1}`;
        el('step-desc').textContent = detail.desc || wound.steps[stepIndex];
        const image = el('step-image');
        image.src = detail.image || wound.image;
        image.alt = '';

        const progress = el('step-progress');
        progress.textContent = '';
        for (let index = 0; index < total; index += 1) {
            const segment = document.createElement('span');
            if (index <= stepIndex) segment.className = 'done';
            progress.appendChild(segment);
        }
        el('step-prev').disabled = stepIndex === 0;
        el('step-next-label').textContent = stepIndex === total - 1 ? 'ทำครบแล้ว' : 'ทำเสร็จแล้ว';
    }

    function moveStep(delta) {
        const wound = currentWound();
        const total = wound.steps.length;
        const next = stepIndex + delta;
        if (next < 0) return;
        if (next >= total) return finishRound('completed');
        stepIndex = next;
        renderStep();
    }

    // ── จบรอบ ───────────────────────────────────────────────────────────

    async function finishRound(reason) {
        stopTickers();
        const wound = currentWound();
        const dispensed = session.state.dispatch.state === 'confirmed';

        // บันทึกเฉพาะรอบที่ตู้จ่ายของจริงและทำแผลจนจบ และเฉพาะโหมดจริง
        if (reason === 'completed' && dispensed && wound && !isDemo()) {
            recordTreatment(wound).catch(error => console.warn('[Kiosk] record failed:', error && error.message));
        }
        // พาดหัวต้องพูดความจริงของรอบนั้น ไม่ใช่ข้อความชัยชนะแบบตายตัว
        // สามกรณีต่างกันจริงๆ: ตู้รับคำสั่งแล้ว · สั่งไปแล้วไม่รู้ผล · ไม่เคยสั่งเลย
        const neverSent = session.state.dispatch.state === 'idle';
        el('done-title').textContent = dispensed ? 'เรียบร้อยแล้ว หายไวๆ นะ' : 'จบรอบนี้แล้ว';
        el('done-icon').style.color = dispensed ? 'var(--success)' : 'var(--warning)';
        el('done-lead').textContent = dispensed
            ? 'ถ้าแผลยังปวดหรือเลือดไม่หยุด ให้ไปหาครูพยาบาล'
            : neverSent
                ? 'รอบนี้ดูวิธีทำแผลอย่างเดียว ยังไม่ได้สั่งตู้จ่ายของ ถ้าต้องใช้ของให้ไปหาครูพยาบาล'
                : 'ตู้ยังไม่ยืนยันว่าจ่ายของออกมา ถ้ายังต้องใช้ของ ให้ไปหาครูพยาบาล';
        showView('done');
        startDoneCountdown();
    }

    async function recordTreatment(wound) {
        const store = storage();
        if (!store) return;
        const student = store.getCurrentStudent();
        const method = session.state.method === 'ai-scan' ? 'AI วิเคราะห์จากภาพถ่าย' : 'เลือกประเภทแผลเอง';
        store.addHistoryEntry({
            studentId: student ? student.studentId : '99999',
            studentName: student ? student.name : 'นักเรียนทั่วไป (หน้าตู้)',
            studentClass: student ? student.class : '-',
            woundType: wound.id,
            woundNameTh: wound.name_th,
            method,
            itemsUsed: wound.items,
            timestamp: new Date().toISOString()
        });
        const payload = NotificationService.buildFirstAidFlexMessage({
            studentId: student ? student.studentId : '99999',
            name: student ? student.name : 'นักเรียนทั่วไป (หน้าตู้)',
            studentClass: student ? student.class : '-',
            woundNameTh: wound.name_th,
            woundNameEn: wound.name_en,
            items: wound.items,
            method
        });
        // แจ้งครูไม่สำเร็จ ไม่ทำให้รอบนี้ล้ม แต่ต้องไม่รายงานว่าส่งแล้ว
        const line = await NotificationService.sendLineNotification(payload);
        if (!line || line.success !== true) {
            console.warn('[Kiosk] LINE not confirmed');
        }
    }

    function startDoneCountdown() {
        let left = Math.round(DONE_RETURN_MS / 1000);
        el('done-countdown').textContent = String(left);
        if (doneTicker !== null) clearInterval(doneTicker);
        doneTicker = setInterval(() => {
            left -= 1;
            el('done-countdown').textContent = String(Math.max(0, left));
            if (left <= 0) resetToStart('done-timeout');
        }, 1000);
    }

    function stopTickers() {
        stopDispenseTicker();
        if (doneTicker !== null) clearInterval(doneTicker);
        if (idleTicker !== null) clearInterval(idleTicker);
        doneTicker = null;
        idleTicker = null;
    }

    // ล้างของรอบนี้ให้หมด: รูป ผล AI แผลที่เลือก และตัวตนผู้ใช้ถ้ามี
    // ไม่แตะคลังยาและไม่แตะประวัติคำสั่งของ Pi ซึ่งเป็นกลไกกันสั่งซ้ำ
    function resetToStart(reason) {
        // เกตต้องมาก่อนทุกอย่างที่ย้อนไม่ได้ ถ้าคำสั่งยังค้างแล้วเราเผลอ logout
        // กับปิดกล้องไปก่อน หน้าจอจะเสียหายทั้งที่การรีเซ็ตถูกปฏิเสธ
        if (!session.reset(reason)) return;
        stopTickers();
        // บวกเลขรุ่น ปิดกล้อง ยกเลิกการวิเคราะห์ และล้างรูปทั้งใน state และใน DOM
        invalidateAsyncWork();
        allergyAnswer = null;
        el('overlay-idle').hidden = true;
        el('overlay-sos').hidden = true;
        const store = storage();
        if (store) store.logoutStudent();
        el('scan-lead').textContent = 'ถือให้นิ่ง แล้วกดปุ่มถ่ายภาพ';
        if (landingView === 'select') goSelect();
        else showView('start');
    }

    // ── เรียกครู ────────────────────────────────────────────────────────

    function openSos() {
        el('sos-overlay-title').textContent = 'เรียกครูพยาบาลใช่ไหม';
        // บอกก่อนกดว่าจะเกิดอะไรขึ้นจริงในสภาพตอนนี้ ไม่ใช่สัญญาสิ่งที่ตู้ทำไม่ได้
        // ตู้ที่ยังไม่ตั้งโหมดส่งเสียงไม่ได้ และ LINE ที่ส่งถึงก็ยังไม่ได้แปลว่าครูเห็นแล้ว
        el('sos-overlay-text').textContent = mode() === 'unset'
            ? 'จะแจ้งครูทาง LINE ให้ · ตู้ยังไม่ได้ตั้งโหมดจึงยังส่งเสียงไม่ได้ ถ้าเจ็บมากให้ไปตามครูที่อยู่ใกล้ที่สุดด้วย'
            : isDemo()
                ? 'ตอนนี้เป็นโหมดสาธิต จะไม่มีการแจ้งครูจริงและไม่มีเสียงจริง'
                : 'ตู้จะส่งเสียงและแจ้งครูทาง LINE · การส่งถึงยังไม่ได้แปลว่าครูเห็นแล้ว';
        el('sos-overlay-actions').hidden = false;
        el('sos-overlay-close').hidden = true;
        el('overlay-sos').hidden = false;
    }

    async function sendSos() {
        if (sosBusy) return;
        sosBusy = true;
        const button = el('sos-confirm');
        button.disabled = true;
        el('sos-overlay-title').textContent = 'กำลังเรียกครู';
        el('sos-overlay-text').textContent = 'รอสักครู่ อย่ากดซ้ำ';
        try {
            const store = storage();
            const student = store ? store.getCurrentStudent() : null;
            const who = student ? `${student.name} (${student.class})` : 'นักเรียนที่ตู้ปฐมพยาบาล';
            // sendSos รายงานผล LINE กับผลออดแยกกันเอง ไม่ OR รวมเป็นสำเร็จเดียว
            const outcome = await NotificationService.sendSos(NotificationService.buildSosFlexMessage(who));
            const lineOk = outcome.line && outcome.line.success === true && outcome.line.mode !== 'simulation';
            const buzzerOk = outcome.buzzer && outcome.buzzer.success === true && outcome.buzzer.mode !== 'simulation';
            el('sos-overlay-title').textContent = lineOk && buzzerOk ? 'เรียกครูแล้ว' : 'ยังยืนยันไม่ได้ทั้งหมด';
            el('sos-overlay-text').textContent =
                `${lineOk ? 'แจ้ง LINE ถึงครูแล้ว' : 'ยังยืนยันการแจ้ง LINE ไม่ได้'} · ` +
                `${buzzerOk ? 'ตู้รับคำสั่งเปิดเสียงแล้ว' : 'ยังยืนยันเสียงที่ตู้ไม่ได้'}` +
                `${lineOk && buzzerOk ? '' : ' — ให้ไปตามครูที่อยู่ใกล้ที่สุดด้วย'}`;
        } catch (error) {
            console.error('[Kiosk] SOS failed:', error);
            el('sos-overlay-title').textContent = 'เรียกครูไม่สำเร็จ';
            el('sos-overlay-text').textContent = 'ให้ไปตามครูที่อยู่ใกล้ที่สุดทันที';
        } finally {
            el('sos-overlay-actions').hidden = true;
            el('sos-overlay-close').hidden = false;
            button.disabled = false;
            sosBusy = false;
        }
    }

    // ── นาฬิกาว่าง ──────────────────────────────────────────────────────

    function onIdleWarning(info) {
        // หน้าแรกไม่ต้องถามว่ายังอยู่ไหม — ไม่มีอะไรให้เสีย
        if (session.state.view === landingView) return;
        let left = Math.round(info.remainingMs / 1000);
        el('idle-countdown').textContent = String(left);
        el('overlay-idle').hidden = false;
        if (idleTicker !== null) clearInterval(idleTicker);
        idleTicker = setInterval(() => {
            left -= 1;
            el('idle-countdown').textContent = String(Math.max(0, left));
            if (left <= 0) clearInterval(idleTicker);
        }, 1000);
    }

    function onIdleExpired() {
        if (session.state.view === landingView) return;
        resetToStart('idle');
    }

    function stayActive() {
        el('overlay-idle').hidden = true;
        if (idleTicker !== null) clearInterval(idleTicker);
        idleTicker = null;
        session.extend();
    }

    // ── การกดปุ่ม ───────────────────────────────────────────────────────

    const ACTIONS = {
        'go-start': () => resetToStart('back'),
        'go-scan': () => { showView('scan'); startCamera(); },
        'go-select': () => goSelect(),
        'capture': capturePhoto,
        'pick-wound': target => {
            session.setWound(target.dataset.wound);
            if (session.state.method !== 'ai-scan') session.setMethod('manual');
            // เปลี่ยนแผล = เปลี่ยนรายการของที่จะได้ คำตอบเดิมเรื่องแพ้ยาใช้ไม่ได้แล้ว
            allergyAnswer = null;
            goConfirm();
        },
        'allergy-answer': target => {
            allergyAnswer = target.dataset.answer;
            refreshConfirmGate();
        },
        // ปุ่มนี้ถูกซ่อนเมื่อ AI ระบุไม่ได้ แต่ยังตรวจซ้ำตรงนี้ ไม่เชื่อว่าปุ่มถูกซ่อนไว้แล้ว
        'airesult-accept': () => { if (currentWound()) goConfirm(); },
        'confirm-back': () => goSelect(),
        'dispense': dispense,
        // ดูวิธีทำแผลโดยไม่สั่งอะไรเลย ต้องใช้ได้แม้ตู้ออฟไลน์ตั้งแต่ต้น
        'guide-only': goSteps,
        'go-steps': goSteps,
        'step-prev': () => moveStep(-1),
        'step-next': () => moveStep(1),
        'finish-now': () => resetToStart('manual'),
        'sos-open': openSos,
        'sos-cancel': () => { el('overlay-sos').hidden = true; },
        'sos-send': sendSos,
        'idle-stay': stayActive
    };

    function onClick(event) {
        const target = event.target.closest('[data-action]');
        if (!target || target.disabled) return;
        const handler = ACTIONS[target.dataset.action];
        if (handler) handler(target);
    }

    // ── เริ่มทำงาน ──────────────────────────────────────────────────────

    function init() {
        ['start', 'scan', 'airesult', 'select', 'confirm', 'dispensing', 'collect', 'steps', 'done', 'problem']
            .forEach(name => { views[name] = el(`view-${name}`); });

        session = KioskSession.create({
            onIdleWarning,
            onIdleExpired,
            // รอบที่ปิดทั้งที่ยังไม่รู้ผลคำสั่ง คือรอบที่ควรมีร่องรอยมากที่สุด
            // ถ้าไม่รับธงนี้ ระบบจะล้างรอบทิ้งเงียบๆ โดยไม่มีใครรู้ว่ามอเตอร์หมุนไปแล้วหรือยัง
            onReset: info => {
                if (info.afterUncertain) {
                    console.warn(`[Kiosk] ปิดรอบที่ผลคำสั่งยังไม่ชัด (reason=${info.reason})`);
                }
            }
        });

        renderWoundGrid();
        document.addEventListener('click', onClick);
        // แตะที่ไหนก็ต่ออายุนาฬิกา แต่ไม่ปลุกนาฬิกาที่พักไว้ตอนรอตู้
        // ถ้าหน้าเตือนหมดเวลาเปิดอยู่ ต้องปิดมันด้วย ไม่งั้นนาฬิกาถูกต่ออายุจริง
        // แต่จอค้างข้อความ "จะกลับหน้าแรกใน 0 วินาที" ที่ไม่มีวันเกิดขึ้น
        ['pointerdown', 'keydown'].forEach(type =>
            document.addEventListener(type, () => {
                if (!session.touch()) return;
                if (!el('overlay-idle').hidden) stayActive();
            }, { passive: true }));

        showView('start');
        session.start();
        startStatusPolling();
        // ตรวจกล้องแล้วค่อยตัดสินว่าหน้าแรกคือหน้าไหน ทำหลัง render แรกเพื่อไม่ให้จอว่าง
        configureEntryPoint();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();

    // เปิดให้เทสเรียกได้โดยไม่ต้องไปหาสตริงในซอร์ส
    window.KioskApp = {
        AI_MIN_CONFIDENCE,
        ANALYZE_TIMEOUT_MS,
        KIOSK_WOUND_IDS,
        canDispenseNow,
        matchedAllergies,
        hasCamera,
        landingView: () => landingView,
        session: () => session
    };
}());
