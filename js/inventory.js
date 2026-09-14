// JS/INVENTORY.JS — ฟอร์มตรวจนับเวชภัณฑ์ในหน้าคลัง
//
// แยกไฟล์จาก js/dashboard-data.js โดยตั้งใจ: ไฟล์นั้นเป็นฝั่ง "แสดงผล" ที่นัยดูแล
// ไฟล์นี้เป็นฝั่ง "กรอกเข้าไป" ซึ่งเพิ่งมีครั้งแรก ⇒ แยกไว้ไม่ต้องแย่งกันแก้
//
// ตู้จ่ายทีละชุด ไม่ได้จ่ายทีละชิ้น หน่วยที่ครูนับจึงเป็นจำนวนชุด (Bank 2026-09-14)
(() => {
    const $ = id => document.getElementById(id);
    const DRAWER_TH = { drawer1: 'ช่อง 1', drawer2: 'ช่อง 2' };
    let current = null, busy = false;

    const say = (text, tone = 'info') => {
        const node = $('inv-status');
        if (!node) return;
        node.textContent = text;
        node.dataset.tone = tone;
    };

    function itemRow(item = { name: '', qty: 1, unit: 'ชิ้น' }) {
        const row = document.createElement('div');
        row.className = 'inv-item-row';
        const name = document.createElement('input');
        name.type = 'text'; name.placeholder = 'เช่น น้ำเกลือ'; name.maxLength = 60;
        name.value = item.name || ''; name.dataset.field = 'name';
        name.setAttribute('aria-label', 'ชื่อของในชุด');
        const qty = document.createElement('input');
        qty.type = 'number'; qty.min = '1'; qty.max = '99'; qty.inputMode = 'numeric';
        qty.value = Number.isInteger(item.qty) ? item.qty : 1; qty.dataset.field = 'qty';
        qty.setAttribute('aria-label', 'จำนวนต่อชุด');
        const unit = document.createElement('input');
        unit.type = 'text'; unit.placeholder = 'ชิ้น'; unit.maxLength = 20;
        unit.value = item.unit || ''; unit.dataset.field = 'unit';
        unit.setAttribute('aria-label', 'หน่วย');
        const remove = document.createElement('button');
        remove.type = 'button'; remove.className = 'dashboard-action'; remove.textContent = 'ลบ';
        remove.onclick = () => row.remove();
        row.append(name, qty, unit, remove);
        return row;
    }

    const readItems = () => [...document.querySelectorAll('#inv-item-rows .inv-item-row')]
        .map(row => {
            const get = field => row.querySelector(`[data-field="${field}"]`).value.trim();
            return { name: get('name'), qty: Number(get('qty')) || 1, unit: get('unit') };
        })
        // แถวที่ยังไม่ได้พิมพ์ชื่อคือแถวเปล่าที่ครูเพิ่งกดเพิ่ม ไม่ใช่ความผิดพลาด — ข้ามไปเงียบๆ
        .filter(item => item.name);

    function fillForm(drawer) {
        const value = current?.drawers?.[drawer] || { kitName: '', items: [], count: null, target: null };
        $('inv-kit-name').value = value.kitName || '';
        // ค่าว่างแปลว่า "ยังไม่ได้นับ" ไม่ใช่ศูนย์ ⇒ ห้ามเติม 0 ให้เอง
        $('inv-count').value = Number.isInteger(value.count) ? value.count : '';
        $('inv-target').value = Number.isInteger(value.target) ? value.target : '';
        const rows = $('inv-item-rows');
        rows.replaceChildren(...(value.items?.length ? value.items.map(itemRow) : [itemRow()]));
    }

    function renderSummary() {
        const target = $('inventory-data');
        if (!target || !current) return;
        target.replaceChildren();
        for (const drawer of ['drawer1', 'drawer2']) {
            const value = current.drawers[drawer];
            const box = document.createElement('div');
            box.className = 'inv-summary';
            const head = document.createElement('h4');
            head.textContent = `${DRAWER_TH[drawer]}${value.kitName ? ' · ' + value.kitName : ''}`;
            const count = document.createElement('p');
            const low = Array.isArray(current.low) && current.low.includes(drawer);
            count.textContent = !Number.isInteger(value.count) ? 'ยังไม่ได้ตรวจนับ'
                : `เหลือ ${value.count} ชุด${Number.isInteger(value.target) ? ` · เกณฑ์ขั้นต่ำ ${value.target} ชุด` : ' · ยังไม่กำหนดเกณฑ์'}`;
            if (low) { count.dataset.tone = 'danger'; count.textContent += ' · ต่ำกว่าเกณฑ์แล้ว'; }
            box.append(head, count);
            if (value.items.length) {
                const list = document.createElement('ul');
                for (const item of value.items) {
                    const li = document.createElement('li');
                    li.textContent = `${item.name} ${item.qty} ${item.unit}`;
                    list.append(li);
                }
                box.append(list);
            } else {
                box.append(Object.assign(document.createElement('p'), { textContent: 'ยังไม่ได้ระบุว่าในชุดมีอะไร' }));
            }
            target.append(box);
        }
        const when = document.createElement('p');
        when.className = 'inv-help';
        when.textContent = current.countedAt
            ? `ตรวจนับล่าสุด ${new Date(current.countedAt).toLocaleString('th-TH')}${current.countedBy ? ' โดย ' + current.countedBy : ''}`
            : 'ยังไม่เคยมีการตรวจนับ';
        target.append(when, Object.assign(document.createElement('p'), { className: 'inv-help',
            textContent: 'จำนวนนี้มาจากการนับของจริงเท่านั้น การที่ตู้ตอบรับคำสั่งไม่ได้ลดจำนวนในนี้' }));
    }

    async function load() {
        const response = await AuthService.authorizedFetch('/api/history?resource=inventory', { signal: AbortSignal.timeout(15000) });
        if (!response.ok) throw new Error(response.status === 403 ? 'ต้องเป็นครูหรือผู้ดูแลระบบจึงจะดูคลังได้' : 'โหลดข้อมูลคลังไม่สำเร็จ');
        current = await response.json();
        fillForm($('inv-drawer').value);
        renderSummary();
    }

    async function save(event) {
        event.preventDefault();
        if (busy) return;
        busy = true;
        $('inv-save').disabled = true;
        say('กำลังบันทึก…');
        try {
            const drawer = $('inv-drawer').value;
            const body = { [drawer]: {
                kitName: $('inv-kit-name').value.trim(),
                items: readItems(),
                count: $('inv-count').value === '' ? null : Number($('inv-count').value),
                target: $('inv-target').value === '' ? null : Number($('inv-target').value)
            } };
            const response = await AuthService.authorizedFetch('/api/history?resource=inventory', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body), signal: AbortSignal.timeout(15000)
            });
            const result = await response.json().catch(() => ({}));
            if (!response.ok) {
                // บอกให้ตรงว่าอะไรผิด ไม่ใช่ "บันทึกไม่สำเร็จ" ลอยๆ ครูจะได้แก้ถูกช่อง
                const reason = { invalid_text: 'ชื่อชุดหรือชื่อของในชุดว่างหรือยาวเกินไป',
                    invalid_number: 'จำนวนต้องเป็นเลขจำนวนเต็ม 0 ถึง 999',
                    duplicate_item: 'มีชื่อของซ้ำกันในชุดเดียวกัน',
                    too_many_items: 'ใส่ของในชุดได้ไม่เกิน 12 รายการ',
                    staff_role_required: 'ต้องเป็นครูหรือผู้ดูแลระบบจึงจะบันทึกได้'
                }[result.error] || 'บันทึกไม่สำเร็จ กรุณาลองใหม่';
                throw new Error(reason);
            }
            current = result;
            renderSummary();
            say(`บันทึก${DRAWER_TH[drawer]}เรียบร้อย`, 'success');
        } catch (error) {
            say(error.message, 'danger');
        } finally {
            busy = false;
            $('inv-save').disabled = false;
        }
    }

    document.addEventListener('DOMContentLoaded', () => {
        if (!$('inventory-form')) return;
        $('inv-add-item').onclick = () => $('inv-item-rows').append(itemRow());
        $('inv-drawer').onchange = () => { fillForm($('inv-drawer').value); say(''); };
        $('inventory-form').onsubmit = save;
        $('inv-item-rows').replaceChildren(itemRow());
        // หน้าโหลดเสร็จก่อนรู้ว่าใครล็อกอิน ⇒ รอสถานะจาก AuthService แล้วค่อยยิง
        AuthService.subscribe(state => {
            if (state.status !== 'ready' || !AuthService.isStaff()) {
                say('เข้าสู่ระบบด้วยบัญชีครูเพื่อตรวจนับคลัง');
                return;
            }
            load().catch(error => say(error.message, 'danger'));
        });
    });
})();
