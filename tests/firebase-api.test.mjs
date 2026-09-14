import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createServer } from 'node:net';
import packet from 'mqtt-packet';
import { firebaseServices } from '../lib/firebase-admin.js';
import command, { closeMqttClientForTests } from '../api/command.js';
import { createNotifyHandler } from '../api/notify.js';
import me from '../api/me.js';
const tokens = new Map();
let auth, db, broker, published = 0;
async function invoke(handler, token, body, method = 'POST') {
    let status = 200, data;
    await handler({ method, headers: token ? { authorization: `Bearer ${token}` } : {}, body }, {
        setHeader() {}, status(value) { status = value; return this; }, json(value) { data = value; }, end() {}
    });
    return { status, data };
}
async function issue(uid) {
    const custom = await auth.createCustomToken(uid);
    const response = await fetch('http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=demo', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({token: custom, returnSecureToken:true})
    });
    const data = await response.json();
    assert.equal(response.status, 200, 'emulator sign-in failed');
    return data.idToken;
}
before(async () => {
    ({auth,db}=firebaseServices());
    for(const [name,role,email,verified] of [
        ['student',null,'student@tesaban6.ac.th',true],['nurse','nurse','nurse@tesaban6.ac.th',true],
        ['teacher','teacher','teacher@tesaban6.ac.th',true],['admin','admin','admin@tesaban6.ac.th',true],
        ['external','nurse','external@elsewhere.test',true],['unverified','admin','unverified@tesaban6.ac.th',false]
    ]) {
        const uid='api-'+name;
        await auth.createUser({uid,email,emailVerified:verified,displayName:'First Surname'});
        if(role)await db.doc('roles/'+uid).set({role});
        tokens.set(name,await issue(uid));
    }
    await db.doc('students/api-student').set({active:true,studentNo:'private-number',allergyFlags:{drawer2:true},updatedBy:'private-nurse',futureSecret:'must-not-leak'});
    broker=createServer(socket=>{
        const parser=packet.parser();socket.on('data',chunk=>parser.parse(chunk));
        const send=data=>socket.write(packet.generate(data));
        parser.on('packet',p=>{
            if(p.cmd==='connect')send({cmd:'connack',returnCode:0,sessionPresent:false});
            if(p.cmd==='subscribe'){
                send({cmd:'suback',messageId:p.messageId,granted:p.subscriptions.map(()=>1)});
                send({cmd:'publish',topic:'test/auth/status',qos:0,retain:true,payload:JSON.stringify({online:true,protocol:2,microbit:'connected',ready:true,ackTimeoutMs:3000,ts:Date.now()})});
            }
            if(p.cmd==='publish'){
                published++;assert.equal(p.retain,false);const c=JSON.parse(p.payload.toString());
                if(p.qos)send({cmd:'puback',messageId:p.messageId});
                send({cmd:'publish',topic:'test/auth/evt',qos:0,retain:false,payload:JSON.stringify({protocol:2,id:c.id,event:c.action==='open'?'drawer_opened':'buzzer_set',drawer:c.drawer,state:c.state})});
            }
            if(p.cmd==='disconnect')socket.end();
        });
    });
    await new Promise(resolve=>broker.listen(0,'127.0.0.1',resolve));
    process.env.MQTT_URL=`mqtt://127.0.0.1:${broker.address().port}`;
    process.env.MQTT_BASE_TOPIC='test/auth';
});
after(async()=>{await closeMqttClientForTests();await new Promise(resolve=>broker.close(resolve));await db.terminate();});

test('actual ID tokens produce anonymous 401, student 403 and staff ACK success',async()=>{
    const body={action:'open',drawer:1,id:'c-api-auth-test'};
    assert.equal((await invoke(command,null,body)).status,401);
    assert.equal((await invoke(command,'invalid-token',body)).status,401);
    for(const user of ['student','external','unverified']) assert.equal((await invoke(command,tokens.get(user),body)).status,403);
    assert.equal(published,0);
    for(const user of ['nurse','teacher','admin']){
        const response=await invoke(command,tokens.get(user),{...body,id:'c-auth-'+user});
        assert.equal(response.status,200,user+' must reach existing ACK path');
        assert.equal(response.data.ack.event,'drawer_opened');
    }
    assert.equal(published,3);
});

test('own-profile projection never leaks clinical fields or studentNo',async()=>{
    const response=await invoke(me,tokens.get('student'),undefined,'GET');
    assert.equal(response.status,200);
    assert.equal(response.data.uid,'api-student');assert.equal(response.data.role,'student');
    assert.deepEqual(response.data.profile,{active:true});
    assert.deepEqual(Object.keys(response.data).sort(),['email','name','profile','role','uid']);
});

test('expired, wrong audience/issuer and revoked tokens fail before publishing',async()=>{
    const parts=tokens.get('student').split('.');
    const payload=JSON.parse(Buffer.from(parts[1],'base64url'));
    for(const patch of [{exp:1},{iat:payload.exp+100},{aud:'different-project'},{iss:'https://securetoken.google.com/other-project'}]){
        const changed=[parts[0],Buffer.from(JSON.stringify({...payload,...patch})).toString('base64url'),parts[2]].join('.');
        assert.equal((await invoke(command,changed,{action:'open',drawer:1})).status,401);
    }
    await new Promise(resolve => setTimeout(resolve, 1100));
    await auth.revokeRefreshTokens('api-student');
    assert.equal((await invoke(command,tokens.get('student'),{action:'open',drawer:1})).status,401);
    tokens.set('student',await issue('api-student'));
    assert.equal(published,3);
});

test('deleting a role takes effect on the next command with the same valid token',async()=>{
    await db.doc('roles/api-nurse').delete();
    assert.equal((await invoke(command,tokens.get('nurse'),{action:'buzzer',state:'on',id:'c-no-role-now'})).status,403);
    assert.equal(published,3);
});

test('actual student ID token may send SOS, but cannot forge sender or submit a staff event',async()=>{
    const sent=[];
    const notify=createNotifyHandler({send:async token=>{sent.push(token?.uid??null);return{success:true};}});
    // การเรียกครูไม่ถูกเกตด้วยตัวตน (Bank 2026-09-14 · กฎเดิมในวิกิข้อ 9) — ไม่มี token ก็ส่งถึง
    // และบัญชีนอกโรงเรียนก็ส่งถึงเหมือนกัน เพียงแต่ไม่ถูกนับเป็นตัวตนที่เชื่อถือได้ จึงส่งแบบไม่ระบุชื่อ
    assert.equal((await invoke(notify,null,{event:'sos'})).status,200);
    assert.equal((await invoke(notify,tokens.get('external'),{event:'sos'})).status,200);
    // ⚠️ ข้อแลกเปลี่ยนที่ต้องรู้: คำขอนิรนามใช้ที่อยู่ต้นทางเป็นกุญแจกันส่งซ้ำ ⇒ สองคนที่ไม่ได้ล็อกอิน
    // และออกจากไอพีเดียวกัน (เช่น Wi-Fi โรงเรียน) ภายใน 2 นาที จะถูกยุบเป็นข้อความเดียว
    // ยอมรับได้เพราะครูไปที่ตู้อยู่ดี และถ้าไม่ยุบเลยช่องทางนี้จะกลายเป็นที่สแปมทันที
    assert.deepEqual(sent,[null],'ส่งถึงครูแบบไม่ระบุชื่อ และคำขอที่สองถูกยุบรวม ไม่ใช่ถูกปฏิเสธ');
    // สิ่งที่ยังกันอยู่: เหตุการณ์อื่นที่ไม่ใช่ sos ยังถูกปฏิเสธ ช่องทางนี้มีไว้เรียกครูอย่างเดียว
    assert.equal((await invoke(notify,tokens.get('student'),{event:'dispense'})).status,400);
    assert.equal(sent.length,1);
    assert.equal((await invoke(notify,tokens.get('student'),{event:'sos',uid:'api-admin',name:'forged',messages:[{}]})).status,200);
    assert.deepEqual(sent,[null,'api-student'],'ชื่อมาจาก token ที่ตรวจแล้วเท่านั้น ไม่ใช่จากเนื้อคำขอ');
});
