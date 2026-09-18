import { createServer } from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { extname, join, resolve } from 'node:path';
// ตัวลองล็อกอินในเครื่อง ไม่ติดต่อ LINE และไม่ติดต่อ broker ของตู้
for (const key of Object.keys(process.env)) {
    if (/^(LINE_|MQTT_)/.test(key)) delete process.env[key];
}
const root = fileURLToPath(new URL('../', import.meta.url));
export async function createWebServer() {
    const routing = JSON.parse(await readFile(join(root, 'vercel.json')));
    const routes = new Map(routing.rewrites.map(r => [r.source, r.destination]));
    // เส้นทางที่ Vercel มีต้องมีที่นี่ด้วย ไม่งั้นหน้าที่เรียกมันได้ 404 ตัวเปล่าแล้วพังด้วยข้อความ JSON
    // (students/roles/photo ใช้แค่ Firebase admin ⇒ ทำงานกับ emulator ได้ · analyze ต้องใช้คีย์ Gemini จึงไม่ใส่)
    const apis = new Set(['firebase-config', 'me', 'command', 'notify', 'history', 'ingest', 'sync', 'students', 'roles', 'photo']);
    return createServer(async (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        try {
            const path = new URL(req.url, 'http://localhost').pathname;
            if (path.startsWith('/api/')) {
                const name = path.slice(5);
                if (!apis.has(name)) { res.writeHead(404).end(); return; }
                let body = '', size = 0;
                for await (const chunk of req) {
                    size += chunk.length;
                    if (size > (name === 'ingest' ? 65536 : 16384)) { res.writeHead(413).end(); return; }
                    body += chunk;
                }
                req.body = name === 'ingest' ? body : body ? JSON.parse(body) : {};
                res.status = code => { res.statusCode = code; return res; };
                res.json = data => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(data)); };
                const handler = (await import(new URL(`../api/${name}.js`, import.meta.url))).default;
                await handler(req, res);
                return;
            }
            let route = routes.get(path) || path;
            if (route.endsWith('/')) route += 'index.html';
            if (!extname(route)) route += '.html';
            if (!/^\/(?:index\.html|(?:student|dashboard|kiosk)\/[a-z0-9-]+\.html|(?:css|js|images|fonts)\/[a-zA-Z0-9_./-]+)$/.test(route) || route.split('/').some(p => p.startsWith('.'))) {
                res.writeHead(404).end(); return;
            }
            const file = await realpath(join(root, route));
            if (!file.startsWith(root)) { res.writeHead(404).end(); return; }
            const types = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.woff2':'font/woff2', '.webp':'image/webp', '.png':'image/png', '.svg':'image/svg+xml' };
            const data = await readFile(file);
            res.setHeader('Content-Type', types[extname(file)] || 'application/octet-stream');
            res.end(data);
        } catch { if (!res.headersSent) res.writeHead(500); res.end(); }
    });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    const server = await createWebServer();
    server.listen(4173, '127.0.0.1', () => console.log('Local web: http://127.0.0.1:4173'));
}
