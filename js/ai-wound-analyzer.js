// JS/AI-WOUND-ANALYZER.JS
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

            if (serverlessResponse.ok) {
                const serverlessResult = await serverlessResponse.json();
                if (serverlessResult && serverlessResult.success) {
                    console.log('[AI Analyzer] Analyzed securely via Vercel Serverless Function!');
                    return serverlessResult;
                }
            }

            const errJson = await serverlessResponse.json().catch(() => ({}));
            console.warn('[AI Analyzer] Serverless API error response:', errJson.error || serverlessResponse.status);
            return {
                success: false,
                error: errJson.error || 'ไม่สามารถวิเคราะห์รูปภาพได้ กรุณาลองใหม่ หรือเลือกแผลด้วยตนเอง'
            };
        } catch (serverlessError) {
            console.error('[AI Analyzer] Network or endpoint failure:', serverlessError);
            return {
                success: false,
                error: 'ไม่สามารถวิเคราะห์รูปภาพได้ กรุณาลองใหม่ หรือเลือกแผลด้วยตนเอง'
            };
        }
    }
};

window.AiWoundAnalyzer = AiWoundAnalyzer;
