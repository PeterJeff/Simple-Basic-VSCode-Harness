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
const { nodeRequest, collectBody, readStream } = require('./transport');

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
// tool-role messages are converted to user messages so the LLM retains tool result context.
function buildAskSageMessage(messages) {
    const system = messages.find(m => m.role === 'system');
    const turns  = messages.filter(m => m.role !== 'system');

    const systemPrompt = system?.content || null;

    const roleMap = { user: 'me', assistant: 'gpt' };

    let messagePayload;
    if (turns.length === 0) {
        messagePayload = '';
    } else if (turns.length === 1 && turns[0].role === 'user') {
        messagePayload = turns[0].content || '';
    } else {
        messagePayload = turns.map(m => {
            if (m.role === 'tool') {
                return { user: 'me', message: `[Tool result: ${m.name || 'tool'}]\n${m.content || ''}` };
            }
            return { user: roleMap[m.role] || 'me', message: m.content || '' };
        });
    }

    return { messagePayload, systemPrompt };
}

// Build a text block that instructs the LLM how to call tools when native
// function-calling is not available (prompt-injection mode).
function buildToolsPrompt(tools) {
    const schemas = tools.map(t => ({
        name:        t.function.name,
        description: t.function.description,
        parameters:  t.function.parameters
    }));
    return `## Tool Use Instructions
To call a tool, respond with ONLY this JSON (no other text):
{"tool_calls":[{"id":"tc1","type":"function","function":{"name":"TOOL_NAME","arguments":"{\"param\":\"value\"}"}}]}
After receiving a tool result (prefixed [Tool result:]), continue reasoning and call another tool or provide your final answer.

Available tools:
${JSON.stringify(schemas, null, 2)}`;
}

// Try to extract an OpenAI-format tool_calls array from a plain-text LLM response.
function parseTextToolCalls(text) {
    const trimmed = (text || '').trim();
    // Case 1: entire response is a JSON object with tool_calls
    try {
        const obj = JSON.parse(trimmed);
        if (Array.isArray(obj.tool_calls) && obj.tool_calls.length > 0) return obj.tool_calls;
    } catch {}
    // Case 2: fenced JSON code block
    const fence = trimmed.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
    if (fence) {
        try {
            const obj = JSON.parse(fence[1]);
            if (Array.isArray(obj.tool_calls) && obj.tool_calls.length > 0) return obj.tool_calls;
        } catch {}
    }
    // Case 3: inline JSON object containing tool_calls anywhere in the text
    const inline = trimmed.match(/\{"tool_calls"\s*:\s*\[[\s\S]*?\]\s*\}/);
    if (inline) {
        try {
            const obj = JSON.parse(inline[0]);
            if (Array.isArray(obj.tool_calls) && obj.tool_calls.length > 0) return obj.tool_calls;
        } catch {}
    }
    return null;
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

    async chat(server, endpoint, { messages, tools, onToken, signal, model, streaming, toolCallMode }) {
        const url  = buildUrl(server, endpoint, 'query', '/server/query');
        const opts = endpoint.adapterOptions || {};
        const mode = toolCallMode || 'api';
        const useStreaming = streaming && typeof onToken === 'function';

        const { messagePayload, systemPrompt: systemFromMessages } = buildAskSageMessage(messages);
        let finalSystemPrompt = opts.system_prompt || systemFromMessages || null;

        // In prompt mode, append tool schemas to the system prompt
        if (mode === 'prompt' && tools?.length) {
            finalSystemPrompt = ((finalSystemPrompt || '') + '\n\n' + buildToolsPrompt(tools)).trim();
        }

        const body = { message: messagePayload, model, temperature: 0.1, usage: true, streaming: useStreaming };

        if (finalSystemPrompt)            body.system_prompt    = finalSystemPrompt;
        if (mode === 'api' && tools?.length) {
            body.tools       = tools;
            body.tool_choice = 'auto';
        }
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

        let reply, usage = null, uuid = null;

        if (useStreaming) {
            const { message, extraFields, usage: streamUsage } = await readStream(res, onToken);
            uuid  = extraFields.uuid || null;
            usage = streamUsage || null;

            // Prompt mode: parse tool calls from accumulated text content
            if (mode === 'prompt' && message.content && !message.tool_calls?.length) {
                const toolCalls = parseTextToolCalls(message.content);
                if (toolCalls) {
                    message.content  = null;
                    message.tool_calls = toolCalls;
                }
            }

            reply = message;
        } else {
            const data = await collectBody(res);
            logger.verbose('RESPONSE', data);

            let text = data.message || data.response || data.text || data.content || data.answer || '';
            uuid = data.uuid || null;

            // Merge usage with any top-level cost/token fields the API may return
            const topLevel = {};
            const costKeys = [
                'prompt_tokens','completion_tokens','total_tokens','input_tokens','output_tokens',
                'input_cost','output_cost','total_cost','cost','token_cost',
                'cost_input','cost_output','token_input_cost','token_output_cost',
                'prompt_cost','completion_cost'
            ];
            for (const k of costKeys) {
                if (data[k] != null) topLevel[k] = data[k];
            }
            usage = (data.usage || Object.keys(topLevel).length > 0)
                ? Object.assign({}, data.usage || {}, topLevel)
                : null;

            let toolCalls = null;
            if (mode === 'api' && Array.isArray(data.tool_calls) && data.tool_calls.length > 0) {
                toolCalls = data.tool_calls;
            } else if (mode === 'prompt') {
                toolCalls = parseTextToolCalls(text);
                if (toolCalls) text = null;
            }

            reply = { role: 'assistant', content: text || null };
            if (toolCalls) reply.tool_calls = toolCalls;

            if (text && onToken) onToken(text);
        }

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
