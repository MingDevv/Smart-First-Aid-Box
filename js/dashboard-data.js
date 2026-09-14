(() => {
    let rows = [], nextCursor = null, revision = 0, busy = false, kind = 'dispense';
    const byId = id => document.getElementById(id);
    const text = (id, value) => { const node = byId(id); if (node) node.textContent = value; };
    const stamp = value => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('en-GB', { timeZone: 'Asia/Bangkok' }) : 'Unknown';
    const day = value => new Date(value).toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
    function node(tag, value) { const item = document.createElement(tag); if (value !== undefined) item.textContent = value; return item; }
    function renderHistory(target, records) {
        if (!target) return;
        target.replaceChildren();
        if (!records.length) { target.append(node('p', 'No cabinet events have synced yet.')); return; }
        const table = node('table'); table.className = 'db-table';
        const caption = node('caption', 'Cabinet events — ACK confirms the command, not collection of supplies.');
        const head = node('thead'), header = node('tr');
        for (const title of ['Cabinet time (Bangkok)', 'Cabinet / drawer', 'Result', 'Identity / wound', 'LINE']) {
            const th = node('th', title); th.scope = 'col'; header.append(th);
        }
        head.append(header); table.append(caption, head);
        const body = node('tbody');
        for (const record of records) {
            const tr = node('tr');
            const identity = `${record.uid || 'Unidentified'} · ${record.woundType || 'SOS'}`;
            for (const value of [stamp(record.ts) + (record.clockTrust === 'untrusted' ? ' (clock unverified)' : ''),
                `${record.cabinetId} / ${record.drawer || 'SOS'}`, record.ack || 'SOS requested', identity,
                ({ delivered: 'Delivered', pending: 'Pending', skipped: 'Historical / no alert', manual_review: 'Needs staff review' })[record.lineStatus] || 'Unknown']) tr.append(node('td', value));
            body.append(tr);
        }
        table.append(body); target.append(table);
    }
    function renderInventory(target, inventory) {
        if (!target) return;
        target.replaceChildren();
        if (!inventory.length) { target.append(node('p', 'No shared stock count recorded. Ask the nurse to count the cabinet supplies.')); return; }
        for (const stock of inventory) {
            target.append(node('h3', stock.cabinetId));
            for (const drawer of ['drawer1', 'drawer2']) target.append(node('p',
                `${drawer === 'drawer1' ? 'Drawer 1' : 'Drawer 2'}: ${stock.counts[drawer] ?? 'Not counted'} · target ${stock.targets[drawer] ?? 'Not set'}`));
            target.append(node('p', `Last physical count: ${stamp(stock.lastCountAt)}`));
        }
        target.append(node('p', 'Recorded physical counts; dispensing ACKs do not measure stock remaining.'));
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
        text('stat-low-stock', data.inventory === null || !counts.length ? 'Not counted' : counts.filter(stock => stock.count !== null && stock.target !== null && stock.count < stock.target).length);
        text('stats-summary', `${rows.length} loaded ${kind === 'sos' ? 'SOS' : 'dispense'} records · ${confirmed.length} confirmed · ${dispenses.filter(row => row.uncertain).length} uncertain`);
        text('dashboard-summary', `Shared cabinet history · refreshed ${stamp(data.fetchedAt)}`);
        text('data-status', `Showing ${rows.length} most recently synced ${kind} records${nextCursor ? '; more records are available' : ''}. Statistics describe these loaded records. Cabinet dates may be unverified.`);
        const cabinet = data.cabinets[0];
        text('cabinet-status-text', cabinet?.lastSeen && Date.now() - Date.parse(cabinet.lastSeen) < 120000 ? 'Cabinet synced recently' : 'Cabinet sync not recent');
        text('cabinet-last-update', `Last sync: ${stamp(cabinet?.lastSeen)}`);
        const holds = data.cabinets.filter(item => item.status?.unresolved);
        text('clearing-state', holds.length ? holds.map(item => `${item.cabinetId}: drawer ${item.status.unresolved.drawer} is held; a teacher must inspect the cabinet.`).join(' ') :
            'No uncertain hold in the latest cabinet reports. Check the physical cabinet before use.');
        text('alerts-panel', rows.some(row => row.lineStatus === 'manual_review') ? 'Some LINE deliveries need staff review; they will not be resent automatically.' : '');
        const more = byId('history-more'); if (more) more.hidden = !nextCursor;
    }
    function clear() {
        rows = []; nextCursor = null;
        for (const id of ['history-table', 'recent-timeline', 'inventory-data', 'inventory-preview']) byId(id)?.replaceChildren();
        for (const id of ['stat-cases-today', 'stat-ai-scans', 'stat-total-items', 'stat-low-stock']) text(id, '—');
        for (const id of ['stats-summary', 'clearing-state', 'alerts-panel', 'dashboard-summary', 'cabinet-status-text', 'cabinet-last-update']) text(id, '');
        if (byId('history-more')) byId('history-more').hidden = true;
    }
    async function load(append = false) {
        if (busy || !window.AuthService?.isStaff()) return;
        const turn = revision;
        busy = true;
        text('data-status', 'Loading shared cabinet data…');
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
            if (turn === revision) { clear(); text('data-status', 'Shared data could not be loaded. Check your connection and retry.'); }
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
        AuthService.subscribe(() => { revision++; clear(); if (AuthService.isStaff()) void load(); else text('data-status', 'Sign in with a staff account to view cabinet records.'); });
        setInterval(() => { if (!document.hidden && !busy && rows.length <= 100) void load(); }, 60000);
    });
})();
