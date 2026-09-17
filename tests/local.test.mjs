import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
const apiBridgeSource = await readFile(new URL('js/api-bridge.js', root), 'utf8');
const storageSource = await readFile(new URL('js/storage.js', root), 'utf8');
const mqttBridgeSource = await readFile(new URL('js/mqtt-bridge.js', root), 'utf8');
const commandApiSource = await readFile(new URL('api/command.js', root), 'utf8');


function browser(runtime) {
    const values = new Map([
        ['smart_first_aid_settings', JSON.stringify({demoMode:false,modeProvisionedAt:'now',dashboardPin:'1234',esp32Url:'http://must-not-contact.invalid'})],
        ['smart_first_aid_history', JSON.stringify([{uid:'other-person',allergies:['private']}])],
        ['smart_first_aid_medicine', JSON.stringify([{qty:99}])]
    ]);
    let calls=0;
    const window={SFAB_RUNTIME:runtime};
    const context=vm.createContext({window,localStorage:{getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,v)},
        fetch:async()=>{calls++;throw new Error('unexpected network');},
        AbortController,setTimeout,clearTimeout,console});
    vm.runInContext(storageSource,context);vm.runInContext(apiBridgeSource,context);
    return {storage:window.StorageService,api:window.ApiBridge,window,values,calls:()=>calls};
}

{
    const b=browser();
    assert.equal(b.storage.getCurrentStudent(),null);
    assert.equal(b.storage.loginStudent('12345').success,false);
    assert.equal(b.storage.getHistory().length,0);assert.equal(b.storage.getMedicines().length,0);
    b.storage.saveSettings({largeText:true,demoMode:false,dashboardPin:'9999',role:'admin'});
    assert.deepEqual(JSON.parse(b.values.get('sfab_ui_preferences')),{largeText:true});
    assert.equal(b.storage.getOperatingMode(),'unset');
    assert.equal((await b.api.openCompartment('cut')).mode,'unauthorized');
    // หยุดเสียงเป็นของครู ⇒ เบราว์เซอร์ไม่มีตัวตนต้องถูกปฏิเสธก่อนแตะเครือข่าย
    assert.equal((await b.api.triggerBuzzer('off')).mode,'unauthorized');
    assert.equal(b.calls(),0);
    // แต่ "ดัง" ต้องพยายามส่งจริงแม้ไม่มีใครล็อกอิน — ที่นี่ fetch ปลอมโยนทิ้ง จึงได้ผลล้มเหลว
    // ของเส้น mqtt ไม่ใช่ unauthorized · สิ่งที่เคสนี้ยืนยันคือ "ไม่ได้ถูกเกตสิทธิ์ตัดทิ้ง"
    const ring = await b.api.triggerBuzzer('on');
    assert.equal(ring.success,false);
    assert.notEqual(ring.mode,'unauthorized');
    assert.ok(b.calls()>0,'ออด SOS ต้องถูกยิงออกไปจริง ไม่ใช่ถูกปฏิเสธเงียบๆ ในเบราว์เซอร์');
    assert.equal(b.storage.addHistoryEntry({uid:'forged'}).success,false);
    assert.equal(JSON.parse(b.values.get('smart_first_aid_history')).length,1);
}
for(const mode of ['real','demo','unset','invalid']) {
    const b=browser({transport:'pi-local',mode});
    const expected=mode==='invalid'?'unset':mode;
    assert.equal(b.storage.getOperatingMode(),expected);
    assert.equal(b.api.operatingMode(),expected);
    b.window.StorageService=undefined;
    assert.equal(b.api.operatingMode(),expected);
    if(expected==='unset') {
        assert.equal((await b.api.openCompartment('cut')).mode,'unprovisioned');
        assert.equal(b.calls(),0);
    }
}
// ESP32 ถูกถอดออกจากตู้แล้ว เส้นจริงคือ Pi ต่อ USB เข้า micro:bit
// ข้อตกลงเรื่อง ACK และ command history ย้ายไปอยู่ที่ tests/microbit-serial.test.mjs แทน
assert.match(commandApiSource, /if \(activeClientState === state\) activeClientState = null/);
assert.match(commandApiSource, /reconnectPeriod: 0/);
assert.match(commandApiSource, /MQTT_CONNECT_TIMEOUT_MS = 4500/);

assert.match(commandApiSource, /'ack_timeout'/);


console.log('local authority passed');
