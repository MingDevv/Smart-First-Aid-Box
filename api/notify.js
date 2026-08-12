// API/NOTIFY.JS — Vercel Serverless Function for Secure LINE Notification
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

    const lineToken = process.env.LINE_TOKEN || process.env.LINE_NOTIFY_TOKEN;
    if (!lineToken || lineToken.trim() === '') {
        return res.status(500).json({ 
            success: false, 
            error: 'ยังไม่ได้ตั้งค่า LINE_TOKEN บน Vercel Environment Variables' 
        });
    }

    try {
        const { message } = req.body || {};
        if (!message) {
            return res.status(400).json({ success: false, error: 'ไม่พบข้อความแจ้งเตือน (Missing message)' });
        }

        const response = await fetch('https://notify-api.line.me/api/notify', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Authorization': `Bearer ${lineToken.trim()}`
            },
            body: new URLSearchParams({ message: message })
        });

        if (response.ok) {
            console.log(`[Vercel Server Log] LINE Notification Sent Successfully!`);
            return res.status(200).json({ success: true, mode: 'serverless' });
        } else {
            console.error(`[Vercel Server Log] LINE Notification Failed: HTTP ${response.status}`);
            return res.status(response.status).json({ 
                success: false, 
                error: `ส่ง LINE ไม่สำเร็จ (HTTP ${response.status})` 
            });
        }
    } catch (error) {
        console.error('[Vercel Serverless Notification Error]', error);
        return res.status(500).json({ success: false, error: error.message || 'Server error' });
    }
}
