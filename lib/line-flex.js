// LIB/LINE-FLEX.JS — ข้อความที่ครูได้รับใน LINE
//
// ของเดิมเป็นข้อความอังกฤษบรรทัดเดียวที่เขียนไว้ให้ตัวเองอ่าน ไม่ใช่ให้ครูอ่าน
// ("Cabinet box1 — confirmed / Drawer 1: cut_abrasion") · Bank บอกตรงๆ ว่า "งงๆ อะไรไม่รู้"
// คนที่อ่านข้อความนี้คือครูในกลุ่ม LINE ตอนมีเด็กมาใช้ตู้ ⇒ ต้องอ่านจบในครั้งเดียวบนมือถือ
// และต้องตอบคำถามเดียวที่ครูมีจริงๆ: ใคร ทำอะไร ต้องไปดูไหม
//
// สีมาจากธีม Care Kit ใน css/global.css ซึ่งเขียนเป็น oklch — LINE รับแต่ hex
// จึงแปลงไว้ตรงนี้ครั้งเดียว (แปลงด้วยสูตร OKLab→sRGB ตรวจกับ oklch(1 0 0)=#FFFFFF แล้ว)
// **แก้สีในธีมเมื่อไหร่ ต้องมาแก้ตรงนี้ด้วย** — เทสเฝ้าว่าค่าพวกนี้ยังตรงกับ global.css
//
// ห้ามใส่ emoji (กฎถาวรทุกโปรเจ็คของ Bank) — ใช้สีและน้ำหนักตัวอักษรสื่อความหมายแทน
// และสีไม่เคยสื่อความหมายลำพัง ทุกสถานะมีคำกำกับเสมอ

export const THEME = Object.freeze({
    primary: '#007475',
    primaryDark: '#006364',
    primaryLight: '#CDF2E0',
    danger: '#D7352D',
    dangerLight: '#FFE4DD',
    success: '#269E5F',
    textMain: '#172A2D',
    textMuted: '#53676B',
    surface: '#FFFFFF',
    canvas: '#EBF2F0',
    border: '#CBDCDA'
});

const WOUND_TH = Object.freeze({ cut_abrasion: 'แผลมีดบาด หรือแผลถลอก', insect: 'แมลงกัดต่อย' });

// `box1` เป็นชื่อที่เครื่องใช้คุยกัน ไม่ใช่ชื่อที่ครูรู้จัก (Bank 2026-09-14)
// รูปแบบไม่ตรงก็แสดงของเดิมไปตรงๆ ดีกว่าเดาผิดแล้วครูไปผิดตู้
export function cabinetLabel(cabinetId) {
    const match = /^box(\d+)$/.exec(String(cabinetId ?? ''));
    return match ? `ตู้ที่ ${Number(match[1])}` : `ตู้ ${cabinetId}`;
}
const DRAWER_TH = Object.freeze({ 1: 'ลิ้นชัก 1', 2: 'ลิ้นชัก 2' });

// อาการที่ทำให้ตู้ปฏิเสธการจ่ายยาแล้วเรียกครูแทน — ครูต้องอ่านออกทันทีว่าด่วนแค่ไหน
// ข้อความเขียนเป็นสิ่งที่เด็กบอก ไม่ใช่การวินิจฉัย เพราะตู้ไม่ได้วินิจฉัยอะไร
const SYMPTOM_TH = Object.freeze({
    swelling: 'เด็กบอกว่าบวมบริเวณที่ถูกกัด',
    chest_tightness: 'เด็กบอกว่าแน่นหน้าอก'
});

// ACK ของตู้บอกได้แค่ว่ามอเตอร์ทำงานตามคำสั่งหรือไม่ ไม่ได้บอกว่าเด็กหยิบของไปจริง
// คำแปลจึงต้องไม่ทำให้ครูเข้าใจเกินกว่าที่ระบบรู้ · 'uncertain' คือกรณีที่ตู้ค้างและต้องมีคนไปดู
const ACK_TH = Object.freeze({
    confirmed: { label: 'ตู้จ่ายของแล้ว', color: THEME.success },
    uncertain: { label: 'ตู้ไม่ยืนยันว่าจ่ายสำเร็จ ต้องไปดูที่ตู้', color: THEME.danger },
    rejected: { label: 'ตู้ปฏิเสธคำสั่ง ไม่ได้จ่ายของ', color: THEME.textMuted },
    resolved_by_operator: { label: 'ครูเคลียร์รายการค้างด้วยตนเองแล้ว', color: THEME.textMuted }
});

// นาฬิกาของตู้ไม่มีถ่าน RTC ⇒ หลังไฟดับมันอาจเดินผิดจนกว่าจะซิงค์เวลาได้
// ถ้าไม่บอก ครูจะอ่านเวลาผิดโดยไม่รู้ตัว การเงียบตรงนี้แย่กว่าการบอกว่าไม่แน่ใจ
const CLOCK_WARNING = 'เวลาที่แสดงมาจากนาฬิกาของตู้ซึ่งยังไม่ได้เทียบกับเวลามาตรฐาน อาจคลาดเคลื่อน';

// ประกอบวันกับเวลาเอง ไม่ใช้ dateStyle/timeStyle
//
// `th-TH` กับ `timeStyle` แทรกคำว่า "เวลา" มาให้เอง ⇒ พอเอาไปวางหลังป้าย "เวลา" ในการ์ด
// มันอ่านว่า "เวลา 14 กันยายน 2569 เวลา 18:05" · ปฏิทินเป็นพุทธศักราชตามค่าตั้งต้นของ th-TH
// ซึ่งถูกแล้วสำหรับครูไทย
export function formatThaiTime(iso, timeZone = 'Asia/Bangkok') {
    const date = new Date(iso);
    if (!Number.isFinite(date.getTime())) return 'ไม่ทราบเวลา';
    const day = new Intl.DateTimeFormat('th-TH', { timeZone, day: 'numeric', month: 'short', year: 'numeric' }).format(date);
    const clock = new Intl.DateTimeFormat('th-TH', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date);
    return `${day} · ${clock} น.`;
}

const text = (value, extra = {}) => ({ type: 'text', text: value, wrap: true, ...extra });

// แถวข้อมูล: หัวข้อซ้าย ค่าขวา — ค่ายาวต้องตัดบรรทัดได้ ไม่ใช่ถูกตัดทิ้ง
const row = (label, value, valueColor = THEME.textMain) => ({
    type: 'box', layout: 'baseline', spacing: 'sm', contents: [
        text(label, { size: 'sm', color: THEME.textMuted, flex: 2 }),
        text(value, { size: 'sm', color: valueColor, flex: 5, weight: 'bold' })
    ]
});

/** ชื่อนักเรียนเป็นของที่ "ยังไม่มี" ไม่ใช่ของที่ "ไม่มี"
 *
 * วันนี้ `validateEvent` บังคับว่า `uid` และ `badgeId` ต้องเป็น null เสมอ ⇒ ตู้ยังส่งตัวตนไม่ได้
 * WP3 (บัตรนักเรียน + QR) จะเป็นคนเติม · ตรงนี้จึงรับ `student` เข้ามาแล้วแสดงให้ถ้ามี
 * ถ้าไม่มีก็บอกตามตรงว่ายังไม่ได้สแกนบัตร แทนที่จะเว้นว่างให้ครูเดาเอง
 * สัญญารูปร่าง: { name: string, room?: string } · ไม่มีฟิลด์อื่นถูกอ่าน
 */
function identityBlock(student) {
    const named = typeof student?.name === 'string' && student.name.trim();
    return {
        type: 'box', layout: 'vertical', spacing: 'xs', contents: [
            text(named ? student.name.trim() : 'ยังไม่ทราบว่าเป็นนักเรียนคนไหน',
                { size: 'xl', weight: 'bold', color: named ? THEME.textMain : THEME.textMuted }),
            text(named
                ? (typeof student.room === 'string' && student.room.trim() ? `ชั้น ${student.room.trim()}` : 'ไม่ระบุชั้นเรียน')
                : 'นักเรียนยังไม่ได้สแกนบัตรที่หน้าตู้',
                { size: 'sm', color: THEME.textMuted })
        ]
    };
}

function shell({ title, accent, body, origin }) {
    const bubble = {
        type: 'bubble',
        header: {
            type: 'box', layout: 'vertical', backgroundColor: accent, paddingAll: '16px',
            contents: [text(title, { color: '#FFFFFF', weight: 'bold', size: 'lg' })]
        },
        body: {
            type: 'box', layout: 'vertical', spacing: 'md', paddingAll: '16px',
            backgroundColor: THEME.surface, contents: body
        }
    };
    if (origin) {
        bubble.footer = {
            type: 'box', layout: 'vertical', paddingAll: '12px', backgroundColor: THEME.surface,
            contents: [{
                type: 'button', style: 'primary', height: 'sm', color: THEME.primary,
                action: { type: 'uri', label: 'ดูประวัติการใช้ตู้', uri: `${origin}/dashboard/statistics` }
            }]
        };
    }
    return bubble;
}

const separator = { type: 'separator', color: THEME.border };

/** ข้อความฉุกเฉิน — ครูต้องรู้ภายในวินาทีแรกว่าต้องลุกไปที่ตู้ */
export function sosBubble(event, { student = null, origin = '' } = {}) {
    const body = [identityBlock(student), separator,
        row('ที่ตู้', event.cabinetId === 'web' ? 'กดจากเว็บ ไม่ได้กดที่ตู้' : cabinetLabel(event.cabinetId)),
        row('เวลา', formatThaiTime(event.ts))];
    // buzzerAck เป็น null แปลว่า "ไม่รู้" ไม่ใช่ "ไม่ดัง" — ต้องไม่ทำให้ครูคิดว่าเด็กได้ยินเสียงแล้ว
    if (event.buzzerAck === true) body.push(row('เสียงออด', 'ดังแล้วที่ตู้', THEME.success));
    else if (event.buzzerAck === false) body.push(row('เสียงออด', 'ตู้แจ้งว่าไม่ได้ดัง', THEME.danger));
    else body.push(row('เสียงออด', 'ไม่ยืนยันว่าดังหรือไม่', THEME.textMuted));
    // อาการรุนแรงต้องอยู่เหนือข้อความทั่วไป และต้องอ่านออกก่อนอย่างอื่นบนการ์ด
    if (SYMPTOM_TH[event.symptom]) {
        body.push(text(SYMPTOM_TH[event.symptom], { size: 'md', weight: 'bold', color: THEME.danger }));
        body.push(text('ตู้ไม่จ่ายยาให้เพราะอาการแบบนี้ต้องให้ครูดูก่อน กรุณาไปที่ตู้ทันที',
            { size: 'sm', color: THEME.textMain }));
    } else {
        body.push(text('มีนักเรียนกดเรียกครูพยาบาลที่ตู้ปฐมพยาบาล กรุณาไปดูที่ตู้',
            { size: 'sm', color: THEME.textMain }));
    }
    if (event.clockTrust && event.clockTrust !== 'ntp') {
        body.push(text(CLOCK_WARNING, { size: 'xs', color: THEME.textMuted }));
    }
    return shell({ title: 'เรียกครูพยาบาล', accent: THEME.danger, body, origin });
}

/** ข้อความแจ้งการใช้ตู้ — ไม่ใช่เรื่องด่วน แต่ครูต้องเห็นว่าใครใช้อะไรไป */
export function dispenseBubble(event, { student = null, origin = '' } = {}) {
    const ack = ACK_TH[event.ack] || { label: event.ack, color: THEME.textMuted };
    const body = [identityBlock(student), separator,
        row('อาการ', WOUND_TH[event.woundType] || event.woundType),
        row('ช่องที่เปิด', DRAWER_TH[event.drawer] || `ลิ้นชัก ${event.drawer}`),
        row('เวลา', formatThaiTime(event.ts)),
        row('ผลจากตู้', ack.label, ack.color),
        text('ตู้ยืนยันได้แค่ว่าเปิดลิ้นชักแล้ว ยืนยันไม่ได้ว่านักเรียนหยิบของออกไปจริง',
            { size: 'xs', color: THEME.textMuted })];
    if (event.clockTrust && event.clockTrust !== 'ntp') {
        body.push(text(CLOCK_WARNING, { size: 'xs', color: THEME.textMuted }));
    }
    return shell({ title: 'มีการใช้ตู้ปฐมพยาบาล', accent: THEME.primary, body, origin });
}

/** altText คือสิ่งที่โผล่บนหน้าจอล็อกและในรายการแชต — ต้องอ่านรู้เรื่องโดยไม่ต้องเปิดดู
 *
 * LINE ตัดที่ 400 ตัวอักษร และไม่แสดง Flex บนนาฬิกาหรือการแจ้งเตือนบางแบบ
 * ⇒ บรรทัดนี้ต้องยืนอยู่ได้ลำพัง ไม่ใช่คำว่า "ข้อความใหม่"
 */
export function altTextFor(event, student = null) {
    // ตัดชื่อก่อน ไม่ใช่ปล่อยให้ LINE ตัดท้ายทิ้ง
    //
    // ถ้าปล่อยชื่อยาวไว้แล้วไปตัดที่ 400 สิ่งที่หายคือ "เวลา" ซึ่งเป็นส่วนที่ครูต้องใช้จริง
    // ส่วนที่รอดคือชื่อที่ยาวเกินจำเป็น · ชื่อมาจาก CSV ที่ครูนำเข้าเอง จึงยาวผิดปกติได้
    const raw = typeof student?.name === 'string' ? student.name.trim() : '';
    const who = raw ? (raw.length > 40 ? `${raw.slice(0, 40)}…` : raw) : 'ไม่ทราบชื่อ';
    // คั่นด้วยจุดกลาง ไม่ใช่คำเชื่อม — "ที่ ตู้ที่ 1" อ่านสะดุดตั้งแต่คำที่สอง
    const where = event.cabinetId === 'web' ? 'กดจากเว็บ' : cabinetLabel(event.cabinetId);
    return event.kind === 'sos'
        ? `เรียกครูพยาบาล${SYMPTOM_TH[event.symptom] ? ` (${SYMPTOM_TH[event.symptom]})` : ''} — ${who} · ${where} · ${formatThaiTime(event.ts)}`
        : `ใช้ตู้ปฐมพยาบาล — ${who} · ${WOUND_TH[event.woundType] || event.woundType} · ${formatThaiTime(event.ts)}`;
}

export function lineMessage(event, options = {}) {
    const contents = event.kind === 'sos' ? sosBubble(event, options) : dispenseBubble(event, options);
    return { type: 'flex', altText: altTextFor(event, options.student).slice(0, 400), contents };
}
