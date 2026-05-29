/**
 * Adapter for Ask Sage native API.
 *
 * Ask Sage exposes three representations on the same server:
 *   1. Native Ask Sage API  (this adapter, adapter id: "ask-sage")
 *   2. OpenAI-compatible sub-API  (use the openai adapter with pathOverrides)
 *   3. Anthropic-compatible sub-API  (future adapter or openai adapter with translation)
 *
 * For the OpenAI sub-API, configure an endpoint like:
 *   { adapter: "openai", pathOverrides: { chat: "/openai/v1/chat/completions", models: "/openai/v1/models" } }
 *
 * TODO (on-site): Document the native Ask Sage API format.
 *
 * Known so far:
 *  - Native endpoint does NOT support streaming.
 *  - Token limits are model-dependent — no static cap to enforce client-side.
 *  - Auth uses the same Bearer token mechanism as OpenAI (verify on-site).
 *
 * adapterOptions:
 *   chatPath    {string}  Path for chat requests. TODO: confirm.
 *   modelsPath  {string}  Path for model list. TODO: confirm.
 */

const logger = require('../logger');
const { nodeRequest, collectBody, authHeaders } = require('./transport');

module.exports = {
    id: 'ask-sage',
    name: 'Ask Sage (Native)',

    async listModels(server, endpoint) {
        // TODO: Confirm the models endpoint path for Ask Sage native API.
        const opts = endpoint.adapterOptions || {};
        const path = opts.modelsPath || (endpoint.pathOverrides || {}).models || '/models';
        const url  = server.url.replace(/\/+$/, '') + path;

        try {
            logger.log(`[ask-sage] listModels ${url}`);
            const res = await nodeRequest(url, { headers: authHeaders(server) });
            if (res.statusCode < 200 || res.statusCode >= 300) {
                logger.log(`[ask-sage] listModels HTTP ${res.statusCode}`);
                return [];
            }
            const data = await collectBody(res);
            const raw = data.data || data.models || [];
            return raw
                .map(m => (typeof m === 'string' ? m : (m.id || m.name || '')))
                .filter(Boolean)
                .sort();
        } catch (e) {
            logger.error('[ask-sage] listModels', e);
            return [];
        }
    },

    async chat(server, endpoint, { messages, tools, onToken, signal, sessionState, model }) {
        // TODO: Confirm Ask Sage native request/response body format.
        //
        // Placeholder assumes OpenAI-compatible body since that's the closest
        // known starting point. Adjust field names, message format, and
        // response parsing once the actual API is tested on-site.
        //
        // Native Ask Sage does not support streaming — onToken is called once
        // with the full response after it arrives.

        const opts = endpoint.adapterOptions || {};
        const path = opts.chatPath || (endpoint.pathOverrides || {}).chat || '/chat/completions';
        const url  = server.url.replace(/\/+$/, '') + path;

        const body = { model, messages, stream: false, temperature: 0.1 };
        if (tools && tools.length > 0) {
            // TODO: Confirm whether Ask Sage native supports tool/function calling.
            body.tools = tools;
            body.tool_choice = 'auto';
        }

        logger.verbose('REQUEST', { url, body });

        const res = await nodeRequest(url, {
            method: 'POST',
            headers: authHeaders(server),
            body: JSON.stringify(body),
            signal
        });

        if (res.statusCode < 200 || res.statusCode >= 300) {
            const err = await collectBody(res).catch(() => ({}));
            throw new Error(`API ${res.statusCode}: ${JSON.stringify(err).slice(0, 300)}`);
        }

        const data = await collectBody(res);
        logger.verbose('RESPONSE', data);

        // TODO: Adjust response parsing for actual Ask Sage response shape.
        let message;
        if (data.choices?.[0]?.message) {
            message = data.choices[0].message;
        } else {
            const text = data.text || data.response || data.content || data.answer || '';
            message = { role: 'assistant', content: text };
        }

        if (message.content && onToken) onToken(message.content);

        return { message, sessionState: null };
    }
};
