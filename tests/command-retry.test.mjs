import assert from 'node:assert/strict';
import { test } from 'node:test';

test('validation and rate-limit refusals are retry-safe without starting MQTT', async () => {
    const api = await import('../api/command.js?retry-contract');
    const invoke = body => new Promise((resolve, reject) => {
        // ต้องเป็น staff จริง ไม่งั้น `{action:'buzzer'}` ถูกเกตสิทธิ์ตัดเป็น 403 ก่อนถึงการตรวจ state
        // ที่เคสนี้ตั้งใจจะตรวจ · และต้องมี token.uid เพราะถังจำกัดอัตรานับด้วย uid แล้ว
        Promise.resolve(api.createCommandHandler(async () => ({role:'teacher', token:{uid:'retry-contract'}}))({ method: 'POST', headers: {}, body }, {
            setHeader() {}, status(code) { this.code = code; return this; },
            json(body) { resolve({ status: this.code, body }); }
        })).catch(reject);
    });
    for (const body of [{ action: 'invalid' }, { action: 'open', drawer: 1, id: 'bad' },
        { action: 'open', drawer: 3 }, { action: 'buzzer', state: 'invalid' }]) {
        const result = await invoke(body);
        assert.equal(result.status, 400);
        assert.equal(result.body.retrySafe, true);
    }
    let result;
    for (let i = 0; i < 8; i++) result = await invoke({ action: 'invalid' });
    assert.equal(result.status, 429);
    assert.equal(result.body.retrySafe, true);
    assert.equal(api.mqttClientStatsForTests().created, 0);
});
