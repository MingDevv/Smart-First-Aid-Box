// API/ANALYZE.JS — Vercel Serverless Function for Secure Gemini Vision Analysis
export const config = {
    api: {
        bodyParser: {
            sizeLimit: '10mb'  // Allow large base64 images
        }
    }
};

// In-memory rate limiting map (10 requests per minute per IP)
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const MAX_REQUESTS_PER_WINDOW = 10;

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

// Safe user-facing error message (never expose internals)
const USER_ERROR_MSG = 'ขณะนี้ระบบ AI วิเคราะห์แผลขัดข้องชั่วคราว กรุณาลองใหม่อีกครั้ง หรือเลือกประเภทแผลด้วยตนเองด้านล่าง';

export default async function handler(req, res) {
    // Set CORS headers safely
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

    // Rate Limiting check
    const clientIp = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown-ip';
    if (checkRateLimit(clientIp)) {
        console.warn(`[Vercel Analyze] Rate limit exceeded for IP: ${clientIp}`);
        return res.status(429).json({
            success: false,
            error: 'ขออภัย คุณใช้งานเกินจำนวนครั้งที่กำหนด กรุณารอ 1 นาที'
        });
    }

    const apiKey = process.env.GEMINI_API_KEY || process.env.GEMINI_KEY || process.env['Gemini Key'];
    if (!apiKey || apiKey.trim() === '') {
        console.error('[Vercel] CRITICAL: No Gemini API key found in any env variable');
        return res.status(500).json({ success: false, error: USER_ERROR_MSG });
    }

    console.log('[Vercel] API Key present, length:', apiKey.trim().length);

    try {
        const { image } = req.body || {};
        if (!image) {
            console.error('[Vercel] No image data in request body');
            return res.status(400).json({ success: false, error: USER_ERROR_MSG });
        }

        const matches = image.match(/^data:([a-zA-Z0-9]+\/[a-zA-Z0-9\-.+]+);base64,(.+)$/);
        if (!matches) {
            console.error('[Vercel] Invalid base64 image format');
            return res.status(400).json({ success: false, error: USER_ERROR_MSG });
        }
        
        const mimeType = matches[1];
        const base64Data = matches[2];
        
        console.log(`[Vercel] Image received: mimeType=${mimeType}, base64Length=${base64Data.length}`);

        const prompt = `คุณคือระบบ AI ผู้เชี่ยวชาญด้านวิเคราะห์บาดแผลและปฐมพยาบาลเบื้องต้นสำหรับนักเรียนในโรงเรียน

โปรดวิเคราะห์ภาพถ่ายนี้อย่างละเอียดที่สุด แล้วจำแนกประเภทบาดแผลออกเป็น 1 ใน 3 ประเภทต่อไปนี้เท่านั้น:

1. **cut_abrasion** (มีดบาด / แผลถลอก)
   - ลักษณะสำคัญ: รอยขูดขีดยาวบนผิวหนัง, ผิวหนังชั้นนอกถลอกเป็นปื้นหรือหลุดลอก, รอยบาดเป็นเส้นตรง/โค้งจากของมีคม, มีเลือดซึมหรือรอยสะเก็ดแผลสดแดง, ขอบแผลชัดเจน

2. **insect** (แมลงสัตว์กัดต่อย)
   - ลักษณะสำคัญ: ตุ่มนูนแดงเป็นวงกลมหรือวงรีเฉพาะจุด 1-3 ตำแหน่ง, รอยบวมแดงรอบจุดกลาง, จุดแดงเล็กตรงกลาง (รอยกัดหรือรอยเหล็กใน), ไม่มีผิวหนังถลอกหลุดลอกเป็นแผ่นกว้าง, อาจมีรอยผื่นแดงรอบ

3. **unknown** (ไม่สามารถระบุได้)
   - ใช้เมื่อ: ภาพมืดมาก/เบลอจนไม่เห็นรายละเอียด, ไม่ใช่ภาพบาดแผลบนผิวหนังมนุษย์, เป็นบาดแผลรุนแรงเกินขอบเขตปฐมพยาบาลเบื้องต้น

กฎสำคัญ:
- ดูที่ลักษณะทางกายภาพของแผลในภาพเท่านั้น
- ถ้าไม่แน่ใจ ให้ตอบ unknown พร้อม confidence ต่ำ
- confidence ต้องสะท้อนความมั่นใจจริงๆ ห้ามให้สูงถ้าภาพไม่ชัด

ตอบเป็น JSON เท่านั้นในรูปแบบนี้ (ห้ามใส่ markdown code block):
{"woundId": "cut_abrasion|insect|unknown", "confidence": 0-100, "description": "คำอธิบายลักษณะแผลสั้นๆ", "reasoning": "เหตุผลที่เลือก"}`;

        // Build a simple, compatible payload (no responseSchema for max compatibility)
        // NOTE: Gemini 3.x are "thinking models" — internal reasoning tokens consume maxOutputTokens
        // Must set high enough to accommodate thinking + actual JSON output
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
                maxOutputTokens: 2048,
                thinkingConfig: {
                    thinkingBudget: 0
                }
            }
        };

        // Candidate models — Aug 2026 (Gemini 1.x/2.x fully retired)
        const candidateModels = ['gemini-3.5-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite'];
        let responseData = null;
        let lastErrorMessage = '';

        for (const modelName of candidateModels) {
            const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey.trim()}`;
            try {
                console.log(`[Vercel] Trying model: ${modelName}...`);
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 15000);

                const response = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                    signal: controller.signal
                });
                clearTimeout(timeoutId);

                console.log(`[Vercel] Model ${modelName} HTTP status: ${response.status}`);

                if (response.ok) {
                    responseData = await response.json();
                    console.log(`[Vercel] ✅ Model ${modelName} responded OK`);
                    break;
                } else {
                    const errText = await response.text().catch(() => '');
                    lastErrorMessage = `HTTP ${response.status}: ${errText.substring(0, 200)}`;
                    console.warn(`[Vercel] ❌ Model ${modelName} failed (${response.status}): ${errText.substring(0, 300)}`);
                }
            } catch (err) {
                lastErrorMessage = err.name === 'AbortError' ? 'Timeout (15s)' : (err.message || 'Fetch error');
                console.warn(`[Vercel] ❌ Model ${modelName} exception: ${lastErrorMessage}`);
            }
        }

        if (!responseData) {
            console.error('[Vercel] ALL candidate models failed. Last error:', lastErrorMessage);
            return res.status(502).json({ success: false, error: USER_ERROR_MSG });
        }

        // Extract text response from Gemini
        // Gemini 3.x "thinking models" may return multiple parts: thought parts + text part
        // We need to find the actual text part (not the thought/thinking part)
        const parts = responseData.candidates?.[0]?.content?.parts || [];
        let textResponse = null;
        
        // First try to find a part with 'text' but no 'thought' flag
        for (const part of parts) {
            if (part.text && !part.thought) {
                textResponse = part.text;
                break;
            }
        }
        // Fallback: just get any text from any part
        if (!textResponse) {
            for (const part of parts) {
                if (part.text) {
                    textResponse = part.text;
                    break;
                }
            }
        }
        
        console.log(`[Vercel] Parts count: ${parts.length}, Raw AI text (first 500 chars): ${String(textResponse).substring(0, 500)}`);

        if (!textResponse) {
            console.error('[Vercel] No text found in Gemini response. Full structure:', JSON.stringify(responseData).substring(0, 800));
            return res.status(502).json({ success: false, error: USER_ERROR_MSG });
        }

        // Robust JSON parsing — handle markdown code fences and extra text
        let parsedResult;
        try {
            // Strip markdown code fences if present: ```json ... ``` or ``` ... ```
            let cleanText = textResponse.trim();
            const jsonMatch = cleanText.match(/```(?:json)?\s*([\s\S]*?)```/);
            if (jsonMatch) {
                cleanText = jsonMatch[1].trim();
            }
            parsedResult = JSON.parse(cleanText);
        } catch (parseErr) {
            console.error('[Vercel] JSON parse failed. Raw text:', textResponse.substring(0, 300));
            console.error('[Vercel] Parse error:', parseErr.message);
            // Try to extract JSON object from text with regex as last resort
            const jsonObjMatch = textResponse.match(/\{[\s\S]*?"woundId"[\s\S]*?\}/);
            if (jsonObjMatch) {
                try {
                    parsedResult = JSON.parse(jsonObjMatch[0]);
                    console.log('[Vercel] Recovered JSON from regex extraction');
                } catch (e2) {
                    return res.status(502).json({ success: false, error: USER_ERROR_MSG });
                }
            } else {
                return res.status(502).json({ success: false, error: USER_ERROR_MSG });
            }
        }

        // Validate and sanitize the parsed result
        const validWoundIds = ['cut_abrasion', 'insect', 'unknown'];
        const woundId = validWoundIds.includes(parsedResult.woundId) ? parsedResult.woundId : 'unknown';
        const confidence = (typeof parsedResult.confidence === 'number' && parsedResult.confidence >= 0 && parsedResult.confidence <= 100)
            ? parsedResult.confidence : 50;

        console.log(`[Vercel] ✅ AI Result: ${woundId} (${confidence}%) — ${parsedResult.reasoning || 'N/A'}`);

        return res.status(200).json({
            success: true,
            mode: 'serverless',
            woundId: woundId,
            confidence: confidence,
            description: parsedResult.description || 'วิเคราะห์เรียบร้อย',
            reasoning: parsedResult.reasoning || ''
        });

    } catch (error) {
        console.error(`[Vercel] UNHANDLED ERROR: name=${error.name}, message=${error.message}, stack=${String(error.stack).substring(0, 300)}`);
        return res.status(500).json({ success: false, error: USER_ERROR_MSG });
    }
}
