/**
 * Adapter for the Ask Sage native API.
 *
 * Two-surface architecture:
 *   User API:   api.asksage.ai/user/  — auth, user management
 *   Server API: api.asksage.ai/server/ — queries, models
 *
 * Auth: x-access-tokens header (token obtained via /user/get-token-with-api-key)
 *
 * Native /server/query takes a single message string, not a messages array.
 * Multi-turn history is flattened into one prompt string before sending.
 * Streaming is not supported on /server/query.
 *
 * adapterOptions (all optional):
 *   persona          {number}    Persona ID
 *   dataset          {string[]}  Dataset names to query against
 *   live             {number}    1 = include web search, 0 = off
 *   limitReferences  {number}    Max RAG references to include
 *   queryPath        {string}    Override /server/query path
 *   modelsPath       {string}    Override /server/get-models path
 */

const logger = require('../logger');
const { nodeRequest, collectBody } = require('./transport');

function askSageHeaders(server) {
    const h = { 'Content-Type': 'application/json' };
    if (server.apiKey) h['x-access-tokens'] = server.apiKey;
    return h;
}

function buildUrl(server, endpoint, key, defaultPath) {
    const opts = endpoint.adapterOptions || {};
    const override = opts[key + 'Path'] || (endpoint.pathOverrides || {})[key];
    return server.url.replace(/\/+$/, '') + (override || defaultPath);
}

// Ask Sage /server/query takes a single string, not a messages array.
// Flatten the conversation into one prompt, preserving context.
function flattenMessages(messages) {
    const system = messages.find(m => m.role === 'system');
    const turns  = messages.filter(m => m.role !== 'system');

    const parts = [];
    if (system?.content) parts.push(system.content);

    if (turns.length === 1 && turns[0].role === 'user') {
        parts.push(turns[0].content || '');
    } else {
        for (const m of turns) {
            const label = m.role === 'user' ? 'User' : 'Assistant';
            parts.push(`${label}: ${m.content || ''}`);
        }
    }

    return parts.join('\n\n').trim();
}

module.exports = {
    id: 'ask-sage',
    name: 'Ask Sage (Native)',

    async listModels(server, endpoint) {
        const url = buildUrl(server, endpoint, 'models', '/server/get-models');
        try {
            logger.log(`[ask-sage] listModels ${url}`);
            const res = await nodeRequest(url, {
                method: 'POST',
                headers: askSageHeaders(server),
                body: JSON.stringify({})
            });
            if (res.statusCode < 200 || res.statusCode >= 300) {
                logger.log(`[ask-sage] listModels HTTP ${res.statusCode}`);
                return [];
            }
            const data = await collectBody(res);
            const raw = data.models || data.data || [];
            return raw
                .map(m => (typeof m === 'string' ? m : (m.id || m.name || '')))
                .filter(Boolean)
                .sort();
        } catch (e) {
            logger.error('[ask-sage] listModels', e);
            return [];
        }
    },

    async chat(server, endpoint, { messages, onToken, signal, model }) {
        const url  = buildUrl(server, endpoint, 'query', '/server/query');
        const opts = endpoint.adapterOptions || {};

        const body = {
            message:     flattenMessages(messages),
            model,
            temperature: 0.1
        };

        if (opts.persona         != null) body.persona           = opts.persona;
        if (opts.dataset         != null) body.dataset            = opts.dataset;
        if (opts.live            != null) body.live               = opts.live;
        if (opts.limitReferences != null) body.limit_references   = opts.limitReferences;

        logger.verbose('REQUEST', { url, body });

        const res = await nodeRequest(url, {
            method: 'POST',
            headers: askSageHeaders(server),
            body: JSON.stringify(body),
            signal
        });

        if (res.statusCode < 200 || res.statusCode >= 300) {
            const err = await collectBody(res).catch(() => ({}));
            throw new Error(`API ${res.statusCode}: ${JSON.stringify(err).slice(0, 300)}`);
        }

        const data = await collectBody(res);
        logger.verbose('RESPONSE', data);

        const text = data.response || data.message || data.text || data.content || data.answer || '';
        const reply = { role: 'assistant', content: text };

        if (text && onToken) onToken(text);

        return { message: reply, sessionState: null };
    }
};
