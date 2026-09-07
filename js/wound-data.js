// JS/WOUND-DATA.JS
const WOUND_DATA = {
    "cut_abrasion": {
        "id": "cut_abrasion",
        "name_th": "มีดบาด / แผลถลอก",
        "name_en": "Cut & Abrasion",
        "severity": "ทั่วไป (Minor)",
        "icon": "🩹",
        "image": "../images/wound_cut_abrasion.webp",
        "drawer": 1,
        "description": "เกิดจากของมีคมบาด หรือผิวหนังถลอกจากการล้มเสียดสีกับพื้น มีเลือดซึมหรือไหลเล็กน้อย",
        "items": ["น้ำเกลือล้างแผล (Normal Saline)", "ยาเบตาดีน (Antiseptic)", "พลาสเตอร์ยา & ผ้าก๊อซ"],
        "itemDetails": [
            { "name": "น้ำเกลือล้างแผล (Normal Saline)", "image": "../images/med_saline.webp", "drawer": 1, "desc": "สำหรับล้างสิ่งสกปรกและฆ่าเชื้อเบื้องต้น" },
            { "name": "ยาเบตาดีน (Antiseptic)", "image": "../images/med_betadine.webp", "drawer": 1, "desc": "ยาทาแผลสด ป้องกันแผลติดเชื้อ" },
            { "name": "พลาสเตอร์ยา & ผ้าก๊อซ", "image": "../images/med_bandage.webp", "drawer": 1, "desc": "ปิดปกป้องบาดแผลจากสิ่งสกปรก" }
        ],
        "steps": [
            "ล้างมือผู้ปฐมพยาบาลให้สะอาดด้วยสบู่และน้ำสะอาด",
            "ล้างทำความสะอาดแผลด้วยน้ำเกลือล้างแผล (NSS) ให้สะอาด",
            "ทายาเบตาดีน บริเวณรอบๆ และบนบาดแผล",
            "ปิดแผลด้วยพลาสเตอร์ยาเพื่อป้องกันฝุ่นและเชื้อโรค"
        ],
        "stepDetails": [
            { "step": 1, "title": "ล้างมือให้สะอาด", "desc": "ล้างมือผู้ปฐมพยาบาลด้วยสบู่และน้ำสะอาดอย่างน้อย 20 วินาทีเพื่อป้องกันเชื้อโรค", "image": "../images/step_wash_hands.webp" },
            { "step": 2, "title": "ล้างทำความสะอาดแผล", "desc": "ใช้น้ำเกลือล้างแผล (Normal Saline) ราดล้างสิ่งสกปรกและฝุ่นออกจากแผลให้สะอาด (ไม่ต้องซับแผลเพื่อลดอาการปวด)", "image": "../images/step_clean_wound.webp" },
            { "step": 3, "title": "ใส่ยารักษาแผล", "desc": "ทาโพวิโดน-ไอโอดีน (เบตาดีน) บางๆ บนแผลและผิวหนังรอบๆ", "image": "../images/step_apply_medicine.webp" },
            { "step": 4, "title": "ปิดปกป้องบาดแผล", "desc": "ติดพลาสเตอร์ยาหรือผ้าก๊อซปิดแผลเพื่อป้องกันการติดเชื้อและความอับชื้น", "image": "../images/step_cover_wound.webp" }
        ],
        "warnings": "หลีกเลี่ยงการใช้แอลกอฮอล์ราดลงบนแผลโดยตรง ให้เช็ดเฉพาะรอบๆ แผลเท่านั้น หากเลือดไหลไม่หยุดให้กดแผลไว้และแจ้งครูพยาบาล"
    },
    "insect": {
        "id": "insect",
        "name_th": "แมลงสัตว์กัดต่อย",
        "name_en": "Insect Bite",
        "severity": "ทั่วไป (Minor)",
        "icon": "🐝",
        "image": "../images/wound_insect_bite.webp",
        "drawer": 2,
        "description": "เกิดจากมด ผึ้ง ต่อ แตน หรือแมลงอื่นๆ กัดต่อย ทำให้ผิวหนังบวม แดง คัน หรือแสบร้อน",
        "items": ["สบู่และน้ำสะอาด", "ถุงน้ำแข็งประคบ", "ยาคาลาไมน์ / ยาหม่อง"],
        "itemDetails": [
            { "name": "สบู่ล้างทำความสะอาด", "image": "../images/step_wash_hands.webp", "drawer": 2, "desc": "ชำระล้างคราบพิษและสบู่เบื้องต้น" },
            { "name": "ถุงน้ำแข็งประคบเย็น", "image": "../images/med_icepack.webp", "drawer": 2, "desc": "ลดอาการปวด บวม แสบร้อน" },
            { "name": "ยาคาลาไมน์ / ยาหม่อง", "image": "../images/med_calamine.webp", "drawer": 2, "desc": "ทาบรรเทาอาการคันและลดอักเสบ" }
        ],
        "steps": [
            "ล้างมือผู้ปฐมพยาบาลให้สะอาดก่อนเริ่มปฐมพยาบาล",
            "ประเมินและสังเกตอาการแพ้รุนแรง",
            "ล้างทำความสะอาดบริเวณที่ถูกกัดด้วยน้ำและสบู่เบาๆ",
            "ประคบเย็นด้วยถุงน้ำแข็งห่อผ้า 10-15 นาที เพื่อลดอาการปวดบวม",
            "ทายาคาลาไมน์เพื่อลดอาการคัน หรือทายาหม่องบรรเทาอาการปวด",
            "หลีกเลี่ยงการเกาบริเวณแผลเพื่อป้องกันการติดเชื้อซ้ำซ้อน"
        ],
        "stepDetails": [
            { "step": 1, "title": "ล้างมือผู้ทำแผล", "desc": "ล้างมือให้สะอาดด้วยสบู่และน้ำสะอาดก่อนสัมผัสบริเวณที่แมลงกัดต่อย", "image": "../images/step_wash_hands.webp" },
            { "step": 2, "title": "ประเมินสังเกตอาการแพ้", "desc": "สังเกตว่ามีอาการแพ้รุนแรงหรือไม่ เช่น หายใจติดขัด แน่นหน้าอก ปากบวม หน้าบวม หากพบอาการให้รีบแจ้งครูพยาบาลหรือ 1669 ทันที", "image": "../images/wound_insect_bite.webp" },
            { "step": 3, "title": "ล้างบริเวณที่ถูกกัด", "desc": "ล้างบริเวณแผลด้วยสบู่อ่อนๆ และน้ำสะอาดเพื่อนำสิ่งสกปรกและคราบพิษออก", "image": "../images/step_clean_wound.webp" },
            { "step": 4, "title": "ประคบเย็นลดปวดบวม", "desc": "ใช้ถุงน้ำแข็งห่อผ้าสะอาดประคบตรงบริเวณที่บวมนาน 5-10 นาที", "image": "../images/med_icepack.webp" },
            { "step": 5, "title": "ทายาบรรเทาอาการ", "desc": "ทายาคาลาไมน์โลชั่น หรือแซมบัค/ยาหม่องบางๆ ตรงจุดคัน", "image": "../images/med_calamine.webp" },
            { "step": 6, "title": "คำแนะนำห้ามเกา", "desc": "หลีกเลี่ยงการเกาเพื่อป้องกันผิวหนังถลอกและเสี่ยงต่อแบคทีเรียแทรกซ้อน", "image": "../images/step_cover_wound.webp" }
        ],
        "warnings": "สังเกตอาการแพ้รุนแรง: หากมีอาการหายใจติดขัด แน่นหน้าอก ปากบวม หน้าบวม คันทั่วตัว ให้รีบแจ้งครูพยาบาลหรือติดต่อสายด่วน 1669 ทันที"
    },
    "burn": {
        "id": "burn",
        "name_th": "แผลไฟไหม้ / น้ำร้อนลวก",
        "name_en": "Burn & Scald",
        "severity": "ปานกลาง (Moderate)",
        "icon": "🔥",
        "image": "../images/wound_burn.webp",
        "drawer": 3,
        "comingSoon": true,
        "locked": true,
        "description": "ผิวหนังแสบร้อน แดง หรือมีตุ่มพองจากการสัมผัสความร้อน เปลวไฟ หรือของเหลวร้อน (อยู่ในระหว่างพัฒนาระบบ)",
        "items": [],
        "itemDetails": [],
        "steps": [],
        "stepDetails": [],
        "warnings": "อยู่ในระหว่างพัฒนาระบบจ่ายยาและเวชภัณฑ์ (Coming Soon)"
    },
    "bruise": {
        "id": "bruise",
        "name_th": "แผลฟกช้ำ / ห้อเลือด",
        "name_en": "Bruise & Contusion",
        "severity": "ทั่วไป (Minor)",
        "icon": "🟣",
        "image": "../images/wound_bruise.webp",
        "drawer": 4,
        "comingSoon": true,
        "locked": true,
        "description": "เส้นเลือดฝอยใต้ผิวหนังแตกจากการกระแทก ผิวหนังบวมแดงหรือเขียวคล้ำ (อยู่ในระหว่างพัฒนาระบบ)",
        "items": [],
        "itemDetails": [],
        "steps": [],
        "stepDetails": [],
        "warnings": "อยู่ในระหว่างพัฒนาระบบจ่ายยาและเวชภัณฑ์ (Coming Soon)"
    },
    "sprain": {
        "id": "sprain",
        "name_th": "ข้อเท้าแพลง / เคล็ดขัดยอก",
        "name_en": "Sprain & Strain",
        "severity": "ปานกลาง (Moderate)",
        "icon": "🦶",
        "image": "../images/wound_sprain.webp",
        "drawer": 5,
        "comingSoon": true,
        "locked": true,
        "description": "เส้นเอ็นหรือกล้ามเนื้อฉีกขาดจากการบิดตัวกะทันหัน มักพบบริเวณข้อเท้า ข้อมือ (อยู่ในระหว่างพัฒนาระบบ)",
        "items": [],
        "itemDetails": [],
        "steps": [],
        "stepDetails": [],
        "warnings": "อยู่ในระหว่างพัฒนาระบบจ่ายยาและเวชภัณฑ์ (Coming Soon)"
    },
    "unknown": {
        "id": "unknown",
        "name_th": "ไม่สามารถระบุได้",
        "name_en": "Unknown",
        "severity": "ไม่ระบุ (Unspecified)",
        "icon": "❓",
        "image": "../images/ai_scanner_hero.webp",
        "drawer": 0,
        "description": "ระบบไม่สามารถแยกแยะประเภทแผลจากภาพถ่ายได้ โปรดเลือกประเภทแผลด้วยตนเอง",
        "items": [],
        "itemDetails": [],
        "steps": [
            "โปรดตรวจสอบว่าภาพถ่ายมีความสว่างเพียงพอ",
            "เลือกประเภทแผลจาก 2 รายการด้านบนด้วยตนเอง",
            "หากอาการรุนแรงให้รีบพบครูพยาบาลทันที"
        ],
        "stepDetails": [],
        "warnings": "การวิเคราะห์เบื้องต้นเป็นเพียงคำแนะนำ ไม่ทดแทนการดูแลจากบุคลากรทางการแพทย์"
    }
};

if (typeof module !== 'undefined' && module.exports) {
    module.exports = WOUND_DATA;
}
