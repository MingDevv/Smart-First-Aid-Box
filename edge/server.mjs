import { createServer } from 'node:http';
import { readFile, realpath, mkdir } from 'node:fs/promises';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { homedir } from 'node:os';
import { LocalController } from './controller.mjs';

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

// โหมดการทำงานของตู้มาจากการติดตั้ง ไม่ใช่จากเบราว์เซอร์
//
// เดิมโหมดเก็บใน localStorage ของโปรไฟล์ Chromium บนตู้ ซึ่งตั้งได้จากหน้าครูที่เดียว
// แต่หน้าตู้ไม่มีลิงก์ออกและ Ctrl+L/Ctrl+N ถูก managed policy บล็อก ⇒ ไปหน้าครูไม่ได้เลย
// โหมดจึงค้างที่ "ยังไม่ได้ตั้ง" ตลอดกาล และตู้ปฏิเสธทุกคำสั่ง — สามอย่างที่แต่ละอย่างถูก
// พอมารวมกันแล้วทำให้ตู้ใช้งานไม่ได้ (เจอ 2026-09-12)
//
// ค่าที่ฉีดนี้ **ชนะ localStorage เสมอ** ไม่งั้นจะมีสองแหล่งความจริงเรื่องโหมด
// ซึ่งเป็นความล้มเหลวที่ระบบสามค่านี้เกิดมาเพื่อกำจัด
// ค่าที่ไม่รู้จักหรือไม่ได้ตั้ง = ไม่ฉีดอะไร แล้วตกกลับไปใช้ localStorage ตามเดิม (fail-closed)
function runtimeModeSnippet(raw) {
    const mode = (raw || '').trim().toLowerCase();
    if (mode !== 'demo' && mode !== 'real') return '';
    return `window.SFAB_RUNTIME.mode = ${JSON.stringify(mode)};`;
}

export async function createLocalServer({ controller, root = ROOT, mode = process.env.SFAB_MODE } = {}) {
    const provisionedMode = runtimeModeSnippet(mode);
    const webRoot = await realpath(root);
    const routing = JSON.parse(await readFile(join(webRoot, 'vercel.json'), 'utf8'));
    const rewrites = new Map(routing.rewrites.map(r => [r.source, r.destination]));
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
                if (pathname !== '/api/command' && !['/api/analyze', '/api/notify'].includes(pathname)) {
                    return json(res, 404, { success: false, error: 'Not found' });
                }
                if (req.method !== 'POST') return json(res, 405, { success: false, error: 'POST required' });
                if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
                    return json(res, 415, { success: false, error: 'JSON required' });
                }
                req.body = await readJson(req, pathname === '/api/analyze' ? 10 * 1024 * 1024 : 16384);
                if (pathname === '/api/command') {
                    const result = await controller.command(req.body);
                    return json(res, result.status, result.body);
                }
                // Reuse optional cloud AI/notification handlers, never the MQTT command handler.
                const { default: handler } = await import(new URL(`..${pathname}.js`, import.meta.url));
                res.status = code => { res.statusCode = code; return res; };
                res.json = body => { json(res, res.statusCode, body); return res; };
                return await handler(req, res);
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
    const controller = new LocalController({ esp32Url: process.env.SFAB_ESP32_URL || '', database });
    const server = await createLocalServer({ controller });
    const port = Number(process.env.SFAB_PORT || 8787);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid SFAB_PORT');
    server.listen(port, '127.0.0.1', () => console.log(`Pi kiosk: http://localhost:${port}/kiosk`));
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
        server.close(async () => { await controller.close(); process.exit(0); });
        server.closeIdleConnections();
    };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
}
