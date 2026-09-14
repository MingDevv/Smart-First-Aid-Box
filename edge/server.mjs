import { StudentSession } from './student-session.mjs';
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

// การวิเคราะห์แผลด้วย AI ส่งต่อขึ้น Vercel ตู้ไม่ถือคีย์ Gemini (เคาะ 2026-09-14)
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
// เส้นทางจอสัมผัสต้องไม่พึ่ง import ที่ล้มได้ — เหตุผลเดียวกับที่ PR #17 ถอด `import mqtt`
// ออกจากหัวไฟล์นี้ (99291a5): ไฟล์ใน api/ เป็นของ Vercel ถ้าวันหนึ่งมันไปเรียกอะไรที่ Pi
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
// พอมารวมกันแล้วทำให้ตู้ใช้งานไม่ได้ (เจอ 2026-09-12)
//
// ค่าที่ฉีดนี้ **ชนะ localStorage เสมอ** ไม่งั้นจะมีสองแหล่งความจริงเรื่องโหมด
// ซึ่งเป็นความล้มเหลวที่ระบบสามค่านี้เกิดมาเพื่อกำจัด
//
// ทำให้ค่าที่ตั้งมาเป็นหนึ่งในสามค่าเสมอ ไม่มีทางคืนค่าว่าง
//
// เดิมค่าที่ไม่รู้จักจะไม่ฉีดอะไรเลย แล้วเบราว์เซอร์ตกกลับไปอ่าน localStorage
// ⇒ เครื่องที่เคยตั้ง Real ไว้ แล้วลบ drop-in ทิ้ง **ไม่ได้กลับเป็น unset** แต่ฟื้นคืน Real
// จาก localStorage เก่า ซึ่งตรงข้ามกับที่ sfab-set-mode.sh สัญญาไว้ (นัยวัดได้จริง R3-1)
// เทสที่ใช้โปรไฟล์ใหม่ทุกครั้งมองไม่เห็นเคสนี้
export function normalizeMode(raw) {
    const mode = (raw ?? '').toString().trim().toLowerCase();
    if (mode === 'demo' || mode === 'real') return mode;
    if (mode !== '') {
        console.warn(`[SFAB] SFAB_MODE="${mode}" ไม่ใช่ค่าที่รู้จัก (demo|real) — ถือว่ายังไม่ได้ตั้งโหมด ตู้จะไม่สั่งอะไร`);
    }
    return 'unset';
}

export async function createLocalServer({ controller, root = ROOT, mode = process.env.SFAB_MODE } = {}) {
    // ฉีดเสมอทั้งสามค่า รวม unset — การมีค่าฉีดอยู่คือสัญญาณว่า "เครื่องนี้เป็นคนกำหนด"
    // เบราว์เซอร์จึงต้องไม่ตกกลับไปอ่าน localStorage ไม่ว่าค่าจะเป็นอะไร
    const deviceMode = normalizeMode(mode);
    const provisionedMode = `window.SFAB_RUNTIME.mode = ${JSON.stringify(deviceMode)};`;
    const webRoot = await realpath(root);
    const routing = JSON.parse(await readFile(join(webRoot, 'vercel.json'), 'utf8'));
    const rewrites = new Map(routing.rewrites.map(r => [r.source, r.destination]));
    const studentSession = new StudentSession(controller.outbox);
    const server = createServer(async (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('X-Frame-Options', 'DENY');
        try {
            // This service is for Chromium ON the Pi. Keep loopback binding and reject DNS rebinding.
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
                        if (!identity) return json(res, 401, { success: false, retrySafe: true, error: 'Scan student card to start a new round' });
                    }
                    const result = await controller.command(req.body, identity);
                    if (identity && result.status >= 400 && !result.body.uncertain) {
                        const row = controller.db.prepare('SELECT state FROM commands WHERE id = ?').get(req.body.id);
                        if (!row || row.state === 'rejected') studentSession.release(req.body.id);
                    }
                    return json(res, result.status, result.body);
                }
                if (pathname === '/api/analyze') return analyzeViaCloud(req, res);
                // Local SOS is journaled; external delivery belongs to Vercel.
                res.status = code => { res.statusCode = code; return res; };
                res.json = body => { json(res, res.statusCode, body); return res; };
                return await createLocalNotify(controller.outbox)(req, res);
            }
            if (!['GET', 'HEAD'].includes(req.method)) return json(res, 405, { error: 'Method not allowed' });
            let route = rewrites.get(pathname) || pathname;
            if (route.endsWith('/')) route += 'index.html';
            if (!extname(route)) route += '.html';
            // Allow only web assets. Never expose source APIs, firmware, database, dotfiles or config.
            // `kiosk` is the cabinet's own single-page app; it needs its own directory because it
            // shares nothing with the phone/teacher pages under student/ and dashboard/.
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
    // SFAB_SERIAL = the micro:bit's CDC device, by-id path preferred (survives re-enumeration).
    // Opened before listen(): a cabinet whose board is unplugged must fail to start loudly,
    // not serve a kiosk that reports "ตู้ยังต่อไม่ได้" forever.
    const serialDevice = (process.env.SFAB_SERIAL || '').trim();
    const serial = serialDevice ? new MicrobitSerial({ device: serialDevice }) : null;
    if (serial) await serial.open();
    const controller = new LocalController({
        esp32Url: process.env.SFAB_ESP32_URL || '', serial, database, mode: deviceMode, cabinetId: process.env.SFAB_CABINET_ID || 'box1' });
    const server = await createLocalServer({ controller, mode: deviceMode });
    const port = Number(process.env.SFAB_PORT || 8787);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid SFAB_PORT');
    server.listen(port, '127.0.0.1', () => console.log(`Pi kiosk: http://localhost:${port}/kiosk`));
    // Optional: with MQTT_URL in the unit's environment the Pi also serves the cloud path
    // (Vercel → broker → here), taking the seat the ESP32 used to hold. Same controller,
    // same gates; without MQTT_URL the cabinet is touchscreen-only exactly as before.
    const sync = startCabinetSync(process.env, controller);
    const cloud = await startCloudBridge(process.env, controller);
    // An idle keep-alive socket does NOT hold close() open. Measured on this server, node
    // v26.8.2: one parked keep-alive connection held open, close() WITHOUT
    // closeIdleConnections() resolved in 0.2ms. (Control: the same probe against a socket
    // mid-request did not resolve at all inside 10s, so it can detect a stalled close.)
    // The earlier claim here — that Chromium's sockets make close() wait out TimeoutStopSec —
    // was wrong, and deploy/pi/ repeated it; both are corrected.
    //
    // What does hold close() open is an IN-FLIGHT request. A POST /api/command may legitimately
    // run to the firmware ACK budget + 3s, up to 123s (controller.mjs caps ackTimeoutMs at
    // 120000). Measured with a 3s stubbed command: 2808ms under `Connection: close` — the
    // remaining command time — and 6811ms over a keep-alive agent, because the socket goes idle
    // only AFTER the response and then waits out keepAliveTimeout (5s); closeIdleConnections()
    // fires once, here, so it cannot catch a socket that becomes idle later. TimeoutStopSec on
    // the unit is sized against that sum; too small a value SIGKILLs mid-command and leaves a
    // row the next start marks uncertain, which now blocks the cabinet until an operator clears
    // it (edge/resolve.mjs).
    //
    // Keep closeIdleConnections(): harmless (0.0ms) and it drops sockets already idle at stop
    // time instead of letting each wait out keepAliveTimeout. closeAllConnections() is
    // deliberately NOT used — it would abort in-flight commands.
    const stop = () => {
        // Drain first: a cloud command still running must get its ACK out before the
        // broker link is closed, or the website reports 504 for a drawer that did open.
        server.close(async () => { await controller.drain(); await cloud?.close(); await sync?.close(); await controller.close(); process.exit(0); });
        server.closeIdleConnections();
    };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
}
