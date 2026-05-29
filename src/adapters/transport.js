const http = require('http');
const https = require('https');
const { URL } = require('url');
const logger = require('../logger');
const { getHttpsAgent } = require('../certLoader');

function nodeRequest(urlStr, { method = 'GET', headers = {}, body, signal } = {}) {
    const parsed = new URL(urlStr);
    const isHttps = parsed.protocol === 'https:';
    const lib = isHttps ? https : http;

    const options = {
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method,
        headers,
        agent: isHttps ? getHttpsAgent() : undefined
    };

    if (signal) options.signal = signal;

    return new Promise((resolve, reject) => {
        const req = lib.request(options, resolve);
        req.on('error', reject);
        if (signal && !options.signal) {
            signal.addEventListener('abort', () => req.destroy(new Error('Request aborted')));
        }
        if (body) req.write(body);
        req.end();
    });
}

function collectBody(res) {
    return new Promise((resolve, reject) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', c => { raw += c; });
        res.on('end', () => {
            try { resolve(JSON.parse(raw)); }
            catch { reject(new Error(`Non-JSON response: ${raw.slice(0, 200)}`)); }
        });
        res.on('error', reject);
    });
}

// Standard OpenAI SSE stream reader.
// Returns { message, extraFields } where extraFields collects any top-level
// fields on SSE event objects that aren't part of the standard choices/delta
// structure (e.g. a session_id emitted by non-standard servers).
function readStream(res, onToken) {
    return new Promise((resolve, reject) => {
        let buffer = '';
        let content = '';
        const tcMap = {};
        const extraFields = {};

        res.setEncoding('utf8');

        res.on('data', chunk => {
            buffer += chunk;
            const lines = buffer.split('\n');
            buffer = lines.pop();

            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const raw = line.slice(6).trim();
                if (raw === '[DONE]') continue;

                let parsed;
                try { parsed = JSON.parse(raw); } catch { continue; }

                // Harvest any non-standard top-level fields (e.g. session_id)
                for (const key of Object.keys(parsed)) {
                    if (key !== 'choices' && key !== 'id' && key !== 'object' &&
                        key !== 'model' && key !== 'created' && key !== 'usage') {
                        extraFields[key] = parsed[key];
                    }
                }

                const delta = parsed.choices?.[0]?.delta;
                if (!delta) continue;

                if (delta.content) {
                    content += delta.content;
                    onToken(delta.content);
                }

                if (delta.tool_calls) {
                    for (const tc of delta.tool_calls) {
                        const idx = tc.index ?? 0;
                        if (!tcMap[idx]) {
                            tcMap[idx] = { id: '', type: 'function', function: { name: '', arguments: '' } };
                        }
                        if (tc.id)                 tcMap[idx].id += tc.id;
                        if (tc.function?.name)      tcMap[idx].function.name += tc.function.name;
                        if (tc.function?.arguments) tcMap[idx].function.arguments += tc.function.arguments;
                    }
                }
            }
        });

        res.on('end', () => {
            const toolCalls = Object.values(tcMap).filter(tc => tc.function.name);
            const message = { role: 'assistant', content: content || null };
            if (toolCalls.length > 0) message.tool_calls = toolCalls;
            logger.verbose('STREAM_END', { contentLen: content.length, toolCalls: toolCalls.length });
            resolve({ message, extraFields });
        });

        res.on('error', reject);
    });
}

function authHeaders(server) {
    const h = { 'Content-Type': 'application/json' };
    if (server.apiKey) h['Authorization'] = `Bearer ${server.apiKey}`;
    return h;
}

module.exports = { nodeRequest, collectBody, readStream, authHeaders };
