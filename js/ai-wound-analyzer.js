// JS/AI-WOUND-ANALYZER.JS — Client-side bridge to serverless Gemini API
const AiWoundAnalyzer = {
    // Perform AI analysis on a base64 encoded image of a wound via serverless backend API ONLY
    async analyzeWound(base64DataWithPrefix) {
        // All Gemini calls MUST go through backend serverless API route to protect API key
        try {
            const serverlessResponse = await fetch('/api/analyze', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ image: base64DataWithPrefix })
            });

            // Read the response body ONCE (can't read body twice)
            const responseBody = await serverlessResponse.json().catch(() => ({}));

            if (serverlessResponse.ok && responseBody && responseBody.success) {
                console.log('[AI Analyzer] ✅ Analyzed securely via Vercel Serverless Function!');
                return responseBody;
            }

            // API returned an error
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
