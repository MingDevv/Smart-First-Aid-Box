// JS/API-BRIDGE.JS
const ApiBridge = {
    // Check if hardware URL is configured and valid
    isHardwareConfigured(settings) {
        if (!settings || !settings.esp32Url) return false;
        const url = settings.esp32Url.trim();
        // If explicitly set to empty or default unconfigured placeholder, mark as not configured
        if (!url || settings.isConfigured === false) return false;
        return true;
    },

    // Check if the hardware (ESP32 controller connected to micro:bit) is online
    async getHardwareStatus() {
        let settings = { esp32Url: '' };
        if (window.StorageService) {
            settings = window.StorageService.getSettings();
        }

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
        let settings = { esp32Url: '' };
        if (window.StorageService) {
            settings = window.StorageService.getSettings();
        }

        // Mapping woundId to ESP32 / micro:bit compartment numbers (1 or 2)
        const woundCompartmentMap = {
            "cut_abrasion": 1,
            "abrasion": 1,
            "cut": 1,
            "insect": 2
        };

        const compartmentNum = woundCompartmentMap[woundId] || 1;

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
        let settings = { esp32Url: '' };
        if (window.StorageService) {
            settings = window.StorageService.getSettings();
        }

        const stateParam = state === 'on' ? '1' : '0';

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

