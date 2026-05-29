/**
 * Adapter for the "jank" internal Gemini proxy.
 *
 * Known quirks this adapter works around:
 *  - Only responds to the "user" role; system/assistant/tool roles are ignored.
 *  - Maintains server-side session history, ignores the messages array beyond
 *    the last entry — so we collapse the full conversation into a single user
 *    message and rely on server session for nothing except the session ID echo.
 *  - Has a minimum word count requirement for submitted messages.
 *  - May use a non-standard field name for the model (configurable via adapterOptions.modelField).
 *  - Session ID is returned in the response body and should be echoed back on
 *    subsequent requests to keep the server-side session alive.
 *
 * adapterOptions (all optional):
 *   sessionField  {string}  Response/request field for the session ID. Default: "session_id"
 *   modelField    {string}  Request field for the model name. Default: "model"
 *   minWordCount  {number}  Minimum words in collapsed message. Default: 0 (disabled)
 *   systemTag     {string}  XML tag wrapping the system prompt block. Default: "SystemPrompt"
 *   historyTag    {string}  XML tag wrapping prior conversation turns. Default: "ConversationHistory"
 *   currentTag    {string}  XML tag wrapping the current user request. Default: "CurrentRequest"
 */

const logger = require('../logger');
const { nodeRequest, collectBody, readStream, authHeaders } = require('./transport');

// ---------------------------------------------------------------------------
// Message collapse — replicates the Python proxy logic in JS
// ---------------------------------------------------------------------------

function collapseMessages(messages, opts = {}) {
    const systemTag  = opts.systemTag  || 'SystemPrompt';
    const historyTag = opts.historyTag || 'ConversationHistory';
    const currentTag = opts.currentTag || 'CurrentRequest';

    const systemMsgs = messages.filter(m => m.role === 'system');
    const convMsgs   = messages.filter(m => m.role !== 'system');

    // Last user message is the "current request"; everything before it is history
    let lastUserIdx = -1;
    for (let i = convMsgs.length - 1; i >= 0; i--) {
        if (convMsgs[i].role === 'user') { lastUserIdx = i; break; }
    }

    const parts = [];

    // System prompt block
    if (systemMsgs.length > 0) {
        const sysText = systemMsgs.map(m => m.content).filter(Boolean).join('\n\n');
        parts.push(`<${systemTag}>\n${sysText}\n</${systemTag}>`);
    }

    // Prior conversation turns
    const histMsgs = lastUserIdx > 0 ? convMsgs.slice(0, lastUserIdx) : [];
    if (histMsgs.length > 0) {
        const lines = [];
        let turnNum = 0;
        let i = 0;

        while (i < histMsgs.length) {
            const m = histMsgs[i];

            if (m.role === 'user') {
                turnNum++;
                lines.push(`\n[TURN ${turnNum}]`);
                lines.push(`<User>\n${m.content}\n</User>`);
                i++;

            } else if (m.role === 'assistant') {
                let text = m.content || '';
                if (m.tool_calls && m.tool_calls.length > 0) {
                    for (const tc of m.tool_calls) {
                        text += `\n[Called tool: ${tc.function.name}(${tc.function.arguments})]`;
                    }
                }
                lines.push(`<Assistant>\n${text.trim()}\n</Assistant>`);
                i++;

            } else if (m.role === 'tool') {
                // Resolve tool name from the preceding assistant's tool_calls list
                let toolName = 'unknown';
                for (let j = i - 1; j >= 0; j--) {
                    if (histMsgs[j].role === 'assistant' && histMsgs[j].tool_calls) {
                        const tc = histMsgs[j].tool_calls.find(t => t.id === m.tool_call_id);
                        if (tc) { toolName = tc.function.name; break; }
                    }
                }
                const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
                lines.push(`<ToolResult tool="${toolName}">\n${content}\n</ToolResult>`);
                i++;

            } else {
                i++;
            }
        }

        parts.push(`<${historyTag}>${lines.join('\n')}\n</${historyTag}>`);
    }

    // Current user request
    if (lastUserIdx >= 0) {
        parts.push(`<${currentTag}>\n${convMsgs[lastUserIdx].content}\n</${currentTag}>`);
    }

    return parts.join('\n\n');
}

function padToWordCount(text, minWords) {
    if (!minWords || minWords <= 0) return text;
    const count = text.split(/\s+/).filter(Boolean).length;
    if (count >= minWords) return text;
    // Pad with neutral filler — on-site LLM can tune the exact phrase
    return text + '\n\n' + 'Please respond to the above request thoroughly.'.repeat(
        Math.ceil((minWords - count) / 8)
    );
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

module.exports = {
    id: 'gemini-jank',
    name: 'Gemini (Jank Proxy)',

    async listModels(server, endpoint) {
        const url = server.url.replace(/\/+$/, '') + '/models';
        try {
            logger.log(`[gemini-jank] listModels ${url}`);
            const res = await nodeRequest(url, { headers: authHeaders(server) });
            if (res.statusCode < 200 || res.statusCode >= 300) {
                logger.log(`[gemini-jank] listModels HTTP ${res.statusCode} — endpoint may not support model listing`);
                return [];
            }
            const data = await collectBody(res);
            const raw = data.data || data.models || [];
            return raw
                .map(m => (typeof m === 'string' ? m : (m.id || m.name || '')))
                .filter(Boolean)
                .sort();
        } catch (e) {
            logger.error('[gemini-jank] listModels', e);
            return [];
        }
    },

    async chat(server, endpoint, { messages, tools, onToken, signal, sessionState, model, streaming }) {
        const chatPath = (endpoint.pathOverrides || {}).chat || '/chat/completions';
        const url = server.url.replace(/\/+$/, '') + chatPath;

        const opts         = endpoint.adapterOptions || {};
        const sessionField = opts.sessionField || 'session_id';
        const modelField   = opts.modelField   || 'model';
        const minWordCount = opts.minWordCount  || 0;

        // Collapse full conversation history into one user message
        let collapsed = collapseMessages(messages, opts);
        collapsed = padToWordCount(collapsed, minWordCount);

        const useStreaming = streaming && typeof onToken === 'function';

        const body = {
            [modelField]: model,
            messages: [{ role: 'user', content: collapsed }],
            stream: useStreaming,
            temperature: 0.1
        };

        // Tools: still sent in the hope the server recognises them.
        // On-site testing may show these need to be removed or reformatted.
        if (tools && tools.length > 0) {
            body.tools = tools;
            body.tool_choice = 'auto';
        }

        // Echo the session ID back so the server can associate the request
        // with its own session store (best-effort; field name is configurable)
        if (sessionState && sessionState[sessionField]) {
            body[sessionField] = sessionState[sessionField];
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
        const newSessionState = { ...(sessionState || {}) };

        if (useStreaming) {
            // readStream harvests any non-standard top-level fields (including session IDs)
            // emitted by the server in SSE events
            const { message: msg, extraFields } = await readStream(res, onToken);
            message = msg;
            if (extraFields[sessionField]) {
                newSessionState[sessionField] = extraFields[sessionField];
            }
        } else {
            const data = await collectBody(res);
            logger.verbose('RESPONSE', data);

            // Capture session ID from response body
            if (data[sessionField]) {
                newSessionState[sessionField] = data[sessionField];
            }

            // Attempt standard choices[0].message; fall back to flat text fields
            if (data.choices?.[0]?.message) {
                message = data.choices[0].message;
            } else {
                const text = data.text || data.response || data.content || '';
                message = { role: 'assistant', content: text };
            }

            if (message.content && onToken) onToken(message.content);
        }

        return { message, sessionState: newSessionState };
    }
};
