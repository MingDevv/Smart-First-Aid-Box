// JS/API-BRIDGE.JS
const ApiBridge = {
    // Check if the hardware (ESP8266 controller connected to micro:bit) is online
    async getHardwareStatus() {
        let settings = { esp8266Url: '' };
        if (window.StorageService) {
            settings = window.StorageService.getSettings();
        }

        if (!settings.esp8266Url || settings.esp8266Url.includes('192.168.1.100')) {
            // Default or empty URL, treat as simulation
            return { connected: false, mode: 'simulation' };
        }

        try {
            // Test connection using a quick fetch with timeout
            const controller = new AbortController();
            const id = setTimeout(() => controller.abort(), 1500); // 1.5s timeout
            
            const response = await fetch(`${settings.esp8266Url}/status`, { 
                signal: controller.signal 
            });
            clearTimeout(id);

            if (response.ok) {
                return { connected: true, mode: 'production' };
            }
            return { connected: false, mode: 'simulation' };
        } catch (e) {
            console.log('[ApiBridge] Cannot connect to micro:bit controller, falling back to simulation.');
            return { connected: false, mode: 'simulation' };
        }
    },

    // Trigger physical box drawer/compartment opening
    async openCompartment(woundId) {
        let settings = { esp8266Url: '' };
        if (window.StorageService) {
            settings = window.StorageService.getSettings();
        }

        // Mapping woundId to micro:bit compartment numbers (servo motors 1-6)
        const woundCompartmentMap = {
            "abrasion": 1,
            "cut": 2,
            "bruise": 3,
            "burn": 4,
            "sprain": 5,
            "insect": 6
        };

        const compartmentNum = woundCompartmentMap[woundId] || 1;

        if (!settings.esp8266Url || settings.esp8266Url.includes('192.168.1.100')) {
            console.log(`[ApiBridge Simulation] Opening Compartment #${compartmentNum} for Wound: ${woundId}`);
            // Return simulation success after a small delay
            await new Promise(resolve => setTimeout(resolve, 800));
            return { success: true, mode: 'simulation', compartment: compartmentNum };
        }

        try {
            const controller = new AbortController();
            const id = setTimeout(() => controller.abort(), 2000); // 2s timeout
            
            const response = await fetch(`${settings.esp8266Url}/open?drawer=${compartmentNum}`, {
                method: 'GET',
                signal: controller.signal
            });
            clearTimeout(id);

            if (response.ok) {
                return { success: true, mode: 'production', compartment: compartmentNum };
            }
            throw new Error('Response not OK');
        } catch (err) {
            console.warn(`[ApiBridge] Hardware link failed. Simulating opening drawer #${compartmentNum}`);
            return { success: true, mode: 'simulation', compartment: compartmentNum };
        }
    },

    // Trigger Buzzer Siren for SOS emergencies or testing
    async triggerBuzzer(state) {
        let settings = { esp8266Url: '' };
        if (window.StorageService) {
            settings = window.StorageService.getSettings();
        }

        const stateParam = state === 'on' ? '1' : '0';

        if (!settings.esp8266Url || settings.esp8266Url.includes('192.168.1.100')) {
            console.log(`[ApiBridge Simulation] Buzzer Siren turned: ${state.toUpperCase()}`);
            return { success: true, mode: 'simulation' };
        }

        try {
            const controller = new AbortController();
            const id = setTimeout(() => controller.abort(), 2000);
            
            const response = await fetch(`${settings.esp8266Url}/buzzer?state=${stateParam}`, {
                method: 'GET',
                signal: controller.signal
            });
            clearTimeout(id);

            if (response.ok) {
                return { success: true, mode: 'production' };
            }
            throw new Error('Response not OK');
        } catch (err) {
            console.warn(`[ApiBridge] Hardware link failed. Simulating buzzer: ${state.toUpperCase()}`);
            return { success: true, mode: 'simulation' };
        }
    }
};

window.ApiBridge = ApiBridge;
