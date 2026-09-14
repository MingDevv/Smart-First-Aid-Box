// ข้อความที่ครูได้รับใน LINE — ต้องอ่านรู้เรื่อง และต้องไม่พาข้อมูลสุขภาพเด็กออกไปด้วย
//
// ของเดิมเป็นอังกฤษบรรทัดเดียวที่เขียนให้ตัวเองอ่าน ("Cabinet box1 — confirmed / Drawer 1:
// cut_abrasion") · Bank: "ตอนนี้ยังเป็นแค่ภาษาอังกฤษ งงๆ อะไรไม่รู้" (2026-09-14)
//
// โครงสร้าง Flex ทั้ง 7 แบบผ่าน validator ของ LINE จริงแล้ว (POST /v2/bot/message/validate/push
// จากบน Pi ที่ถือโทเคนอยู่ · ตัวอย่างที่จงใจให้ผิดถูกปฏิเสธด้วย 400 = validator ทำงานจริง)
// เทสชุดนี้จึงไม่ตรวจไวยากรณ์ซ้ำ แต่ตรวจสิ่งที่ validator ไม่มีทางรู้: ความหมายที่ครูจะอ่านได้
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { lineMessage, sosBubble, dispenseBubble, formatThaiTime, altTextFor, cabinetLabel, THEME } from '../lib/line-flex.js';
import { resolveStudent } from '../lib/cabinet-line.js';

const SOS = { kind: 'sos', cabinetId: 'box1', ts: '2026-09-14T11:05:00.000Z', clockTrust: 'ntp', buzzerAck: true };
const DISPENSE = { kind: 'dispense', cabinetId: 'box1', ts: '2026-09-14T11:05:00.000Z', clockTrust: 'ntp',
    drawer: 1, woundType: 'cut_abrasion', ack: 'confirmed' };
const STUDENT = { name: 'เด็กชายสมชาย ใจดี', room: 'ป.5/2' };

const flatten = node => {
    if (Array.isArray(node)) return node.flatMap(flatten);
    if (!node || typeof node !== 'object') return [];
    const own = typeof node.text === 'string' ? [node.text] : [];
    const label = node.action?.label ? [node.action.label] : [];
    return [...own, ...label, ...flatten(node.contents || [])];
};
const words = bubble => flatten([bubble.header, bubble.body, bubble.footer]).join(' | ');

test('the card is Thai the teacher can act on, not enum names copied out of the code', () => {
    const seen = words(dispenseBubble(DISPENSE, { student: STUDENT }));
    for (const raw of ['cut_abrasion', 'insect', 'confirmed', 'uncertain', 'rejected', 'drawer1', 'Cabinet', 'Drawer'])
        assert.ok(!seen.includes(raw), `ค่าดิบ "${raw}" ต้องไม่โผล่ให้ครูเห็น`);
    assert.match(seen, /แผลมีดบาด/);
    assert.match(seen, /ลิ้นชัก 1/);
    assert.match(seen, /ตู้จ่ายของแล้ว/);
});

test('every cabinet answer has a Thai sentence, so no state can leak out raw', () => {
    for (const [ack, expected] of [['confirmed', /จ่ายของแล้ว/], ['uncertain', /ต้องไปดูที่ตู้/],
        ['rejected', /ไม่ได้จ่ายของ/], ['resolved_by_operator', /เคลียร์รายการค้าง/]]) {
        assert.match(words(dispenseBubble({ ...DISPENSE, ack })), expected, ack);
    }
    for (const [drawer, woundType, expected] of [[1, 'cut_abrasion', /แผลมีดบาด/], [2, 'insect', /แมลงกัดต่อย/]]) {
        assert.match(words(dispenseBubble({ ...DISPENSE, drawer, woundType })), expected, woundType);
    }
});

// ชื่อนักเรียนเป็นของที่ "ยังไม่มี" ไม่ใช่ของที่ "ไม่มี" — WP3 จะเป็นคนเติม
// การ์ดต้องพร้อมรับมันอยู่แล้ว และระหว่างนี้ต้องบอกตามตรง ไม่ใช่เว้นว่างให้ครูเดา
test('the student name shows when it is known, and says so plainly when it is not', () => {
    const named = words(sosBubble(SOS, { student: STUDENT }));
    assert.match(named, /เด็กชายสมชาย ใจดี/);
    assert.match(named, /ชั้น ป\.5\/2/);

    const unknown = words(sosBubble(SOS, {}));
    assert.match(unknown, /ยังไม่ทราบว่าเป็นนักเรียนคนไหน/);
    assert.match(unknown, /ยังไม่ได้สแกนบัตร/);

    const noRoom = words(sosBubble(SOS, { student: { name: 'มานี' } }));
    assert.match(noRoom, /มานี/);
    assert.match(noRoom, /ไม่ระบุชั้นเรียน/);
});

// `students/{uid}` เก็บประวัติแพ้ยาและแพ้อาหารไว้ด้วย · กลุ่ม LINE ของครูไม่ใช่ที่ของมัน
test('a student lookup carries the name out and leaves the health record behind', async () => {
    const doc = { name: 'เด็กหญิงมานี รักเรียน', room: 'ป.6/1',
        drugAllergies: 'เพนิซิลลิน', foodAllergies: 'ถั่วลิสง', studentNo: '12345', note: 'ความลับ' };
    const db = { doc: () => ({ get: async () => ({ exists: true, data: () => doc }) }) };
    const student = await resolveStudent(db, { uid: 'u-1' });
    assert.deepEqual(Object.keys(student).sort(), ['name', 'room'], 'ต้องหยิบทีละฟิลด์ ไม่ใช่ยกเอกสารทั้งใบ');

    const rendered = JSON.stringify(lineMessage({ ...DISPENSE, uid: 'u-1' }, { student }));
    for (const secret of ['เพนิซิลลิน', 'ถั่วลิสง', '12345', 'ความลับ'])
        assert.ok(!rendered.includes(secret), `ข้อมูลสุขภาพ/รหัส "${secret}" ต้องไม่ออกไปกับข้อความ LINE`);

    // วันนี้ตู้ยังส่งตัวตนไม่ได้เลย — uid เป็น null เสมอ ⇒ ต้องไม่ไปอ่าน Firestore โดยเปล่าประโยชน์
    let reads = 0;
    const counting = { doc: () => { reads++; return { get: async () => ({ exists: false }) }; } };
    assert.equal(await resolveStudent(counting, { uid: null }), null);
    assert.equal(reads, 0, 'ไม่มี uid ก็ไม่ต้องแตะฐานข้อมูล');
});

// buzzerAck เป็น null แปลว่า "ไม่รู้" ไม่ใช่ "ไม่ดัง" — ครูต้องไม่เข้าใจว่าเด็กได้ยินเสียงแล้ว
test('an unknown buzzer result is reported as unknown, never as silence or success', () => {
    assert.match(words(sosBubble({ ...SOS, buzzerAck: true })), /ดังแล้วที่ตู้/);
    assert.match(words(sosBubble({ ...SOS, buzzerAck: false })), /ไม่ได้ดัง/);
    assert.match(words(sosBubble({ ...SOS, buzzerAck: null })), /ไม่ยืนยันว่าดังหรือไม่/);
});

// ตู้ยังไม่มีถ่าน RTC ⇒ เวลาอาจผิด · เงียบเรื่องนี้แย่กว่าบอกว่าไม่แน่ใจ
test('an unverified cabinet clock is disclosed on the card, and only when it is unverified', () => {
    for (const trust of ['untrusted', 'rtc']) {
        assert.match(words(sosBubble({ ...SOS, clockTrust: trust })), /อาจคลาดเคลื่อน/, trust);
        assert.match(words(dispenseBubble({ ...DISPENSE, clockTrust: trust })), /อาจคลาดเคลื่อน/, trust);
    }
    assert.doesNotMatch(words(sosBubble(SOS)), /อาจคลาดเคลื่อน/);
    assert.doesNotMatch(words(dispenseBubble(DISPENSE)), /อาจคลาดเคลื่อน/);
});

test('a web SOS says it came from the web, because that changes what the teacher should do', () => {
    assert.match(words(sosBubble({ ...SOS, cabinetId: 'web' })), /กดจากเว็บ ไม่ได้กดที่ตู้/);
    assert.match(words(sosBubble(SOS)), /ตู้ที่ 1/);
});

// `box1` เป็นชื่อที่เครื่องใช้คุยกัน ครูไม่รู้จัก (Bank 2026-09-14)
test('the cabinet is named the way a teacher would say it, and an unknown shape is shown as-is', () => {
    assert.equal(cabinetLabel('box1'), 'ตู้ที่ 1');
    assert.equal(cabinetLabel('box12'), 'ตู้ที่ 12');
    // รูปแบบที่ไม่รู้จักต้องไม่ถูกเดาเป็นเลขมั่ว ครูจะได้ไม่เดินไปผิดตู้
    for (const odd of ['clinic-a', '', null, 'boxA']) assert.match(cabinetLabel(odd), /^ตู้ /);
    assert.doesNotMatch(words(sosBubble(SOS)), /box1/, 'ชื่อทางเทคนิคต้องไม่โผล่บนการ์ด');
    assert.doesNotMatch(altTextFor(SOS, null), /box1/);
});

// altText คือสิ่งที่ครูเห็นบนหน้าจอล็อก · LINE ไม่แสดง Flex ในทุกที่ ⇒ บรรทัดนี้ต้องยืนได้ลำพัง
test('the notification line stands on its own and stays inside the LINE limit', () => {
    const long = { name: 'เด็กหญิง' + 'ก'.repeat(600), room: 'ป.1/1' };
    for (const event of [SOS, DISPENSE]) {
        for (const student of [null, STUDENT, long]) {
            const message = lineMessage(event, { student });
            assert.ok(message.altText.length <= 400, 'altText ต้องไม่เกิน 400 ตัวอักษรที่ LINE ตัด');
            assert.ok(message.altText.length > 10, 'ต้องไม่ใช่คำว่า "ข้อความใหม่"');
            assert.match(message.altText, /2569/, 'ต้องบอกเวลาโดยไม่ต้องเปิดการ์ด');
            assert.equal(message.type, 'flex');
        }
    }
    assert.match(altTextFor(SOS, STUDENT), /เรียกครูพยาบาล/);
    assert.match(altTextFor(DISPENSE, null), /ไม่ทราบชื่อ/);
});

test('the time is Thai local wall clock, not the UTC string the cabinet stored', () => {
    // 11:05Z = 18:05 ตามเวลาไทย · ถ้าเผลอแสดง UTC ครูจะอ่านผิดไป 7 ชั่วโมง
    assert.match(formatThaiTime('2026-09-14T11:05:00.000Z'), /18:05/);
    assert.match(formatThaiTime('2026-09-14T11:05:00.000Z'), /2569/, 'ปีพุทธศักราชตามที่คนไทยอ่าน');
    assert.doesNotMatch(formatThaiTime('2026-09-14T11:05:00.000Z'), /เวลา.*เวลา/, 'คำว่าเวลาต้องไม่ซ้ำ');
    assert.equal(formatThaiTime('not-a-date'), 'ไม่ทราบเวลา');
});

// สีของการ์ดต้องเป็นสีเดียวกับเว็บ · ธีมเขียนเป็น oklch แต่ LINE รับแต่ hex
// ถ้าใครแก้ธีมแล้วลืมที่นี่ การ์ดจะเพี้ยนเงียบๆ — เทสนี้แปลงเองแล้วเทียบ
test('the card colours are the same theme as the app, converted from the real tokens', async () => {
    const css = await readFile(new URL('../css/global.css', import.meta.url), 'utf8');
    const gamma = t => t > 0.0031308 ? 1.055 * Math.pow(t, 1 / 2.4) - 0.055 : 12.92 * t;
    const toHex = (L, C, hDeg) => {
        const h = hDeg * Math.PI / 180, a = C * Math.cos(h), b = C * Math.sin(h);
        const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
        const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
        const s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3;
        return '#' + [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
            -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
            -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s]
            .map(v => Math.round(Math.min(1, Math.max(0, gamma(v))) * 255).toString(16).padStart(2, '0'))
            .join('').toUpperCase();
    };
    assert.equal(toHex(1, 0, 0), '#FFFFFF', 'ตัวแปลงต้องถูกก่อน จึงจะเชื่อผลเทียบข้างล่างได้');
    const token = name => {
        const match = css.match(new RegExp(`--${name}:\\s*oklch\\(([\\d.]+)\\s+([\\d.]+)\\s+([\\d.]+)\\)`));
        assert.ok(match, `ไม่พบโทเคน --${name} ใน css/global.css`);
        return toHex(Number(match[1]), Number(match[2]), Number(match[3]));
    };
    for (const [key, name] of [['primary', 'primary'], ['danger', 'danger'], ['success', 'success'],
        ['textMain', 'text-main'], ['textMuted', 'text-muted'], ['border', 'border-color']]) {
        assert.equal(THEME[key], token(name), `สี ${key} ไม่ตรงกับ --${name} ในธีมแล้ว`);
    }
});

test('no emoji anywhere in what the teacher receives', async () => {
    const source = await readFile(new URL('../lib/line-flex.js', import.meta.url), 'utf8');
    const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u;
    assert.ok(!emoji.test(source), 'กฎถาวร: UI ทุกที่ห้ามใช้ emoji');
    for (const event of [SOS, DISPENSE]) {
        assert.ok(!emoji.test(JSON.stringify(lineMessage(event, { student: STUDENT }))));
    }
});

// ปุ่มต้องพาไปหน้าที่มีจริง และต้องหายไปเงียบๆ ถ้ายังไม่รู้ว่าเว็บอยู่ที่ไหน แทนที่จะสร้างลิงก์เสีย
test('the history button appears only when a real origin is known', () => {
    const withOrigin = sosBubble(SOS, { origin: 'https://smart-first-aid-box.vercel.app' });
    assert.equal(withOrigin.footer.contents[0].action.uri, 'https://smart-first-aid-box.vercel.app/dashboard/statistics');
    assert.equal(sosBubble(SOS, {}).footer, undefined, 'ไม่รู้ปลายทางก็อย่าใส่ปุ่มที่กดแล้วพัง');
});
