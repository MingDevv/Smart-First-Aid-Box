import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAuthorizer, isSchoolIdentity } from '../lib/auth.js';
import { firebaseEnvironment } from '../lib/firebase-admin.js';
import firebaseConfig from '../api/firebase-config.js';
import { createCommandHandler, mqttClientStatsForTests } from '../api/command.js';
import { createNotifyHandler, sendSchoolSos } from '../api/notify.js';

const school = { uid: 'test-student', email: 'student@tesaban6.ac.th', email_verified: true, name: 'First Surname',
    iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000)+3600 };
function services({ token = school, role, error, failRole = false } = {}) {
    return () => ({ auth: { async verifyIdToken(value, revoked) {
        assert.equal(value, 'synthetic'); assert.equal(revoked, true);
        if (error) throw { code: error }; return token;
    } }, db: { doc(path) { assert.equal(path, `roles/${token.uid}`); return { async get() {
        if (failRole) throw new Error('unavailable');
        return { exists: role !== undefined, data: () => ({ role }) };
    } }; } } });
}
const request = body => ({ method: 'POST', headers: { authorization: 'Bearer synthetic' }, body });
export async function invoke(handler, req) {
    let status = 200, data;
    const headers = {};
    await handler(req, { setHeader(key, value) { headers[key.toLowerCase()] = value; },
        status(code) { status = code; return this; },
        json(value) { data = value; }, end() {} });
    return { status, data, headers };
}

test('school domain is exact and verified; provider hint is not authority', () => {
    assert.equal(isSchoolIdentity(school), true);
    for (const token of [{}, { ...school, email_verified: false }, { ...school, email_verified: 'true' },
        { ...school, email: 'a@tesaban6.ac.th.attacker.test' }, { ...school, email: 'a@other.test', hd: 'tesaban6.ac.th' },
        { ...school, email: 'a@x@tesaban6.ac.th' }, { ...school, email: 'a @tesaban6.ac.th' }]) {
        assert.equal(isSchoolIdentity(token), false);
    }
});

test('emulator configuration cannot be enabled partially or on Vercel/production', () => {
    const env = { FIREBASE_PROJECT_ID:'demo-sfab', SFAB_USE_FIREBASE_EMULATORS:'true',
        FIREBASE_AUTH_EMULATOR_HOST:'127.0.0.1:9099', FIRESTORE_EMULATOR_HOST:'127.0.0.1:8080' };
    assert.equal(firebaseEnvironment(env).emulator, true);
    for (const patch of [{ VERCEL:'1' }, { NODE_ENV:'production' }, { SFAB_USE_FIREBASE_EMULATORS:'' },
        { FIREBASE_PROJECT_ID:'real-project' }, { FIRESTORE_EMULATOR_HOST:'public.example:8080' },
        { FIREBASE_AUTH_EMULATOR_HOST:'' }]) assert.throws(() => firebaseEnvironment({ ...env, ...patch }));
});

test('role allowlist, revocation and failures close the command path before MQTT', async () => {
    for (const [options, req, expected] of [
        [{}, { method:'POST', headers:{}, body:{} }, 401],
        [{}, { method:'POST', headers:{ authorization: ['Bearer synthetic'] }, body:{} }, 401],
        [{ error:'auth/id-token-expired' }, request({}), 401],
        [{ error:'auth/id-token-revoked' }, request({}), 401],
        [{ error:'auth/user-disabled' }, request({}), 401],
        [{ error:'auth/internal-error' }, request({}), 503],
        [{ token:{...school,email_verified:false},role:'admin' }, request({}), 403],
        [{ token:{...school,email:'a@elsewhere.test'},role:'teacher' }, request({}), 403],
        [{}, request({role:'admin'}), 403], [{role:'owner'}, request({}),403],
        [{failRole:true},request({}),503]
    ]) {
        const handler = createCommandHandler(createAuthorizer(services(options)));
        const result = await invoke(handler, req);
        assert.equal(result.status, expected);
        assert.equal(result.data.retrySafe, true);
    }
    const studentHandler = createCommandHandler(createAuthorizer(services()));
    assert.equal((await invoke(studentHandler, {method:'GET',headers:{}})).status,401);
    assert.equal((await invoke(studentHandler, {...request(),method:'GET'})).status,403);
    assert.equal(mqttClientStatsForTests().created, 0);
    // สามบทบาทเท่านั้น — `nurse` ที่ค้างในเอกสารเก่าต้องตกเป็น student ไม่ใช่ผ่าน
    for (const role of ['teacher','admin']) {
        const handler = createCommandHandler(createAuthorizer(services({role})));
        assert.equal((await invoke(handler,request({action:'invalid'}))).status,400);
    }
});

test('student SOS only accepts its event and forwards exclusively verified identity', async () => {
    const sent = [];
    const handler = createNotifyHandler({authorizeRequest:createAuthorizer(services()),send:async token => {
        sent.push(token); return { success:true };
    }});
    assert.equal((await invoke(handler,request({messages:[{type:'text',text:'forged'}]}))).status,400);
    // ไม่มี token ก็ต้องส่งถึงครู — การเรียกครูไม่ถูกเกตด้วยตัวตน ตามกฎในวิกิข้อ 9
    // ตัวตนเป็นของแถมที่ทำให้ข้อความมีชื่อ ไม่ใช่เงื่อนไขก่อนส่ง · ฝั่ง send ได้ null ไปตรงๆ
    assert.equal((await invoke(handler,{...request({event:'sos'}),headers:{}})).status,200);
    assert.deepEqual(sent,[null],'ต้องส่งแบบไม่ระบุชื่อ ไม่ใช่ปฏิเสธ');
    // ฟิลด์ตัวตนที่ปลอมมาในเนื้อคำขอยังถูกทิ้งเหมือนเดิม ชื่อมาจาก token ที่ตรวจแล้วเท่านั้น
    assert.equal((await invoke(handler,request({event:'sos',uid:'admin',name:'forged',flexMessage:{}}))).status,200);
    assert.deepEqual(sent,[null,school]);
    const failed=createNotifyHandler({authorizeRequest:createAuthorizer(services()),send:async()=>({success:false})});
    assert.equal((await invoke(failed,request({event:'sos'}))).status,503);
});

test('LINE sends minimal plain text to a configured group and preserves transport failure', async () => {
    const oldFetch=globalThis.fetch;
    const oldToken=process.env.LINE_CHANNEL_ACCESS_TOKEN,oldGroup=process.env.LINE_GROUP_ID;
    process.env.LINE_CHANNEL_ACCESS_TOKEN='synthetic-line-token'; process.env.LINE_GROUP_ID='synthetic-group';
    try {
        let body;
        globalThis.fetch=async(url,options)=>{ assert.equal(url,'https://api.line.me/v2/bot/message/push');body=JSON.parse(options.body);return{ok:true}; };
        assert.equal((await sendSchoolSos(school)).success,true);
        assert.equal(body.to,'synthetic-group');
        // SOS จากเว็บใช้การ์ด Flex ภาษาไทยชุดเดียวกับฝั่งตู้ ⇒ ครูเห็นหน้าตาเดียวกันทั้งสองทาง
        assert.equal(body.messages[0].type,'flex');
        const rendered = JSON.stringify(body.messages[0]);
        // ชื่อต้นอย่างเดียว ไม่เอานามสกุล — ข้อจำกัดเดิมที่ต้องอยู่ต่อแม้เปลี่ยนรูปแบบข้อความ
        assert.match(rendered,/First/);assert.doesNotMatch(rendered,/Surname/);
        assert.match(body.messages[0].altText,/เรียกครูพยาบาล/);
        assert.match(rendered,/กดจากเว็บ/,'ครูต้องรู้ว่ากดมาจากเว็บ ไม่ใช่ที่หน้าตู้');
        globalThis.fetch=async()=>({ok:false});assert.equal((await sendSchoolSos(school)).success,false);
        delete process.env.LINE_GROUP_ID;
        let calls = 0;
        globalThis.fetch=async()=>{calls++;return {ok:false};};
        assert.equal((await sendSchoolSos(school)).success,false);
        assert.equal(calls,0,'missing group must not contact LINE or broadcast');
    } finally {
        globalThis.fetch=oldFetch;
        for (const [key,value] of [['LINE_CHANNEL_ACCESS_TOKEN',oldToken],['LINE_GROUP_ID',oldGroup]]) {
            if(value===undefined)delete process.env[key];else process.env[key]=value;
        }
    }
});


test('public Firebase config is an explicit allowlist and missing config fails closed', async () => {
    const values = { FIREBASE_PROJECT_ID:'synthetic-school-project', FIREBASE_WEB_API_KEY:'synthetic-public-key',
        FIREBASE_AUTH_DOMAIN:'synthetic-school-project.firebaseapp.com', FIREBASE_WEB_APP_ID:'synthetic-web-app',
        FIREBASE_CLIENT_EMAIL:'synthetic-service-account', FIREBASE_PRIVATE_KEY:'synthetic-private-placeholder',
        SFAB_USE_FIREBASE_EMULATORS:undefined, FIREBASE_AUTH_EMULATOR_HOST:undefined, FIRESTORE_EMULATOR_HOST:undefined };
    const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
    const assign = entries => {
        for (const [key,value] of Object.entries(entries)) {
            if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
    };
    try {
        assign(values);
        const response = await invoke(firebaseConfig,{method:'GET'});
        assert.equal(response.status,200);
        assert.deepEqual(Object.keys(response.data),['config']);
        assert.deepEqual(Object.keys(response.data.config).sort(),['apiKey','appId','authDomain','projectId']);
        assert.doesNotMatch(JSON.stringify(response.data),/synthetic-private|synthetic-service/);
        delete process.env.FIREBASE_WEB_APP_ID;
        assert.equal((await invoke(firebaseConfig,{method:'GET'})).status,503);
    } finally { assign(previous); }
});

// ค่าสาธารณะที่ห้ามแคช = ปลุก lambda ทุกครั้งที่เปิดหน้า แล้วการโหลด SDK ถึงจะเริ่มได้
// วัดจริงบน production: 0.42–1.70 วินาทีต่อหน้า และ `x-vercel-cache: MISS` ทุกครั้ง
// สิ่งที่ต้องไม่พังไปพร้อมกัน: คำตอบตอนตั้งค่าไม่ครบ (503) ต้องไม่ถูกแคชค้าง ไม่งั้นแก้ env แล้วเว็บยังเสียทั้งวัน
test('public Firebase config is cacheable, but a misconfigured answer never is', async () => {
    const values = { FIREBASE_PROJECT_ID:'synthetic-school-project', FIREBASE_WEB_API_KEY:'synthetic-public-key',
        FIREBASE_AUTH_DOMAIN:'synthetic-school-project.firebaseapp.com', FIREBASE_WEB_APP_ID:'synthetic-web-app',
        FIREBASE_CLIENT_EMAIL:'synthetic-service-account', FIREBASE_PRIVATE_KEY:'synthetic-private-placeholder',
        SFAB_USE_FIREBASE_EMULATORS:undefined, FIREBASE_AUTH_EMULATOR_HOST:undefined, FIRESTORE_EMULATOR_HOST:undefined };
    const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
    const assign = entries => {
        for (const [key,value] of Object.entries(entries)) {
            if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
    };
    try {
        assign(values);
        const ok = await invoke(firebaseConfig,{method:'GET'});
        assert.equal(ok.status,200);
        assert.match(ok.headers['cache-control'],/(^|,\s*)public/);
        assert.match(ok.headers['cache-control'],/s-maxage=\d+/,'ขอบเครือข่ายต้องเก็บได้ ไม่งั้นยังปลุก lambda ทุกหน้าอยู่ดี');
        assert.doesNotMatch(ok.headers['cache-control'],/no-store/);

        delete process.env.FIREBASE_WEB_API_KEY;
        const broken = await invoke(firebaseConfig,{method:'GET'});
        assert.equal(broken.status,503);
        assert.match(broken.headers['cache-control'],/no-store/,'503 ที่ถูกแคชไว้ = แก้ env แล้วเว็บยังพังต่อ');

        assign({ ...values, FIREBASE_PROJECT_ID:'demo-sfab', SFAB_USE_FIREBASE_EMULATORS:'true',
            FIREBASE_AUTH_EMULATOR_HOST:'127.0.0.1:9099', FIRESTORE_EMULATOR_HOST:'127.0.0.1:8080' });
        const emulated = await invoke(firebaseConfig,{method:'GET'});
        assert.equal(emulated.status,200);
        assert.match(emulated.headers['cache-control'],/no-store/,'ค่าโหมด emulator ห้ามไปค้างที่ขอบเครือข่าย');

        const rejected = await invoke(firebaseConfig,{method:'POST'});
        assert.equal(rejected.status,405);
        assert.match(rejected.headers['cache-control'],/no-store/);
    } finally { assign(previous); }
});


test('SOS coalesces concurrent requests and deduplicates successful delivery for 120 seconds', async () => {
    let time = 1000, calls = 0, release, started;
    const sending = new Promise(resolve => { started = resolve; });
    const pending = new Promise(resolve => { release = resolve; });
    const handler = createNotifyHandler({authorizeRequest:createAuthorizer(services()), now:()=>time,
        send:async()=>{calls++;started();await pending;return {success:true};}});
    const first = invoke(handler,request({event:'sos'}));
    await sending;
    const duplicate = invoke(handler,request({event:'sos'}));
    release();
    const [original, repeated] = await Promise.all([first,duplicate]);
    assert.equal(original.status,200);
    assert.equal(repeated.status,200);
    assert.equal(repeated.data.deduplicated,true);
    assert.equal(calls,1,'concurrent SOS must send LINE once');
    time += 119999;
    assert.equal((await invoke(handler,request({event:'sos'}))).data.deduplicated,true);
    assert.equal(calls,1);
    time++;
    assert.equal((await invoke(handler,request({event:'sos'}))).data.deduplicated,undefined);
    assert.equal(calls,2,'a fresh SOS is allowed after the dedupe window');
});

test('SOS failures stay failures for concurrent callers and are never cached as success', async () => {
    let calls=0, release, started;
    const sending=new Promise(resolve=>{started=resolve;});
    const pending=new Promise(resolve=>{release=resolve;});
    const handler=createNotifyHandler({authorizeRequest:createAuthorizer(services()),send:async()=>{
        calls++;
        if(calls===1){started();await pending;return {success:false};}
        if(calls===2)throw new Error('synthetic transport failure');
        return {success:true};
    }});
    const first=invoke(handler,request({event:'sos'}));
    await sending;
    const duplicate=invoke(handler,request({event:'sos'}));
    await new Promise(resolve=>setImmediate(resolve));
    release();
    const results=await Promise.all([first,duplicate]);
    assert.deepEqual(results.map(r=>r.status),[503,503]);
    assert.equal(calls,1,'concurrent failures must share the same attempt');
    assert.equal((await invoke(handler,request({event:'sos'}))).status,503);
    assert.equal((await invoke(handler,request({event:'sos'}))).status,200);
    assert.equal(calls,3,'failed attempts must not suppress a later retry');
});

test('SOS caps new attempts globally at 10 per minute per instance, including failures', async () => {
    let time=1000,calls=0;
    const handler=createNotifyHandler({now:()=>time,
        authorizeRequest:async req=>({token:{...school,uid:req.headers['x-test-uid']}}),
        send:async()=>{calls++;return {success:calls!==1};}});
    const sos=uid=>invoke(handler,{...request({event:'sos'}),headers:{'x-test-uid':uid}});
    const results=await Promise.all(Array.from({length:20},(_,i)=>sos('synthetic-'+i)));
    assert.equal(calls,10);
    assert.equal(results.filter(r=>r.status===429).length,10);
    assert.equal((await sos('synthetic-1')).data.deduplicated,true,'already delivered duplicates do not use the cap');
    assert.equal((await sos('synthetic-0')).status,429,'failures also consume the attempt budget');
    time+=60000;
    assert.equal((await sos('new-window')).status,200);
    assert.equal(calls,11);
});
