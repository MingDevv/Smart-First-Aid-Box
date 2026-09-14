import { randomUUID } from 'node:crypto';
import { eventCollection, eventKey, lineText } from './cabinet-events.js';

// LINE keeps retry keys for 24h. Stop automatic retries conservatively at 23h:
// a new key or an expired key could deliver a previously accepted message twice.
export const RETRY_HORIZON_MS = 23 * 60 * 60 * 1000;
export async function pushLine(payload, retryKey, env = process.env, fetchImpl = fetch) {
    if (!env.LINE_CHANNEL_ACCESS_TOKEN) return false;
    try {
        const response = await fetchImpl('https://api.line.me/v2/bot/message/push', {
            method: 'POST', headers: { 'Content-Type': 'application/json',
                Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN.trim()}`, 'X-Line-Retry-Key': retryKey },
            body: JSON.stringify(payload), signal: AbortSignal.timeout(8000), redirect: 'error'
        });
        return response.ok || (response.status === 409 && Boolean(response.headers.get('x-line-accepted-request-id')));
    } catch { return false; }
}
export async function deliverEvent(db, event, { env = process.env, send = pushLine, now = Date.now } = {}) {
    const ref = db.doc(`_deliveries/${eventKey(event)}`);
    const record = db.doc(`${eventCollection(event)}/${eventKey(event)}`);
    const owner = randomUUID();
    const claim = await db.runTransaction(async tx => {
        const snap = await tx.get(ref);
        const state = snap.data();
        if (['delivered', 'skipped', 'manual_review'].includes(state.status)) return { status: state.status };
        const time = now();
        if (state.firstAttemptAt !== null && time - state.firstAttemptAt >= RETRY_HORIZON_MS) {
            tx.update(ref, { status: 'manual_review', leaseUntil: 0 });
            tx.update(record, { lineStatus: 'manual_review' });
            return { status: 'manual_review' };
        }
        if (state.leaseUntil > time || !env.LINE_GROUP_ID || !env.LINE_CHANNEL_ACCESS_TOKEN) return { status: 'pending' };
        const payload = state.payload || { to: env.LINE_GROUP_ID.trim(), messages: [{ type: 'text', text: lineText(event) }] };
        tx.update(ref, { owner, leaseUntil: time + 30000, firstAttemptAt: state.firstAttemptAt ?? time, payload });
        return { status: 'claimed', retryKey: state.retryKey, payload };
    });
    if (claim.status !== 'claimed') return claim.status;
    const success = await send(claim.payload, claim.retryKey, env);
    return db.runTransaction(async tx => {
        const current = (await tx.get(ref)).data();
        if (current.status === 'delivered') return 'delivered';
        if (success) {
            tx.update(ref, { status: 'delivered', leaseUntil: 0 });
            tx.update(record, { lineDelivered: true, lineStatus: 'delivered' });
            return 'delivered';
        }
        if (current.owner === owner) tx.update(ref, { leaseUntil: 0 });
        return 'pending';
    });
}
