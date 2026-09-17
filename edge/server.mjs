import { StudentSession } from './student-session.mjs';
import { CabinetPhotos, MAX_BASE64 as PHOTO_MAX_BASE64 } from './photos.mjs';
import { createServer } from 'node:http';
import { readFile, realpath, mkdir } from 'node:fs/promises';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { homedir } from 'node:os';
import { LocalController } from './controller.mjs';
import { MicrobitSerial } from './microbit-serial.mjs';
import { startCloudBridge } from './mqtt-cloud.mjs';
import { startCabinetSync } from './sync.mjs';
import { createLocalNotify } from './notify.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.webp': 'image/webp',
    '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
    '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf' };

function json(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
}

async function readJson(req, limit) {
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
        size += chunk.length;
        if (size > limit) throw Object.assign(new Error('Request too large'), { status: 413 });
        chunks.push(chunk);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString()); }
    catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }); }
}

// การวิเคราะห์แผลด้วย AI ส่งต่อขึ้น Vercel ตู้ไม่ถือคีย์ Gemini
//
// เหตุผลที่ไม่ใส่คีย์ไว้ที่ตู้: Gemini ต้องใช้เน็ตอยู่แล้ว การเก็บคีย์ไว้บนการ์ด SD ของตู้
// ที่ตั้งอยู่กลางทางเดินโรงเรียนจึงไม่ได้ทำให้ทำงานตอนออฟไลน์ได้เพิ่มขึ้นเลยแม้แต่นิดเดียว
// แลกมาแต่ความเสี่ยงว่าการ์ดหายแล้วคีย์หลุด · ตรงกับกติกาเดิมที่ว่า Pi ไม่ถือ credential
// ตอนเน็ตล่ม ทั้งสองทางตกไปที่ทางถอยเดียวกันคือให้เลือกแผลเอง
//
// อ่าน env ตอนเรียก ไม่ใช่ตอนโหลดโมดูล เพื่อให้เทสชี้ไปที่เซิร์ฟเวอร์จำลองได้โดยไม่ต้องยุ่งกับลำดับ import
function cloudBase() {
    return (process.env.SFAB_CLOUD_BASE || 'https://smart-first-aid-box.vercel.app').replace(/\/+$/, '');
}

// งบเวลาฝั่งเบราว์เซอร์คือ 25 วิ (ANALYZE_TIMEOUT_MS ใน js/kiosk-app.js) ตัดให้ต่ำกว่าเล็กน้อย
// เพื่อให้ตู้เป็นคนตอบว่าไปไม่ถึง แทนที่จะให้เบราว์เซอร์ abort เองแล้วไม่รู้ว่าพลาดที่ช่วงไหน
const CLOUD_ANALYZE_TIMEOUT_MS = 20000;

// เขียนซ้ำจาก USER_ERROR_MSG ใน api/analyze.js โดยตั้งใจ **ห้ามเปลี่ยนเป็น import**
// เส้นทางจอสัมผัสต้องไม่พึ่ง import ที่ล้มได้ — เหตุผลเดียวกับที่หัวไฟล์นี้ไม่มี `import mqtt`
// อยู่ด้วย: ไฟล์ใน api/ เป็นของ Vercel ถ้าวันหนึ่งมันไปเรียกอะไรที่ Pi
// ไม่มี ตู้จะบูตบริการไม่ขึ้นทั้งใบ แล้วจอสัมผัสตายไปด้วยทั้งที่ไม่เกี่ยวกับ AI เลย
// กันค่าเพี้ยนด้วยเทส 'the cabinet fallback sentence matches the cloud one' แทนการ import
export const CLOUD_ANALYZE_ERROR_MSG = 'ขณะนี้ระบบ AI วิเคราะห์แผลขัดข้องชั่วคราว กรุณาลองใหม่อีกครั้ง หรือเลือกประเภทแผลด้วยตนเองด้านล่าง';

async function analyzeViaCloud(req, res) {
    try {
        const upstream = await fetch(`${cloudBase()}/api/analyze`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(req.body),
            signal: AbortSignal.timeout(CLOUD_ANALYZE_TIMEOUT_MS)
        });
        // ส่งสถานะและเนื้อของต้นทางต่อตามจริง — 429 ของ rate limit กับ 502 ของโมเดลล่ม
        // เป็นคนละเรื่องกัน หน้าตู้จึงต้องได้เห็นตัวจริง ไม่ใช่ถูกยุบเป็นความล้มเหลวก้อนเดียว
        return json(res, upstream.status, await upstream.json());
    } catch (error) {
        // เน็ตนอกล่ม Vercel ไม่ตอบ หรือตอบมาไม่ใช่ JSON — ทั้งหมดนี้หน้าตู้ทำอย่างเดียวกันคือ
        // พาไปเลือกแผลเอง จึงตอบด้วยประโยคเดียวกับที่ฝั่งคลาวด์ใช้
        console.warn('[SFAB] cloud analyze failed:', error && error.message);
        return json(res, 502, { success: false, error: CLOUD_ANALYZE_ERROR_MSG });
    }
}

// โหมดการทำงานของตู้มาจากการติดตั้ง ไม่ใช่จากเบราว์เซอร์
//
// เดิมโหมดเก็บใน localStorage ของโปรไฟล์ Chromium บนตู้ ซึ่งตั้งได้จากหน้าครูที่เดียว
// แต่หน้าตู้ไม่มีลิงก์ออกและ Ctrl+L/Ctrl+N ถูก managed policy บล็อก ⇒ ไปหน้าครูไม่ได้เลย
// โหมดจึงค้างที่ "ยังไม่ได้ตั้ง" ตลอดกาล และตู้ปฏิเสธทุกคำสั่ง — สามอย่างที่แต่ละอย่างถูก
// พอมารวมกันแล้วทำให้ตู้ใช้งานไม่ได้
//
// ค่าที่ฉีดนี้ **ชนะ localStorage เสมอ** ไม่งั้นจะมีสองแหล่งความจริงเรื่องโหมด
// ซึ่งเป็นความล้มเหลวที่ระบบสามค่านี้เกิดมาเพื่อกำจัด
//
// ทำให้ค่าที่ตั้งมาเป็นหนึ่งในสามค่าเสมอ ไม่มีทางคืนค่าว่าง
//
// เดิมค่าที่ไม่รู้จักจะไม่ฉีดอะไรเลย แล้วเบราว์เซอร์ตกกลับไปอ่าน localStorage
// ⇒ เครื่องที่เคยตั้ง Real ไว้ แล้วลบ drop-in ทิ้ง **ไม่ได้กลับเป็น unset** แต่ฟื้นคืน Real
// จาก localStorage เก่า ซึ่งตรงข้ามกับที่ sfab-set-mode.sh สัญญาไว้
// เทสที่ใช้โปรไฟล์ใหม่ทุกครั้งมองไม่เห็นเคสนี้
export function normalizeMode(raw) {
    const mode = (raw ?? '').toString().trim().toLowerCase();
    if (mode === 'demo' || mode === 'real') return mode;
    if (mode !== '') {
        console.warn(`[SFAB] SFAB_MODE="${mode}" ไม่ใช่ค่าที่รู้จัก (demo|real) — ถือว่ายังไม่ได้ตั้งโหมด ตู้จะไม่สั่งอะไร`);
    }
    return 'unset';
}

// `photos`/`sync` เป็นตัวเลือกโดยตั้งใจ — เทสจำนวนมากเรียก createLocalServer({controller, mode})
// ตรงๆ การบังคับให้ส่งเข้ามาจะทำให้เทสที่ไม่เกี่ยวกับรูปพังทั้งแถว · ไม่ส่ง = ตู้ยังใช้คิวรูป
// ของตัวเองได้ (สร้างจาก db เดียวกับสมุดคำสั่ง) แค่ไม่มีใครมาปลุกให้อัปขึ้นคลาวด์
export async function createLocalServer({ controller, root = ROOT, mode = process.env.SFAB_MODE,
    photos = new CabinetPhotos(controller.outbox.db), sync = null } = {}) {
    // ฉีดเสมอทั้งสามค่า รวม unset — การมีค่าฉีดอยู่คือสัญญาณว่า "เครื่องนี้เป็นคนกำหนด"
    // เบราว์เซอร์จึงต้องไม่ตกกลับไปอ่าน localStorage ไม่ว่าค่าจะเป็นอะไร
    const deviceMode = normalizeMode(mode);
    const provisionedMode = `window.SFAB_RUNTIME.mode = ${JSON.stringify(deviceMode)};`;
    const webRoot = await realpath(root);
    const routing = JSON.parse(await readFile(join(webRoot, 'vercel.json'), 'utf8'));
    const rewrites = new Map(routing.rewrites.map(r => [r.source, r.destination]));
    const studentSession = new StudentSession(controller.outbox, undefined, photos);
    const server = createServer(async (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('X-Frame-Options', 'DENY');
        try {
            // บริการนี้มีไว้ให้เบราว์เซอร์บน Pi เท่านั้น ผูกกับ loopback และกัน DNS rebinding
            const host = req.headers.host || '';
            const allowed = [`127.0.0.1:${server.address().port}`, `localhost:${server.address().port}`];
            if (!allowed.includes(host) || (req.headers.origin && req.headers.origin !== `http://${host}`) ||
                req.headers['sec-fetch-site'] === 'cross-site') {
                return json(res, 403, { success: false, error: 'Local kiosk origin required' });
            }
            const url = new URL(req.url, `http://${host}`);
            const pathname = decodeURIComponent(url.pathname);
            if (pathname.startsWith('/api/')) {
                if (req.method === 'GET' && pathname === '/api/local/status') {
                    return json(res, 200, await controller.status());
                }
                if (req.method === 'GET' && pathname === '/api/local/history') {
                    return json(res, 200, { commands: controller.history() });
                }
                if (pathname === '/api/local/student') {
                    if (req.method !== 'POST') return json(res, 405, { error: 'POST required' });
                    if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') return json(res, 415, { error: 'JSON required' });
                    const body = await readJson(req, 1024);
                    if (body.action === 'clear') { studentSession.clear(); return json(res, 200, { success: true }); }
                    const student = studentSession.scan(body.code);
                    return json(res, student ? 200 : 404, student || { error: 'card_not_found' });
                }
                // ไม่มีบัตร → ถ่ายรูปใบหน้าไว้ให้ครูดู แล้วเปิดรอบให้ใช้ตู้ได้
                //
                // **ทำไมต้องผ่านตู้ ไม่ให้เบราว์เซอร์ยิง `/api/photo` เอง**: ปลายทางนั้นบังคับ
                // ลายเซ็น HMAC จาก SFAB_CABINET_SECRET ซึ่งต้องไม่มีวันไปโผล่ในหน้าเว็บ
                //
                // **ทำไมตอบ 200 ทั้งที่ยังไม่ได้อัปขึ้นคลาวด์**: ตู้ต้องใช้งานได้ตอนเน็ตล่ม
                // รูปเข้าคิวบนตู้ก่อน แล้วรอบ sync เป็นคนส่งขึ้นไป · การรอผลอัปโหลดตรงนี้
                // จะทำให้เด็กที่ลืมบัตรใช้ตู้ไม่ได้เลยเมื่อเน็ตล่ม ซึ่งเป็นกรณีที่ฟีเจอร์นี้มีไว้เพื่อ
                if (pathname === '/api/local/photo') {
                    if (req.method !== 'POST') return json(res, 405, { error: 'POST required' });
                    if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') return json(res, 415, { error: 'JSON required' });
                    // เพดานต้องสูงกว่า base64 เต็มเพดานบวกกรอบ JSON ไม่งั้นรูปที่ถูกต้องโดน 413
                    const body = await readJson(req, PHOTO_MAX_BASE64 + 4096);
                    if (!photos.store(body.eventId, body.jpegBase64)) {
                        return json(res, 400, { error: 'invalid_photo' });
                    }
                    const round = studentSession.beginPhotoRound(body.eventId);
                    if (!round) return json(res, 400, { error: 'invalid_photo' });
                    // ปลุกรอบ sync ให้ลองส่งเดี๋ยวนี้ แต่ไม่รอผล — คำตอบของ 200 นี้แปลว่า
                    // "ตู้รับรูปไว้แล้วและเปิดรอบให้" ไม่ใช่ "ครูได้รับรูปแล้ว"
                    sync?.wake();
                    return json(res, 200, { sessionId: round.sessionId });
                }
                if (pathname !== '/api/command' && !['/api/analyze', '/api/notify'].includes(pathname)) {
                    return json(res, 404, { success: false, error: 'Not found' });
                }
                if (req.method !== 'POST') return json(res, 405, { success: false, error: 'POST required' });
                if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
                    return json(res, 415, { success: false, error: 'JSON required' });
                }
                req.body = await readJson(req, pathname === '/api/analyze' ? 10 * 1024 * 1024 : 16384);
                if (pathname === '/api/command') {
                    let identity = null;
                    if (req.body.action === 'open') {
                        identity = studentSession.identify(req.body.studentSession, req.body.id);
                        // ข้อความนี้ขึ้นบนจอตู้ตรงๆ ⇒ ต้องเป็นภาษาไทยเหมือนทุกคำตอบของตู้
                        // ของเดิมเป็นอังกฤษ ซึ่งเด็กหน้าตู้อ่านไม่รู้เรื่อง
                        if (!identity) return json(res, 401, { success: false, retrySafe: true, error: 'รอบนี้หมดอายุแล้ว กรุณาสแกนบัตรใหม่ หรือถ่ายรูปใบหน้าอีกครั้งเพื่อเริ่มรอบใหม่' });
                    }
                    const result = await controller.command(req.body, identity);
                    if (identity && result.status >= 400 && !result.body.uncertain) {
                        const row = controller.db.prepare('SELECT state FROM commands WHERE id = ?').get(req.body.id);
                        if (!row || row.state === 'rejected') studentSession.release(req.body.id);
                    }
                    return json(res, result.status, result.body);
                }
                if (pathname === '/api/analyze') return analyzeViaCloud(req, res);
                // SOS ที่ตู้แค่ลงสมุด ส่วนการส่งออกข้างนอกเป็นหน้าที่ของ Vercel
                res.status = code => { res.statusCode = code; return res; };
                res.json = body => { json(res, res.statusCode, body); return res; };
                return await createLocalNotify(controller.outbox)(req, res);
            }
            if (!['GET', 'HEAD'].includes(req.method)) return json(res, 405, { error: 'Method not allowed' });
            let route = rewrites.get(pathname) || pathname;
            if (route.endsWith('/')) route += 'index.html';
            if (!extname(route)) route += '.html';
            // เสิร์ฟเฉพาะไฟล์หน้าเว็บ ห้ามเปิดซอร์ส ฐานข้อมูล ไฟล์ซ่อน หรือไฟล์ตั้งค่าออกไปเด็ดขาด
            // kiosk คือแอปของจอตู้เอง แยกโฟลเดอร์เพราะไม่ได้ใช้อะไรร่วมกับหน้ามือถือหรือหน้าครูเลย
            if (!/^\/(?:index\.html|(?:student|dashboard|kiosk)\/[a-z0-9-]+\.html|(?:css|js|images|fonts)\/[a-zA-Z0-9_./-]+)$/.test(route) ||
                route.split('/').some(part => part.startsWith('.')) || !TYPES[extname(route)]) {
                return json(res, 404, { error: 'Not found' });
            }
            const path = await realpath(join(webRoot, route));
            if (!path.startsWith(webRoot + sep)) return json(res, 404, { error: 'Not found' });
            let body = await readFile(path);
            if (extname(path) === '.html') {
                body = body.toString().replace(/<head>/i,
                    `<head><script>window.SFAB_RUNTIME = { transport: "pi-local" };${provisionedMode}</script>`)
                    .replace(/<script\s+src="https:\/\/cdn\.jsdelivr\.net\/npm\/mqtt@[^\"]+"><\/script>/g, '');
            }
            res.writeHead(200, { 'Content-Type': TYPES[extname(path)] });
            res.end(req.method === 'HEAD' ? undefined : body);
        } catch (error) {
            const status = error.status || (['ENOENT', 'ENOTDIR'].includes(error.code) ? 404 : 500);
            if (!res.headersSent) json(res, status, { success: false, error: status === 500 ? 'Local service error' : 'Invalid request or missing resource' });
            else res.end();
        }
    });
    server.requestTimeout = 20000;
    server.headersTimeout = 5000;
    return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    const database = process.env.SFAB_DATABASE || join(homedir(), '.local/share/smart-first-aid-box/commands.sqlite');
    await mkdir(dirname(database), { recursive: true, mode: 0o700 });
    // โหมดเดียวกันถูกส่งให้ทั้ง controller (เกตการสั่งจริง) และหน้าเว็บ (สิ่งที่จอบอกผู้ใช้)
    // ต้องมาจากแหล่งเดียว ไม่งั้นจอกับพฤติกรรมจริงจะหลอกกันได้
    const deviceMode = normalizeMode(process.env.SFAB_MODE);
    // SFAB_SERIAL คือพอร์ตของ micro:bit ใช้ path แบบ by-id จะได้ไม่เปลี่ยนตอนเสียบใหม่
    // เปิดพอร์ตก่อนเปิดเซิร์ฟเวอร์ ตู้ที่ยังไม่ได้เสียบบอร์ดต้องล้มให้ดังๆ
    // not serve a kiosk that reports "ตู้ยังต่อไม่ได้" forever.
    const serialDevice = (process.env.SFAB_SERIAL || '').trim();
    const serial = serialDevice ? new MicrobitSerial({ device: serialDevice }) : null;
    if (serial) await serial.open();
    const controller = new LocalController({
        esp32Url: process.env.SFAB_ESP32_URL || '', serial, database, mode: deviceMode, cabinetId: process.env.SFAB_CABINET_ID || 'box1' });
    // ปุ่ม SOS ไร้สายลงสมุดเดียวกับ SOS ที่กดจากจอตู้ ⇒ ได้ retry ตอนเน็ตหลุดฟรี
    // ไม่มี symptom เพราะปุ่มที่สนามไม่มีให้เลือกอาการ
    if (serial) serial.onRemoteSos = () => controller.outbox.queueSos();
    // ลำดับนี้บังคับ: คิวรูป → ตัวส่ง → เซิร์ฟเวอร์ · เซิร์ฟเวอร์ต้องถือ `sync` ไว้เพื่อปลุกให้
    // ส่งรูปทันทีที่เด็กถ่ายเสร็จ ไม่ใช่รอรอบถัดไปอีก 60 วินาที · ทั้งสองตัวใช้ db ก้อนเดียวกับ
    // สมุดคำสั่ง จะได้ไม่มีไฟล์ที่สองให้ลืมสำรองหรือลืมลบ
    const photos = new CabinetPhotos(controller.outbox.db);
    // ถ้าตั้ง MQTT_URL ไว้ Pi จะรับคำสั่งจากทางคลาวด์ด้วย ใช้ controller ตัวเดิม ด่านเดิม
    // ถ้าไม่ตั้ง ตู้ก็ทำงานด้วยจอสัมผัสอย่างเดียวเหมือนเดิม
    const sync = startCabinetSync(process.env, controller, photos);
    const server = await createLocalServer({ controller, mode: deviceMode, photos, sync });
    const port = Number(process.env.SFAB_PORT || 8787);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid SFAB_PORT');
    server.listen(port, '127.0.0.1', () => console.log(`Pi kiosk: http://localhost:${port}/kiosk`));
    const cloud = await startCloudBridge(process.env, controller);
    // ตัวที่ทำให้ปิดเซิร์ฟเวอร์ไม่ลงคือคำสั่งที่ยังวิ่งอยู่ ไม่ใช่ socket ที่ว่างอยู่เฉยๆ
    // คำสั่งเปิดลิ้นชักหนึ่งใบใช้เวลาได้ถึง 123 วิ ถ้า TimeoutStopSec สั้นเกินไปจะโดน SIGKILL
    // กลางคัน แล้วทิ้งแถวค้างที่บล็อกตู้จนกว่าครูจะมาเคลียร์ด้วย edge/resolve.mjs
    //
    // เก็บ closeIdleConnections() ไว้ ไม่เสียหายอะไรและช่วยตัด socket ที่ว่างอยู่แล้วทิ้งเลย
    // ส่วน closeAllConnections() ตั้งใจไม่ใช้ เพราะมันจะตัดคำสั่งที่กำลังวิ่งอยู่ทิ้งไปด้วย
    const stop = () => {
        // รอให้คำสั่งที่ค้างอยู่จบก่อน ไม่งั้นลิ้นชักเปิดจริงแต่เว็บขึ้นว่าไม่สำเร็จ
        server.close(async () => { await controller.drain(); await cloud?.close(); await sync?.close(); await controller.close(); process.exit(0); });
        server.closeIdleConnections();
    };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
}
