// รูปใบหน้าของคนที่ใช้ตู้โดยไม่มีบัตร — เส้นทางเก็บ ส่ง และเปิดดู
//
// คนไม่มีบัตรหรือคนนอกที่บาดเจ็บต้องใช้ตู้ได้ แต่ต้องถ่ายรูปหน้าส่งครู
// เหตุผลคือกันคนมากดเล่น
//
// เทสชุดนี้ปักสิ่งที่ทำให้ "เปิดให้ดึงโดยไม่ล็อกอิน" ยังพอรับได้: เดาไม่ได้ อายุสั้น
// ไม่บอกว่าพลาดตรงไหน และเขียนทับประวัติไม่ได้
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHmac, createHash } from 'node:crypto';
import { createPhotoHandler, VIEW_TTL_MS, MAX_BASE64 } from '../api/photo.js';
import { inspectFrame, FACE_MIN_COVERAGE } from '../lib/face-check.js';
import { sosBubble } from '../lib/line-flex.js';
import { resolvePhoto } from '../lib/cabinet-line.js';

const SECRET = 'x'.repeat(48);
const ENV = { SFAB_CABINET_SECRET: SECRET, SFAB_CABINET_ID: 'box1' };
const JPEG = Buffer.alloc(1024, 7).toString('base64');

function signed(body, at, eventId = 'evt-000001') {
    const digest = createHash('sha256').update(body).digest('hex');
    const mac = createHmac('sha256', SECRET).update(['SFAB1', 'POST', '/api/photo', 'box1', String(at), digest].join('\n')).digest('hex');
    return { method: 'POST', body: Buffer.from(body),
        headers: { 'x-sfab-cabinet': 'box1', 'x-sfab-timestamp': String(at), 'x-sfab-signature': mac, 'x-sfab-event': eventId } };
}

function store() {
    const docs = new Map();
    return { docs, db: {
        doc: path => ({
            async create(value) {
                if (docs.has(path)) { const error = new Error('already exists'); error.code = 6; throw error; }
                docs.set(path, value);
            },
            async get() { const value = docs.get(path); return { exists: !!value, data: () => value }; }
        })
    } };
}

const invoke = async (handler, req) => {
    let status = 0, payload, body, headers = {};
    const res = { setHeader(k, v) { headers[k.toLowerCase()] = v; }, status(code) { status = code; return res; },
        json(value) { payload = value; return res; }, end(value) { body = value; return res; } };
    await handler(req, res);
    return { status, payload, body, headers };
};

test('the cabinet uploads a face photo with the same signature scheme as everything else', async () => {
    const { db, docs } = store();
    const at = Date.now();
    const handler = createPhotoHandler({ services: () => ({ db }), env: ENV, now: () => at, makeToken: () => 'T'.repeat(43) });
    const ok = await invoke(handler, signed(JPEG, at));
    assert.equal(ok.status, 200);
    // `signedResponse` ตอบด้วย res.end(JSON) ไม่ใช่ res.json() เพราะต้องเซ็นตัวเนื้อที่ส่งออกจริง
    assert.equal(JSON.parse(ok.body).viewToken, 'T'.repeat(43));
    assert.equal(docs.get('photos/box1~evt-000001').jpegBase64, JPEG);
    assert.equal(ok.headers['x-sfab-signature'] !== undefined, true, 'คำตอบต้องถูกเซ็นกลับเหมือน endpoint อื่นของตู้');

    // ลายเซ็นผิดต้องไม่ผ่าน และต้องไม่เขียนอะไรลงฐานข้อมูล
    const forged = signed(JPEG, at);
    forged.headers['x-sfab-signature'] = 'a'.repeat(64);
    const bad = await invoke(handler, { ...forged, headers: { ...forged.headers } });
    assert.equal(bad.status, 401);
    assert.equal(docs.size, 1, 'คำขอที่ลายเซ็นผิดต้องไม่สร้างเอกสารใหม่');
});

// ประวัติต้องแก้ย้อนหลังไม่ได้ · ส่งรูปใหม่ทับ id เดิมจึงต้องถูกปฏิเสธ ไม่ใช่เขียนทับเงียบๆ
test('a photo cannot be replaced once the event has one', async () => {
    const { db } = store();
    const at = Date.now();
    const handler = createPhotoHandler({ services: () => ({ db }), env: ENV, now: () => at });
    assert.equal((await invoke(handler, signed(JPEG, at))).status, 200);
    assert.equal((await invoke(handler, signed(Buffer.alloc(1024, 9).toString('base64'), at))).status, 409);
});

test('rubbish never reaches storage, so nothing breaks later when a teacher opens it', async () => {
    const { db, docs } = store();
    const at = Date.now();
    const handler = createPhotoHandler({ services: () => ({ db }), env: ENV, now: () => at });
    for (const [label, body, eventId] of [
        ['ไม่ใช่ base64', 'ไม่ใช่รูป'.repeat(200), 'evt-000002'],
        ['สั้นเกินกว่าจะเป็นรูป', 'AAAA', 'evt-000003']
    ]) {
        assert.equal((await invoke(handler, signed(body, at, eventId))).status, 400, label);
    }
    const tooBig = signed('A'.repeat(MAX_BASE64 + 4), at, 'evt-000004');
    assert.equal((await invoke(handler, tooBig)).status, 413);
    // รูปแบบ event id ที่ไม่ถูกต้องต้องไม่กลายเป็น path ประหลาดในฐานข้อมูล
    assert.equal((await invoke(handler, signed(JPEG, at, '../../etc'))).status, 400);
    assert.equal(docs.size, 0, 'ไม่มีคำขอไหนข้างบนควรถูกเก็บ');
});

// เส้นทางเปิดดูไม่มีการล็อกอินโดยเจตนา เพราะ LINE เป็นคนดึงรูปเอง
// ความปลอดภัยจึงอยู่ที่โทเคนล้วน — และต้องไม่บอกว่าพลาดตรงไหน
test('the unauthenticated view needs the exact token and dies after fifteen minutes', async () => {
    const { db } = store();
    let clock = Date.now();
    // ปฏิเสธการล็อกอินอย่างชัดเจน ไม่ใช่ปล่อยให้ผ่านเพราะ Firebase ใช้ไม่ได้ในเทส
    // ไม่งั้นเคส "ไม่มีโทเคน" ข้างล่างจะเขียวด้วยเหตุผลที่ไม่เกี่ยวกับสิ่งที่มันตั้งใจตรวจ
    const denied = async () => { throw new Error('not staff'); };
    const handler = createPhotoHandler({ services: () => ({ db }), env: ENV, now: () => clock, makeToken: () => 'T'.repeat(43), authorizeRequest: denied });
    await invoke(handler, signed(JPEG, clock));
    const get = (query) => invoke(handler, { method: 'GET', url: `/api/photo?${query}` });

    const good = await get('event=box1~evt-000001&t=' + 'T'.repeat(43));
    assert.equal(good.status, 200);
    assert.equal(good.headers['content-type'], 'image/jpeg');
    assert.match(good.headers['cache-control'], /no-store/, 'ห้ามให้ CDN เก็บไว้หลังโทเคนตาย');
    assert.equal(good.headers['x-content-type-options'], 'nosniff');

    for (const [label, query] of [
        ['โทเคนผิด', 'event=box1~evt-000001&t=' + 'U'.repeat(43)],
        ['ไม่มีโทเคน', 'event=box1~evt-000001'],
        ['โทเคนสั้น', 'event=box1~evt-000001&t=T'],
        ['ไม่มีเหตุการณ์นี้', 'event=box1~evt-999999&t=' + 'T'.repeat(43)],
        ['path แปลกปลอม', 'event=../../roles/x&t=' + 'T'.repeat(43)]
    ]) {
        const result = await get(query);
        assert.equal(result.status, 404, label);
        assert.equal(result.body, undefined, `${label}: ต้องไม่คืนรูป`);
    }

    clock += VIEW_TTL_MS - 1;
    assert.equal((await get('event=box1~evt-000001&t=' + 'T'.repeat(43))).status, 200, 'ก่อนหมดอายุยังดูได้');
    clock += 2;
    assert.equal((await get('event=box1~evt-000001&t=' + 'T'.repeat(43))).status, 404, 'หมดอายุแล้วต้องดูไม่ได้');
});

// ครูเปิดรูปจากหน้าประวัติหลังบ้านได้โดยไม่ต้องมีลิงก์จาก LINE
// อายุ 15 นาทีเป็นของโทเคนที่ลอยอยู่ในแชต ไม่ใช่ของครูที่ล็อกอินอยู่ — ครูต้องย้อนดูได้ตลอด 7 วัน
test('staff open the photo from the history page without a token, and only staff can', async () => {
    const { db } = store();
    const clock = Date.now();
    let asked = null;
    const staffOnly = async (req, options) => { asked = options; return { role: 'teacher' }; };
    const make = authorizeRequest => createPhotoHandler({ services: () => ({ db }), env: ENV, now: () => clock + VIEW_TTL_MS * 10, makeToken: () => 'T'.repeat(43), authorizeRequest });

    await invoke(createPhotoHandler({ services: () => ({ db }), env: ENV, now: () => clock, makeToken: () => 'T'.repeat(43) }), signed(JPEG, clock));

    const asStaff = await invoke(make(staffOnly), { method: 'GET', url: '/api/photo?event=box1~evt-000001' });
    assert.equal(asStaff.status, 200, 'ครูเปิดได้แม้โทเคนของ LINE หมดอายุไปนานแล้ว');
    assert.equal(asStaff.headers['content-type'], 'image/jpeg');
    assert.match(asStaff.headers['cache-control'], /no-store/);
    assert.deepEqual(asked, { staffOnly: true }, 'ต้องขอสิทธิ์ระดับครู ไม่ใช่แค่บัญชีโรงเรียน');

    const rejected = async () => { throw new Error('not staff'); };
    const asStudent = await invoke(make(rejected), { method: 'GET', url: '/api/photo?event=box1~evt-000001' });
    assert.equal(asStudent.status, 404, 'คนที่ไม่ใช่ครูต้องไม่ได้รูป และไม่รู้ว่าเพราะสิทธิ์หรือเพราะไม่มีรูป');
    assert.equal(asStudent.body, undefined);

    // ไม่มีรูปจริงๆ ก็ตอบ 404 เหมือนกัน แม้ผู้ขอจะเป็นครู
    assert.equal((await invoke(make(staffOnly), { method: 'GET', url: '/api/photo?event=box1~evt-999999' })).status, 404);
});

test('the LINE card shows the photo, and says plainly that this person had no card', async () => {
    const event = { kind: 'sos', cabinetId: 'box1', ts: '2026-09-14T11:05:00.000Z', clockTrust: 'ntp', buzzerAck: null };
    const url = 'https://smart-first-aid-box.vercel.app/api/photo?event=box1~evt-000001&t=TTT';
    const withPhoto = sosBubble(event, { photoUrl: url });
    assert.equal(withPhoto.hero.url, url);
    assert.equal(withPhoto.hero.type, 'image');
    assert.match(JSON.stringify(withPhoto.body), /ใช้ตู้โดยไม่มีบัตร/);

    assert.equal(sosBubble(event, {}).hero, undefined, 'ไม่มีรูปก็ต้องไม่มีช่องรูปว่างๆ');
    // ค่าแปลกปลอมต้องไม่กลายเป็น url ในการ์ดที่ส่งออกไป
    for (const bad of ['javascript:alert(1)', 'http://insecure.test/a.jpg', 'https://x', ' ', null])
        assert.equal(sosBubble(event, { photoUrl: bad }).hero, undefined, String(bad));
});

test('the photo link is built only when a photo actually exists', async () => {
    const origin = 'https://smart-first-aid-box.vercel.app';
    const event = { id: 'evt-000001', cabinetId: 'box1' };
    const present = { doc: () => ({ get: async () => ({ exists: true, data: () => ({ viewToken: 'TOK' }) }) }) };
    assert.equal(await resolvePhoto(present, event, origin),
        `${origin}/api/photo?event=box1~evt-000001&t=TOK`);
    const absent = { doc: () => ({ get: async () => ({ exists: false }) }) };
    assert.equal(await resolvePhoto(absent, event, origin), null);
    assert.equal(await resolvePhoto(present, event, ''), null, 'ไม่รู้โดเมนก็อย่าสร้างลิงก์เสีย');
    const broken = { doc: () => ({ get: async () => { throw new Error('firestore down'); } }) };
    assert.equal(await resolvePhoto(broken, event, origin), null, 'ฐานข้อมูลล่มต้องไม่ทำให้ LINE ไม่ถูกส่ง');
});

// การถ่ายรูปจะยับยั้งคนกดเล่นได้ ก็ต่อเมื่อเอามือบังเลนส์แล้วไม่ผ่าน
const frame = (fill, size = 40) => {
    const pixels = new Uint8ClampedArray(size * size * 4);
    for (let i = 0; i < size * size; i++) {
        const [r, g, b] = fill(i % size, Math.floor(i / size));
        pixels.set([r, g, b, 255], i * 4);
    }
    return { pixels, size };
};

test('covering the lens or aiming at the ceiling does not count as showing your face', () => {
    const dark = frame(() => [3, 3, 3]);
    assert.equal(inspectFrame(dark.pixels, dark.size, dark.size).reason, 'too_dark');

    const wall = frame(() => [200, 200, 200]);
    assert.equal(inspectFrame(wall.pixels, wall.size, wall.size).ok, false, 'ผนังเรียบๆ ต้องไม่ผ่าน');

    const glare = frame(() => [252, 252, 252]);
    assert.equal(inspectFrame(glare.pixels, glare.size, glare.size).reason, 'too_bright');

    assert.equal(inspectFrame(null, 40, 40).reason, 'no_image');
    assert.equal(inspectFrame(new Uint8ClampedArray(4), 40, 40).reason, 'no_image');
});

test('a real face-shaped frame passes, and every rejection tells the child what to do', () => {
    // ใบหน้าโทนผิวกลางเฟรม บนพื้นหลังเข้ม — รูปแบบเดียวกับคนยืนหน้าตู้
    const size = 40, centre = size / 2;
    const face = frame((x, y) => {
        const dx = x - centre, dy = y - centre;
        return Math.hypot(dx, dy) < size * 0.3 ? [190, 130, 100] : [30, 34, 40];
    }, size);
    const result = inspectFrame(face.pixels, size, size);
    assert.equal(result.ok, true, `ควรผ่าน แต่ได้ ${result.reason} (coverage=${result.coverage})`);
    assert.ok(result.coverage >= FACE_MIN_COVERAGE);

    for (const sample of [frame(() => [3, 3, 3]), frame(() => [200, 200, 200]), frame(() => [252, 252, 252])]) {
        const rejected = inspectFrame(sample.pixels, sample.size, sample.size);
        assert.equal(rejected.ok, false);
        assert.ok(rejected.message.length > 8, 'ต้องบอกเด็กว่าให้ทำอะไรต่อ ไม่ใช่แค่ปฏิเสธ');
        assert.doesNotMatch(rejected.message, /[A-Za-z]/, 'จอตู้ห้ามมีภาษาอังกฤษ');
    }
});
