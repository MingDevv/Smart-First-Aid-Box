// ตัวเลือกเส้นทางส่งคำสั่งไปตู้ และคุยกับ API ของเว็บ
//
// อยู่บนตู้ใช้บริการในเครื่อง อยู่บนเว็บใช้ MQTT
// คำสั่งที่ผลไม่ชัดเจน ห้ามเปลี่ยนไปลองอีกทางเด็ดขาด เพราะของจริงอาจขยับไปแล้ว
// โหมดสาธิตต้องตั้งเองเท่านั้น ไม่มีการเดาให้
const ApiBridge = {
    isPiLocal() {
        return window.SFAB_RUNTIME?.transport === 'pi-local';
    },

    async sendLocalCommand(body) {
        const statusController = new AbortController();
        const statusTimeout = setTimeout(() => statusController.abort(), 2500);
        let commandTimeoutMs;
        try {
            const response = await fetch('/api/local/status', { signal: statusController.signal });
            const status = await response.json();
            if (statusController.signal.aborted || !response.ok || !Number.isInteger(status.commandTimeoutMs) ||
                status.commandTimeoutMs < 6000 || status.commandTimeoutMs > 123000) {
                throw new Error('Missing hardware timing budget');
            }
            commandTimeoutMs = status.commandTimeoutMs + 5000;
        } catch {
            return { success: false, mode: 'pi-local', commandId: body.id, retrySafe: true,
                error: 'ยังไม่ได้ส่งคำสั่ง ตู้ยังไม่พร้อมหรือเชื่อมต่อ Pi ไม่ได้ ตรวจการตั้งค่าแล้วลองใหม่ได้' };
        } finally { clearTimeout(statusTimeout); }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), commandTimeoutMs);
        try {
            const response = await fetch('/api/command', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body), signal: controller.signal
            });
            const data = await response.json();
            if (response.ok && data.success && data.mode === 'pi-local' &&
                data.ack?.protocol === 2 && (body.action === 'open'
                    ? this.isDrawerAck(data.ack, body.id, body.drawer)
                    : data.ack.event === 'buzzer_set' && data.ack.id === body.id && data.ack.state === body.state)) {
                return { ...data, mode: 'pi-local' };
            }
            // ต้องส่ง `retrySafe` ของ Pi ต่อออกไป ไม่ใช่ทิ้งแล้วประกอบวัตถุใหม่
            //
            // `settleDispatch()` ในคีออสก์แปล "ไม่มี retrySafe" เป็น **uncertain** = ส่งไปแล้วไม่รู้ผล
            // ⇒ คำปฏิเสธที่ชัดเจน (เช่น 401 ที่ยังไม่ได้ส่งคำสั่งออกไปเลย) กลายเป็นหน้าจอ
            // "ไม่แน่ใจว่าตู้จ่ายของออกมาหรือยัง" ที่ซ่อนปุ่มลองใหม่ และค้างจอไว้ให้คนมาดู
            // — บอกครูว่าลิ้นชักอาจเปิดไปแล้ว ทั้งที่ไม่มีอะไรถูกส่ง
            return { success: false, mode: 'pi-local', commandId: body.id,
                retrySafe: data.retrySafe === true,
                error: data.error || 'Pi ยังยืนยันผลจากตู้ยาไม่ได้' };
        } catch {
            // ตรงนี้ไม่ใส่ retrySafe โดยตั้งใจ — เน็ตขาดกลางคันคือกรณีที่ "ไม่รู้ว่าส่งถึงหรือยัง" จริงๆ
            return { success: false, mode: 'pi-local', commandId: body.id,
                error: 'การเชื่อมต่อ Pi ขัดข้อง กรุณาตรวจตู้ก่อน ห้ามสั่งจ่ายซ้ำ' };
        } finally { clearTimeout(timeout); }
    },

    // GET อาจต้องต่อ MQTT ใหม่และรออ่านสถานะที่ค้างอยู่ จึงให้เวลานานกว่าปกติ
    MQTT_STATUS_TIMEOUT_MS: 8000,
    // ออด SOS ของคนที่ยังไม่ได้ล็อกอินข้ามการ preflight (ซึ่งต้องใช้โทเคน) แล้วยิง POST ตรง
    // เซิร์ฟเวอร์ตรวจ `hardware.connected` ให้อยู่แล้วก่อน publish · งบนี้ต้องคลุมงบ ACK
    // ของเฟิร์มแวร์ (สูงสุด 120 วิ) ไม่ได้ จึงตั้งเท่าค่าเริ่มต้นที่ใช้กับลิ้นชัก = 45 วิ
    ANON_BUZZER_TIMEOUT_MS: 45000,

    isHardwareConfigured(settings) {
        if (!settings || !settings.esp32Url) return false;
        const url = settings.esp32Url.trim();
        // ถ้าตั้งเป็นค่าว่างหรือค่าตัวอย่าง ให้ถือว่ายังไม่ได้ตั้งค่า
        if (!url || settings.isConfigured === false) return false;
        return true;
    },

    isMqttListenerConfigured() {
        return !!(window.MqttBridge && window.MqttBridge.isConfigured());
    },

    getSettings() {
        return window.StorageService ? window.StorageService.getSettings() : { esp32Url: '' };
    },

    createCommandId() {
        const random = (window.crypto && typeof window.crypto.randomUUID === 'function')
            ? window.crypto.randomUUID().replace(/-/g, '').slice(0, 12)
            : Math.random().toString(16).slice(2, 14);
        return `c-${Date.now().toString(36)}-${random}`;
    },

    isDrawerAck(ack, commandId, drawer) {
        return !!(
            ack &&
            ack.event === 'drawer_opened' &&
            ack.id === commandId &&
            Number(ack.drawer) === Number(drawer)
        );
    },

    async fetchWithTimeout(url, options, timeoutMs) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        try {
            return await fetch(url, { ...options, signal: controller.signal });
        } finally {
            clearTimeout(timeout);
        }
    },

    isCommandAck(ack, body) {
        return ack?.protocol === 2 && ack.id === body.id && (body.action === 'open'
            ? ack.event === 'drawer_opened' && ack.drawer === body.drawer
            : ack.event === 'buzzer_set' && ack.state === body.state);
    },

    // จับเวลาไปจนอ่าน body จบ ไม่ใช่แค่ได้ header มา
    async fetchJson(url, options, timeoutMs, { anonymous = false } = {}) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        try {
            // `anonymous` มีไว้ให้ออด SOS เท่านั้น — `authorizedFetch` โยนทิ้งตั้งแต่ยังไม่ยิง
            // ถ้าไม่มีใครล็อกอินอยู่ ซึ่งจะทำให้คนที่กำลังเจ็บเรียกครูไม่ได้
            const send = url === '/api/command' && !this.isPiLocal() && !anonymous
                ? window.AuthService?.authorizedFetch.bind(window.AuthService) : fetch;
            if (!send) throw new Error('School sign-in required');
            const response = await send(url, { ...options, signal: controller.signal });
            const data = await response.json();
            if (controller.signal.aborted) throw new Error('Response deadline exceeded');
            return { response, data };
        } finally { clearTimeout(timeout); }
    },

    async sendMqttCommand(body, { anonymous = false } = {}) {
        let hardware = null;
        // preflight อ่านสถานะตู้ ซึ่งเป็น endpoint ที่ต้องล็อกอิน ⇒ รอบที่ไม่มีตัวตนข้ามไปเลย
        // แล้วให้เซิร์ฟเวอร์เป็นคนตรวจความพร้อมก่อน publish (มันตรวจอยู่แล้วทุกครั้ง)
        if (anonymous) {
            const { response, data } = await this.fetchJson('/api/command', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            }, this.ANON_BUZZER_TIMEOUT_MS, { anonymous: true }).catch(() => ({ response: null, data: {} }));
            if (response?.ok && data.success && this.isCommandAck(data.ack, body)) {
                return { success: true, mode: 'mqtt', commandId: body.id, mqttConfigured: true };
            }
            return { success: false, mode: 'mqtt', commandId: body.id,
                retrySafe: data.retrySafe === true,
                error: data.error || 'ยังยืนยันว่าออดดังไม่ได้ กรุณาเรียกครูที่อยู่ใกล้ที่สุด' };
        }
        try {
            const { response, data } = await this.fetchJson('/api/command', {}, this.MQTT_STATUS_TIMEOUT_MS);
            if (response.ok && data.mqttConfigured === false) {
                return { success: false, mode: 'mqtt', mqttConfigured: false, retrySafe: true,
                    error: 'ยังไม่ได้ตั้งค่า MQTT บนเซิร์ฟเวอร์' };
            }
            if (!response.ok || !data.connected || data.protocol !== 2 ||
                !Number.isInteger(data.ackTimeoutMs) || data.ackTimeoutMs < 3000 || data.ackTimeoutMs > 120000 ||
                data.commandTimeoutMs !== data.ackTimeoutMs + 10000 || (body.action === 'open' && !data.ready)) {
                throw new Error('Cabinet not ready');
            }
            hardware = data;
        } catch {
            return { success: false, mode: 'mqtt', retrySafe: true,
                error: 'ยังไม่ได้ส่งคำสั่ง ตู้ยังไม่พร้อมหรือเชื่อมต่อ MQTT ไม่ได้ ตรวจการตั้งค่าแล้วลองใหม่' };
        }

        try {
            const { response, data } = await this.fetchJson('/api/command', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ...body, ackTimeoutMs: hardware.ackTimeoutMs })
            }, hardware.commandTimeoutMs + 5000);
            if (response.ok && data.success && this.isCommandAck(data.ack, body)) {
                return { success: true, mode: 'mqtt', compartment: body.drawer, commandId: body.id, mqttConfigured: true };
            }
            return { success: false, mode: 'mqtt', commandId: body.id, mqttConfigured: true,
                retrySafe: data.retrySafe === true,
                error: data.error || 'ยังยืนยันผลจากตู้ยาไม่ได้ กรุณาตรวจตู้ก่อน ห้ามสั่งซ้ำ' };
        } catch {
            return { success: false, mode: 'mqtt', commandId: body.id, mqttConfigured: true,
                error: 'การเชื่อมต่อ MQTT ขัดข้อง ผลคำสั่งยังไม่แน่นอน กรุณาตรวจตู้ก่อน ห้ามสั่งซ้ำ' };
        }
    },

    async sendLanCommand(baseUrl, body) {
        // เว็บ https เรียกตู้ที่เป็น http ตรงๆ ไม่ได้ เบราว์เซอร์บล็อก เส้นออฟไลน์จึงต้องใช้จอบนตู้
        if (window.location?.protocol === 'https:' && baseUrl.startsWith('http:')) {
            return { success: false, mode: 'production', retrySafe: true,
                error: 'เว็บ HTTPS ต้องตั้งค่า MQTT หรือใช้หน้าตู้บน Pi สำหรับการสั่งงานใน LAN' };
        }
        let budget;
        try {
            const { response, data } = await this.fetchJson(`${baseUrl}/status`, {}, 2500);
            if (!response.ok || data.protocol !== 2 || data.microbit !== 'connected' ||
                !Number.isInteger(data.ackTimeoutMs) || data.ackTimeoutMs < 3000 || data.ackTimeoutMs > 120000 ||
                (body.action === 'open' && !data.ready)) throw new Error('Not ready');
            budget = data.ackTimeoutMs + 3000;
        } catch {
            return { success: false, mode: 'production', retrySafe: true, error: 'ยังไม่ได้ส่งคำสั่ง ตู้ใน LAN ยังไม่พร้อม' };
        }
        const deadline = Date.now() + budget;
        let reply;
        try {
            const path = body.action === 'open' ? `/open?drawer=${body.drawer}` : `/buzzer?state=${body.state === 'on' ? 1 : 0}`;
            reply = await this.fetchJson(`${baseUrl}${path}&id=${encodeURIComponent(body.id)}`, {}, 2000);
        } catch { /* Possibly sent. From here, query only; never issue another actuator request. */ }
        while (Date.now() < deadline) {
            if (reply?.response.ok && reply.data.success === true && this.isCommandAck(reply.data, body)) {
                return { success: true, mode: 'production', compartment: body.drawer, commandId: body.id };
            }
            if (reply?.data.actuated === false && reply.data.id === body.id) {
                return { success: false, mode: 'production', error: 'ตู้ปฏิเสธคำสั่ง กรุณาตรวจสถานะหน้าตู้' };
            }
            await new Promise(resolve => setTimeout(resolve, 250));
            const remaining = deadline - Date.now();
            if (remaining <= 0) break;
            try {
                reply = await this.fetchJson(`${baseUrl}/command-status?id=${encodeURIComponent(body.id)}`, {}, Math.min(1000, remaining));
            } catch { reply = null; }
        }
        return { success: false, mode: 'production', commandId: body.id,
            error: 'ยังยืนยันผลจากตู้ไม่ได้ กรุณาตรวจตู้ก่อน ห้ามสั่งซ้ำ' };
    },

    sendLanOpen(baseUrl, drawer, commandId) {
        return this.sendLanCommand(baseUrl, { action: 'open', drawer, id: commandId });
    },

    // โหมดของตู้ demo real หรือยังไม่ได้ตั้ง อ่านจากที่เดียวกันทั้งระบบ
    // ถ้าไม่มี StorageService (ตอนเทส) ให้อ่านเอง สองที่จะได้ไม่เห็นโหมดไม่ตรงกัน
    operatingMode() {
        const mode = window.SFAB_RUNTIME?.mode;
        return this.isPiLocal() && ['demo', 'real', 'unset'].includes(mode) ? mode : 'unset';
    },

    isDemoMode(settings) {
        return this.operatingMode(settings) === 'demo';
    },

    // ยังไม่มีใครตั้งโหมด จึงห้ามสั่งของจริงและห้ามอ้างว่าสำเร็จ
    // ลองใหม่ได้ปลอดภัยเพราะยังไม่มีคำสั่งไหนออกจากเบราว์เซอร์เลย
    unprovisioned(commandId) {
        return { success: false, mode: 'unprovisioned', commandId, retrySafe: true,
            error: 'ตู้ยังไม่ได้ตั้งโหมดการทำงาน ให้ครูตั้งค่าที่หน้าครูก่อนใช้งาน' };
    },

    // เช็คว่าตู้ออนไลน์อยู่ไหม
    async getHardwareStatus() {
        const settings = this.getSettings();
        if (!this.isPiLocal() && !window.AuthService?.isSignedIn()) {
            return { connected: false, ready: false, mode: 'unauthorized' };
        }
        if (this.isPiLocal()) {
            try {
                const response = await this.fetchWithTimeout('/api/local/status', {}, 2500);
                const data = await response.json();
                return { connected: response.ok && data.connected === true,
                    ready: data.ready === true, reason: data.reason, mode: 'pi-local',
                    // อยู่ข้ามการรีเฟรชและรีสตาร์ต เพราะ Pi อ่านจากสมุดคำสั่ง ไม่ใช่จากที่หน้านี้จำไว้
                    unresolved: data.unresolved || null };
            } catch { return { connected: false, mode: 'pi-local' }; }
        }

        try {
            const { response, data } = await this.fetchJson('/api/command', {}, this.MQTT_STATUS_TIMEOUT_MS);
            if (data.mqttConfigured !== false) {
                return { connected: response.ok && data.connected === true,
                    ready: data.ready === true, reason: data.reason, mode: 'mqtt' };
            }
            if (this.isHardwareConfigured(settings) &&
                !(window.location?.protocol === 'https:' && settings.esp32Url.startsWith('http:'))) {
                const lan = await this.fetchJson(`${settings.esp32Url.trim()}/status`, {}, 2500);
                return { connected: lan.response.ok && lan.data.protocol === 2 && lan.data.microbit === 'connected',
                    ready: lan.data.ready === true, mode: 'production' };
            }
        } catch { return { connected: false, mode: 'mqtt' }; }

        return { connected: false, mode: 'offline', error: 'ตู้ไม่ได้เชื่อมต่อฮาร์ดแวร์' };
    },

    // สั่งเปิดช่องจ่ายยา ช่อง 1 แผลถลอก ช่อง 2 แมลงกัด
    // `presetId` ให้ผู้เรียกกำหนด id ของคำสั่งเองได้ สำหรับรอบที่ต้องผูกของอย่างอื่นเข้ากับ id
    // นั้นก่อนคำสั่งจะถูกส่ง (รอบไม่มีบัตรอัปรูปใบหน้าไว้ที่คีย์ `{cabinetId}~{id}` ก่อน)
    // ไม่ส่งมา = สร้างเองเหมือนเดิม
    async openCompartment(woundId, studentSession, presetId = null) {
        const settings = this.getSettings();
        const isDemo = this.isDemoMode();
        // เปิดช่องยาคืองานของนักเรียนที่เจ็บ ไม่ใช่ของครู ⇒ เกตคือ "ล็อกอินบัญชีโรงเรียนแล้วหรือยัง"
        // ไม่ใช่บทบาท · เสียงออด (triggerBuzzer) ยังเป็นของครูอยู่ เพราะมันเรียกคนทั้งห้องพยาบาล
        if (!this.isPiLocal() && !window.AuthService?.isSignedIn()) {
            return { success: false, mode: 'unauthorized', retrySafe: true, error: 'กรุณาเข้าสู่ระบบด้วยบัญชีโรงเรียนก่อนสั่งเปิดช่องยา' };
        }
        const woundCompartmentMap = {
            cut_abrasion: 1,
            abrasion: 1,
            cut: 1,
            insect: 2
        };
        const compartmentNum = woundCompartmentMap[woundId] || 1;
        const commandId = presetId || this.createCommandId();

        // 0. ยังไม่มีใครเลือกโหมด: ห้ามสั่งจริง และห้ามแกล้งทำเป็นว่าจำลองสำเร็จ
        //    เกตนี้ต้องมาก่อนทุกอย่างที่แตะเครือข่าย
        if (this.isPiLocal() && this.operatingMode() === 'unset') return this.unprovisioned(commandId);

        // 1. ถ้าเปิดโหมดสาธิต (Demo ON): จำลองการสั่งจ่ายยาสำเร็จทันที ไม่ต้องส่งสัญญาณฮาร์ดแวร์จริง
        if (isDemo) {
            console.log(`[ApiBridge Demo ON] Opening Compartment #${compartmentNum} for Wound: ${woundId}`);
            await new Promise(resolve => setTimeout(resolve, 500));
            return { success: true, mode: 'simulation', compartment: compartmentNum };
        }

        if (!Object.hasOwn(woundCompartmentMap, woundId)) {
            return { success: false, mode: this.isPiLocal() ? 'pi-local' : 'mqtt', retrySafe: true,
                error: 'ประเภทแผลนี้ไม่มีช่องยารองรับ' };
        }
        if (this.isPiLocal()) {
            return this.sendLocalCommand({ action: 'open', drawer: compartmentNum, id: commandId, ...(studentSession ? { studentSession } : {}) });
        }

        // 2. ถ้าปิดโหมดสาธิต (Demo OFF): ส่งสัญญาณจริงผ่าน MQTT / LAN เท่านั้น
        console.log(`[ApiBridge Demo OFF] Sending REAL hardware command for Compartment #${compartmentNum}...`);
        const mqttResult = await this.sendMqttCommand({
            action: 'open',
            woundId,
            drawer: compartmentNum,
            id: commandId,
            ts: Date.now()
        });
        if (mqttResult.success) {
            return { success: true, mode: 'mqtt', compartment: mqttResult.compartment || compartmentNum };
        }

        // คลาวด์ล้มแล้วห้ามหันไปยิงตรงในวงแลนแทน

        // ปิดโหมดสาธิตอยู่และส่งสัญญาณฮาร์ดแวร์จริงไม่สำเร็จ -> คืนค่าความล้มเหลวตามจริง!
        return {
            success: false,
            mode: 'mqtt',
            compartment: compartmentNum,
            retrySafe: mqttResult.retrySafe === true,
            error: mqttResult.error || 'ตู้ยาไม่ยืนยันการเปิดลิ้นชัก กรุณาตรวจสอบการเชื่อมต่อตู้ยา'
        };
    },

    // สั่งออดเรียกครู
    async triggerBuzzer(state) {
        const commandId = this.createCommandId();
        if (this.isPiLocal()) {
            return this.sendLocalCommand({ action: 'buzzer', state: state === 'on' ? 'on' : 'off', id: commandId });
        }
        // เสียงออกจาก SOS ต้องดังทุกครั้งที่มีคนกด **ไม่ว่าจะล็อกอินอยู่หรือไม่**
        // คนที่เจ็บอาจไม่ใช่เจ้าของเครื่อง และการขอให้ล็อกอินก่อนเรียกคนช่วย คือการกันคนออกจาก
        // ความช่วยเหลือในนาทีที่ต้องการมันที่สุด
        //
        // **แต่การ "หยุด" เสียงยังเป็นของครู** — ถ้าใครก็กดหยุดได้ คนที่ก่อเหตุก็ปิดปาก SOS
        // ของตัวเองได้ · ฝั่งครูหยุดจากหน้า dashboard ซึ่งล็อกอินอยู่แล้ว
        const wantsOn = state === 'on';
        if (!wantsOn && !window.AuthService?.isStaff()) {
            return { success: false, mode: 'unauthorized', retrySafe: true,
                error: 'เฉพาะครูที่ได้รับสิทธิ์เท่านั้นที่หยุดเสียงได้' };
        }
        const anonymous = wantsOn && window.AuthService?.isSignedIn?.() !== true;
        const mqttResult = await this.sendMqttCommand({
            action: 'buzzer',
            state: wantsOn ? 'on' : 'off',
            id: commandId,
            ts: Date.now()
        }, { anonymous });
        if (mqttResult.success) return { success: true, mode: 'mqtt' };


        return { success: false, mode: 'mqtt', retrySafe: mqttResult.retrySafe === true, error: mqttResult.error || 'ไม่สามารถส่งสัญญาณไซเรนไปยังอุปกรณ์ได้' };
    }
};

window.ApiBridge = ApiBridge;
