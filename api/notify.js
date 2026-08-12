// API/NOTIFY.JS — Vercel Serverless Function for LINE Messaging API (Push Message)
export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ success: false, error: 'Method Not Allowed' });
    }

    const notifyToken = process.env.LINE_NOTIFY_TOKEN || process.env.LINE_TOKEN || process.env['Line Token'];
    const channelToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
    const groupId = process.env.LINE_GROUP_ID || process.env.LINE_USER_ID;

    // 1. Prioritize LINE Notify Token if provided (Direct push to the pre-selected LINE Group/Chat)
    if (notifyToken && notifyToken.trim() !== '') {
        try {
            const { message } = req.body || {};
            if (!message) {
                return res.status(400).json({ success: false, error: 'ไม่พบข้อความแจ้งเตือน (Missing message)' });
            }

            const response = await fetch('https://notify-api.line.me/api/notify', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Authorization': `Bearer ${notifyToken.trim()}`
                },
                body: new URLSearchParams({ message })
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

    // 2. Messaging API Integration (Push to Group or Broadcast to All Followers)
    const tokenToUse = channelToken || notifyToken;

    if (!tokenToUse || tokenToUse.trim() === '') {
        console.error('[Vercel LINE] Neither LINE_NOTIFY_TOKEN nor LINE_CHANNEL_ACCESS_TOKEN configured');
        return res.status(500).json({ 
            success: false, 
            error: 'ยังไม่ได้ตั้งค่า LINE_CHANNEL_ACCESS_TOKEN บน Vercel' 
        });
    }

    try {
        const { message } = req.body || {};
        if (!message) {
            return res.status(400).json({ success: false, error: 'ไม่พบข้อความแจ้งเตือน (Missing message)' });
        }

        // If Group ID provided -> Push to group; Else -> Broadcast to all bot friends/followers
        const targetUrl = (groupId && groupId.trim() !== '') 
            ? 'https://api.line.me/v2/bot/message/push' 
            : 'https://api.line.me/v2/bot/message/broadcast';

        const bodyData = (groupId && groupId.trim() !== '')
            ? { to: groupId.trim(), messages: [{ type: 'text', text: message }] }
            : { messages: [{ type: 'text', text: message }] };

        const response = await fetch(targetUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${tokenToUse.trim()}`
            },
            body: JSON.stringify(bodyData)
        });

        if (response.ok) {
            console.log(`[Vercel LINE] Message sent successfully via ${targetUrl}!`);
            return res.status(200).json({ success: true, mode: 'messaging_api' });
        } else {
            const errData = await response.json().catch(() => ({}));
            console.error(`[Vercel LINE] Push failed (HTTP ${response.status}):`, JSON.stringify(errData));
            return res.status(response.status).json({ 
                success: false, 
                error: errData.message || `ส่ง LINE ไม่สำเร็จ (HTTP ${response.status})` 
            });
        }
    } catch (error) {
        console.error('[Vercel LINE] Serverless Notification Error:', error);
        return res.status(500).json({ success: false, error: error.message || 'Server error' });
    }
}
