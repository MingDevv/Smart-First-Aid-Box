import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import QRCode from 'qrcode';
import jsQR from 'jsqr';
import { validateStudent, importPlan, rosterProjection, hash, newCard } from '../lib/students.js';
import { exportCsv, parseCsv } from '../lib/student-csv.js';
import { StudentSession } from '../edge/student-session.mjs';
import { CabinetOutbox } from '../edge/outbox.mjs';
const student = { studentId:'0001',givenName:'เด็กหญิง กานต์',surname:'ใจดี',classLevel:'ม.3',room:'01',drugAllergies:'เพนิซิลลิน, ยาอื่น\nบรรทัดสอง',foodAllergies:'=danger()',schoolEmail:'demo01@tesaban6.ac.th' };
test('CSV preserves Thai, multiline and leading zero IDs; protects every formula prefix',()=>{
    const csv=exportCsv([student]);assert.ok(csv.startsWith('\uFEFF'));assert.deepEqual(parseCsv(csv),[student]);
    for(const value of ['=x','+x','-x','@x','\t=x'])assert.ok(exportCsv([{...student,foodAllergies:value}]).includes(String.fromCharCode(34,39)));
    for(const bad of ['a,b',String.fromCharCode(34)+'broken','x'.repeat(1024*1024+1)])assert.throws(()=>parseCsv(bad));
    assert.throws(()=>parseCsv(exportCsv(Array(201).fill(student))));
    assert.throws(()=>validateStudent({...student,givenName:'x'.repeat(161)}));
});
test('idempotent preview rejects duplicate identifiers/accounts and changes digest for stale preview',()=>{
    const first=importPlan([student],[]);assert.equal(first.summary.create,1);
    const stored={...validateStudent(student),revision:1,cardHash:'private'};
    assert.equal(importPlan([student],[stored]).summary.skip,1);
    assert.equal(importPlan([student,student],[]).summary.reject,1);
    assert.equal(importPlan([student,{...student,studentId:'0002'}],[]).summary.reject,1);
    assert.notEqual(importPlan([student],[stored]).digest,first.digest);
    assert.deepEqual(Object.keys(rosterProjection([stored])[0]).sort(),['cardHash','givenName','studentId','surname']);
});
test('generated card decodes with the real offline decoder',()=>{
    const code=newCard(),qr=QRCode.create(code,{errorCorrectionLevel:'M'}),scale=8,margin=4,width=(qr.modules.size+margin*2)*scale;
    const data=new Uint8ClampedArray(width*width*4);data.fill(255);
    for(let y=0;y<width;y++)for(let x=0;x<width;x++){
        const mx=Math.floor(x/scale)-margin,my=Math.floor(y/scale)-margin;
        if(mx>=0&&my>=0&&mx<qr.modules.size&&my<qr.modules.size&&qr.modules.get(my,mx)){const i=(y*width+x)*4;data[i]=data[i+1]=data[i+2]=0;}
    }
    assert.equal(jsQR(data,width,width).data,code);
});
test('offline card matches hash cache; one command, expiry, rotation and reset clear identity',()=>{
    const db=new DatabaseSync(':memory:'),outbox=new CabinetOutbox(db);const code=newCard();let now=1000;
    outbox.saveCache({roster:[{...student,cardHash:hash(code)}]});const session=new StudentSession(outbox,()=>now);
    assert.equal(session.scan('0001'),null);const login=session.scan(code);assert.equal(login.givenName,student.givenName);assert.equal(login.drugAllergies,undefined);
    assert.equal(session.identify(login.sessionId,'first').studentId,'0001');assert.equal(session.identify(login.sessionId,'second'),null);
    assert.ok(session.identify(login.sessionId,'first'));session.clear();assert.equal(session.identify(login.sessionId,'first'),null);
    const next=session.scan(code);now+=600001;assert.equal(session.identify(next.sessionId,'new'),null);
    outbox.saveCache({roster:[]});assert.equal(session.scan(code),null);db.close();
});
import { LocalController } from '../edge/controller.mjs';
import { createLocalServer } from '../edge/server.mjs';
test('local HTTP scan binds journal history; raw IDs fail and a second command requires new scan',async t=>{
    let opens=0, ready=true;
    const controller=new LocalController({database:':memory:',mode:'real',serial:{device:'synthetic',async close(){},async request(path){const url=new URL(path,'http://device');if(url.pathname==='/status')return {status:200,data:{protocol:2,microbit:'connected',ready,ackTimeoutMs:3000}};opens++;return {status:200,data:{success:true,protocol:2,event:'drawer_opened',id:url.searchParams.get('id'),drawer:Number(url.searchParams.get('drawer'))}};}}});
    const code=newCard();controller.outbox.saveCache({roster:[{studentId:'0001',givenName:student.givenName,surname:student.surname,cardHash:hash(code)}]});
    const server=await createLocalServer({controller,mode:'real'});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});await controller.close();});
    const origin='http://127.0.0.1:'+server.address().port;
    const post=(path,body)=>fetch(origin+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    const command={id:'student-command-1',action:'open',drawer:1};
    assert.equal((await post('/api/command',command)).status,401);assert.equal(opens,0);
    assert.equal((await post('/api/local/student',{code:'0001'})).status,404);
    const login=await (await post('/api/local/student',{code})).json();
    assert.equal((await post('/api/command',{...command,studentSession:login.sessionId})).status,200);
    assert.equal((await post('/api/command',{...command,studentSession:login.sessionId})).status,200);assert.equal(opens,1);
    assert.equal((await post('/api/command',{...command,id:'student-command-2',studentSession:login.sessionId})).status,401);assert.equal(opens,1);
    const event=controller.outbox.pending()[0];assert.equal(event.studentId,'0001');assert.equal(event.verifiedBy,'cabinet_card');assert.equal(event.uid,'0001');
    assert.equal(event.givenName,undefined);assert.equal(event.drugAllergies,undefined);
    await post('/api/local/student',{action:'clear'});assert.equal((await post('/api/command',{...command,studentSession:login.sessionId})).status,401);
    const again=await (await post('/api/local/student',{code})).json();ready=false;
    assert.equal((await post('/api/command',{...command,id:'student-rejected-1',studentSession:again.sessionId})).status,503);ready=true;
    assert.equal((await post('/api/command',{...command,id:'student-safe-retry',studentSession:again.sessionId})).status,200);assert.equal(opens,2);
});
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
test('crash recovery preserves the card identity on an uncertain command without replay',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'sfab-wp3-recovery-')),database=join(dir,'journal.sqlite');
    let controller=new LocalController({database,mode:'real'});
    controller.db.prepare("INSERT INTO commands(id,drawer,state,created_at,student_identity) VALUES(?,1,'pending',?,?)").run('wp3-crash-command',new Date().toISOString(),JSON.stringify({studentId:'0001',badgeId:'a'.repeat(64)}));
    await controller.close();controller=new LocalController({database,mode:'real'});
    const event=controller.outbox.pending()[0];assert.equal(event.uid,'0001');assert.equal(event.studentId,'0001');assert.equal(event.ack,'uncertain');assert.equal(event.historical,false);assert.ok(controller.unresolved());await controller.close();
});
