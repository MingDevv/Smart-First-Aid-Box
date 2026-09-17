import { responseSignature } from './cabinet-protocol.js';

export async function readCabinetBody(req) {
    let body;
    if (typeof req.body === 'string' || Buffer.isBuffer(req.body)) body = Buffer.from(req.body);
    else {
        // บาง adapter ให้มาแค่ stream ตู้ส่งมาเป็น octet-stream Vercel จึงแปลงเป็น Buffer ให้
        // ห้ามเอา JSON ที่ถูก parse แล้วมาแปลงกลับเป็นข้อความอีกรอบ
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
            size += chunk.length;
            if (size > 65536) throw Object.assign(new Error('body_too_large'), { status: 413 });
            chunks.push(chunk);
        }
        body = Buffer.concat(chunks);
    }
    if (body.length > 65536) throw Object.assign(new Error('body_too_large'), { status: 413 });
    return body.toString('utf8');
}
export function signedResponse(res, auth, status, data, etag = '') {
    const body = status === 304 ? '' : JSON.stringify(data);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json');
    if (etag) res.setHeader('ETag', etag);
    res.setHeader('X-SFAB-Signature', responseSignature(auth.secret, auth.signature, status, etag, body));
    res.status(status).end(body);
}
export function cabinetFailure(res, error) {
    const status = [400, 401, 409, 413, 503].includes(error.status) ? error.status : 503;
    return res.status(status).json({ success: false, error: status === 503 ? 'service_unavailable' :
        ({ 400: 'invalid_request', 401: 'invalid_cabinet_signature', 409: 'event_conflict', 413: 'body_too_large' })[status] });
}
