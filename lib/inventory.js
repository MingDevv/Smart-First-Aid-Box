// LIB/INVENTORY.JS — คลังเวชภัณฑ์ของตู้ นับเป็น "ชุด" ไม่ใช่ชิ้น
//
// Bank 2026-09-14: "คลังยาให้เลือกเป็นช่อง จำนวน และยาที่ว่านี่จะจัดเป็นชุดครับ
// ใน 1 ชุดประกอบไปด้วย น้ำเกลือ พลาสเตอร์ อะไรแบบนี้"
//
// ทำไมนับเป็นชุด: ตู้จ่ายทีละชุด ไม่ได้จ่ายทีละชิ้น ⇒ หน่วยที่ครูนับจริงหน้าตู้คือจำนวนชุด
// ในช่อง การให้ครูนับพลาสเตอร์ทีละแผ่นจะไม่ตรงกับสิ่งที่ตู้ทำ และจะไม่มีวันตรงกัน
//
// **ตัวเลขนี้มาจากการนับของคนเท่านั้น** — ACK ของตู้ไม่เคยลดจำนวนในนี้ ซึ่งเป็นกติกาเดิม
// ตั้งแต่ WP2 (`docs/cabinet-sync.md`) เหตุผลคือ ACK พิสูจน์แค่ว่ามอเตอร์ทำงาน ไม่ได้พิสูจน์
// ว่าของออกจากช่องไปจริง ถ้าเอามาลดสต็อกอัตโนมัติ ตัวเลขจะเพี้ยนสะสมโดยไม่มีใครรู้
import { AccessError } from './auth.js';

export const DRAWERS = Object.freeze(['drawer1', 'drawer2']);
export const DRAWER_TH = Object.freeze({ drawer1: 'ช่อง 1', drawer2: 'ช่อง 2' });
export const MAX_KIT_ITEMS = 12;
export const MAX_COUNT = 999;

const cleanText = (value, limit) => {
    if (typeof value !== 'string') throw new AccessError(400, 'invalid_text');
    const text = value.trim().replace(/\s+/g, ' ');
    // อักขระควบคุมถูกตัดทิ้ง ไม่ใช่แค่ตัดความยาว — ค่าพวกนี้ไปโผล่ในหน้าเว็บและใน CSV ที่ครูเปิด
    if (!text || text.length > limit || /[\u0000-\u001f\u007f]/.test(text)) throw new AccessError(400, 'invalid_text');
    return text;
};

const wholeNumber = (value, max) => {
    if (value === null || value === undefined || value === '') return null;
    const number = typeof value === 'number' ? value : Number(String(value).trim());
    if (!Number.isInteger(number) || number < 0 || number > max) throw new AccessError(400, 'invalid_number');
    return number;
};

/** ของหนึ่งอย่างในชุด เช่น น้ำเกลือ 1 ขวด */
export function validateItem(raw) {
    return { name: cleanText(raw?.name, 60), qty: wholeNumber(raw?.qty, 99) ?? 1,
        unit: raw?.unit === undefined || raw?.unit === '' ? 'ชิ้น' : cleanText(raw.unit, 20) };
}

/** สิ่งที่ครูกรอกได้สำหรับหนึ่งช่อง: ชื่อชุด ของในชุด จำนวนที่นับได้ และเกณฑ์ขั้นต่ำ
 *
 * `count` กับ `target` เป็น null ได้ และ null แปลว่า "ยังไม่ได้นับ" ไม่ใช่ศูนย์
 * แยกให้ขาด เพราะศูนย์แปลว่าของหมด ซึ่งเป็นคนละเรื่องกับยังไม่มีใครไปนับ
 */
export function validateDrawer(raw) {
    if (!raw || typeof raw !== 'object') throw new AccessError(400, 'invalid_drawer');
    const items = Array.isArray(raw.items) ? raw.items : [];
    if (items.length > MAX_KIT_ITEMS) throw new AccessError(400, 'too_many_items');
    const kit = items.map(validateItem);
    const names = new Set(kit.map(item => item.name));
    if (names.size !== kit.length) throw new AccessError(400, 'duplicate_item');
    return { kitName: cleanText(raw.kitName, 60), items: kit,
        count: wholeNumber(raw.count, MAX_COUNT), target: wholeNumber(raw.target, MAX_COUNT) };
}

export function validateInventory(raw) {
    if (!raw || typeof raw !== 'object') throw new AccessError(400, 'invalid_inventory');
    const drawers = {};
    for (const drawer of DRAWERS) {
        if (raw[drawer] === undefined) continue;
        drawers[drawer] = validateDrawer(raw[drawer]);
    }
    if (!Object.keys(drawers).length) throw new AccessError(400, 'nothing_to_save');
    return drawers;
}

/** รูปที่ส่งให้เบราว์เซอร์ — หยิบทีละฟิลด์ ไม่ใช่ยกเอกสารทั้งใบ
 *
 * เอกสารนี้ยังเก็บว่าใครนับและนับเมื่อไหร่ ซึ่งครูควรเห็น แต่ถ้า spread ทั้งใบ
 * ฟิลด์ที่ใครเพิ่มทีหลังจะหลุดออกไปเองโดยไม่มีใครตั้งใจ
 */
export function inventoryView(doc) {
    const drawers = {};
    for (const drawer of DRAWERS) {
        const value = doc?.[drawer] || {};
        const items = Array.isArray(value.items) ? value.items : [];
        drawers[drawer] = {
            kitName: typeof value.kitName === 'string' ? value.kitName : '',
            items: items.slice(0, MAX_KIT_ITEMS).map(item => ({
                name: typeof item?.name === 'string' ? item.name : '',
                qty: Number.isInteger(item?.qty) ? item.qty : 1,
                unit: typeof item?.unit === 'string' ? item.unit : 'ชิ้น'
            })),
            count: Number.isInteger(value.count) ? value.count : null,
            target: Number.isInteger(value.target) ? value.target : null
        };
    }
    return { drawers, countedAt: typeof doc?.countedAt === 'string' ? doc.countedAt : null,
        countedBy: typeof doc?.countedBy === 'string' ? doc.countedBy : '' };
}

/** ช่องไหนต่ำกว่าเกณฑ์ — ตอบ null เมื่อยังไม่มีข้อมูลพอจะตอบ
 *
 * "0 ช่องต่ำกว่าเกณฑ์" ตอนที่ยังไม่มีใครนับเลย อ่านว่า "ของครบ" ทั้งที่แปลว่า "ไม่รู้"
 */
export function lowDrawers(view) {
    const known = DRAWERS.filter(drawer => {
        const value = view.drawers[drawer];
        return Number.isInteger(value.count) && Number.isInteger(value.target);
    });
    if (!known.length) return null;
    return known.filter(drawer => view.drawers[drawer].count < view.drawers[drawer].target);
}
