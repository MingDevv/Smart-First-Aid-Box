// JS/API-BRIDGE.JS
const ApiBridge = {
    // Check if the hardware (ESP32 controller connected to micro:bit) is online
    async getHardwareStatus() {
        let settings = { esp32Url: '' };
        if (window.StorageService) {
            settings = window.StorageService.getSettings();
        }

        const url = settings.esp32Url || settings.esp8266Url || '';

        if (!url || url.includes('192.168.1.100')) {
            // Default or empty URL, treat as simulation
            return { connected: false, mode: 'simulation' };
        }

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
            return { connected: false, mode: 'simulation' };
        } catch (e) {
            console.log('[ApiBridge] Cannot connect to ESP32 controller, falling back to simulation.');
            return { connected: false, mode: 'simulation' };
        }
    },

    // Trigger physical box compartment opening (Compartment 1: Cut/Abrasion, Compartment 2: Insect Bite)
    async openCompartment(woundId) {
        let settings = { esp32Url: '' };
        if (window.StorageService) {
            settings = window.StorageService.getSettings();
        }

        const url = settings.esp32Url || settings.esp8266Url || '';

        // Mapping woundId to ESP32 / micro:bit compartment numbers (1 or 2)
        const woundCompartmentMap = {
            "cut_abrasion": 1,
            "abrasion": 1,
            "cut": 1,
            "insect": 2
        };

        const compartmentNum = woundCompartmentMap[woundId] || 1;

        if (!url || url.includes('192.168.1.100')) {
            console.log(`[ApiBridge Simulation] Opening Compartment #${compartmentNum} for Wound: ${woundId}`);
            await new Promise(resolve => setTimeout(resolve, 800));
            return { success: true, mode: 'simulation', compartment: compartmentNum };
        }

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
            throw new Error('Response not OK');
        } catch (err) {
            console.warn(`[ApiBridge] ESP32 link failed. Simulating opening drawer #${compartmentNum}`);
            return { success: true, mode: 'simulation', compartment: compartmentNum };
        }
    },

    // Trigger Buzzer Siren for SOS emergencies
    async triggerBuzzer(state) {
        let settings = { esp32Url: '' };
        if (window.StorageService) {
            settings = window.StorageService.getSettings();
        }

        const url = settings.esp32Url || settings.esp8266Url || '';
        const stateParam = state === 'on' ? '1' : '0';

        if (!url || url.includes('192.168.1.100')) {
            console.log(`[ApiBridge Simulation] ESP32 Buzzer Siren turned: ${state.toUpperCase()}`);
            return { success: true, mode: 'simulation' };
        }

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
            throw new Error('Response not OK');
        } catch (err) {
            console.warn(`[ApiBridge] ESP32 link failed. Simulating buzzer: ${state.toUpperCase()}`);
            return { success: true, mode: 'simulation' };
        }
    }
};

window.ApiBridge = ApiBridge;
