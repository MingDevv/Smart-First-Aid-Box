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
    await handler(req, { setHeader() {}, status(code) { status = code; return this; },
        json(value) { data = value; }, end() {} });
    return { status, data };
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
        [{ token:{...school,email:'a@elsewhere.test'},role:'nurse' }, request({}), 403],
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
    for (const role of ['nurse','teacher','admin']) {
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
    assert.equal((await invoke(handler,{...request({event:'sos'}),headers:{}})).status,401);
    assert.equal(sent.length,0);
    assert.equal((await invoke(handler,request({event:'sos',uid:'admin',name:'forged',flexMessage:{}}))).status,200);
    assert.deepEqual(sent,[school]);
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
        assert.equal(body.to,'synthetic-group'); assert.equal(body.messages[0].type,'text');
        assert.match(body.messages[0].text,/First/);assert.doesNotMatch(body.messages[0].text,/Surname/);
        globalThis.fetch=async()=>({ok:false});assert.equal((await sendSchoolSos(school)).success,false);
        delete process.env.LINE_GROUP_ID;
        globalThis.fetch=()=>{throw new Error('must not broadcast');};
        assert.equal((await sendSchoolSos(school)).success,false);
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
