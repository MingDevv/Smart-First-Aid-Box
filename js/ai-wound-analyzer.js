// JS/AI-WOUND-ANALYZER.JS
const AiWoundAnalyzer = {
    // Perform AI analysis on a base64 encoded image of a wound
    async analyzeWound(base64DataWithPrefix) {
        let settings = { geminiApiKey: '' };
        if (window.StorageService) {
            settings = window.StorageService.getSettings();
        }

        // Check if API key exists
        if (!settings.geminiApiKey || settings.geminiApiKey.trim() === '') {
            console.log('[AI Analyzer] No Gemini API Key configured. Running in simulation mode.');
            return this.getSimulatedWoundResult();
        }

        try {
            const matches = base64DataWithPrefix.match(/^data:([a-zA-Z0-9]+\/[a-zA-Z0-9-.+]+);base64,(.+)$/);
            if (!matches) {
                throw new Error('รูปแบบไฟล์รูปภาพไม่ถูกต้อง (Invalid base64 image format)');
            }
            
            const mimeType = matches[1];
            const base64Data = matches[2];

            const apiKey = settings.geminiApiKey.trim();
            // Use stable Gemini model endpoint
            const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;

            const prompt = `วิเคราะห์ภาพบาดแผลนี้แล้วเลือกประเภทแผลที่ตรงที่สุดจาก 3 ประเภทนี้เท่านั้น:

1. **cut_abrasion** (มีดบาด / แผลถลอก) — มีรอยขูดขีด ผิวหนังชั้นนอกหลุดลอก แผลโดนของมีคมบาด หรือมีเลือดซึมเล็กน้อย
2. **insect** (แมลงสัตว์กัดต่อย) — มีตุ่มนูนแดง คัน รอยจุดกัด หรือรอยเหล็กในผึ้ง/มดกัด
3. **unknown** (ไม่สามารถระบุได้) — ภาพมืด เบลอ ไม่ใช่บาดแผลบนร่างกาย หรือเป็นแผลรุนแรงมากที่เกินขอบเขตการปฐมพยาบาลเบื้องต้น (เช่น แผลลึก เลือดไหลไม่หยุด หมากัด)

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
                    temperature: 0.2,
                    responseMimeType: "application/json",
                    responseSchema: {
                        type: "OBJECT",
                        properties: {
                            woundId: {
                                type: "STRING",
                                enum: ["cut_abrasion", "insect", "unknown"],
                                description: "The wound type that best matches the image."
                            },
                            confidence: {
                                type: "INTEGER",
                                description: "Confidence percentage (0-100)."
                            },
                            description: {
                                type: "STRING",
                                description: "Brief Thai explanation of observed features."
                            }
                        },
                        required: ["woundId", "confidence", "description"]
                    }
                }
            };

            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(payload)
            });

            if (!response.ok) {
                const errData = await response.json().catch(() => ({}));
                throw new Error(errData?.error?.message || `HTTP error! status: ${response.status}`);
            }

            const data = await response.json();
            const textResponse = data.candidates?.[0]?.content?.parts?.[0]?.text;
            if (!textResponse) {
                throw new Error('ไม่ได้รับคำตอบจากโมเดล AI (Empty response from AI model)');
            }

            const parsedResult = JSON.parse(textResponse.trim());
            return {
                success: true,
                mode: 'production',
                woundId: parsedResult.woundId || 'unknown',
                confidence: typeof parsedResult.confidence === 'number' ? parsedResult.confidence : 80,
                description: parsedResult.description || 'วิเคราะห์โดยระบบเรียบร้อย'
            };

        } catch (error) {
            console.error('[AI Analyzer Error] Gemini API failed:', error);
            return {
                success: false,
                mode: 'error',
                error: error.message || 'การเรียก AI ขัดข้อง'
            };
        }
    },

    // Return a mocked classification result (Explicit Simulation mode)
    async getSimulatedWoundResult(errorReason = '') {
        const options = [
            { woundId: 'cut_abrasion', confidence: 95, description: 'พบรอยขูดขีดบนผิวหนังและรอยเลือดซึม สอดคล้องกับแผลมีดบาด/แผลถลอกทั่วไป' },
            { woundId: 'insect', confidence: 92, description: 'พบบาดแผลบวมแดงนูนตรงกลางเฉพาะจุด สอดคล้องกับแมลงสัตว์กัดต่อย' }
        ];

        await new Promise(resolve => setTimeout(resolve, 1500));

        const randomResult = options[Math.floor(Math.random() * options.length)];
        
        return {
            success: true,
            mode: 'simulation',
            woundId: randomResult.woundId,
            confidence: randomResult.confidence,
            description: randomResult.description + (errorReason ? ` (${errorReason})` : '')
        };
    }
};

window.AiWoundAnalyzer = AiWoundAnalyzer;

