(() => {
    const $ = id => document.getElementById(id);
    const fields = ['studentId','givenName','surname','classLevel','room','drugAllergies','foodAllergies','schoolEmail'];
    let roster = [], preview = null, payload = null, revision = 0, historyId = null, cursor = null, cardId = null;
    const status = text => { $('roster-status').textContent = text; };
    function node(tag, text) { const el = document.createElement(tag); el.textContent = text; return el; }
    function download(blob, name) { const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
    async function request(query = '', body) {
        const generation = revision;
        const res = await AuthService.authorizedFetch('/api/students' + query, { ...(body ? { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) } : {}), signal:AbortSignal.timeout(20000) });
        const data = await res.json();
        if (generation !== revision || !AuthService.isStaff()) throw new Error('บัญชีเปลี่ยน กรุณาโหลดใหม่');
        if (!res.ok) throw new Error(({preview_changed:'ข้อมูลเปลี่ยนระหว่างตรวจสอบ กรุณาตรวจสอบใหม่',fix_rejected_rows:'แก้ไขรายการที่ไม่ผ่านก่อนบันทึก',invalid_csv:'ไฟล์ CSV ไม่ถูกต้อง ตรวจสอบหัวคอลัมน์และขนาดไฟล์',export_rate_limited:'ส่งออกได้หนึ่งครั้งต่อนาที',roster_limit:'ทะเบียนเกินขีดจำกัด 500 คน'})[data.error] || 'ทำรายการไม่สำเร็จ กรุณาตรวจสอบการเชื่อมต่อแล้วลองใหม่');
        return data;
    }
    const run = fn => async event => { const button = event?.currentTarget; if (button?.tagName === 'BUTTON') button.disabled = true; try { await fn(event); } catch (error) { status(error.message); } finally { if (button?.tagName === 'BUTTON') button.disabled = false; } };
    async function load() { status('กำลังโหลดทะเบียน'); const data = await request(); roster = data.students; render(); status('นักเรียน ' + roster.length + ' คน'); }
    function render() {
        const text = $('search').value.toLowerCase(); $('roster-rows').replaceChildren();
        for (const row of roster.filter(row => [row.studentId,row.givenName,row.surname,row.classLevel,row.room].join(' ').toLowerCase().includes(text))) {
            const tr = document.createElement('tr'); tr.append(node('td',row.studentId),node('td',row.givenName+' '+row.surname),node('td',row.classLevel+' / '+row.room));
            const actions = document.createElement('td');
            for (const [label, fn] of [['แก้ไข',()=>edit(row)],['ประวัติ',()=>showHistory(row)],['บัตร QR',()=>card(row.studentId)]]) { const button=node('button',label);button.type='button';button.addEventListener('click',run(fn));actions.append(button); }
            tr.append(actions);$('roster-rows').append(tr);
        }
        if (!$('roster-rows').children.length) { const tr=node('tr',''),td=node('td',roster.length?'ไม่พบรายชื่อที่ค้นหา':'ยังไม่มีนักเรียน เพิ่มรายชื่อหรือนำเข้า CSV ด้านล่าง');td.colSpan=4;tr.append(td);$('roster-rows').append(tr); }
    }
    function edit(row) { for(const key of fields) $('student-form').elements[key].value=row[key]||''; $('student-form').elements.studentId.readOnly=true; $('editor-title').textContent='แก้ไขข้อมูล '+row.givenName; $('student-form').scrollIntoView({block:'center'}); }
    function clearPreview() { preview=null;payload=null;$('import-preview').hidden=true;$('preview-rows').replaceChildren(); }
    async function showPreview(body) {
        clearPreview(); const data=await request('',{...body,action:'preview'});preview=data;payload=body;
        $('preview-summary').textContent='เพิ่ม '+data.summary.create+' · แก้ไข '+data.summary.update+' · ไม่เปลี่ยน '+data.summary.skip+' · ไม่ผ่าน '+data.summary.reject;
        const table=document.createElement('table');
        for(const item of data.rows){const tr=document.createElement('tr');tr.append(node('td',String(item.line)),node('td',({create:'เพิ่ม',update:'แก้ไข',skip:'ไม่เปลี่ยน',reject:'ไม่ผ่าน'})[item.action]),node('td',item.reason||fields.map(key=>key+': '+item.row[key]).join('\n')));table.append(tr);}
        $('preview-rows').append(table);$('confirm-import').disabled=!!data.summary.reject;$('import-preview').hidden=false;$('import-preview').scrollIntoView({block:'start'});
    }
    async function showHistory(row, append=false) {
        if(!append){historyId=row.studentId;cursor=null;$('history-records').replaceChildren();$('history-title').textContent='ประวัติของ '+row.givenName+' '+row.surname;}
        const requested=historyId;
        const data=await request('?'+new URLSearchParams({action:'history',studentId:historyId,...(cursor?{cursor}:{})}));
        if(requested!==historyId)return;
        $('student-history').hidden=false;
        for(const event of data.history.rows)$('history-records').append(node('p',new Date(event.ts).toLocaleString('th-TH')+' · ช่อง '+event.drawer+' · '+event.ack+(event.clockTrust==='untrusted'?' · เวลาตู้ยังไม่ยืนยัน':'')));
        if(!append&&!data.history.rows.length)$('history-records').append(node('p','ยังไม่มีประวัติที่ซิงก์สำหรับนักเรียนคนนี้'));
        cursor=data.history.nextCursor;$('history-more').hidden=!cursor;
        if(!append)$('student-history').scrollIntoView({block:'start'});
    }
    async function card(id,replace=false) {
        const data=await request('',{action:replace?'replace-card':'card',studentId:id});cardId=id;
        $('card-name').textContent=data.student.givenName+' '+data.student.surname;$('card-class').textContent=id+' · '+data.student.classLevel+' / '+data.student.room;
        const generation = revision;
        await SfabQr.draw($('card-qr'),data.code); if (generation !== revision || !AuthService.isStaff()) { $('card-qr').getContext('2d').clearRect(0,0,280,280); return; } if(!$('card-dialog').open){ $('card-dialog').showModal(); $('card-dialog').scrollTop = 0; }
    }
    document.addEventListener('DOMContentLoaded',()=>{
        $('reload').onclick=run(load);$('search').oninput=render;
        $('student-form').onsubmit=run(event=>{event.preventDefault();return showPreview({rows:[Object.fromEntries(fields.map(key=>[key,$('student-form').elements[key].value]))]});});
        $('new-student').onclick=()=>{$('student-form').reset();$('student-form').elements.studentId.readOnly=false;$('editor-title').textContent='เพิ่มนักเรียน';clearPreview();};
        $('preview-csv').onclick=run(async()=>{const file=$('csv-file').files[0];if(!file||file.size>1024*1024)throw new Error('เลือกไฟล์ CSV ไม่เกิน 1 MiB');const bytes=await file.arrayBuffer();let csv;try{csv=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{throw new Error('กรุณาบันทึก CSV เป็น UTF-8');}await showPreview({csv});});
        $('confirm-import').onclick=run(async()=>{if(!preview||!payload)return;await request('',{...payload,action:'import',digest:preview.digest});clearPreview();await load();status('บันทึกข้อมูลเรียบร้อย');});
        $('cancel-import').onclick=clearPreview;
        $('export').onclick=run(async()=>{const generation=revision;const res=await AuthService.authorizedFetch('/api/students?action=export',{signal:AbortSignal.timeout(20000)});if(!res.ok)throw new Error(res.status===429?'ส่งออกได้หนึ่งครั้งต่อนาที':'ส่งออกไม่สำเร็จ');const blob=await res.blob();if(generation===revision&&AuthService.isStaff())download(blob,'sfab-students.csv');});
        $('template').onclick=()=>download(new Blob(['\uFEFF'+fields.join(',')+'\r\nDEMO001,นักเรียนตัวอย่าง,หนึ่ง,ม.3,1,ยังไม่ทราบ,ยังไม่ทราบ,\r\nDEMO002,นักเรียนตัวอย่าง,สอง,ม.3,1,ยังไม่ทราบ,ยังไม่ทราบ,\r\nDEMO003,นักเรียนตัวอย่าง,สาม,ม.3,2,ยังไม่ทราบ,ยังไม่ทราบ,\r\n'],{type:'text/csv;charset=utf-8'}),'sfab-demo-template.csv');
        $('history-more').onclick=run(()=>showHistory(null,true));$('print').onclick=()=>window.print();$('close-card').onclick=()=>{$('card-dialog').close();$('card-qr').getContext('2d').clearRect(0,0,280,280);};
        $('replace-card').onclick=run(()=>{if(window.confirm('บัตรเดิมจะใช้ไม่ได้หลังตู้ซิงก์ ต้องการออกบัตรใหม่หรือไม่?'))return card(cardId,true);});
        AuthService.subscribe(()=>{revision++;roster=[];clearPreview();render();$('student-form').reset();$('card-dialog').close();$('card-name').textContent='';$('card-class').textContent='';$('card-qr').getContext('2d').clearRect(0,0,280,280);$('student-history').hidden=true;$('history-records').replaceChildren();historyId=null;cursor=null;cardId=null;if(AuthService.isStaff())void run(load)();else status('เข้าสู่ระบบด้วยบัญชีครูเพื่อดูทะเบียน');});
    });
})();
