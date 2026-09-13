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

export async function createLocalServer({ controller, root = ROOT } = {}) {
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
            if (!/^\/(?:index\.html|(?:student|dashboard)\/[a-z0-9-]+\.html|(?:css|js|images|fonts)\/[a-zA-Z0-9_./-]+)$/.test(route) ||
                route.split('/').some(part => part.startsWith('.')) || !TYPES[extname(route)]) {
                return json(res, 404, { error: 'Not found' });
            }
            const path = await realpath(join(webRoot, route));
            if (!path.startsWith(webRoot + sep)) return json(res, 404, { error: 'Not found' });
            let body = await readFile(path);
            if (extname(path) === '.html') {
                body = body.toString().replace(/<head>/i,
                    '<head><script>window.SFAB_RUNTIME = { transport: "pi-local" };</script>')
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
    server.listen(port, '127.0.0.1', () => console.log(`Pi kiosk: http://localhost:${port}/student/kiosk`));
    const stop = () => server.close(async () => { await controller.close(); process.exit(0); });
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
}
