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
                description: parsedResult.description || 'วิเคราะห์โดยระบบเรียบร้อย',
                reasoning: parsedResult.reasoning || ''
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

