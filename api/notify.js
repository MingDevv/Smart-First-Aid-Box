import { authorize, accessFailure, apiHeaders } from '../lib/auth.js';

export async function sendSchoolSos(token) {
    const channel = process.env.LINE_CHANNEL_ACCESS_TOKEN?.trim();
    const group = process.env.LINE_GROUP_ID?.trim();
    if (!channel || !group) return { success: false };
    const firstName = (typeof token.name === 'string' ? token.name : '')
        .trim().split(/\s+/)[0].replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 60) || 'School user';
    // Client names and Flex payloads never reach LINE. UID disambiguates first names.
    const text = `SOS — ${firstName}\nReference: ${token.uid}\n${new Date().toISOString()}\nPlease contact the student.`;
    try {
        const response = await fetch('https://api.line.me/v2/bot/message/push', {
            method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${channel}` },
            body: JSON.stringify({ to: group, messages: [{ type: 'text', text }] }),
            signal: AbortSignal.timeout(8000), redirect: 'error'
        });
        return { success: response.ok };
    } catch { return { success: false }; }
}

export function createNotifyHandler({ authorizeRequest = authorize, send = sendSchoolSos } = {}) {
    const limits = new Map();
    return async function handler(req, res) {
        apiHeaders(res, 'POST, OPTIONS');
        if (req.method === 'OPTIONS') return res.status(204).end();
        if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'method_not_allowed' });
        let identity;
        try { identity = await authorizeRequest(req); }
        catch (error) { return accessFailure(res, error); }
        if (req.body?.event !== 'sos') return res.status(400).json({ success: false, error: 'sos_event_required' });
        const now = Date.now();
        for (const [uid, entry] of limits) if (entry.until <= now) limits.delete(uid);
        const entry = limits.get(identity.token.uid) || { count: 0, until: now + 60000 };
        entry.count++;
        limits.set(identity.token.uid, entry);
        if (entry.count > 15) return res.status(429).json({ success: false, error: 'too_many_requests' });
        try {
            const result = await send(identity.token);
            return res.status(result.success ? 200 : 503).json(result.success
                ? { success: true, mode: 'messaging_api' } : { success: false, error: 'line_unavailable' });
        } catch { return res.status(503).json({ success: false, error: 'line_unavailable' }); }
    };
}
export default createNotifyHandler();
