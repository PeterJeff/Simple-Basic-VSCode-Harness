const vscode = require('vscode');
const logger = require('./logger');
const { getAdapter } = require('./adapters/index');

function getConfig() {
    return vscode.workspace.getConfiguration('standaloneAgent');
}

// Resolve the active server + endpoint config objects.
// Returns { server, endpoint, adapter } or throws with a user-friendly message.
function resolveActive() {
    const cfg = getConfig();
    const servers   = cfg.get('servers',   []);
    const endpoints = cfg.get('endpoints', []);
    const activeName = cfg.get('activeEndpoint', '');

    const endpoint = endpoints.find(e => e.name === activeName) || endpoints[0] || null;
    if (!endpoint) throw new Error('No endpoint configured. Add one under standaloneAgent.endpoints in Settings.');

    const server = servers.find(s => s.name === endpoint.server) || null;
    if (!server) throw new Error(`Endpoint "${endpoint.name}" references server "${endpoint.server}" which is not in standaloneAgent.servers.`);

    const adapter = getAdapter(endpoint.adapter);
    if (!adapter) throw new Error(`Unknown adapter "${endpoint.adapter}" on endpoint "${endpoint.name}". Valid adapters: openai, gemini-jank, gemini, ask-sage.`);

    return { server, endpoint, adapter };
}

// Resolve which model to use: endpoint-level override wins, then global setting.
function resolveModel(endpoint) {
    const cfg = getConfig();
    return endpoint.model || cfg.get('model', '');
}

// Resolve whether to stream: endpoint-level override wins, then global setting.
function resolveStreaming(endpoint) {
    const cfg = getConfig();
    if (endpoint.streaming !== undefined && endpoint.streaming !== null) {
        return endpoint.streaming;
    }
    return cfg.get('streaming', true);
}

function resolveToolCallMode() {
    return getConfig().get('askSageToolMode', 'api');
}

// Public accessors used by chatProvider / UI
function getEndpoints() {
    return getConfig().get('endpoints', []);
}

function getServers() {
    return getConfig().get('servers', []);
}

function getActiveEndpointName() {
    return getConfig().get('activeEndpoint', '');
}

async function listModels() {
    let resolved;
    try { resolved = resolveActive(); }
    catch (e) { logger.error('listModels', e); return []; }

    const { server, endpoint, adapter } = resolved;
    return await adapter.listModels(server, endpoint);
}

/**
 * Send a chat request through the active endpoint adapter.
 *
 * @param {object}   opts
 * @param {Array}    opts.messages      Full conversation messages array (OpenAI format)
 * @param {Array}    [opts.tools]       Tool definitions (OpenAI format)
 * @param {Function} [opts.onToken]     Called with each streamed text token
 * @param {AbortSignal} [opts.signal]
 * @param {object}   [opts.sessionState] Opaque state from the previous call (adapter-specific)
 *
 * @returns {Promise<{ message: object, sessionState: object }>}
 */
async function chat({ messages, tools, onToken, signal, sessionState }) {
    const { server, endpoint, adapter } = resolveActive();

    const model = resolveModel(endpoint);
    if (!model) throw new Error('No model selected. Open the model dropdown in the sidebar.');

    const streaming    = resolveStreaming(endpoint);
    const toolCallMode = resolveToolCallMode();

    logger.log(`[apiClient] chat via adapter=${endpoint.adapter} endpoint="${endpoint.name}" model=${model} streaming=${streaming} toolCallMode=${toolCallMode}`);

    return await adapter.chat(server, endpoint, {
        messages,
        tools,
        onToken,
        signal,
        sessionState,
        model,
        streaming,
        toolCallMode
    });
}

module.exports = { chat, listModels, getConfig, getEndpoints, getServers, getActiveEndpointName, resolveActive };
