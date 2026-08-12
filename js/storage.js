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
    // Student Methods (On-demand private lookup - SEC Privacy Fix)
    getStudents() {
        const data = localStorage.getItem(STORAGE_KEYS.STUDENTS);
        if (data) {
            return JSON.parse(data);
        }
        return []; // Do not leak default student database into unauthenticated localStorage
    },

    getCurrentStudent() {
        const data = sessionStorage.getItem(STORAGE_KEYS.CURRENT_STUDENT);
        return data ? JSON.parse(data) : null;
    },

    loginStudent(studentId) {
        const cleanId = String(studentId).trim();
        
        // Check dynamically stored students or default list on-demand
        const customStudents = this.getStudents();
        let student = customStudents.find(s => s.studentId === cleanId);
        
        if (!student) {
            student = DEFAULT_STUDENTS.find(s => s.studentId === cleanId);
        }

        if (student) {
            sessionStorage.setItem(STORAGE_KEYS.CURRENT_STUDENT, JSON.stringify(student));
            return { success: true, student };
        }
        
        // Allow guest login explicitly for ID 99999
        if (cleanId === "99999") {
            const guestStudent = {
                studentId: "99999",
                name: "นักเรียนทั่วไป (ไม่ระบุตัวตน)",
                class: "ทั่วไป",
                allergies: []
            };
            sessionStorage.setItem(STORAGE_KEYS.CURRENT_STUDENT, JSON.stringify(guestStudent));
            return { success: true, student: guestStudent };
        }

        // Reject invalid student ID
        return { 
            success: false, 
            error: "ไม่พบรหัสนักเรียนในระบบ กรุณาตรวจสอบรหัส หรือกด 'ทั่วไป' เพื่อใช้บริการ" 
        };
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

        // Deduct quantities in inventory using smart item mapping
        if (entry.itemsUsed && Array.isArray(entry.itemsUsed)) {
            entry.itemsUsed.forEach(itemName => {
                this.deductMedicineStock(itemName, 1);
            });
        }

        // Sync to Supabase
        this.syncToSupabase(newEntry);

        return newEntry;
    },

    async syncToSupabase(entry) {
        const settings = this.getSettings();
        let baseUrl = (settings.supabaseUrl || '').trim();
        let anonKey = (settings.supabaseAnonKey || '').trim();

        if (!baseUrl || !anonKey) {
            console.log('[Supabase] URL or Anon Key not configured in settings. Local fallback active.');
            if (window.NotificationService) {
                window.NotificationService.showToast('💡 คุณสามารถตั้งค่า Supabase URL & Key ในตั้งค่าเพื่อบันทึกลง Database ออนไลน์ได้', 'info');
            }
            return;
        }

        // Clean trailing slashes from URL
        baseUrl = baseUrl.replace(/\/+$/, '');
        const endpoint = `${baseUrl}/rest/v1/treatment_history`;

        // Clean payload matching production Supabase schema (student_id, student_name, student_class, wound_name, method, items_used, created_at)
        const payload = {
            student_id: entry.studentId || '12345',
            student_name: entry.studentName || 'นักเรียนทั่วไป',
            student_class: entry.studentClass || '-',
            wound_name: entry.woundNameTh || 'มีดบาด / แผลถลอก',
            method: entry.method || 'เลือกประเภทแผลเอง',
            items_used: Array.isArray(entry.itemsUsed) ? entry.itemsUsed.join(', ') : (entry.itemsUsed || ''),
            created_at: entry.timestamp || new Date().toISOString()
        };

        try {
            const response = await fetch(endpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'apikey': anonKey,
                    'Authorization': `Bearer ${anonKey}`,
                    'Prefer': 'return=minimal'
                },
                body: JSON.stringify(payload)
            });

            if (response.ok || response.status === 201 || response.status === 200) {
                console.log('[Supabase] ✅ Successfully inserted record into Supabase!');
                if (window.NotificationService) {
                    window.NotificationService.showToast('☁️ บันทึกลง Supabase สำเร็จเรียบร้อย!', 'success');
                }
            } else {
                const errText = await response.text();
                console.error('[Supabase Error]', response.status, errText);
                if (window.NotificationService) {
                    window.NotificationService.showToast(`Supabase Sync Warning: ${errText.substring(0, 60)}`, 'warning');
                }
            }
        } catch (err) {
            console.error('[Supabase Fetch Exception]', err);
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

        // Alias dictionary mapping wound item text to stock medicine names
        const itemAliasMap = {
            "สำลี/ผ้าก๊อซสะอาด": ["สำลีสะอาด", "ผ้าก๊อซปราศจากเชื้อ"],
            "ยาคารามายด์ หรือ ยาหม่อง": ["ยาคารามายด์ (Calamine Lotion)"],
            "ถุงน้ำแข็งประคบ": ["เจลเย็น / Cold Pack"],
            "ยาเบตาดีน (Antiseptic)": ["ยาเบตาดีน (Antiseptic)"],
            "พลาสเตอร์ยา": ["พลาสเตอร์ยา"],
            "น้ำเกลือล้างแผล (Normal Saline)": ["น้ำเกลือล้างแผล (Normal Saline)"]
        };

        const targets = itemAliasMap[name] || [name];

        const updated = medicines.map(med => {
            const isMatch = targets.some(target => 
                med.name === target || 
                med.name.toLowerCase().includes(target.toLowerCase()) || 
                target.toLowerCase().includes(med.name.toLowerCase())
            );
            if (isMatch) {
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
