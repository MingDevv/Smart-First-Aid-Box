// ฝั่งเบราว์เซอร์ ส่งรูปแผลไปให้เซิร์ฟเวอร์วิเคราะห์
const AiWoundAnalyzer = {
    // วิเคราะห์รูปแผลผ่าน API ของเราเท่านั้น
    async analyzeWound(base64DataWithPrefix) {
        // ห้ามเรียก Gemini ตรงจากเบราว์เซอร์ ไม่งั้นคีย์หลุด
        try {
            const serverlessResponse = await fetch('/api/analyze', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ image: base64DataWithPrefix })
            });

            // อ่าน body ได้ครั้งเดียว
            const responseBody = await serverlessResponse.json().catch(() => ({}));

            if (serverlessResponse.ok && responseBody && responseBody.success) {
                console.log('[AI Analyzer] ✅ Analyzed securely via Vercel Serverless Function!');
                return responseBody;
            }

            // API ตอบกลับมาเป็นข้อผิดพลาด
            console.warn(`[AI Analyzer] Server error (${serverlessResponse.status}):`, responseBody.error || 'Unknown');
            return {
                success: false,
                error: responseBody.error || 'ขณะนี้ระบบ AI วิเคราะห์แผลขัดข้องชั่วคราว กรุณาลองใหม่อีกครั้ง หรือเลือกประเภทแผลด้วยตนเองด้านล่าง'
            };
        } catch (networkError) {
            console.error('[AI Analyzer] Network failure:', networkError.message);
            return {
                success: false,
                error: 'ไม่สามารถเชื่อมต่อระบบวิเคราะห์ได้ กรุณาตรวจสอบอินเทอร์เน็ตแล้วลองใหม่'
            };
        }
    }
};

window.AiWoundAnalyzer = AiWoundAnalyzer;
