/**
 * Adapter for the Ask Sage native API.
 *
 * Two-surface architecture:
 *   User API:   api.asksage.ai/user/  — auth, user management
 *   Server API: api.asksage.ai/server/ — queries, models
 *
 * Auth: x-access-tokens header (token obtained via /user/get-token-with-api-key)
 *
 * /server/query accepts a plain string (single-turn) or a [{user,message}] array
 * (multi-turn). System prompt is sent as a separate top-level field.
 * Streaming is not supported on /server/query.
 *
 * adapterOptions (all optional):
 *   persona          {number}    Persona ID
 *   dataset          {string[]}  Dataset names to query against
 *   live             {number}    1 = include web search, 0 = off
 *   limitReferences  {number}    Max RAG references to include
 *   system_prompt    {string}    Override system prompt (takes precedence over messages)
 *   reasoningEffort  {string}    'low'|'medium'|'high' for o1/o3 models
 *   queryPath        {string}    Override /server/query path
 *   modelsPath       {string}    Override /server/get-models path
 *   monthlyUsagePath {string}    Override /server/count-monthly-tokens path
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

// Convert OpenAI-format messages to Ask Sage's native format.
// Single user turn → plain string. Multi-turn → [{user,message}] array.
// System message is extracted separately for the top-level system_prompt field.
function buildAskSageMessage(messages) {
    const system = messages.find(m => m.role === 'system');
    const turns  = messages.filter(m => m.role !== 'system' && m.role !== 'tool');

    const systemPrompt = system?.content || null;

    let messagePayload;
    if (turns.length === 0) {
        messagePayload = '';
    } else if (turns.length === 1 && turns[0].role === 'user') {
        messagePayload = turns[0].content || '';
    } else {
        const roleMap = { user: 'me', assistant: 'gpt' };
        messagePayload = turns.map(m => ({
            user: roleMap[m.role] || 'me',
            message: m.content || ''
        }));
    }

    return { messagePayload, systemPrompt };
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

        const { messagePayload, systemPrompt: systemFromMessages } = buildAskSageMessage(messages);
        const finalSystemPrompt = opts.system_prompt || systemFromMessages || null;

        const body = { message: messagePayload, model, temperature: 0.1 };

        if (finalSystemPrompt)            body.system_prompt    = finalSystemPrompt;
        if (opts.persona         != null) body.persona          = opts.persona;
        if (opts.dataset         != null) body.dataset          = opts.dataset;
        if (opts.live            != null) body.live             = opts.live;
        if (opts.limitReferences != null) body.limit_references = opts.limitReferences;
        if (opts.reasoningEffort != null) body.reasoning_effort = opts.reasoningEffort;

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

        const text  = data.message || data.response || data.text || data.content || data.answer || '';
        const usage = data.usage || null;
        const uuid  = data.uuid  || null;
        const reply = { role: 'assistant', content: text };

        if (text && onToken) onToken(text);

        return { message: reply, sessionState: null, usage, uuid };
    },

    async getMonthlyUsage(server, endpoint) {
        const url = buildUrl(server, endpoint, 'monthlyUsage', '/server/count-monthly-tokens');
        logger.log(`[ask-sage] getMonthlyUsage ${url}`);
        const res = await nodeRequest(url, {
            method: 'POST',
            headers: askSageHeaders(server),
            body: JSON.stringify({})
        });
        if (res.statusCode < 200 || res.statusCode >= 300) {
            const err = await collectBody(res).catch(() => ({}));
            throw new Error(`API ${res.statusCode}: ${JSON.stringify(err).slice(0, 300)}`);
        }
        const data = await collectBody(res);
        logger.verbose('MONTHLY_USAGE', data);
        return data;
    }
};
