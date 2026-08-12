// API/ANALYZE.JS — Vercel Serverless Function for Secure Gemini Vision Analysis
export const config = {
    api: {
        bodyParser: {
            sizeLimit: '10mb'  // Allow large base64 images
        }
    }
};

export default async function handler(req, res) {
    // Set CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ success: false, error: 'Method Not Allowed' });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey || apiKey.trim() === '') {
        console.error('[Vercel] GEMINI_API_KEY is not configured in Environment Variables');
        return res.status(500).json({ 
            success: false, 
            error: 'ยังไม่ได้ตั้งค่า GEMINI_API_KEY บน Vercel Environment Variables' 
        });
    }

    try {
        const { image } = req.body || {};
        if (!image) {
            return res.status(400).json({ success: false, error: 'ไม่พบข้อมูลรูปภาพ (Missing image)' });
        }

        const matches = image.match(/^data:([a-zA-Z0-9]+\/[a-zA-Z0-9-.+]+);base64,(.+)$/);
        if (!matches) {
            return res.status(400).json({ success: false, error: 'รูปแบบไฟล์รูปภาพไม่ถูกต้อง (Invalid base64 format)' });
        }
        
        const mimeType = matches[1];
        const base64Data = matches[2];

        // Use gemini-2.0-flash — stable, free-tier compatible, fast, supports vision
        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey.trim()}`;

        const prompt = `คุณคือระบบ AI ผู้เชี่ยวชาญด้านวิเคราะห์บาดแผลและปฐมพยาบาลเบื้องต้นสำหรับนักเรียนในโรงเรียน

โปรดวิเคราะห์ภาพถ่ายนี้อย่างละเอียดที่สุด แล้วจำแนกประเภทบาดแผลออกเป็น 1 ใน 3 ประเภทต่อไปนี้เท่านั้น:

1. **cut_abrasion** (มีดบาด / แผลถลอก)
   - ลักษณะสำคัญ: รอยขูดขีดยาวบนผิวหนัง, ผิวหนังชั้นนอกถลอกเป็นปื้นหรือหลุดลอก, รอยบาดเป็นเส้นตรง/โค้งจากของมีคม, มีเลือดซึมหรือรอยสะเก็ดแผลสดแดง, ขอบแผลชัดเจน

2. **insect** (แมลงสัตว์กัดต่อย)
   - ลักษณะสำคัญ: ตุ่มนูนแดงเป็นวงกลมหรือวงรีเฉพาะจุด 1-3 ตำแหน่ง, รอยบวมแดงรอบจุดกลาง, จุดแดงเล็กตรงกลาง (รอยกัดหรือรอยเหล็กใน), ไม่มีผิวหนังถลอกหลุดลอกเป็นแผ่นกว้าง, อาจมีรอยผื่นแดงรอบ

3. **unknown** (ไม่สามารถระบุได้)
   - ใช้เมื่อ: ภาพมืดมาก/เบลอจนไม่เห็นรายละเอียด, ไม่ใช่ภาพบาดแผลบนผิวหนังมนุษย์, เป็นบาดแผลรุนแรงเกินขอบเขตปฐมพยาบาลเบื้องต้น (เลือดไหลไม่หยุด, แผลลึกมาก, แผลไฟไหม้พอง, รอยสัตว์ใหญ่กัด)

กฎสำคัญ:
- ดูที่ลักษณะทางกายภาพของแผลในภาพเท่านั้น
- ถ้าไม่แน่ใจ ให้ตอบ unknown พร้อม confidence ต่ำ
- confidence ต้องสะท้อนความมั่นใจจริงๆ ห้ามให้สูงถ้าภาพไม่ชัด

ตอบเป็น JSON เท่านั้น`;

        const payload = {
            contents: [
                {
                    parts: [
                        { text: prompt },
                        {
                            inlineData: {
                                mimeType: mimeType,
                                data: base64Data
                            }
                        }
                    ]
                }
            ],
            generationConfig: {
                temperature: 0.1,
                maxOutputTokens: 256,
                responseMimeType: "application/json",
                responseSchema: {
                    type: "OBJECT",
                    properties: {
                        woundId: {
                            type: "STRING",
                            enum: ["cut_abrasion", "insect", "unknown"],
                            description: "ประเภทบาดแผลที่ตรงกับภาพที่สุด"
                        },
                        confidence: {
                            type: "INTEGER",
                            description: "ระดับความมั่นใจเป็นเปอร์เซ็นต์ (0-100) สะท้อนความชัดเจนของภาพและลักษณะแผลจริง"
                        },
                        description: {
                            type: "STRING",
                            description: "คำอธิบายลักษณะบาดแผลภาษาไทยสั้นๆ ที่สังเกตเห็นจากภาพ"
                        },
                        reasoning: {
                            type: "STRING",
                            description: "เหตุผลสั้นๆ ที่เลือกระบุประเภทนี้ โดยอ้างอิงจากสิ่งที่เห็นในภาพ"
                        }
                    },
                    required: ["woundId", "confidence", "description", "reasoning"]
                }
            }
        };

        // Call Gemini with 15 second timeout
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000);

        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: controller.signal
        });
        clearTimeout(timeoutId);

        if (!response.ok) {
            const errData = await response.json().catch(() => ({}));
            console.error('[Vercel] Gemini API Error:', response.status, errData?.error?.message);
            return res.status(502).json({ 
                success: false, 
                error: errData?.error?.message || `Gemini API error (HTTP ${response.status})` 
            });
        }

        const data = await response.json();
        const textResponse = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!textResponse) {
            console.error('[Vercel] Empty response from Gemini');
            return res.status(502).json({ success: false, error: 'ไม่ได้รับคำตอบจากโมเดล AI' });
        }

        const parsedResult = JSON.parse(textResponse.trim());

        console.log(`[Vercel] ✅ AI Result: ${parsedResult.woundId} (${parsedResult.confidence}%) — ${parsedResult.reasoning}`);

        return res.status(200).json({
            success: true,
            mode: 'serverless',
            woundId: parsedResult.woundId || 'unknown',
            confidence: typeof parsedResult.confidence === 'number' ? parsedResult.confidence : 50,
            description: parsedResult.description || 'วิเคราะห์เรียบร้อย',
            reasoning: parsedResult.reasoning || ''
        });

    } catch (error) {
        if (error.name === 'AbortError') {
            console.error('[Vercel] Gemini API Timeout (15s)');
            return res.status(504).json({ success: false, error: 'AI วิเคราะห์ไม่ทันภายใน 15 วินาที กรุณาลองใหม่' });
        }
        console.error('[Vercel] Serverless Error:', error.message);
        return res.status(500).json({ success: false, error: error.message || 'Server error' });
    }
}
