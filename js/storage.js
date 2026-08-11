// JS/STORAGE.JS
const STORAGE_KEYS = {
    HISTORY: 'smart_first_aid_history',
    MEDICINE: 'smart_first_aid_medicine',
    SETTINGS: 'smart_first_aid_settings',
    STUDENTS: 'smart_first_aid_students',
    CURRENT_STUDENT: 'smart_first_aid_current_student'
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

const DEFAULT_STUDENTS = [
    { studentId: "12345", name: "นายหมิง พัฒนาการ", class: "ม.4/1", allergies: ["ยาเบตาดีน"] },
    { studentId: "12346", name: "นางสาวเปตอง ปฐมพยาบาล", class: "ม.5/2", allergies: [] },
    { studentId: "12347", name: "นายเมย์ ออกแบบระบบ", class: "ม.6/1", allergies: ["แอลกอฮอล์"] },
    { studentId: "11111", name: "นายสมชาย ใจดี", class: "ม.4/2", allergies: [] },
    { studentId: "99999", name: "นักเรียนทั่วไป (ไม่ระบุตัวตน)", class: "ทั่วไป", allergies: [] }
];

const DEFAULT_SETTINGS = {
    lineToken: '',
    dashboardPin: '1234',
    esp32Url: 'http://192.168.1.100',
    supabaseUrl: '',
    supabaseAnonKey: ''
};

const StorageService = {
    // Student Methods
    getStudents() {
        const data = localStorage.getItem(STORAGE_KEYS.STUDENTS);
        if (!data) {
            localStorage.setItem(STORAGE_KEYS.STUDENTS, JSON.stringify(DEFAULT_STUDENTS));
            return DEFAULT_STUDENTS;
        }
        return JSON.parse(data);
    },

    getCurrentStudent() {
        const data = sessionStorage.getItem(STORAGE_KEYS.CURRENT_STUDENT);
        return data ? JSON.parse(data) : null;
    },

    loginStudent(studentId) {
        const students = this.getStudents();
        const student = students.find(s => s.studentId === String(studentId).trim());
        if (student) {
            sessionStorage.setItem(STORAGE_KEYS.CURRENT_STUDENT, JSON.stringify(student));
            return { success: true, student };
        }
        // If not found, create a generic entry for this ID
        const genericStudent = {
            studentId: String(studentId),
            name: `นักเรียน รหัส ${studentId}`,
            class: "ทั่วไป",
            allergies: []
        };
        sessionStorage.setItem(STORAGE_KEYS.CURRENT_STUDENT, JSON.stringify(genericStudent));
        return { success: true, student: genericStudent };
    },

    logoutStudent() {
        sessionStorage.removeItem(STORAGE_KEYS.CURRENT_STUDENT);
    },

    // History Methods
    getHistory() {
        const data = localStorage.getItem(STORAGE_KEYS.HISTORY);
        return data ? JSON.parse(data) : [];
    },

    addHistoryEntry(entry) {
        const history = this.getHistory();
        const currentStudent = this.getCurrentStudent();

        const newEntry = {
            id: 'H-' + Date.now(),
            timestamp: new Date().toISOString(),
            studentId: currentStudent ? currentStudent.studentId : '12345',
            studentName: currentStudent ? currentStudent.name : 'นักเรียนทั่วไป',
            studentClass: currentStudent ? currentStudent.class : '-',
            allergies: currentStudent ? currentStudent.allergies : [],
            ...entry
        };
        history.unshift(newEntry);
        localStorage.setItem(STORAGE_KEYS.HISTORY, JSON.stringify(history));

        // Deduct quantities in inventory
        if (entry.itemsUsed && Array.isArray(entry.itemsUsed)) {
            entry.itemsUsed.forEach(itemName => {
                this.deductMedicineStock(itemName, 1);
            });
        }

        // Try syncing to Supabase if configured
        this.syncToSupabase(newEntry);

        return newEntry;
    },

    async syncToSupabase(entry) {
        const settings = this.getSettings();
        if (!settings.supabaseUrl || !settings.supabaseAnonKey) {
            return;
        }

        try {
            const endpoint = `${settings.supabaseUrl}/rest/v1/treatment_history`;
            await fetch(endpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'apikey': settings.supabaseAnonKey,
                    'Authorization': `Bearer ${settings.supabaseAnonKey}`,
                    'Prefer': 'return=minimal'
                },
                body: JSON.stringify({
                    student_id: entry.studentId,
                    student_name: entry.studentName,
                    student_class: entry.studentClass,
                    wound_name: entry.woundNameTh,
                    method: entry.method,
                    items_used: Array.isArray(entry.itemsUsed) ? entry.itemsUsed.join(', ') : entry.itemsUsed,
                    created_at: entry.timestamp
                })
            });
            console.log('[Supabase] Successfully synced history entry!');
        } catch (err) {
            console.warn('[Supabase] Sync skipped or failed:', err);
        }
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
StorageService.getStudents();
