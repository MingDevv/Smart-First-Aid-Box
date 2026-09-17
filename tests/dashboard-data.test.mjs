import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
const source = await readFile(new URL('../js/dashboard-data.js', import.meta.url), 'utf8');
function page() {
    class Element {
        constructor(id = '') { this.id = id; this.children = []; this.listeners = {}; this.textContent = ''; this.detached = false; }
        append(...nodes) { for (const child of nodes) child.detached = false; this.children.push(...nodes); }
        // ของที่ถูกถอดออกจาก DOM ต้องรู้ตัว — โค้ดจริงใช้ `isConnected` กันคำตอบที่มาช้า
        // ไปแปะรูปบนแถวที่ถูกวาดทับไปแล้ว
        replaceChildren(...nodes) { for (const child of this.children) child.detach(); this.children = nodes; this.textContent = ''; }
        detach() { this.detached = true; for (const child of this.children) child.detach(); }
        get isConnected() { return !this.detached; }
        querySelector(selector) { return this.children.find(child => child.tag === selector.replace(/^\w+\./, '')) || null; }
        remove() { this.detached = true; }
        addEventListener(type, fn) { this.listeners[type] = fn; }
        get text() { return this.textContent + this.children.map(node => node.text).join(' '); }
    }
    const ids = ['history-table','recent-timeline','inventory-data','inventory-preview','stat-cases-today','stat-ai-scans','stat-total-items','stat-low-stock','stat-stock-note','stats-summary','dashboard-summary','data-status','cabinet-status-text','cabinet-last-update','clearing-state','alerts-panel','history-more','data-refresh','history-kind'];
    const elements = Object.fromEntries(ids.map(id => [id, new Element(id)]));
    let callback, staff = true, data, failure = false;
    const requests = [];
    let photoDelay = null;
    const AuthService = { isStaff: () => staff, subscribe: fn => { callback = fn; }, authorizedFetch: async url => {
        requests.push(url);
        if (url.startsWith('/api/photo')) {
            if (photoDelay) await photoDelay;
            return { ok: true, blob: async () => ({ size: 10 }) };
        }
        return { ok: !failure, json: async () => data };
    } };
    // นับการสร้าง/คืน object URL ของรูปใบหน้า — blob ที่ไม่ถูก revoke ค้างอยู่กับ document
    const objectUrls = { created: 0, revoked: 0, live: new Set() };
    const URL = { createObjectURL: () => { objectUrls.created++; const value = `blob:photo-${objectUrls.created}`; objectUrls.live.add(value); return value; },
        revokeObjectURL: value => { objectUrls.revoked++; objectUrls.live.delete(value); } };
    vm.runInNewContext(source, { document: { getElementById: id => elements[id], createElement: tag => { const el = new Element(); el.tag = tag; return el; }, addEventListener: (_, fn) => fn() }, window: { AuthService }, AuthService, URL, URLSearchParams, AbortSignal, setInterval() {} });
    const flush = () => new Promise(resolve => setImmediate(resolve));
    return { elements, requests, objectUrls, holdPhoto(promise) { photoDelay = promise; }, async load(value) { data = value; callback(); await flush(); }, async more(value) { data = value; elements['history-more'].listeners.click(); await flush(); }, async kind(kind, value) { data = value; elements['history-kind'].listeners.change({target:{value:kind}}); await flush(); }, async fail() { failure = true; elements['data-refresh'].listeners.click(); await flush(); }, async signOut() { staff = false; callback(); await flush(); } };
}
const data = rows => ({ rows, inventory: null, cabinets: [], nextCursor: null, fetchedAt:'2026-09-14T12:00:00Z' });
const record = (eventId, ack, extra = {}) => ({eventId,kind:'dispense',cabinetId:'DEMO',ts:'2026-09-14T11:00:00Z',drawer:1,ack,woundType:'cut_abrasion',lineStatus:'pending',...extra});
test('teacher history explains every outcome and missing stock without exposing opaque uid values', async () => {
    const p = page();
    await p.load(data([
        record('1','confirmed',{studentId:'DEMO001',uid:'opaque-account-uid',lineStatus:'delivered'}),
        record('2','uncertain',{uncertain:true,lineStatus:'manual_review',clockTrust:'untrusted'}),
        record('3','rejected'), record('4','resolved_by_operator',{lineStatus:'skipped'})
    ]));
    const text=p.elements['history-table'].text;
    for(const word of ['ตู้ตอบรับแล้ว','ยังไม่ทราบผล','ตู้ไม่รับคำสั่ง','ผู้ดูแลตรวจสอบและปิดรายการแล้ว','บัตรนักเรียนเลขที่ DEMO001','เวลาตู้ยังไม่ได้ตรวจสอบ','ครูควรตรวจ LINE']) assert.ok(text.includes(word),word);
    assert.ok(!text.includes('opaque-account-uid'));
    // แถวเก่าที่ยังไม่มีเซนเซอร์ต้องอ่านว่า "ไม่ได้ตรวจ" ไม่ใช่ปล่อยว่างให้ครูเดาเอง
    assert.ok(text.includes('ไม่ได้ตรวจของตก'), 'dropCheck ที่หายไปต้องมีคำอธิบาย');
    assert.equal(p.elements['stat-low-stock'].textContent,'—');
    assert.match(p.elements['inventory-preview'].text,/ยังไม่มีจำนวนเวชภัณฑ์/);
    assert.match(p.elements['recent-timeline'].text,/ยังไม่ได้ยืนยันว่านักเรียนรับของแล้ว/);
    await p.signOut();
    assert.equal(p.elements['history-table'].text,'');
    assert.equal(p.elements['recent-timeline'].text,'');
});
test('pagination deduplicates records and SOS filter replaces dispense totals with separate buzzer results', async () => {
    const p=page(); const a=record('1','confirmed');
    await p.load({...data([a]),nextCursor:'older'});
    await p.more(data([a,record('2','uncertain',{uncertain:true})]));
    assert.match(p.requests.at(-1),/cursor=older/);
    assert.match(p.elements['stats-summary'].text,/เบิกเวชภัณฑ์ 2 รายการ/);
    assert.equal(p.elements['history-more'].hidden,true);
    await p.kind('sos',data([{eventId:'sos',kind:'sos',cabinetId:'DEMO',ts:a.ts,buzzerAck:false,lineStatus:'delivered'}]));
    assert.equal(p.requests.at(-1),'/api/history?kind=sos');
    assert.match(p.elements['stats-summary'].text,/เรียกครูฉุกเฉิน 1 ครั้ง · ตู้ตอบรับให้เปิดเสียง 0 ครั้ง/);
    assert.match(p.elements['history-table'].text,/ตู้ไม่ตอบรับการเปิดเสียง/);
    assert.match(p.elements['history-table'].text,/ส่งเข้า LINE แล้ว/);
    assert.doesNotMatch(p.elements['history-table'].text,/ตู้ตอบรับแล้ว/);
    await p.fail();
    assert.equal(p.elements['history-table'].text,'');
    assert.match(p.elements['data-status'].text,/โหลดข้อมูลไม่ได้/);
});

// ภาพใบหน้าเด็กที่โหลดมาแล้ว ต้องไม่ค้างอยู่ในแท็บหลังจอถูกล้าง
// `URL.createObjectURL` ผูก blob ไว้กับ document จนกว่าจะ revoke ⇒ รีเฟรช เปลี่ยนตัวกรอง
// หรือออกจากระบบ ล้วนลบ DOM ทิ้งโดยที่รูปยังอยู่ ถ้าไม่มีใครคืนให้
test('face photos are released when the table is redrawn or the teacher signs out', async () => {
    const view = page();
    const photoRow = record('evt-photo-1', 'confirmed', { verifiedBy: 'cabinet_photo' });
    await view.load(data([photoRow]));

    const table = view.elements['history-table'];
    const findButton = () => {
        const found = [];
        const walk = element => { if (element.tag === 'button') found.push(element); element.children.forEach(walk); };
        walk(table);
        return found.find(button => button.textContent === 'ดูรูปใบหน้า');
    };

    const open = findButton();
    assert.ok(open, 'แถวที่ไม่มีบัตรต้องมีปุ่มเปิดรูป');
    await open.onclick();
    assert.equal(view.objectUrls.created, 1);
    assert.equal(view.objectUrls.revoked, 0);

    // วาดตารางใหม่ = DOM เดิมถูกทิ้ง ⇒ รูปต้องถูกคืนไปพร้อมกัน ไม่ใช่ค้างไว้
    await view.load(data([photoRow]));
    assert.equal(view.objectUrls.revoked, 1, 'วาดใหม่แล้วต้องคืน object URL ของรอบก่อน');
    assert.equal(view.objectUrls.live.size, 0);

    const again = findButton();
    await again.onclick();
    assert.equal(view.objectUrls.created, 2);
    await view.signOut();
    assert.equal(view.objectUrls.live.size, 0, 'ออกจากระบบแล้วต้องไม่มีรูปเด็กค้างอยู่เลย');
});

// คำตอบที่มาถึงหลังออกจากระบบ ต้องไม่สร้างรูปขึ้นมาใหม่บนจอที่ถูกล้างไปแล้ว
test('a photo response that lands after sign-out never becomes an object URL', async () => {
    const view = page();
    let release;
    view.holdPhoto(new Promise(resolve => { release = resolve; }));
    await view.load(data([record('evt-photo-2', 'confirmed', { verifiedBy: 'cabinet_photo' })]));

    const table = view.elements['history-table'];
    const found = [];
    const walk = element => { if (element.tag === 'button') found.push(element); element.children.forEach(walk); };
    walk(table);
    const open = found.find(button => button.textContent === 'ดูรูปใบหน้า');

    const pending = open.onclick();
    await view.signOut();
    release();
    await pending;

    assert.equal(view.objectUrls.created, 0, 'ครูออกจากระบบไปแล้ว รูปที่มาช้าต้องถูกทิ้ง ไม่ใช่เอามาแสดง');
    assert.equal(view.objectUrls.live.size, 0);
});
