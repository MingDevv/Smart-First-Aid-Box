// JS/API-BRIDGE.JS
//
// ขาลง (สั่งงานตู้ยา) มีสองเส้นทาง เรียงตามลำดับที่ลอง:
//   1. MQTT ผ่าน /api/command — ใช้ได้จากทุกที่ที่มีเน็ต ไม่ติด mixed content
//   2. HTTP ตรงไปที่ ESP32 ในวง LAN — ใช้ได้เฉพาะตอนเปิดหน้าเว็บผ่าน http:// ในวงเดียวกัน
//      แต่ไม่พึ่งอินเทอร์เน็ต จึงเก็บไว้เป็นเส้นสำรองสำหรับวันที่เน็ตโรงเรียนล่ม
//   3. โหมดจำลอง — เมื่อยังไม่ได้ตั้งค่าอะไรเลย
const ApiBridge = {
    // Check if hardware URL is configured and valid
    isHardwareConfigured(settings) {
        if (!settings || !settings.esp32Url) return false;
        const url = settings.esp32Url.trim();
        // If explicitly set to empty or default unconfigured placeholder, mark as not configured
        if (!url || settings.isConfigured === false) return false;
        return true;
    },

    isMqttConfigured() {
        return !!(window.MqttBridge && window.MqttBridge.isConfigured());
    },

    getSettings() {
        return window.StorageService ? window.StorageService.getSettings() : { esp32Url: '' };
    },

    // ส่งคำสั่งให้เซิร์ฟเวอร์ publish ขึ้น MQTT แทนเรา (รหัส broker ไม่เคยออกมาถึงเบราว์เซอร์)
    async sendMqttCommand(body) {
        const controller = new AbortController();
        const id = setTimeout(() => controller.abort(), 6000);
        try {
            const response = await fetch('/api/command', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
                signal: controller.signal
            });
            const data = await response.json().catch(() => ({}));
            if (response.ok && data.success) {
                return { success: true, mode: 'mqtt', compartment: data.compartment, commandId: data.commandId };
            }
            return { success: false, mode: 'mqtt', error: data.error || `MQTT ตอบกลับสถานะรหัส: ${response.status}` };
        } catch (err) {
            return { success: false, mode: 'mqtt', error: 'ส่งคำสั่งผ่าน MQTT ไม่สำเร็จ' };
        } finally {
            clearTimeout(id);
        }
    },

    // Check if the hardware (ESP32 controller connected to micro:bit) is online
    async getHardwareStatus() {
        // MQTT รู้สถานะจาก retained message + LWT ของ broker อยู่แล้ว ไม่ต้องยิงถามกล่อง
        if (this.isMqttConfigured() && window.MqttBridge.isOnline()) {
            return { connected: true, mode: 'mqtt' };
        }

        const settings = this.getSettings();

        if (!this.isHardwareConfigured(settings)) {
            return { connected: false, mode: 'simulation' };
        }

        const url = settings.esp32Url.trim();

        try {
            const controller = new AbortController();
            const id = setTimeout(() => controller.abort(), 1500);

            const response = await fetch(`${url}/status`, {
                signal: controller.signal
            });
            clearTimeout(id);

            if (response.ok) {
                return { connected: true, mode: 'production' };
            }
            return { connected: false, mode: 'error', error: `HTTP ${response.status}` };
        } catch (e) {
            console.log('[ApiBridge] Cannot connect to ESP32 controller.');
            return { connected: false, mode: 'error', error: e.message };
        }
    },

    // Trigger physical box compartment opening (Compartment 1: Cut/Abrasion, Compartment 2: Insect Bite)
    async openCompartment(woundId) {
        const settings = this.getSettings();

        // Mapping woundId to ESP32 / micro:bit compartment numbers (1 or 2)
        const woundCompartmentMap = {
            "cut_abrasion": 1,
            "abrasion": 1,
            "cut": 1,
            "insect": 2
        };

        const compartmentNum = woundCompartmentMap[woundId] || 1;

        if (this.isMqttConfigured()) {
            const result = await this.sendMqttCommand({ action: 'open', woundId, drawer: compartmentNum });
            if (result.success) {
                return { success: true, mode: 'mqtt', compartment: result.compartment || compartmentNum };
            }
            console.warn('[ApiBridge] MQTT ไม่สำเร็จ ลองสั่งผ่าน LAN ต่อ:', result.error);
        }

        if (!this.isHardwareConfigured(settings)) {
            console.log(`[ApiBridge Simulation] Opening Compartment #${compartmentNum} for Wound: ${woundId}`);
            await new Promise(resolve => setTimeout(resolve, 800));
            return { success: true, mode: 'simulation', compartment: compartmentNum };
        }

        const url = settings.esp32Url.trim();

        try {
            const controller = new AbortController();
            const id = setTimeout(() => controller.abort(), 2000);

            const response = await fetch(`${url}/open?drawer=${compartmentNum}`, {
                method: 'GET',
                signal: controller.signal
            });
            clearTimeout(id);

            if (response.ok) {
                return { success: true, mode: 'production', compartment: compartmentNum };
            }
            return { success: false, mode: 'production', compartment: compartmentNum, error: `ตู้ยาตอบกลับสถานะรหัส: ${response.status}` };
        } catch (err) {
            console.warn(`[ApiBridge Error] Connection to ESP32 failed at ${url}:`, err);
            return { success: false, mode: 'error', compartment: compartmentNum, error: 'ไม่สามารถเชื่อมต่อกับตู้ยาได้ กรุณาตรวจสอบสายสัญญาณหรือ WiFi' };
        }
    },

    // Trigger Buzzer Siren for SOS emergencies
    async triggerBuzzer(state) {
        const settings = this.getSettings();
        const stateParam = state === 'on' ? '1' : '0';

        if (this.isMqttConfigured()) {
            const result = await this.sendMqttCommand({ action: 'buzzer', state: state === 'on' ? 'on' : 'off' });
            if (result.success) {
                return { success: true, mode: 'mqtt' };
            }
            console.warn('[ApiBridge] MQTT ไม่สำเร็จ ลองสั่งผ่าน LAN ต่อ:', result.error);
        }

        if (!this.isHardwareConfigured(settings)) {
            console.log(`[ApiBridge Simulation] ESP32 Buzzer Siren turned: ${state.toUpperCase()}`);
            return { success: true, mode: 'simulation' };
        }

        const url = settings.esp32Url.trim();

        try {
            const controller = new AbortController();
            const id = setTimeout(() => controller.abort(), 2000);

            const response = await fetch(`${url}/buzzer?state=${stateParam}`, {
                method: 'GET',
                signal: controller.signal
            });
            clearTimeout(id);

            if (response.ok) {
                return { success: true, mode: 'production' };
            }
            return { success: false, mode: 'production', error: `สวิตช์สัญญาณตอบกลับสถานะรหัส: ${response.status}` };
        } catch (err) {
            console.warn(`[ApiBridge Error] ESP32 Buzzer link failed at ${url}:`, err);
            return { success: false, mode: 'error', error: 'ไม่สามารถส่งสัญญาณไซเรนไปยังอุปกรณ์ได้' };
        }
    }
};

window.ApiBridge = ApiBridge;
