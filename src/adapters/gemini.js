/**
 * Adapter for the Google Gemini API (generateContent / streamGenerateContent).
 *
 * Auth: enterprise deployments typically use x-goog-api-key header or Bearer token.
 *       Set adapterOptions.useQueryKey=true to pass the key as ?key= instead.
 *
 * adapterOptions:
 *   apiVersion   {string}  "v1" or "v1beta". Default: "v1" (stable/production)
 *   useQueryKey  {boolean} Pass apiKey as ?key= query param. Default: false (use header)
 *   cachedContent {string} CachedContent resource name to attach (e.g. "cachedContents/abc123")
 */

const { URL } = require('url');
const logger = require('../logger');
const { nodeRequest, collectBody } = require('./transport');

// ---------------------------------------------------------------------------
// Message conversion
// ---------------------------------------------------------------------------

// Convert OpenAI-style messages array to Gemini contents[].
// - role "system"    → skipped (goes into systemInstruction)
// - role "assistant" → "model"; tool_calls emit functionCall parts
// - role "tool"      → folded into a "user" turn as functionResponse parts
// - role "user"      → "user"
function toGeminiContents(messages) {
    const contents = [];

    for (const m of messages) {
        if (m.role === 'system') continue;

        if (m.role === 'tool') {
            // Fold tool result into preceding or new user turn
            let responseValue;
            try { responseValue = JSON.parse(m.content); }
            catch { responseValue = { result: m.content }; }

            const part = {
                functionResponse: {
                    name: m.name || 'unknown',
                    response: responseValue
                }
            };

            const last = contents[contents.length - 1];
            if (last && last.role === 'user') {
                last.parts.push(part);
            } else {
                contents.push({ role: 'user', parts: [part] });
            }
            continue;
        }

        if (m.role === 'assistant') {
            const parts = [];
            if (m.content) parts.push({ text: m.content });
            for (const tc of (m.tool_calls || [])) {
                let args;
                try { args = JSON.parse(tc.function.arguments); }
                catch { args = {}; }
                parts.push({ functionCall: { name: tc.function.name, args } });
            }
            if (parts.length > 0) contents.push({ role: 'model', parts });
            continue;
        }

        // User message
        const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
        contents.push({ role: 'user', parts: [{ text }] });
    }

    return contents;
}

// Convert OpenAI tools array to Gemini tools[] (functionDeclarations).
function toGeminiFunctionDeclarations(tools) {
    const decls = [];
    for (const t of tools) {
        if (t.type !== 'function' || !t.function) continue;
        const { name, description, parameters } = t.function;
        decls.push({ name, description, parameters });
    }
    return decls.length > 0 ? [{ functionDeclarations: decls }] : [];
}

// Parse a Gemini candidate into an OpenAI-style message object.
function fromGeminiCandidate(candidate) {
    const parts = candidate?.content?.parts || [];
    let text = '';
    const toolCalls = [];

    for (const part of parts) {
        if (part.text) {
            text += part.text;
        } else if (part.functionCall) {
            toolCalls.push({
                id: `gemini_${part.functionCall.name}_${Date.now()}`,
                type: 'function',
                function: {
                    name: part.functionCall.name,
                    arguments: JSON.stringify(part.functionCall.args || {})
                }
            });
        }
    }

    const message = { role: 'assistant', content: text || null };
    if (toolCalls.length > 0) message.tool_calls = toolCalls;
    return message;
}

// ---------------------------------------------------------------------------
// SSE stream reader (Gemini ?alt=sse format)
// Each data: line is a full GenerateContentResponse JSON chunk.
// ---------------------------------------------------------------------------
function readGeminiStream(res, onToken) {
    return new Promise((resolve, reject) => {
        let buffer = '';
        let text = '';
        const functionCallParts = [];

        res.setEncoding('utf8');

        res.on('data', chunk => {
            buffer += chunk;
            const lines = buffer.split('\n');
            buffer = lines.pop(); // hold incomplete last line

            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const raw = line.slice(6).trim();
                if (!raw || raw === '[DONE]') continue;

                let parsed;
                try { parsed = JSON.parse(raw); } catch { continue; }

                const parts = parsed.candidates?.[0]?.content?.parts || [];
                for (const part of parts) {
                    if (part.text) {
                        text += part.text;
                        onToken(part.text);
                    } else if (part.functionCall) {
                        functionCallParts.push(part.functionCall);
                    }
                }
            }
        });

        res.on('end', () => {
            const toolCalls = functionCallParts.map(fc => ({
                id: `gemini_${fc.name}_${Date.now()}`,
                type: 'function',
                function: { name: fc.name, arguments: JSON.stringify(fc.args || {}) }
            }));

            const message = { role: 'assistant', content: text || null };
            if (toolCalls.length > 0) message.tool_calls = toolCalls;
            logger.verbose('STREAM_END', { contentLen: text.length, toolCalls: toolCalls.length });
            resolve({ message });
        });

        res.on('error', reject);
    });
}

// ---------------------------------------------------------------------------
// Auth / URL helpers
// ---------------------------------------------------------------------------

// Build request headers. Enterprise may use x-goog-api-key or Bearer token.
// If useQueryKey is set the key goes in the URL instead; return plain headers.
function geminiHeaders(server, opts) {
    const h = { 'Content-Type': 'application/json' };
    if (!server.apiKey || opts.useQueryKey) return h;

    const key = server.apiKey;
    if (key.startsWith('Bearer ') || key.startsWith('ya29.')) {
        h['Authorization'] = key.startsWith('Bearer ') ? key : `Bearer ${key}`;
    } else {
        h['x-goog-api-key'] = key;
    }
    return h;
}

// Construct a versioned Gemini URL, appending ?alt=sse for streaming and
// optionally ?key= when useQueryKey is enabled.
function buildUrl(base, ver, pathSuffix, server, opts, streaming) {
    const u = new URL(`${base}/${ver}/${pathSuffix}`);
    if (streaming) u.searchParams.set('alt', 'sse');
    if (opts.useQueryKey && server.apiKey) u.searchParams.set('key', server.apiKey);
    return u.toString();
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

module.exports = {
    id: 'gemini',
    name: 'Google Gemini',

    async listModels(server, endpoint) {
        const opts = endpoint.adapterOptions || {};
        const ver  = opts.apiVersion || 'v1';
        const base = server.url.replace(/\/+$/, '');
        const url  = buildUrl(base, ver, 'models', server, opts, false);

        try {
            logger.log(`[gemini] listModels ${url}`);
            const res = await nodeRequest(url, { headers: geminiHeaders(server, opts) });
            if (res.statusCode < 200 || res.statusCode >= 300) {
                logger.log(`[gemini] listModels HTTP ${res.statusCode}`);
                return [];
            }
            const data = await collectBody(res);
            const raw = data.models || data.data || [];
            return raw
                .map(m => m.name || m.id || (typeof m === 'string' ? m : ''))
                .filter(Boolean)
                .map(n => n.replace(/^models\//, ''))
                .sort();
        } catch (e) {
            logger.error('[gemini] listModels', e);
            return [];
        }
    },

    async chat(server, endpoint, { messages, tools, onToken, signal, sessionState, model, streaming }) {
        const opts        = endpoint.adapterOptions || {};
        const ver         = opts.apiVersion || 'v1';
        const base        = server.url.replace(/\/+$/, '');
        const useStreaming = streaming && typeof onToken === 'function';
        const action      = useStreaming ? 'streamGenerateContent' : 'generateContent';
        const url         = buildUrl(base, ver, `models/${encodeURIComponent(model)}:${action}`, server, opts, useStreaming);

        // Build request body
        const systemMsgs = messages.filter(m => m.role === 'system');
        const body = {
            contents: toGeminiContents(messages),
            generationConfig: { temperature: 0.1 }
        };

        if (systemMsgs.length > 0) {
            body.systemInstruction = {
                parts: [{ text: systemMsgs.map(m => m.content).filter(Boolean).join('\n\n') }]
            };
        }

        if (tools && tools.length > 0) {
            const decls = toGeminiFunctionDeclarations(tools);
            if (decls.length > 0) {
                body.tools     = decls;
                body.toolConfig = { functionCallingConfig: { mode: 'AUTO' } };
            }
        }

        // Context caching: attach a pre-created cachedContent resource if configured
        if (opts.cachedContent) {
            body.cachedContent = opts.cachedContent;
        }

        logger.verbose('REQUEST', { url, body });

        const res = await nodeRequest(url, {
            method: 'POST',
            headers: geminiHeaders(server, opts),
            body: JSON.stringify(body),
            signal
        });

        if (res.statusCode < 200 || res.statusCode >= 300) {
            const err = await collectBody(res).catch(() => ({}));
            throw new Error(`Gemini API ${res.statusCode}: ${JSON.stringify(err).slice(0, 300)}`);
        }

        let message;
        if (useStreaming) {
            ({ message } = await readGeminiStream(res, onToken));
        } else {
            const data = await collectBody(res);
            logger.verbose('RESPONSE', data);
            const candidates = data.candidates || (Array.isArray(data) ? data : []);
            message = fromGeminiCandidate(candidates[0]);
            if (message.content && onToken) onToken(message.content);
        }

        return { message, sessionState: null };
    }
};
