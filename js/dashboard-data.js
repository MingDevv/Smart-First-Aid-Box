(() => {
    let rows = [], nextCursor = null, revision = 0, busy = false, kind = 'dispense';
    const byId = id => document.getElementById(id);
    const text = (id, value) => { const node = byId(id); if (node) node.textContent = value; };
    const stamp = value => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' }) : 'ยังไม่มีข้อมูลเวลา';
    const day = value => new Date(value).toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
    function node(tag, value) { const item = document.createElement(tag); if (value !== undefined) item.textContent = value; return item; }
    const woundName = value => ({ cut_abrasion: 'แผลมีดบาด / ถลอก', insect: 'แมลงสัตว์กัดต่อย' })[value] || 'ไม่ระบุประเภทแผล';
    const resultName = record => record.kind === 'sos'
        ? record.buzzerAck === true ? 'ตู้ตอบรับให้เปิดเสียงเรียกครู' : record.buzzerAck === false ? 'ตู้ไม่ตอบรับการเปิดเสียง' : 'ยังไม่ทราบผลการเปิดเสียง'
        : ({ confirmed: 'ตู้ตอบรับแล้ว', uncertain: 'ยังไม่ทราบผล · กรุณาตรวจตู้', rejected: 'ตู้ไม่รับคำสั่ง', resolved_by_operator: 'ผู้ดูแลตรวจสอบและปิดรายการแล้ว' })[record.ack] || 'ยังไม่ทราบผล';
    const lineName = value => ({ delivered: 'ส่งเข้า LINE แล้ว', pending: 'รอส่งข้อความ', skipped: 'รายการย้อนหลัง · ไม่ส่งแจ้งเตือน', manual_review: 'ส่งไม่แน่ชัด · ครูควรตรวจ LINE' })[value] || 'ยังไม่ทราบสถานะข้อความ';
    // บอกทั้งชื่อและ **ที่มาของชื่อ** — บัตรพิสูจน์แค่ว่ามีคนถือบัตรใบนั้น ส่วนบัญชีโรงเรียน
    // ผ่านการยืนยันโทเคนฝั่งเซิร์ฟเวอร์ · ครูต้องแยกสองอย่างนี้ออกจากกันได้
    const personName = record => record.accountName ? `${record.accountName} · บัญชีโรงเรียน`
        : record.verifiedBy === 'school_account' ? 'สั่งจากเว็บด้วยบัญชีโรงเรียน (ยังดึงชื่อไม่ได้)'
        : record.studentId ? 'บัตรนักเรียนเลขที่ ' + record.studentId
        : record.verifiedBy === 'cabinet_photo' ? 'ไม่มีบัตร · มีรูปใบหน้า'
        : 'ไม่ได้ระบุนักเรียน';

    // รูปโหลดเมื่อครูกดเท่านั้น ไม่ใช่โหลดมาพร้อมตาราง — หน้าเด็กไม่ควรถูกดึงมาไว้ล่วงหน้า
    // ทั้งหน้า และ `<img src>` แนบ Authorization ไม่ได้ ⇒ ต้องดึงเป็น blob ด้วย authorizedFetch
    function photoControl(record) {
        const wrap = node('div');
        wrap.className = 'history-photo';
        const button = node('button', 'ดูรูปใบหน้า');
        button.type = 'button';
        let url = null;
        button.onclick = async () => {
            if (url) { URL.revokeObjectURL(url); url = null; wrap.querySelector('img')?.remove(); button.textContent = 'ดูรูปใบหน้า'; return; }
            button.disabled = true;
            try {
                const response = await AuthService.authorizedFetch(`/api/photo?event=${encodeURIComponent(record.eventId)}`,
                    { signal: AbortSignal.timeout(15000) });
                // 404 ครอบทั้ง "ไม่มีสิทธิ์" และ "รูปถูกลบตามกำหนดแล้ว" โดยตั้งใจ ⇒ บอกครูตามที่รู้จริง
                if (!response.ok) throw new Error('not_available');
                url = URL.createObjectURL(await response.blob());
                const image = node('img');
                image.src = url;
                image.alt = `ภาพใบหน้าของผู้ใช้ตู้ รายการ ${record.eventId}`;
                wrap.append(image);
                button.textContent = 'ซ่อนรูป';
            } catch {
                wrap.append(node('p', 'ดูรูปไม่ได้ — อาจถูกลบตามกำหนด 7 วันแล้ว'));
                button.remove();
            } finally { button.disabled = false; }
        };
        wrap.append(button);
        return wrap;
    }
    function renderHistory(target, records) {
        if (!target) return;
        target.replaceChildren();
        if (!records.length) { target.append(node('p', 'ยังไม่มีรายการใช้งานที่ส่งมาจากตู้')); return; }
        const recent = target.id === 'recent-timeline';
        if (recent) {
            const list = node('ol'); list.className = 'recent-activity';
            for (const record of records) {
                const item = node('li');
                item.append(node('strong', record.kind === 'sos' ? 'เรียกครูฉุกเฉิน' : woundName(record.woundType)));
                item.append(node('p', resultName(record)));
                item.append(node('p', `${stamp(record.ts)}${record.clockTrust === 'untrusted' ? ' · เวลาตู้ยังไม่ได้ตรวจสอบ' : ''}`));
                item.append(node('p', `${record.studentId ? 'บัตรนักเรียนเลขที่ ' + record.studentId : 'ไม่ได้ระบุนักเรียน'} · ${lineName(record.lineStatus)}`));
                list.append(item);
            }
            target.append(list, node('p', 'ตู้ตอบรับคำสั่งแล้ว ยังไม่ได้ยืนยันว่านักเรียนรับของแล้ว'));
            return;
        }
        const table = node('table'); table.className = 'db-table';
        const caption = node('caption', (kind === 'sos' ? 'สถานะเสียงเรียกครูและข้อความ LINE แสดงแยกกัน การส่งข้อความไม่ได้ยืนยันว่าครูอ่านแล้ว' : 'ตู้ตอบรับคำสั่งแล้ว ยังไม่ได้ยืนยันว่านักเรียนรับของแล้ว') + ' · เรียงตามรายการที่ส่งเข้าระบบล่าสุด');
        const head = node('thead'), header = node('tr');
        for (const title of ['วันและเวลา (ไทย)', 'ตู้ / ช่อง', 'ผลการทำงาน', 'นักเรียน / การใช้งาน', 'แจ้งครูทาง LINE']) {
            const th = node('th', title); th.scope = 'col'; header.append(th);
        }
        head.append(header); table.append(caption, head);
        const body = node('tbody');
        for (const record of records) {
            const tr = node('tr');
            const identity = `${personName(record)} · ${record.kind === 'sos' ? 'เรียกครูฉุกเฉิน' : woundName(record.woundType)}`;
            for (const value of [stamp(record.ts) + (record.clockTrust === 'untrusted' ? ' (เวลาตู้ยังไม่ได้ตรวจสอบ)' : ''),
                `ตู้ ${record.cabinetId} / ${record.drawer ? 'ช่อง ' + record.drawer : 'เรียกครู'}`, resultName(record), identity,
                lineName(record.lineStatus)]) tr.append(node('td', value));
            // รอบที่ไม่มีบัตรมีรูปใบหน้าเป็นหลักฐานเดียวว่าใครมาใช้ ⇒ ครูต้องเปิดดูได้จากรายการนั้นเลย
            // ผูกกับแถว ไม่ทำหน้ารวมรูป — นี่คือหน้าเด็ก ไม่ควรมีที่ให้ไล่ดูเรียงกันทั้งหมด
            if (record.verifiedBy === 'cabinet_photo') tr.lastChild.append(photoControl(record));
            body.append(tr);
        }
        table.append(body); target.append(table);
    }
    function renderInventory(target, inventory) {
        if (!target) return;
        target.replaceChildren();
        if (!inventory?.length) { target.append(node('p', 'ยังไม่มีจำนวนเวชภัณฑ์ กรุณาตรวจนับของที่ตู้')); return; }
        for (const stock of inventory) {
            target.append(node('h3', 'ตู้ ' + stock.cabinetId));
            for (const drawer of ['drawer1', 'drawer2']) target.append(node('p',
                `${drawer === 'drawer1' ? 'ช่อง 1' : 'ช่อง 2'}: ${stock.counts[drawer] ?? 'ยังไม่ได้ตรวจนับ'} · เกณฑ์ขั้นต่ำ ${stock.targets[drawer] ?? 'ยังไม่กำหนด'}`));
            target.append(node('p', `ตรวจนับล่าสุด: ${stamp(stock.lastCountAt)}`));
        }
        target.append(node('p', 'จำนวนนี้มาจากการตรวจนับของจริง การตอบรับคำสั่งของตู้ไม่ได้บอกจำนวนของที่เหลือ'));
    }
    function render(data) {
        renderHistory(byId('history-table'), rows);
        renderHistory(byId('recent-timeline'), rows.slice(0, 5));
        renderInventory(byId('inventory-data'), data.inventory);
        renderInventory(byId('inventory-preview'), data.inventory);
        const today = day(new Date());
        const dispenses = rows.filter(row => row.kind === 'dispense');
        const confirmed = dispenses.filter(row => row.ack === 'confirmed');
        text('stat-cases-today', confirmed.filter(row => day(row.ts) === today).length);
        text('stat-ai-scans', dispenses.filter(row => row.uncertain).length);
        text('stat-total-items', rows.length);
        const counts = data.inventory?.flatMap(stock => ['drawer1', 'drawer2'].map(drawer => ({ count: stock.counts[drawer], target: stock.targets[drawer] }))) || [];
        const counted = counts.filter(stock => Number.isFinite(stock.count) && Number.isFinite(stock.target));
        text('stat-low-stock', counted.length ? counted.filter(stock => stock.count < stock.target).length : '—');
        text('stat-stock-note', !counted.length ? 'ยังไม่มีผลตรวจนับและเกณฑ์ขั้นต่ำ' : counted.length < counts.length ? 'บางช่องยังไม่มีผลตรวจนับหรือเกณฑ์ขั้นต่ำ' : 'จากจำนวนที่ครูตรวจนับ');
        text('stats-summary', kind === 'sos' ? `เรียกครูฉุกเฉิน ${rows.length} ครั้ง · ตู้ตอบรับให้เปิดเสียง ${rows.filter(row => row.buzzerAck === true).length} ครั้ง` : `เบิกเวชภัณฑ์ ${rows.length} รายการ · ตู้ตอบรับแล้ว ${confirmed.length} รายการ · ต้องตรวจสอบผล ${dispenses.filter(row => row.uncertain).length} รายการ`);
        text('dashboard-summary', `ประวัติการใช้งานตู้ · อัปเดต ${stamp(data.fetchedAt)}`);
        text('data-status', `แสดง${kind === 'sos' ? 'การเรียกครูฉุกเฉิน' : 'การเบิกเวชภัณฑ์'} ${rows.length} รายการที่ส่งเข้าระบบล่าสุด${nextCursor ? ' · ยังมีรายการก่อนหน้า' : ''} ตัวเลขสรุปนับเฉพาะรายการที่โหลดแล้ว เวลาอ้างอิงจากนาฬิกาตู้`);
        const cabinet = data.cabinets[0];
        text('cabinet-status-text', cabinet?.lastSeen && Date.now() - Date.parse(cabinet.lastSeen) < 120000 ? 'ตู้ส่งข้อมูลล่าสุดแล้ว' : 'ยังไม่มีข้อมูลใหม่จากตู้');
        text('cabinet-last-update', `ส่งข้อมูลล่าสุด: ${stamp(cabinet?.lastSeen)}`);
        const holds = data.cabinets.filter(item => item.status?.unresolved);
        text('clearing-state', holds.length ? holds.map(item => `ตู้ ${item.cabinetId}: ช่อง ${item.status.unresolved.drawer} มีรายการค้าง กรุณาตรวจสอบที่ตู้`).join(' ') :
            'ข้อมูลล่าสุดไม่พบรายการค้าง กรุณาตรวจความพร้อมของตู้ก่อนใช้งาน');
        text('alerts-panel', rows.some(row => row.lineStatus === 'manual_review') ? 'บางรายการยังยืนยันการส่ง LINE ไม่ได้ กรุณาตรวจข้อความในกลุ่ม ระบบจะไม่ส่งซ้ำให้อัตโนมัติ' : '');
        const more = byId('history-more'); if (more) more.hidden = !nextCursor;
    }
    function clear() {
        rows = []; nextCursor = null;
        for (const id of ['history-table', 'recent-timeline', 'inventory-data', 'inventory-preview']) byId(id)?.replaceChildren();
        for (const id of ['stat-cases-today', 'stat-ai-scans', 'stat-total-items', 'stat-low-stock']) text(id, '—');
        for (const id of ['stat-stock-note', 'stats-summary', 'clearing-state', 'alerts-panel', 'dashboard-summary', 'cabinet-status-text', 'cabinet-last-update']) text(id, '');
        if (byId('history-more')) byId('history-more').hidden = true;
    }
    async function load(append = false) {
        if (busy || !window.AuthService?.isStaff()) return;
        const turn = revision;
        busy = true;
        text('data-status', 'กำลังโหลดข้อมูลการใช้งาน…');
        for (const id of ['data-refresh', 'history-more', 'history-kind']) if (byId(id)) byId(id).disabled = true;
        try {
            const query = new URLSearchParams({ kind });
            if (append && nextCursor) query.set('cursor', nextCursor);
            const response = await AuthService.authorizedFetch('/api/history?' + query, { signal: AbortSignal.timeout(15000) });
            if (!response.ok) throw new Error('Shared data unavailable');
            const data = await response.json();
            if (turn !== revision || !AuthService.isStaff()) return;
            rows = append ? [...new Map([...rows, ...data.rows].map(row => [row.eventId, row])).values()] : data.rows;
            nextCursor = data.nextCursor;
            render(data);
        } catch {
            if (turn === revision) { clear(); text('data-status', 'โหลดข้อมูลไม่ได้ กรุณาตรวจอินเทอร์เน็ตแล้วกดอัปเดตข้อมูลอีกครั้ง'); }
        } finally {
            busy = false;
            for (const id of ['data-refresh', 'history-more', 'history-kind']) if (byId(id)) byId(id).disabled = false;
            if (turn !== revision && AuthService.isStaff()) void load();
        }
    }
    document.addEventListener('DOMContentLoaded', () => {
        byId('data-refresh')?.addEventListener('click', () => void load());
        byId('history-more')?.addEventListener('click', () => void load(true));
        byId('history-kind')?.addEventListener('change', event => { kind = event.target.value; clear(); void load(); });
        AuthService.subscribe(() => { revision++; clear(); if (AuthService.isStaff()) void load(); else text('data-status', 'เข้าสู่ระบบด้วยบัญชีครูเพื่อดูประวัติการใช้งานตู้'); });
        setInterval(() => { if (!document.hidden && !busy && rows.length <= 100) void load(); }, 60000);
    });
})();
