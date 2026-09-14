import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
const source = await readFile(new URL('../js/dashboard-data.js', import.meta.url), 'utf8');
function page() {
    class Element {
        constructor(id = '') { this.id = id; this.children = []; this.listeners = {}; this.textContent = ''; }
        append(...nodes) { this.children.push(...nodes); }
        replaceChildren(...nodes) { this.children = nodes; this.textContent = ''; }
        addEventListener(type, fn) { this.listeners[type] = fn; }
        get text() { return this.textContent + this.children.map(node => node.text).join(' '); }
    }
    const ids = ['history-table','recent-timeline','inventory-data','inventory-preview','stat-cases-today','stat-ai-scans','stat-total-items','stat-low-stock','stat-stock-note','stats-summary','dashboard-summary','data-status','cabinet-status-text','cabinet-last-update','clearing-state','alerts-panel','history-more','data-refresh','history-kind'];
    const elements = Object.fromEntries(ids.map(id => [id, new Element(id)]));
    let callback, staff = true, data, failure = false;
    const requests = [];
    const AuthService = { isStaff: () => staff, subscribe: fn => { callback = fn; }, authorizedFetch: async url => { requests.push(url); return { ok: !failure, json: async () => data }; } };
    vm.runInNewContext(source, { document: { getElementById: id => elements[id], createElement: () => new Element(), addEventListener: (_, fn) => fn() }, window: { AuthService }, AuthService, URLSearchParams, AbortSignal, setInterval() {} });
    const flush = () => new Promise(resolve => setImmediate(resolve));
    return { elements, requests, async load(value) { data = value; callback(); await flush(); }, async more(value) { data = value; elements['history-more'].listeners.click(); await flush(); }, async kind(kind, value) { data = value; elements['history-kind'].listeners.change({target:{value:kind}}); await flush(); }, async fail() { failure = true; elements['data-refresh'].listeners.click(); await flush(); }, async signOut() { staff = false; callback(); await flush(); } };
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
