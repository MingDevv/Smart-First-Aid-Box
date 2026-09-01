// JS/API-BRIDGE.JS
//
// ขาลง (สั่งงานตู้ยา) มีสองเส้นทาง เรียงตามลำดับที่ลอง:
//   1. MQTT ผ่าน /api/command — ใช้ได้จากทุกที่ที่มีเน็ต ไม่ติด mixed content
//   2. HTTP ตรงไปที่ ESP32 ในวง LAN — ใช้ได้เฉพาะตอนเปิดหน้าเว็บผ่าน http:// ในวงเดียวกัน
//      แต่ไม่พึ่งอินเทอร์เน็ต จึงเก็บไว้เป็นเส้นสำรองสำหรับวันที่เน็ตโรงเรียนล่ม
//   3. โหมดจำลอง — ใช้ได้เมื่อ server ยืนยันว่าไม่ได้ตั้ง MQTT และไม่ได้ตั้ง LAN เท่านั้น
const ApiBridge = {
    // 2.5s connect + 5.5s device ACK = server budget สูงสุดราว 8s
    // browser ต้องรอนานกว่านั้นเสมอ ไม่เช่นนั้น server อาจ publish หลัง browser fallback ไปแล้ว
    BROWSER_COMMAND_TIMEOUT_MS: 9500,
    DRAWER_ACK_TIMEOUT_MS: 7500,

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

    // server จะตอบ success สำหรับการเปิดลิ้นชักก็ต่อเมื่อมันได้รับ drawer_opened id เดียวกัน
    async sendMqttCommand(body) {
        const directAckPromise = body.action === 'open' &&
            window.MqttBridge &&
            typeof window.MqttBridge.waitForDrawerOpened === 'function'
            ? window.MqttBridge.waitForDrawerOpened(body.id, body.drawer, this.DRAWER_ACK_TIMEOUT_MS)
            : Promise.resolve(null);

        try {
            const response = await this.fetchWithTimeout('/api/command', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            }, this.BROWSER_COMMAND_TIMEOUT_MS);
            const data = await response.json().catch(() => ({}));

            if (body.action === 'open') {
                if (response.ok && data.success && this.isDrawerAck(data.ack, body.id, body.drawer)) {
                    return {
                        success: true,
                        mode: 'mqtt',
                        compartment: data.compartment,
                        commandId: body.id,
                        mqttConfigured: true
                    };
                }

                // ถ้าหน้านี้มี subscriber ของตัวเอง event ตรงจาก broker ก็เป็นหลักฐานได้เช่นกัน
                if (data.mqttConfigured !== false) {
                    const directAck = await directAckPromise;
                    if (this.isDrawerAck(directAck, body.id, body.drawer)) {
                        return {
                            success: true,
                            mode: 'mqtt',
                            compartment: Number(body.drawer),
                            commandId: body.id,
                            mqttConfigured: true
                        };
                    }
                }

                return {
                    success: false,
                    mode: 'mqtt',
                    commandId: body.id,
                    mqttConfigured: data.mqttConfigured,
                    error: data.error || `MQTT ตอบกลับสถานะรหัส: ${response.status}`
                };
            }

            if (response.ok && data.success) {
                return { success: true, mode: 'mqtt', commandId: body.id, mqttConfigured: true };
            }
            return {
                success: false,
                mode: 'mqtt',
                commandId: body.id,
                mqttConfigured: data.mqttConfigured,
                error: data.error || `MQTT ตอบกลับสถานะรหัส: ${response.status}`
            };
        } catch (err) {
            if (body.action === 'open') {
                const directAck = await directAckPromise;
                if (this.isDrawerAck(directAck, body.id, body.drawer)) {
                    return {
                        success: true,
                        mode: 'mqtt',
                        compartment: Number(body.drawer),
                        commandId: body.id,
                        mqttConfigured: true
                    };
                }
            }
            return {
                success: false,
                mode: 'mqtt',
                commandId: body.id,
                // ไม่รู้ว่า server ตั้ง MQTT หรือไม่ ต้องถือว่าอาจตั้งไว้และห้ามรายงาน simulation success
                mqttConfigured: undefined,
                error: err.name === 'AbortError'
                    ? 'รอคำยืนยันจากตู้ยาผ่าน MQTT นานเกินไป'
                    : 'ส่งคำสั่งผ่าน MQTT ไม่สำเร็จ'
            };
        }
    },

    async sendLanOpen(baseUrl, drawer, commandId) {
        const deadline = Date.now() + this.DRAWER_ACK_TIMEOUT_MS;
        const openUrl = `${baseUrl}/open?drawer=${drawer}&id=${encodeURIComponent(commandId)}`;

        try {
            const response = await this.fetchWithTimeout(openUrl, { method: 'GET' }, 2000);
            const data = await response.json().catch(() => ({}));
            if (response.status === 200 && this.isDrawerAck(data, commandId, drawer)) {
                return { success: true, mode: 'production', compartment: drawer, commandId };
            }
            if (response.status !== 202) {
                return {
                    success: false,
                    mode: 'production',
                    compartment: drawer,
                    commandId,
                    error: data.error || `ตู้ยาตอบกลับสถานะรหัส: ${response.status}`
                };
            }

            while (Date.now() < deadline) {
                await new Promise(resolve => setTimeout(resolve, 250));
                const remaining = deadline - Date.now();
                if (remaining <= 0) break;

                const statusResponse = await this.fetchWithTimeout(
                    `${baseUrl}/command-status?id=${encodeURIComponent(commandId)}`,
                    { method: 'GET' },
                    Math.min(1000, remaining)
                );
                const statusData = await statusResponse.json().catch(() => ({}));

                if (statusResponse.status === 200 && this.isDrawerAck(statusData, commandId, drawer)) {
                    return { success: true, mode: 'production', compartment: drawer, commandId };
                }
                if (statusResponse.status !== 202 && statusResponse.status !== 404) {
                    return {
                        success: false,
                        mode: 'production',
                        compartment: drawer,
                        commandId,
                        error: statusData.error || `ตู้ยาตอบกลับสถานะรหัส: ${statusResponse.status}`
                    };
                }
            }

            return {
                success: false,
                mode: 'production',
                compartment: drawer,
                commandId,
                error: 'ไม่พบคำยืนยันว่าลิ้นชักเปิดภายในเวลาที่กำหนด'
            };
        } catch (err) {
            console.warn(`[ApiBridge Error] Connection to ESP32 failed at ${baseUrl}:`, err);
            return {
                success: false,
                mode: 'error',
                compartment: drawer,
                commandId,
                error: 'ไม่สามารถเชื่อมต่อกับตู้ยาได้ กรุณาตรวจสอบสายสัญญาณหรือ WiFi'
            };
        }
    },

    // Check if the hardware (ESP32 controller connected to micro:bit) is online
    async getHardwareStatus() {
        // MQTT listener รู้สถานะจาก retained message + LWT ของ broker อยู่แล้ว
        if (this.isMqttListenerConfigured() && window.MqttBridge.isOnline()) {
            return { connected: true, mode: 'mqtt' };
        }

        const settings = this.getSettings();
        if (!this.isHardwareConfigured(settings)) return { connected: false, mode: 'simulation' };

        const url = settings.esp32Url.trim();
        try {
            const response = await this.fetchWithTimeout(`${url}/status`, {}, 1500);
            if (response.ok) return { connected: true, mode: 'production' };
            return { connected: false, mode: 'error', error: `HTTP ${response.status}` };
        } catch (e) {
            console.log('[ApiBridge] Cannot connect to ESP32 controller.');
            return { connected: false, mode: 'error', error: e.message };
        }
    },

    // Trigger physical box compartment opening (Compartment 1: Cut/Abrasion, Compartment 2: Insect Bite)
    async openCompartment(woundId) {
        const settings = this.getSettings();
        const woundCompartmentMap = {
            cut_abrasion: 1,
            abrasion: 1,
            cut: 1,
            insect: 2
        };
        const compartmentNum = woundCompartmentMap[woundId] || 1;
        const commandId = this.createCommandId();

        // ลอง server ทุกครั้ง — localStorage บอกได้แค่ listener ฝั่ง browser ไม่ใช่ขาลงของ Vercel
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
        console.warn('[ApiBridge] MQTT ไม่สำเร็จ ลองสั่งผ่าน LAN ต่อ:', mqttResult.error);

        if (this.isHardwareConfigured(settings)) {
            return this.sendLanOpen(settings.esp32Url.trim(), compartmentNum, commandId);
        }

        // จำลองได้เฉพาะเมื่อ server ตอบชัดเจนว่าไม่ได้ตั้ง MQTT เท่านั้น
        if (mqttResult.mqttConfigured === false) {
            console.log(`[ApiBridge Simulation] Opening Compartment #${compartmentNum} for Wound: ${woundId}`);
            await new Promise(resolve => setTimeout(resolve, 800));
            return { success: true, mode: 'simulation', compartment: compartmentNum };
        }

        return {
            success: false,
            mode: 'mqtt',
            compartment: compartmentNum,
            error: mqttResult.error || 'ตู้ยาไม่ยืนยันการเปิดลิ้นชัก'
        };
    },

    // Trigger Buzzer Siren for SOS emergencies
    async triggerBuzzer(state) {
        const settings = this.getSettings();
        const stateParam = state === 'on' ? '1' : '0';
        const commandId = this.createCommandId();

        const mqttResult = await this.sendMqttCommand({
            action: 'buzzer',
            state: state === 'on' ? 'on' : 'off',
            id: commandId,
            ts: Date.now()
        });
        if (mqttResult.success) return { success: true, mode: 'mqtt' };
        console.warn('[ApiBridge] MQTT ไม่สำเร็จ ลองสั่งผ่าน LAN ต่อ:', mqttResult.error);

        if (!this.isHardwareConfigured(settings)) {
            if (mqttResult.mqttConfigured === false) {
                console.log(`[ApiBridge Simulation] ESP32 Buzzer Siren turned: ${state.toUpperCase()}`);
                return { success: true, mode: 'simulation' };
            }
            return { success: false, mode: 'mqtt', error: mqttResult.error || 'ส่งสัญญาณไซเรนไม่สำเร็จ' };
        }

        const url = settings.esp32Url.trim();
        try {
            const response = await this.fetchWithTimeout(
                `${url}/buzzer?state=${stateParam}&id=${encodeURIComponent(commandId)}`,
                { method: 'GET' },
                2000
            );
            if (response.ok) return { success: true, mode: 'production' };
            return { success: false, mode: 'production', error: `สวิตช์สัญญาณตอบกลับสถานะรหัส: ${response.status}` };
        } catch (err) {
            console.warn(`[ApiBridge Error] ESP32 Buzzer link failed at ${url}:`, err);
            return { success: false, mode: 'error', error: 'ไม่สามารถส่งสัญญาณไซเรนไปยังอุปกรณ์ได้' };
        }
    }
};

window.ApiBridge = ApiBridge;
