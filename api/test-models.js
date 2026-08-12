// API/TEST-MODELS.JS — Diagnostic endpoint to check available Gemini models
export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    
    const apiKey = process.env.GEMINI_API_KEY || process.env.GEMINI_KEY || process.env['Gemini Key'];
    
    if (!apiKey) {
        return res.status(200).json({ 
            status: 'NO_API_KEY',
            message: 'No API key found in any environment variable',
            checkedVars: ['GEMINI_API_KEY', 'GEMINI_KEY', 'Gemini Key']
        });
    }

    const results = {
        apiKeyLength: apiKey.trim().length,
        apiKeyPrefix: apiKey.trim().substring(0, 6) + '...',
        modelsChecked: [],
        availableModels: [],
        errors: []
    };

    // Test candidate models with a minimal text-only request
    const testModels = [
        'gemini-3.5-flash',
        'gemini-3.6-flash', 
        'gemini-3.5-flash-lite',
        'gemini-2.5-flash',
        'gemini-2.0-flash',
        'gemini-1.5-flash'
    ];

    for (const model of testModels) {
        try {
            // Try v1beta endpoint
            const urlBeta = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey.trim()}`;
            const resp = await fetch(urlBeta, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: 'Reply with just the word: OK' }] }],
                    generationConfig: { maxOutputTokens: 10 }
                })
            });
            
            const data = await resp.text();
            const status = resp.status;
            
            results.modelsChecked.push({
                model,
                endpoint: 'v1beta',
                httpStatus: status,
                ok: resp.ok,
                response: data.substring(0, 200)
            });

            if (resp.ok) {
                results.availableModels.push(model);
            }
        } catch (err) {
            results.modelsChecked.push({
                model,
                endpoint: 'v1beta',
                error: err.message
            });
        }
    }

    // Also try v1 endpoint with first available or first model
    const testModel = results.availableModels[0] || testModels[0];
    try {
        const urlV1 = `https://generativelanguage.googleapis.com/v1/models/${testModel}:generateContent?key=${apiKey.trim()}`;
        const respV1 = await fetch(urlV1, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: 'Reply with just: OK' }] }],
                generationConfig: { maxOutputTokens: 10 }
            })
        });
        results.v1EndpointTest = {
            model: testModel,
            httpStatus: respV1.status,
            ok: respV1.ok,
            response: (await respV1.text()).substring(0, 200)
        };
    } catch (err) {
        results.v1EndpointTest = { error: err.message };
    }

    // Also try listing models
    try {
        const listResp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey.trim()}`);
        if (listResp.ok) {
            const listData = await listResp.json();
            results.allApiModels = (listData.models || [])
                .filter(m => m.supportedGenerationMethods?.includes('generateContent'))
                .map(m => m.name)
                .slice(0, 20);
        } else {
            results.listModelsError = `HTTP ${listResp.status}: ${(await listResp.text()).substring(0, 200)}`;
        }
    } catch (err) {
        results.listModelsError = err.message;
    }

    return res.status(200).json(results);
}
