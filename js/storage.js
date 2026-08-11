// JS/STORAGE.JS
const STORAGE_KEYS = {
    HISTORY: 'smart_first_aid_history',
    MEDICINE: 'smart_first_aid_medicine',
    SETTINGS: 'smart_first_aid_settings'
};

const DEFAULT_MEDICINES = [
    { id: 1, name: "น้ำเกลือล้างแผล (Normal Saline)", qty: 5, unit: "ขวด", exp: "2027-12-01", minQty: 2 },
    { id: 2, name: "ยาเบตาดีน (Antiseptic)", qty: 4, unit: "ขวด", exp: "2027-08-15", minQty: 1 },
    { id: 3, name: "สำลีสะอาด", qty: 10, unit: "ซอง", exp: "2028-01-10", minQty: 3 },
    { id: 4, name: "ผ้าก๊อซปราศจากเชื้อ", qty: 15, unit: "ซอง", exp: "2028-03-20", minQty: 5 },
    { id: 5, name: "พลาสเตอร์ยา", qty: 45, unit: "ชิ้น", exp: "2027-10-30", minQty: 10 },
    { id: 6, name: "เจลเย็น / Cold Pack", qty: 3, unit: "ชิ้น", exp: "2029-01-01", minQty: 1 },
    { id: 7, name: "ผ้าพันเคล็ด (Elastic Bandage)", qty: 6, unit: "ม้วน", exp: "2029-05-12", minQty: 2 },
    { id: 8, name: "ยาคารามายด์ (Calamine Lotion)", qty: 3, unit: "ขวด", exp: "2027-04-18", minQty: 1 }
];

const DEFAULT_SETTINGS = {
    lineToken: '',
    dashboardPin: '1234',
    esp8266Url: 'http://192.168.1.100' // Mock/Default URL for micro:bit controller ESP8266
};

const StorageService = {
    // History Methods
    getHistory() {
        const data = localStorage.getItem(STORAGE_KEYS.HISTORY);
        return data ? JSON.parse(data) : [];
    },

    addHistoryEntry(entry) {
        const history = this.getHistory();
        const newEntry = {
            id: 'H-' + Date.now(),
            timestamp: new Date().toISOString(),
            ...entry
        };
        history.unshift(newEntry); // Newest first
        localStorage.setItem(STORAGE_KEYS.HISTORY, JSON.stringify(history));

        // Deduct quantities in inventory if items were used
        if (entry.itemsUsed && Array.isArray(entry.itemsUsed)) {
            entry.itemsUsed.forEach(itemName => {
                this.deductMedicineStock(itemName, 1);
            });
        }

        return newEntry;
    },

    clearHistory() {
        localStorage.setItem(STORAGE_KEYS.HISTORY, JSON.stringify([]));
    },

    // Medicine Methods
    getMedicines() {
        const data = localStorage.getItem(STORAGE_KEYS.MEDICINE);
        if (!data) {
            localStorage.setItem(STORAGE_KEYS.MEDICINE, JSON.stringify(DEFAULT_MEDICINES));
            return DEFAULT_MEDICINES;
        }
        return JSON.parse(data);
    },

    saveMedicines(medicines) {
        localStorage.setItem(STORAGE_KEYS.MEDICINE, JSON.stringify(medicines));
    },

    deductMedicineStock(name, amount = 1) {
        const medicines = this.getMedicines();
        const updated = medicines.map(med => {
            if (med.name === name) {
                return { ...med, qty: Math.max(0, med.qty - amount) };
            }
            return med;
        });
        this.saveMedicines(updated);
    },

    addMedicine(med) {
        const medicines = this.getMedicines();
        const newMed = {
            id: Date.now(),
            ...med
        };
        medicines.push(newMed);
        this.saveMedicines(medicines);
        return newMed;
    },

    updateMedicine(id, updatedData) {
        const medicines = this.getMedicines();
        const index = medicines.findIndex(m => m.id === Number(id) || m.id === id);
        if (index !== -1) {
            medicines[index] = { ...medicines[index], ...updatedData };
            this.saveMedicines(medicines);
            return true;
        }
        return false;
    },

    deleteMedicine(id) {
        const medicines = this.getMedicines();
        const filtered = medicines.filter(m => m.id !== Number(id) && m.id !== id);
        this.saveMedicines(filtered);
    },

    // Settings Methods
    getSettings() {
        const data = localStorage.getItem(STORAGE_KEYS.SETTINGS);
        if (!data) {
            localStorage.setItem(STORAGE_KEYS.SETTINGS, JSON.stringify(DEFAULT_SETTINGS));
            return DEFAULT_SETTINGS;
        }
        // Merge in case defaults got new properties
        return { ...DEFAULT_SETTINGS, ...JSON.parse(data) };
    },

    saveSettings(settings) {
        const current = this.getSettings();
        localStorage.setItem(STORAGE_KEYS.SETTINGS, JSON.stringify({ ...current, ...settings }));
    }
};

// Initialize if empty
StorageService.getMedicines();
StorageService.getSettings();
