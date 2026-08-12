// In-memory rate limiting map (15 requests per minute per IP)
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const MAX_REQUESTS_PER_WINDOW = 15;

function checkRateLimit(ip) {
    const now = Date.now();
    const windowData = rateLimitMap.get(ip) || { count: 0, resetTime: now + RATE_LIMIT_WINDOW_MS };
    if (now > windowData.resetTime) {
        windowData.count = 1;
        windowData.resetTime = now + RATE_LIMIT_WINDOW_MS;
    } else {
        windowData.count++;
    }
    rateLimitMap.set(ip, windowData);
    return windowData.count > MAX_REQUESTS_PER_WINDOW;
}

export default async function handler(req, res) {
    const origin = req.headers.origin || '*';
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ success: false, error: 'Method Not Allowed' });
    }

    const clientIp = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown-ip';
    if (checkRateLimit(clientIp)) {
        console.warn(`[Vercel Notify] Rate limit exceeded for IP: ${clientIp}`);
        return res.status(429).json({
            success: false,
            error: 'ขออภัย คุณส่งข้อความถี่เกินไป (Rate limit exceeded) กรุณารอ 1 นาที'
        });
    }

    const notifyToken = process.env.LINE_NOTIFY_TOKEN || process.env.LINE_TOKEN || process.env['Line Token'];
    const channelToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
    const groupId = process.env.LINE_GROUP_ID || process.env.LINE_USER_ID;

    const { message, flexMessage, messages } = req.body || {};

    // Determine payload format
    let lineMessagesPayload = [];
    if (messages && Array.isArray(messages) && messages.length > 0) {
        lineMessagesPayload = messages;
    } else if (flexMessage) {
        lineMessagesPayload = [flexMessage];
    } else if (message) {
        lineMessagesPayload = [{ type: 'text', text: typeof message === 'string' ? message : JSON.stringify(message) }];
    } else {
        return res.status(400).json({ success: false, error: 'ไม่พบข้อความแจ้งเตือน (Missing message or flexMessage)' });
    }

    // 1. If Messaging API Channel Access Token is provided -> Send rich message / Flex Message
    if (channelToken && channelToken.trim() !== '') {
        try {
            const targetUrl = (groupId && groupId.trim() !== '') 
                ? 'https://api.line.me/v2/bot/message/push' 
                : 'https://api.line.me/v2/bot/message/broadcast';

            const bodyData = (groupId && groupId.trim() !== '')
                ? { to: groupId.trim(), messages: lineMessagesPayload }
                : { messages: lineMessagesPayload };

            const response = await fetch(targetUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${channelToken.trim()}`
                },
                body: JSON.stringify(bodyData)
            });

            if (response.ok) {
                console.log(`[Vercel LINE Messaging API] Sent successfully via ${targetUrl}!`);
                return res.status(200).json({ success: true, mode: 'messaging_api' });
            } else {
                const errData = await response.json().catch(() => ({}));
                console.error(`[Vercel LINE Messaging API] Error (HTTP ${response.status}):`, JSON.stringify(errData));
                // Fall through to LINE Notify if configured
                if (!notifyToken) {
                    return res.status(response.status).json({ 
                        success: false, 
                        error: errData.message || `ส่ง LINE Messaging API ไม่สำเร็จ (HTTP ${response.status})` 
                    });
                }
            }
        } catch (messagingErr) {
            console.error('[Vercel LINE Messaging API Exception]', messagingErr);
            if (!notifyToken) {
                return res.status(500).json({ success: false, error: messagingErr.message });
            }
        }
    }

    // 2. Fallback or Primary LINE Notify Token (Sends plain text message)
    if (notifyToken && notifyToken.trim() !== '') {
        try {
            // Extract text fallback from flex payload if needed
            let textMessage = message;
            if (!textMessage && flexMessage) {
                textMessage = flexMessage.altText || 'แจ้งเตือนจากระบบ Smart First Aid Box';
            }

            const response = await fetch('https://notify-api.line.me/api/notify', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Authorization': `Bearer ${notifyToken.trim()}`
                },
                body: new URLSearchParams({ message: textMessage })
            });

            if (response.ok) {
                console.log('[Vercel LINE Notify] Sent successfully via LINE Notify API!');
                return res.status(200).json({ success: true, mode: 'line_notify' });
            } else {
                const errText = await response.text();
                console.error(`[Vercel LINE Notify Error] HTTP ${response.status}: ${errText}`);
                return res.status(response.status).json({ success: false, error: `ส่ง LINE Notify ไม่สำเร็จ (HTTP ${response.status})` });
            }
        } catch (err) {
            console.error('[Vercel LINE Notify Exception]', err);
            return res.status(500).json({ success: false, error: err.message });
        }
    }

    console.error('[Vercel LINE] Neither LINE_CHANNEL_ACCESS_TOKEN nor LINE_NOTIFY_TOKEN configured');
    return res.status(500).json({ 
        success: false, 
        error: 'ยังไม่ได้ตั้งค่า LINE_CHANNEL_ACCESS_TOKEN หรือ LINE_NOTIFY_TOKEN บน Vercel' 
    });
}
