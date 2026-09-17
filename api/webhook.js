import crypto from 'crypto';

// รับ webhook จาก LINE ใช้ตอนตั้งค่าเพื่อดูว่า group id ของกลุ่มครูคืออะไร
export default async function handler(req, res) {
    if (req.method === 'GET') {
        return res.status(200).send('LINE Webhook Listener is active!');
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ success: false, error: 'Method Not Allowed' });
    }

    // ถ้าตั้ง LINE_CHANNEL_SECRET ไว้ ให้ตรวจลายเซ็นก่อนเชื่อว่ามาจาก LINE จริง
    const channelSecret = process.env.LINE_CHANNEL_SECRET;
    const signature = req.headers['x-line-signature'];

    if (channelSecret && channelSecret.trim() !== '') {
        if (!signature) {
            console.error('[LINE Webhook] Rejected: Missing X-Line-Signature header');
            return res.status(401).json({ success: false, error: 'Unauthorized: Missing X-Line-Signature' });
        }

        const bodyRaw = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
        const expectedSignature = crypto
            .createHmac('sha256', channelSecret.trim())
            .update(bodyRaw)
            .digest('base64');

        if (signature !== expectedSignature) {
            console.error('[LINE Webhook] Rejected: Invalid signature');
            return res.status(401).json({ success: false, error: 'Unauthorized: Invalid signature' });
        }
    }

    try {
        const events = req.body?.events || [];
        for (const event of events) {
            const sourceType = event.source?.type; // 'user', 'group', or 'room'
            const userId = event.source?.userId;
            const groupId = event.source?.groupId;
            const roomId = event.source?.roomId;

            console.log(`[LINE Webhook Log] Event Type: ${event.type} | Source Type: ${sourceType}`);
            if (groupId) {
                console.log(`[LINE Webhook Log] ⭐ GROUP ID FOUND: ${groupId}`);
            }
            if (userId) {
                console.log(`[LINE Webhook Log] ⭐ USER ID FOUND: ${userId}`);
            }
            if (roomId) {
                console.log(`[LINE Webhook Log] ⭐ ROOM ID FOUND: ${roomId}`);
            }
        }

        // ตอบ 200 เสมอ ไม่งั้น LINE จะถือว่าตรวจ webhook ไม่ผ่าน
        return res.status(200).json({ success: true });
    } catch (error) {
        console.error('[LINE Webhook Error]', error);
        return res.status(200).json({ success: true }); // Return 200 so LINE doesn't flag failure
    }
}
