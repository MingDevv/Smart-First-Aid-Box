// JS/AI-WOUND-ANALYZER.JS
const AiWoundAnalyzer = {
    // Perform AI analysis on a base64 encoded image of a wound
    async analyzeWound(base64DataWithPrefix) {
        // 1. Get settings for Gemini API Key
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
            // Extract pure base64 content and mime type
            const matches = base64DataWithPrefix.match(/^data:([a-zA-Z0-9]+\/[a-zA-Z0-9-.+]+);base64,(.+)$/);
            if (!matches) {
                throw new Error('Invalid base64 image format');
            }
            
            const mimeType = matches[1];
            const base64Data = matches[2];

            // 2. Prepare API payload — ใช้ Gemini 2.5 Pro ซึ่งมีความแม่นยำสูงกว่า 2.0 Flash มากในการวิเคราะห์ภาพทางการแพทย์
            const apiKey = settings.geminiApiKey.trim();
            const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro-preview-06-05:generateContent?key=${apiKey}`;

            const prompt = `คุณคือผู้เชี่ยวชาญด้านเวชศาสตร์ฉุกเฉินและการปฐมพยาบาล โปรดวิเคราะห์ภาพบาดแผลนี้อย่างเป็นขั้นตอน

## ขั้นตอนที่ 1: สังเกตลักษณะทางกายภาพ
วิเคราะห์ภาพโดยพิจารณาสิ่งต่อไปนี้:
- ผิวหนังมีรอยฉีกขาด แยกตัว หรือเปิดเป็นแผลหรือไม่?
- มีเลือดไหล ซึม หรือเลือดออกหรือไม่?
- มีรอยแดง บวม ช้ำ หรือสีผิวเปลี่ยนแปลงหรือไม่?
- มีตุ่มน้ำพอง ผิวหนังลอก หรือรอยไหม้หรือไม่?
- มีตุ่มคัน รอยจุดกัด หรือรอยนูนเฉพาะจุดหรือไม่?
- บริเวณนั้นเป็นข้อต่อที่บวมแดงผิดปกติหรือไม่?

## ขั้นตอนที่ 2: เปรียบเทียบกับ 6 ประเภทบาดแผล
จำแนกแผลออกเป็นหนึ่งในประเภทต่อไปนี้เท่านั้น:

1. **abrasion** (แผลถลอก) — ผิวหนังชั้นนอกหลุดลอก มีรอยขูดขีด ถลอก อาจมีเลือดซึมเล็กน้อย มักเกิดจากการล้มเสียดสีกับพื้น มักเห็นเศษดินหรือสิ่งสกปรกฝังตัว ผิวหนังแดงระเรื่อเป็นบริเวณกว้าง
2. **cut** (แผลบาด/ฉีกขาด) — ผิวหนังแยกออกจากกันเป็นรอยตัดชัดเจน ขอบแผลเรียบ(บาด)หรือไม่เรียบ(ฉีกขาด) มีเลือดไหลออกมาชัดเจน แผลมีความลึก สาเหตุมักจากของมีคม
3. **bruise** (แผลฟกช้ำ) — ไม่มีแผลเปิด ไม่มีเลือดออก แต่มีรอยจ้ำสีม่วง เขียว น้ำเงิน หรือเหลืองใต้ผิวหนัง เกิดจากเส้นเลือดฝอยแตกใต้ผิวหนังเนื่องจากการกระแทก อาจมีอาการบวมร่วมด้วย
4. **burn** (แผลไหม้/น้ำร้อนลวก) — ผิวหนังแดงจัด มีตุ่มน้ำพอง(Blister) ผิวหนังลอก หรือไหม้ดำ สาเหตุจากความร้อน ของร้อน สารเคมี มักมีขอบเขตรอยไหม้ชัดเจน
5. **sprain** (เคล็ดขัดยอก) — ไม่มีแผลเปิดที่ผิวหนัง แต่พบอาการบวมแดงชัดเจนบริเวณข้อต่อ เช่น ข้อเท้า ข้อมือ อาจมีรอยช้ำร่วมด้วย บ่งบอกว่าเส้นเอ็นหรือกล้ามเนื้อได้รับบาดเจ็บ
6. **insect** (แมลงสัตว์กัดต่อย) — มีตุ่มนูนแดง คัน เฉพาะจุด อาจเห็นรอยจุดกัดตรงกลาง พบรอยเหล็กในของผึ้ง หรือรอยกัดคู่ของมดหรือแมงมุม บริเวณรอบๆ อาจบวมแดงเป็นวง

## ขั้นตอนที่ 3: สรุปผล
- เลือกประเภทแผลที่ตรงกับภาพมากที่สุดเพียง 1 ประเภท
- ให้คะแนนความมั่นใจ (0-100) ตามความชัดเจนของลักษณะบาดแผลที่พบ
- อธิบายเป็นภาษาไทยสั้นๆ ว่าเห็นลักษณะอะไรในภาพที่ทำให้เลือกประเภทนี้

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
                                enum: ["abrasion", "cut", "bruise", "burn", "sprain", "insect"],
                                description: "The wound type that best matches the image."
                            },
                            confidence: {
                                type: "INTEGER",
                                description: "Confidence percentage (0-100) based on how clearly the visual indicators match."
                            },
                            description: {
                                type: "STRING",
                                description: "Brief Thai explanation of what visual features were observed and why this wound type was chosen."
                            }
                        },
                        required: ["woundId", "confidence", "description"]
                    }
                }
            };

            // 3. Make fetch request
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
            
            // Extract JSON text from Gemini response structure
            const textResponse = data.candidates?.[0]?.content?.parts?.[0]?.text;
            if (!textResponse) {
                throw new Error('Empty response from AI model');
            }

            // Parse result
            const parsedResult = JSON.parse(textResponse.trim());
            return {
                success: true,
                mode: 'production',
                woundId: parsedResult.woundId,
                confidence: parsedResult.confidence || 90,
                description: parsedResult.description || 'วิเคราะห์โดยระบบ AI'
            };

        } catch (error) {
            console.error('[AI Analyzer] Gemini API error:', error);
            // Notify user of fallback
            if (window.NotificationService) {
                window.NotificationService.showToast('การวิเคราะห์ด้วย AI ขัดข้อง กำลังใช้โหมดจำลองแทน', 'warning');
            }
            return this.getSimulatedWoundResult(error.message);
        }
    },

    // Return a mocked classification result (Simulation fallback)
    async getSimulatedWoundResult(errorReason = '') {
        // List of possible results
        const options = [
            { woundId: 'abrasion', confidence: 95, description: 'ภาพถ่ายมีลักษณะผิวหนังถลอก แดง และมีสิ่งสกปรกติดอยู่ชั้นนอก เข้าข่ายแผลถลอกทั่วไป' },
            { woundId: 'cut', confidence: 88, description: 'ภาพแสดงผิวหนังแยกตัวออกจากกัน มีเลือดซึมไหลออกมา มีขอบแผลเรียบคล้ายโดนของมีคมบาด' },
            { woundId: 'bruise', confidence: 92, description: 'พบรอยจ้ำสีม่วงอมน้ำเงินใต้ผิวหนังโดยไม่มีแผลเปิด สอดคล้องกับอาการฟกช้ำกระแทก' },
            { woundId: 'burn', confidence: 90, description: 'ผิวหนังมีรอยแดงเข้ม แสบร้อน และพบตุ่มน้ำพองขนาดเล็ก เข้าข่ายแผลโดนของร้อนลวกระดับสอง' },
            { woundId: 'sprain', confidence: 85, description: 'พบการบวมแดงชัดเจนบริเวณข้อเท้าและข้อต่อ ไม่พบรอยฉีกขาดของผิวหนังด้านนอก น่าจะเกิดการเคล็ดขัดยอก' },
            { woundId: 'insect', confidence: 94, description: 'พบบาดแผลบวมแดงนูนตรงกลางคล้ายตุ่มแพ้ มีรอยจุดกัดต่อยตรงกลางชัดเจน สอดคล้องกับแมลงสัตว์กัดต่อย' }
        ];

        // Simulate network delay
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Randomly select one result
        const randomResult = options[Math.floor(Math.random() * options.length)];
        
        return {
            success: true,
            mode: 'simulation',
            woundId: randomResult.woundId,
            confidence: randomResult.confidence,
            description: randomResult.description + (errorReason ? ` (จำลองเนื่องจาก: ${errorReason})` : '')
        };
    }
};

window.AiWoundAnalyzer = AiWoundAnalyzer;
