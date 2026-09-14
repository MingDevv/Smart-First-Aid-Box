(() => {
    document.addEventListener('DOMContentLoaded', () => {
        const rows = document.getElementById('history-rows'), empty = document.getElementById('empty-state'), table = document.getElementById('table-container');
        const more = document.createElement('button'); more.type = 'button'; more.textContent = 'โหลดประวัติเพิ่ม'; table.after(more);
        let revision = 0, cursor = null, count = 0, busy = false;
        function clear() { rows.replaceChildren(); table.style.display = 'none'; more.hidden = true; empty.style.display = 'block'; count = 0; cursor = null; for (const id of ['history-total','history-ai-total','history-latest']) document.getElementById(id).textContent = '—'; }
        async function load(append = false) {
            if (busy) return; busy = true; more.disabled = true; const generation = revision;
            try {
                const res = await AuthService.authorizedFetch('/api/students?action=me' + (append && cursor ? '&cursor=' + encodeURIComponent(cursor) : ''), { signal: AbortSignal.timeout(15000) });
                const data = await res.json(); if (generation !== revision) return;
                if (!res.ok) throw new Error(res.status === 404 ? 'ยังไม่ได้เชื่อมบัญชีนี้กับทะเบียนนักเรียน กรุณาติดต่อครู' : 'โหลดประวัติไม่ได้ กรุณาลองใหม่');
                for (const value of data.history.rows) {
                    const tr = document.createElement('tr');
                    for (const text of [new Date(value.ts).toLocaleString('th-TH'), 'ช่อง ' + value.drawer, value.clockTrust === 'untrusted' ? 'เวลาตู้ยังไม่ยืนยัน' : 'เวลาจากตู้', value.ack]) { const td=document.createElement('td');td.textContent=text;tr.append(td); }
                    rows.append(tr); count++;
                }
                table.style.display = count ? '' : 'none'; empty.style.display = count ? 'none' : 'block'; empty.textContent = 'ยังไม่มีประวัติจากตู้สำหรับ ' + data.student.givenName;
                document.getElementById('history-total').textContent = count; cursor=data.history.nextCursor;more.hidden=!cursor;more.textContent='โหลดประวัติเพิ่ม';
            } catch (error) { if(generation===revision){clear();empty.textContent=error.message;more.hidden=false;more.textContent='ลองใหม่';} }
            finally { busy=false;more.disabled=false;if(generation!==revision&&AuthService.state?.user)void load(); }
        }
        more.onclick=()=>void load(!!cursor);
        AuthService.subscribe(state=>{revision++;clear();empty.textContent='เข้าสู่ระบบเพื่อดูประวัติของคุณ';if(state.user)void load();});
    });
})();
