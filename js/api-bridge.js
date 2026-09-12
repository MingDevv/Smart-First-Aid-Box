// JS/API-BRIDGE.JS
//
// Pi uses the local service. Vercel uses MQTT with protocol-2 readiness and ACKs.
// An explicitly unconfigured MQTT server permits HTTP-LAN fallback. An uncertain
// command never falls back to another actuator transport. Demo is explicit only.
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
            return { success: false, mode: 'pi-local', commandId: body.id,
                error: data.error || 'Pi ยังยืนยันผลจากตู้ยาไม่ได้' };
        } catch {
            return { success: false, mode: 'pi-local', commandId: body.id,
                error: 'การเชื่อมต่อ Pi ขัดข้อง กรุณาตรวจตู้ก่อน ห้ามสั่งจ่ายซ้ำ' };
        } finally { clearTimeout(timeout); }
    },

    // GET may establish MQTT and receive retained hardware metadata (4.5s + 2s).
    MQTT_STATUS_TIMEOUT_MS: 8000,

    // Check if hardware URL is configured and valid
    isHardwareConfigured(settings) {
        if (!settings || !settings.esp32Url) return false;
        const url = settings.esp32Url.trim();
        // If explicitly set to empty or default unconfigured placeholder, mark as not configured
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

    // Keep the deadline active through JSON body consumption, not only response headers.
    async fetchJson(url, options, timeoutMs) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = await fetch(url, { ...options, signal: controller.signal });
            const data = await response.json();
            if (controller.signal.aborted) throw new Error('Response deadline exceeded');
            return { response, data };
        } finally { clearTimeout(timeout); }
    },

    async sendMqttCommand(body) {
        let hardware;
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
        // HTTPS Vercel cannot call an HTTP cabinet. The Pi kiosk provides the offline path.
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

    // 'demo' | 'real' | 'unset'. Single source of truth, shared with NotificationService.
    // Falls back to the module's own reading when StorageService is absent (tests, vm harnesses)
    // so the two can never drift into disagreeing about what mode the cabinet is in.
    operatingMode(settings) {
        // ค่าที่บริการบน Pi ฉีดมาชนะเสมอ ต้องตรวจก่อน StorageService เพราะฟังก์ชันนี้ถูก
        // เรียกได้ในบริบทที่ไม่มี StorageService (vm harness) และคำตอบต้องตรงกันทุกที่
        const injected = window.SFAB_RUNTIME?.mode;
        if (injected === 'demo' || injected === 'real' || injected === 'unset') return injected;
        const s = settings || this.getSettings();
        if (window.StorageService?.getOperatingMode) return window.StorageService.getOperatingMode(s);
        if (!s.modeProvisionedAt) return 'unset';
        if (s.demoMode === true || s.demoMode === 'true') return 'demo';
        if (s.demoMode === false || s.demoMode === 'false') return 'real';
        return 'unset';
    },

    isDemoMode(settings) {
        return this.operatingMode(settings) === 'demo';
    },

    // Nobody has chosen a mode, so nothing may be actuated and nothing may be claimed.
    // retrySafe is true because no command left the browser — the operator can set the mode
    // and the student can try again without risking a second physical operation.
    unprovisioned(commandId) {
        return { success: false, mode: 'unprovisioned', commandId, retrySafe: true,
            error: 'ตู้ยังไม่ได้ตั้งโหมดการทำงาน ให้ครูตั้งค่าที่หน้าครูก่อนใช้งาน' };
    },

    // Check if the hardware (ESP32 controller connected to micro:bit) is online
    async getHardwareStatus() {
        const settings = this.getSettings();
        const isDemo = this.isDemoMode(settings);

        // ยังไม่ได้ตั้งโหมด = ตู้ใช้งานไม่ได้ ต้องรายงานแบบนั้น ไม่ใช่ไปถามสถานะจริงมาโชว์ว่า
        // "พร้อม" ข้างปุ่มที่จะปฏิเสธทุกครั้ง — ป้ายกับพฤติกรรมต้องพูดตรงกัน
        if (this.operatingMode(settings) === 'unset') {
            return { connected: false, ready: false, mode: 'unprovisioned',
                error: 'ตู้ยังไม่ได้ตั้งโหมดการทำงาน' };
        }

        if (isDemo) {
            return { connected: true, mode: 'simulation' };
        }

        if (this.isPiLocal()) {
            try {
                const response = await this.fetchWithTimeout('/api/local/status', {}, 2500);
                const data = await response.json();
                return { connected: response.ok && data.connected === true,
                    ready: data.ready === true, reason: data.reason, mode: 'pi-local',
                    // Survives reload and restart: the Pi reads it from the command journal,
                    // not from anything this page remembers. See edge/controller.mjs unresolved().
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

    // Trigger physical box compartment opening (Compartment 1: Cut/Abrasion, Compartment 2: Insect Bite)
    async openCompartment(woundId) {
        const settings = this.getSettings();
        const isDemo = this.isDemoMode(settings);
        const woundCompartmentMap = {
            cut_abrasion: 1,
            abrasion: 1,
            cut: 1,
            insect: 2
        };
        const compartmentNum = woundCompartmentMap[woundId] || 1;
        const commandId = this.createCommandId();

        // 0. ยังไม่มีใครเลือกโหมด: ห้ามสั่งจริง และห้ามแกล้งทำเป็นว่าจำลองสำเร็จ
        //    เกตนี้ต้องมาก่อนทุกอย่างที่แตะเครือข่าย (Bank เคาะ 2026-09-11)
        if (this.operatingMode(settings) === 'unset') return this.unprovisioned(commandId);

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
            return this.sendLocalCommand({ action: 'open', drawer: compartmentNum, id: commandId });
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

        // Only an explicitly unconfigured cloud path may dispatch via LAN.
        // Timeout/refusal after publishing must not start a second attempt on another transport.
        if (mqttResult.mqttConfigured === false && this.isHardwareConfigured(settings)) {
            return this.sendLanOpen(settings.esp32Url.trim(), compartmentNum, commandId);
        }

        // ปิดโหมดสาธิตอยู่และส่งสัญญาณฮาร์ดแวร์จริงไม่สำเร็จ -> คืนค่าความล้มเหลวตามจริง!
        return {
            success: false,
            mode: 'mqtt',
            compartment: compartmentNum,
            retrySafe: mqttResult.retrySafe === true,
            error: mqttResult.error || 'ตู้ยาไม่ยืนยันการเปิดลิ้นชัก กรุณาตรวจสอบการเชื่อมต่อตู้ยา'
        };
    },

    // Trigger Buzzer Siren for SOS emergencies
    async triggerBuzzer(state) {
        const settings = this.getSettings();
        const isDemo = this.isDemoMode(settings);
        const commandId = this.createCommandId();

        // ออดคือฮาร์ดแวร์เหมือนกัน โหมดที่ยังไม่ได้ตั้งจึงสั่งไม่ได้
        // แต่ NotificationService.sendSos รายงานผล LINE แยกจากผลออด การขอความช่วยเหลือ
        // จึงยังถึงครูได้ และหน้าจอจะบอกตรงๆ ว่าเสียงที่ตู้ยังยืนยันไม่ได้
        if (this.operatingMode(settings) === 'unset') return this.unprovisioned(commandId);

        if (isDemo) {
            console.log(`[ApiBridge Demo ON] ESP32 Siren: ${state.toUpperCase()}`);
            return { success: true, mode: 'simulation' };
        }

        if (this.isPiLocal()) {
            return this.sendLocalCommand({ action: 'buzzer', state: state === 'on' ? 'on' : 'off', id: commandId });
        }

        // ปิดโหมดสาธิตอยู่ -> ส่งสัญญาณจริงผ่าน MQTT / LAN
        const mqttResult = await this.sendMqttCommand({
            action: 'buzzer',
            state: state === 'on' ? 'on' : 'off',
            id: commandId,
            ts: Date.now()
        });
        if (mqttResult.success) return { success: true, mode: 'mqtt' };

        if (mqttResult.mqttConfigured === false && this.isHardwareConfigured(settings)) {
            return this.sendLanCommand(settings.esp32Url.trim(), {
                action: 'buzzer', state: state === 'on' ? 'on' : 'off', id: commandId
            });
        }

        return { success: false, mode: 'mqtt', retrySafe: mqttResult.retrySafe === true, error: mqttResult.error || 'ไม่สามารถส่งสัญญาณไซเรนไปยังอุปกรณ์ได้' };
    }
};

window.ApiBridge = ApiBridge;
