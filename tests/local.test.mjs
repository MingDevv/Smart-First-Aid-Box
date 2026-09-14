import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
const apiBridgeSource = await readFile(new URL('js/api-bridge.js', root), 'utf8');
const storageSource = await readFile(new URL('js/storage.js', root), 'utf8');
const mqttBridgeSource = await readFile(new URL('js/mqtt-bridge.js', root), 'utf8');
const firmwareSource = await readFile(new URL('firmware/esp32_smart_box/esp32_smart_box.ino', root), 'utf8');
const commandHistorySource = await readFile(new URL('firmware/esp32_smart_box/command_history.h', root), 'utf8');
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
    assert.equal((await b.api.triggerBuzzer('on')).mode,'unauthorized');
    assert.equal(b.calls(),0);
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
// These are static firmware invariants only; the Arduino sketch is not compiled by this test.
assert.match(commandHistorySource, /COMMAND_HISTORY_SIZE = 8/);
assert.match(commandHistorySource, /offset < COMMAND_HISTORY_SIZE/);
assert.match(commandHistorySource, /record->expired = true/);
assert.match(firmwareSource, /COMMAND_ACK_TIMEOUT_MS = SFAB_COMMAND_ACK_TIMEOUT_MS/);
assert.match(firmwareSource, /enqueueEvent\("ack_timeout"/);
assert.match(firmwareSource, /POST_SUBSCRIBE_GUARD_MS = 500/);
assert.match(firmwareSource, /if \(!doc\["ts"\]\.is<uint64_t>\(\)\)/);
assert.match(firmwareSource, /if \(cmdMs > nowMs\)/);
assert.match(firmwareSource, /if \(WiFi\.status\(\) != WL_CONNECTED\) return;/);
assert.match(firmwareSource, /mqtt\.setSocketTimeout\(2\)/);
assert.match(firmwareSource, /Serial2\.setTimeout\(100\)/);
assert.match(firmwareSource, /configTime\(7 \* 3600, 0, "pool\.ntp\.org", "time\.google\.com"\)/);

const callbackBody = firmwareSource.slice(
    firmwareSource.indexOf('void onMqttMessage'),
    firmwareSource.indexOf('// PubSubClient::connect')
);
assert.doesNotMatch(callbackBody, /publishEvent\s*\(/);
assert.match(callbackBody, /enqueueEvent\s*\(/);
assert.match(commandApiSource, /if \(activeClientState === state\) activeClientState = null/);
assert.match(commandApiSource, /reconnectPeriod: 0/);
assert.match(commandApiSource, /MQTT_CONNECT_TIMEOUT_MS = 4500/);

assert.match(commandApiSource, /'ack_timeout'/);


console.log('local authority and firmware invariants passed');
