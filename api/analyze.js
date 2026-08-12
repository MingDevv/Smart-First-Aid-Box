// API/ANALYZE.JS — Vercel Serverless Function for Secure Gemini Vision Analysis
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

        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey.trim()}`;

        const prompt = `คุณคือระบบ AI ผู้เชี่ยวชาญด้านวิเคราะห์บาดแผลและปฐมพยาบาลเบื้องต้น 

โปรดวิเคราะห์ภาพถ่ายบาดแผลนี้อย่างละเอียด แล้วจำแนกประเภทบาดแผลออกเป็น 1 ใน 3 ประเภทต่อไปนี้เท่านั้น:

1. **cut_abrasion** (มีดบาด / แผลถลอก)
   - ลักษณะทางทัศนวิสัย: รอยขูดขีดบนผิวหนัง, ผิวหนังชั้นนอกถลอกเป็นปื้น, รอยบาดเป็นเส้นตรงจากของมีคม, มีเลือดซึมหรือรอยสะเก็ดแผลสด
2. **insect** (แมลงสัตว์กัดต่อย)
   - ลักษณะทางทัศนวิสัย: ตุ่มนูนแดงเป็นวงกลมหรือวงรีเฉพาะจุด, รอยบวมแดงจากการอักเสบ, จุดแดงตรงกลาง (รอยกัด/เหล็กใน), ไม่มีผิวหนังถลอกหลุดลอกเป็นแผ่น
3. **unknown** (ไม่สามารถระบุได้)
   - ลักษณะทางทัศนวิสัย: ภาพมืด เบลอ หลุดโฟกัส, ไม่ใช่ภาพบาดแผลบนผิวหนังมนุษย์, หรือเป็นบาดแผลรุนแรงที่เกินขอบเขตตู้ปฐมพยาบาล (เช่น เลือดไหลไม่หยุด แผลลึกเห็นกระดูก/กล้ามเนื้อ แผลไฟไหม้พอง รอยหมากัด)

ตอบเป็นโครงสร้าง JSON เท่านั้น`;

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
                            description: "ระดับความมั่นใจเป็นเปอร์เซ็นต์ (0-100)"
                        },
                        description: {
                            type: "STRING",
                            description: "คำอธิบายลักษณะบาดแผลภาษาไทยสั้นๆ ที่สังเกตเห็นจากภาพ"
                        },
                        reasoning: {
                            type: "STRING",
                            description: "เหตุผลสั้นๆ ที่เลือกระบุประเภทนี้"
                        }
                    },
                    required: ["woundId", "confidence", "description", "reasoning"]
                }
            }
        };

        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            const errData = await response.json().catch(() => ({}));
            return res.status(response.status).json({ 
                success: false, 
                error: errData?.error?.message || `Gemini API error! status: ${response.status}` 
            });
        }

        const data = await response.json();
        const textResponse = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!textResponse) {
            return res.status(500).json({ success: false, error: 'ไม่ได้รับคำตอบจากโมเดล AI' });
        }

        const parsedResult = JSON.parse(textResponse.trim());

        console.log(`[Vercel Server Log] AI Analyzed Result: ${parsedResult.woundId} (${parsedResult.confidence}%)`);

        return res.status(200).json({
            success: true,
            mode: 'serverless',
            woundId: parsedResult.woundId || 'unknown',
            confidence: typeof parsedResult.confidence === 'number' ? parsedResult.confidence : 80,
            description: parsedResult.description || 'วิเคราะห์เรียบร้อย',
            reasoning: parsedResult.reasoning || ''
        });

    } catch (error) {
        console.error('[Vercel Serverless Error]', error);
        return res.status(500).json({ success: false, error: error.message || 'Server error' });
    }
}
