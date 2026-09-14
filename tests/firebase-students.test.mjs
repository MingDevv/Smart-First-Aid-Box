import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { firebaseServices } from '../lib/firebase-admin.js';
import { createStudentsHandler } from '../api/students.js';
import { createIngestHandler } from '../api/ingest.js';
import { createSyncHandler } from '../api/sync.js';
import { signedHeaders } from '../lib/cabinet-protocol.js';
import { StudentSession } from '../edge/student-session.mjs';
import { LocalController } from '../edge/controller.mjs';
import { hash } from '../lib/students.js';
import { parseCsv, exportCsv } from '../lib/student-csv.js';
let db,auth;const tokens={};
const rows=[1,2,3].map(n=>({studentId:'wp3-00'+n,givenName:'นักเรียนทดสอบ '+n,surname:'สมมติ',classLevel:'ม.3',room:'01',drugAllergies:'ยา ก',foodAllergies:'อาหาร ข',schoolEmail:'wp3-student'+n+'@tesaban6.ac.th'}));
before(async()=>{
    ({db,auth}=firebaseServices());
    for(const [name,role] of [['teacher','teacher'],['admin','admin'],['student1','student'],['student2','student']]){
        const uid='wp3-'+name;await auth.createUser({uid,email:uid+'@tesaban6.ac.th',emailVerified:true});if(role!=='student')await db.doc('roles/'+uid).set({role});
        const token=await auth.createCustomToken(uid),res=await fetch('http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=demo',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token,returnSecureToken:true})});tokens[name]=(await res.json()).idToken;
    }
});
after(()=>db.terminate());
async function invoke(handler,{token,method='GET',body,url='/api/students',headers={}}={}){
    let status=200,data;const responseHeaders={};
    await handler({method,body,url,headers:{...headers,...(token?{authorization:'Bearer '+token}:{})}},{setHeader(k,v){responseHeaders[k.toLowerCase()]=v;},status(v){status=v;return this;},json(v){data=v;return this;},send(v){data=v;return this;},end(v){data=v;return this;}});
    return {status,data,headers:responseHeaders};
}
const api=createStudentsHandler();
test('actual school tokens: import twice, dry run writes nothing, export audited/rate-limited, no student access',async()=>{
    assert.equal((await invoke(api)).status,401);assert.equal((await invoke(api,{token:tokens.student1})).status,403);
    const preview=await invoke(api,{token:tokens.teacher,method:'POST',body:{action:'preview',csv:exportCsv(rows)}});assert.equal(preview.status,200);assert.equal(preview.data.summary.create,3);
    assert.equal((await db.doc('students/wp3-001').get()).exists,false);
    const imported=await invoke(api,{token:tokens.teacher,method:'POST',body:{action:'import',rows,digest:preview.data.digest}});assert.equal(imported.status,200);
    const second=await invoke(api,{token:tokens.admin,method:'POST',body:{action:'preview',rows}});assert.deepEqual(second.data.summary,{create:0,update:0,skip:3,reject:0});
    assert.equal((await invoke(api,{token:tokens.admin,method:'POST',body:{action:'import',rows,digest:second.data.digest}})).status,200);
    assert.equal((await invoke(api,{token:tokens.admin,method:'POST',body:{action:'import',rows,digest:preview.data.digest}})).status,409);
    const doc=(await db.doc('students/wp3-001').get()).data();assert.equal(doc.name,rows[0].givenName+' '+rows[0].surname);assert.equal(doc.room,'01');
    const teacher=await invoke(api,{token:tokens.teacher}),admin=await invoke(api,{token:tokens.admin});assert.deepEqual(teacher.data,admin.data);
    const exported=await invoke(api,{token:tokens.teacher,url:'/api/students?action=export'});assert.equal(exported.status,200);assert.ok(exported.data.startsWith('\uFEFF'));assert.deepEqual(parseCsv(exported.data).filter(row=>row.studentId.startsWith('wp3-')),rows);
    assert.equal((await invoke(api,{token:tokens.teacher,url:'/api/students?action=export'})).status,429);
    assert.equal((await db.collection('_studentAudit').where('action','==','export').get()).size,1);
});
test('cards, signed minimal offline cache, identified ingest and own-history projection end to end',async()=>{
    const card=await invoke(api,{token:tokens.teacher,method:'POST',body:{action:'card',studentId:rows[0].studentId}});assert.equal(card.status,200);
    const roster=await invoke(api,{token:tokens.teacher});assert.ok(!JSON.stringify(roster.data).includes(card.data.code));
    const secret='synthetic-wp3-cabinet-secret-only-tests',env={SFAB_CABINET_SECRET:secret,SFAB_CABINET_ID:'wp3box'};
    const sync=createSyncHandler({env});
    const bundle=await invoke(sync,{url:'/api/sync',headers:signedHeaders(secret,'GET','/api/sync','wp3box')});assert.equal(bundle.status,200);const data=JSON.parse(bundle.data);
    const cached=data.roster.find(row=>row.studentId===rows[0].studentId);assert.deepEqual(Object.keys(cached).sort(),['cardHash','givenName','studentId','surname']);assert.equal(cached.cardHash,hash(card.data.code));
    assert.ok(!JSON.stringify(data).includes('drugAllergies'));assert.ok(!JSON.stringify(data).includes('อาหาร ข'));
    const controller=new LocalController({database:':memory:',cabinetId:'wp3box',mode:'real',serial:{device:'synthetic',async close(){},async request(path){const url=new URL(path,'http://device');return url.pathname==='/status'?{status:200,data:{protocol:2,microbit:'connected',ready:true,ackTimeoutMs:3000}}:{status:200,data:{success:true,protocol:2,event:'drawer_opened',id:url.searchParams.get('id'),drawer:1}};}}});
    controller.outbox.saveCache(data);const session=new StudentSession(controller.outbox),login=session.scan(card.data.code);assert.ok(login);
    const identity=session.identify(login.sessionId,'wp3-offline-command');await controller.command({id:'wp3-offline-command',action:'open',drawer:1},identity);
    const events=controller.outbox.pending();assert.equal(events[0].uid,rows[0].studentId);
    const body=JSON.stringify({events,heartbeat:{mode:'real',clockTrust:'untrusted',unresolved:null}});
    const ingest=createIngestHandler({env,send:async()=>true});const sent=await invoke(ingest,{url:'/api/ingest',method:'POST',body:Buffer.from(body),headers:signedHeaders(secret,'POST','/api/ingest','wp3box',body)});assert.equal(sent.status,200);
    const own=await invoke(api,{token:tokens.student1,url:'/api/students?action=me&studentId=wp3-002'});assert.equal(own.status,200);assert.equal(own.data.student.studentId,'wp3-001');assert.equal(own.data.history.rows.length,1);assert.equal(own.data.student.cardCode,undefined);
    const other=await invoke(api,{token:tokens.student2,url:'/api/students?action=me&studentId=wp3-001'});assert.equal(other.data.history.rows.length,0);
    for(const action of ['export','history'])assert.equal((await invoke(api,{token:tokens.student1,url:'/api/students?action='+action+'&studentId=wp3-001'})).status,403);
    const newCard=await invoke(api,{token:tokens.admin,method:'POST',body:{action:'replace-card',studentId:'wp3-001'}});assert.notEqual(newCard.data.code,card.data.code);
    const refreshed=await invoke(sync,{url:'/api/sync',headers:signedHeaders(secret,'GET','/api/sync','wp3box')});controller.outbox.saveCache(JSON.parse(refreshed.data));assert.equal(session.scan(card.data.code),null);assert.ok(session.scan(newCard.data.code));
    await controller.close();
});
