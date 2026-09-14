// แมลงกัดต่อย: ถามอาการแทนคำถามแพ้ยา และไม่จ่ายยาเมื่ออาการบ่งชี้การแพ้รุนแรง
//
// Bank 2026-09-14: "ในส่วนของแพ้ยา ของหมวดแมลงกัดต่อย เปลี่ยนเป็น มีอาการเหล่านี้หรือไม่
// บวมบริเวณแผล, แน่นหน้าอก, ไม่มี โดยจะไม่ให้รับยา ถ้าเป็นสองอย่างแรก จะส่ง sos หาครู
// พร้อมรายละเอียดแทน"
//
// เส้นที่ต้องไม่ขยับ: อาการเป็น **enum** เท่านั้น เพราะค่านี้เดินทางไปโผล่ในกลุ่ม LINE ของครู
// ถ้าเปิดให้เป็นข้อความอิสระ จอตู้ที่ไม่มีใครเฝ้าก็กลายเป็นช่องส่งข้อความเข้ากลุ่มครู
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { validateEvent, SOS_SYMPTOMS } from '../lib/cabinet-events.js';
import { sosBubble, lineMessage } from '../lib/line-flex.js';

const BASE = { id: 'evt-00000001', kind: 'sos', cabinetId: 'box1', uid: null, historical: false,
    ts: '2026-09-14T11:05:00.000Z', clockTrust: 'ntp', buzzerAck: null };

test('an SOS can carry why it was raised, but only from a fixed list', () => {
    for (const symptom of SOS_SYMPTOMS) {
        assert.equal(validateEvent({ ...BASE, symptom }, 'box1').symptom, symptom);
    }
    // ไม่ระบุอาการยังต้องผ่าน เพราะการกดปุ่มเรียกครูธรรมดาไม่มีอาการกำกับ
    assert.equal(validateEvent(BASE, 'box1').symptom, null);
    assert.equal(validateEvent({ ...BASE, symptom: null }, 'box1').symptom, null);

    for (const bad of ['anything', '', 'SWELLING', 123, {}, ['swelling'],
        'เด็กบอกว่าปวดมาก โทรหาผู้ปกครองด้วย']) {
        assert.throws(() => validateEvent({ ...BASE, symptom: bad }, 'box1'),
            `ค่า ${JSON.stringify(bad)} ต้องถูกปฏิเสธ ไม่ใช่เก็บไว้แล้วส่งต่อไปหาครู`);
    }
});

test('the teacher is told which symptom raised the alarm, on the card and on the lock screen', () => {
    for (const [symptom, expected] of [['swelling', /บวมบริเวณที่ถูกกัด/], ['chest_tightness', /แน่นหน้าอก/]]) {
        const message = lineMessage({ ...BASE, symptom }, { origin: 'https://x.test' });
        assert.match(message.altText, expected, 'ต้องอ่านออกโดยไม่ต้องเปิดการ์ด');
        const rendered = JSON.stringify(sosBubble({ ...BASE, symptom }));
        assert.match(rendered, expected);
        assert.match(rendered, /ตู้ไม่จ่ายยาให้/, 'ครูต้องรู้ว่าตู้ปฏิเสธไปแล้ว จะได้ไม่คิดว่าเด็กได้ยาไปแล้ว');
        assert.doesNotMatch(rendered, new RegExp(symptom), 'ค่าดิบต้องไม่โผล่ให้ครูเห็น');
    }
    // เรียกครูธรรมดาต้องไม่มีบรรทัดอาการงอกมา
    const plain = JSON.stringify(sosBubble(BASE));
    assert.doesNotMatch(plain, /ตู้ไม่จ่ายยาให้/);
    assert.match(plain, /มีนักเรียนกดเรียกครูพยาบาล/);
});

// ข้อความบนการ์ดต้องเป็นสิ่งที่เด็กบอก ไม่ใช่การวินิจฉัย เพราะตู้ไม่ได้วินิจฉัยอะไร
test('the card reports what the child said, it does not diagnose', () => {
    const rendered = JSON.stringify(sosBubble({ ...BASE, symptom: 'chest_tightness' }));
    assert.match(rendered, /เด็กบอกว่า/);
    for (const claim of [/แพ้รุนแรง/, /anaphylaxis/i, /อาการแพ้/])
        assert.doesNotMatch(rendered, claim, 'ตู้ไม่มีสิทธิ์บอกว่าเด็กเป็นอะไร');
});

test('the cabinet screen asks about symptoms for insect bites and about allergies otherwise', async () => {
    const source = await readFile(new URL('../js/kiosk-app.js', import.meta.url), 'utf8');
    assert.match(source, /TRIAGE\s*=\s*\{[\s\S]*insect:/, 'หมวดแมลงกัดต่อยต้องมีชุดคำถามของตัวเอง');
    for (const label of ['บวมบริเวณแผล', 'แน่นหน้าอก', 'ไม่มี'])
        assert.ok(source.includes(`'${label}'`), `ต้องมีตัวเลือก "${label}"`);
    assert.match(source, /ตอนนี้มีอาการแบบนี้ไหม/);
    assert.match(source, /เคยแพ้สิ่งที่แสดงนี้ไหม/, 'แผลทั่วไปยังถามเรื่องแพ้ยาเหมือนเดิม');

    // สองอาการแรกต้องบล็อกการจ่าย และต้องเรียกครูเองโดยไม่รอให้เด็กหาปุ่มเจอ
    assert.match(source, /symptom === 'swelling'[\s\S]{0,120}ตู้เรียกครูให้แล้ว/);
    assert.match(source, /symptom === 'chest_tightness'[\s\S]{0,120}ตู้เรียกครูให้แล้ว/);
    assert.match(source, /chosen\?\.symptom[\s\S]{0,80}sendSos\(\{ symptom: chosen\.symptom, auto: true \}\)/);
});

// ถ้าจอตู้ส่งค่าที่ไม่รู้จักมา ตู้ต้องไม่ทิ้งการเรียกครู แค่ทิ้งเหตุผล
// การเรียกครูสำคัญกว่าการได้เหตุผลครบ
test('an unrecognised symptom loses the reason, never the call for help', async () => {
    const outbox = await readFile(new URL('../edge/outbox.mjs', import.meta.url), 'utf8');
    assert.match(outbox, /SOS_SYMPTOMS\.includes\(symptom\) \? symptom : null/);
    const notify = await readFile(new URL('../edge/notify.mjs', import.meta.url), 'utf8');
    assert.match(notify, /queueSos\(req\.body\.eventId, req\.body\.symptom \?\? null\)/);
    assert.doesNotMatch(notify, /symptom[\s\S]{0,60}return res\.status\(400\)/,
        'อาการที่อ่านไม่ออกต้องไม่ทำให้ทั้งคำขอถูกปฏิเสธ');
});
