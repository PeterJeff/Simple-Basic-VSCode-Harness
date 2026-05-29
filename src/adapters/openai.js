const logger = require('../logger');
const { nodeRequest, collectBody, readStream, authHeaders } = require('./transport');

function buildUrl(server, endpoint, pathKey) {
    const defaults = { chat: '/chat/completions', models: '/models' };
    const override = (endpoint.pathOverrides || {})[pathKey];
    return server.url.replace(/\/+$/, '') + (override || defaults[pathKey]);
}

module.exports = {
    id: 'openai',
    name: 'OpenAI Compatible',

    async listModels(server, endpoint) {
        const url = buildUrl(server, endpoint, 'models');
        try {
            logger.log(`[openai] listModels ${url}`);
            const res = await nodeRequest(url, { headers: authHeaders(server) });
            if (res.statusCode < 200 || res.statusCode >= 300) throw new Error(`HTTP ${res.statusCode}`);
            const data = await collectBody(res);
            const raw = data.data || data.models || [];
            return raw
                .map(m => (typeof m === 'string' ? m : (m.id || m.name || '')))
                .filter(Boolean)
                .sort();
        } catch (e) {
            logger.error('[openai] listModels', e);
            return [];
        }
    },

    async chat(server, endpoint, { messages, tools, onToken, signal, sessionState, model, streaming }) {
        const url = buildUrl(server, endpoint, 'chat');
        const useStreaming = streaming && typeof onToken === 'function';

        const body = { model, messages, stream: useStreaming, temperature: 0.1 };
        if (tools && tools.length > 0) {
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

        let message;
        if (useStreaming) {
            ({ message } = await readStream(res, onToken));
        } else {
            const data = await collectBody(res);
            logger.verbose('RESPONSE', data);
            message = data.choices[0].message;
            if (message.content && onToken) onToken(message.content);
        }

        return { message, sessionState: null };
    }
};
