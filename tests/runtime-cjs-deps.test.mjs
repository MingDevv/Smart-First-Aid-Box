// ห้ามมีแพ็กเกจ ESM-only อยู่ใต้ขอบ `require()` ของ dependency ที่ใช้ตอนรันจริง
//
// 2026-09-14: WP1 ขึ้น production แล้วทุก endpoint ที่ import lib/firebase-admin.js ตายพร้อมกัน
//   กันพังตอนรันจริงจาก ERR_REQUIRE_ESM ที่ jwks-rsa เรียก jose ซึ่งเป็น ES Module
// firebase-admin@14 → jwks-rsa@4.1.0 (CommonJS, `const jose = require('jose')`) → jose@6 ซึ่ง
// ประกาศ "type":"module" และไม่มีเงื่อนไข `require` ใน exports เลย
//
// ทำไมเทสเดิมไม่จับ: Node ตั้งแต่ 20.19/22.12 รองรับ require(esm) แล้ว การ require ในเครื่องจึง
// ผ่านทุกเวอร์ชันที่เรามี · แต่ Vercel ห่อ Module._load ด้วยตัวโหลดของตัวเอง (/opt/rust/nodejs.js)
// ที่ยังไม่รองรับ ⇒ **เทสที่รันของจริงในเครื่องพิสูจน์แทนไม่ได้ ต้องตรวจที่ "ประกาศ" ของแพ็กเกจ**
//
// เทสนี้จึงไม่เรียก require แต่เดินกราฟ dependency ของ runtime deps แล้วถามว่า แพ็กเกจ CommonJS
// ตัวไหนประกาศพึ่งแพ็กเกจที่ไม่มีทางเข้าแบบ CJS บ้าง · แก้ด้วย overrides ใน package.json
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const rootPkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

// หาแพ็กเกจจากดิสก์ตรงๆ ไม่ใช้ require.resolve
//
// `require.resolve('<pkg>/package.json')` ใช้ไม่ได้กับแพ็กเกจที่ไม่ประกาศ "./package.json" ไว้ใน
// exports — firebase-admin เป็นแบบนั้นพอดี · เทสรุ่นแรกจับ error นั้นแล้วคืน null เงียบๆ
// ⇒ เดินกราฟไม่ได้สักก้าวแล้ว "ผ่าน" เพราะไม่เจอ offender · เทสที่พังเงียบแย่กว่าไม่มีเทส
function findPkg(name, fromDir) {
    let dir = fromDir ?? ROOT;
    for (;;) {
        const candidate = join(dir, 'node_modules', name, 'package.json');
        if (existsSync(candidate)) {
            return { dir: dirname(candidate), json: JSON.parse(readFileSync(candidate, 'utf8')) };
        }
        const parent = dirname(dir);
        if (parent === dir) return null;   // ถึงรากแล้วไม่เจอ = ไม่ได้ติดตั้ง (optional/peer)
        dir = parent;
    }
}

// มีทางเข้าแบบ CommonJS ไหม — ดูจาก exports ก่อน เพราะ exports ชนะ main เสมอเมื่อมีทั้งคู่
function hasCjsEntry(pkg) {
    const dot = pkg.exports?.['.'] ?? pkg.exports;
    if (dot && typeof dot === 'object' && !Array.isArray(dot)) {
        const keys = Object.keys(dot);
        // ถ้าประกาศ exports แบบมีเงื่อนไข ต้องมี require/node-ตัวใดตัวหนึ่งจึงจะ require ได้
        if (keys.some(k => ['require', 'node-require'].includes(k))) return true;
        if (keys.some(k => k.startsWith('.'))) return pkg.type !== 'module';   // subpath map ล้วน
        return pkg.type !== 'module' && keys.includes('default');
    }
    if (typeof pkg.exports === 'string') return pkg.type !== 'module';
    return pkg.type !== 'module';   // ไม่มี exports = ใช้ main แบบเดิม
}

// "ประกาศเป็น dependency" ไม่เท่ากับ "require จริง" — ต้องแยกให้ออก ไม่งั้นเทสร้องผิดตัว
//
// gaxios@7 ประกาศ node-fetch@3 (ESM-only) ไว้ แต่ฝั่ง CJS ของมันเอ่ยถึง node-fetch เฉพาะใน
// คอมเมนต์ ตัวโค้ดใช้ global fetch · พิสูจน์แล้วว่า require(gaxios/cjs) โหลด node-fetch มา 0 โมดูล
// ⇒ ปลอดภัย · ต่างจาก jwks-rsa ที่ `const jose = require('jose')` อยู่บรรทัดแรกของ src/utils.js
//
// จึงมองหาสตริง require('<dep>') ในไฟล์ .js/.cjs ของพ่อ — คอมเมนต์ไม่ match เพราะไม่มีวงเล็บครบ
// และไฟล์ ESM ของพ่อก็ไม่ match เพราะมันเขียน import ไม่ใช่ require
function requiresAtRuntime(pkgDir, dep) {
    const needles = [`require('${dep}')`, `require("${dep}")`, `require(\`${dep}\`)`];
    const stack = [pkgDir];
    while (stack.length) {
        let entries;
        try { entries = readdirSync(stack.pop(), { withFileTypes: true, recursive: false }); }
        catch { continue; }
        for (const entry of entries) {
            const full = join(entry.parentPath ?? entry.path, entry.name);
            if (entry.isDirectory()) {
                if (entry.name !== 'node_modules') stack.push(full);
            } else if (['.js', '.cjs'].includes(extname(entry.name))) {
                let text;
                try { text = readFileSync(full, 'utf8'); } catch { continue; }
                if (needles.some(n => text.includes(n))) return true;
            }
        }
    }
    return false;
}

test('ไม่มีแพ็กเกจ ESM-only อยู่ใต้ขอบ require() ของ dependency ที่ใช้ตอนรันจริง', () => {
    const roots = Object.keys(rootPkg.dependencies ?? {});
    assert.ok(roots.length, 'ไม่มี runtime dependency ให้ตรวจ = เทสนี้ไม่มีความหมาย');

    const seen = new Set();
    const offenders = [];
    const queue = roots.map(name => [name, null]);

    for (const name of roots) {
        assert.ok(findPkg(name, null), `หา ${name} ใน node_modules ไม่เจอ — รัน npm install ก่อน ` +
            '(ถ้าปล่อยผ่าน เทสนี้จะ "ผ่าน" เพราะไม่ได้ตรวจอะไรเลย)');
    }

    while (queue.length) {
        const [name, fromDir] = queue.shift();
        const found = findPkg(name, fromDir);
        if (!found || seen.has(found.dir)) continue;
        seen.add(found.dir);
        const { json, dir } = found;
        for (const dep of Object.keys(json.dependencies ?? {})) {
            // `@types/*` เป็นไฟล์ .d.ts ล้วน ไม่มีโค้ดให้รัน และไม่เคยถูก require ตอนรันจริง
            // (mqtt ประกาศ @types/ws เป็น dependency ตรงๆ ซึ่งทำให้เทสรุ่นแรกร้องผิดตัว)
            if (dep.startsWith('@types/')) continue;
            const child = findPkg(dep, dir);
            if (!child) continue;
            // สนใจเฉพาะตอนที่ "พ่อเป็น CommonJS" — พ่อที่เป็น ESM ใช้ import ได้อยู่แล้ว
            if (json.type !== 'module' && !hasCjsEntry(child.json) && requiresAtRuntime(dir, dep)) {
                offenders.push(`${json.name}@${json.version} require('${dep}') -> ${child.json.name}@${child.json.version} (ESM-only)`);
            }
            queue.push([dep, dir]);
        }
    }

    // กันเทสพังเงียบซ้ำรอยเดิม: ต้องเดินได้จริงหลายสิบแพ็กเกจ ไม่ใช่ศูนย์แล้วผ่าน
    assert.ok(seen.size > 20, `เดินกราฟได้แค่ ${seen.size} แพ็กเกจ — น้อยเกินกว่าจะเป็นของจริง`);
    assert.deepEqual(offenders, [],
        'แพ็กเกจ CommonJS พึ่งแพ็กเกจ ESM-only — Node ในเครื่องยอม แต่ตัวโหลดของ Vercel ไม่ยอม ' +
        'และจะตายตอนรันบน production เท่านั้น · แก้ด้วย overrides ใน package.json:\n  ' +
        offenders.join('\n  '));
});
