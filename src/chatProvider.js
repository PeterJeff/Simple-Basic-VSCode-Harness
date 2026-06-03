const vscode = require('vscode');
const path = require('path');
const crypto = require('crypto');
const api = require('./apiClient');
const agentRunner = require('./agentRunner');
const toolHandler = require('./toolHandler');
const HistoryManager = require('./historyManager');
const logger = require('./logger');
const certLoader = require('./certLoader');

const MODELS_CACHE_TTL  = 30 * 24 * 60 * 60 * 1000;  // 30 days
const MONTHLY_CACHE_TTL =  3 * 24 * 60 * 60 * 1000;  // 3 days

class ChatViewProvider {
    constructor(context) {
        this._ctx = context;
        this._view = null;
        this._history = new HistoryManager(context);
        this._session = this._history.createSession();
        this._mode = 'chat';
        this._streamMsgId = '';
        this._streamBuffers = new Map(); // msgId → accumulated token text for server-side markdown render
        this._sessionState = null;
        this._pendingApprovals = new Map(); // callId → { resolve }
        certLoader.configure({ enabled: api.getConfig().get('winCertStore', true) });

        // Inject secrets store so adapters read keys from OS keychain, not plain-text settings
        api.setSecrets(context.secrets);

        // Register in-chat approval callback with toolHandler
        toolHandler.setApprovalCallback(async (toolName, callId, args, msgId, rawCall) => {
            return new Promise((resolve) => {
                let handled = false;
                const wrappedResolve = (decision) => {
                    handled = true;
                    resolve(decision);
                };

                this._pendingApprovals.set(callId, { resolve: wrappedResolve });
                this.sendToWebview({
                    type: 'toolApprovalRequest',
                    callId,
                    toolName,
                    args,
                    rawCall,
                    msgId
                });

                // If user hasn't responded in 3 s, show a toast so the agent stays visible
                // even when the chat panel is collapsed.
                setTimeout(() => {
                    if (!handled) {
                        vscode.window.showInformationMessage(
                            `Standalone Agent: approve "${toolName}" in chat`,
                            'Focus Chat'
                        ).then(choice => {
                            if (choice === 'Focus Chat') {
                                vscode.commands.executeCommand('standalone-agent.chatView.focus');
                            }
                        });
                    }
                }, 3000);
            });
        });
    }

    // ── VSCode webview lifecycle ───────────────────────────────────────────────

    resolveWebviewView(webviewView) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this._ctx.extensionUri, 'media')
            ]
        };

        webviewView.webview.html = this._buildHtml(webviewView.webview);

        webviewView.webview.onDidReceiveMessage(
            msg => this._handleWebviewMessage(msg),
            undefined,
            this._ctx.subscriptions
        );
    }

    // ── Public API (called by extension.js commands) ──────────────────────────

    newChat() {
        if (agentRunner.isRunning()) agentRunner.stop();
        this._clearPendingApprovals();
        if (this._session.messages.length > 0) {
            this._history.saveSession(this._session);
        }
        this._session = this._history.createSession();
        this._sessionState = null;
        this.sendToWebview({ type: 'newChat' });
        this.sendToWebview({ type: 'sessions', sessions: this._history.getSessions() });
    }

    clearHistory() {
        this._history.clearAll();
        this._session = this._history.createSession();
        this.sendToWebview({ type: 'newChat' });
        this.sendToWebview({ type: 'sessions', sessions: [] });
    }

    onConfigChange() {
        const cfg = api.getConfig();
        certLoader.configure({ enabled: cfg.get('winCertStore', true) });
        const supportsMonthlyUsage = this._supportsMonthlyUsage();

        // Re-run migration on every config change so any apiKey re-added to settings.json
        // (e.g. by direct file edit) is immediately swept into secrets and stripped.
        this._migrateApiKeys().catch(() => {});

        this._getServersForWebview().then(servers => {
            this.sendToWebview({
                type: 'configUpdate',
                servers,
                endpoints: api.getEndpoints(),
                activeEndpoint: cfg.get('activeEndpoint', ''),
                model: cfg.get('model', ''),
                streaming: cfg.get('streaming', true),
                enterToSend: cfg.get('enterToSend', true),
                verboseLogging: cfg.get('verboseLogging', false),
                maxIterations: cfg.get('maxIterations', 20),
                toolPermissions: cfg.get('toolPermissions', {}),
                askSageToolMode: cfg.get('askSageToolMode', 'api'),
                supportsMonthlyUsage
            });
        });

        this._sessionState = null;
        if (supportsMonthlyUsage) {
            this._fetchMonthlyUsage().catch(() => {});
        }
    }

    sendToWebview(msg) {
        this._view?.webview.postMessage(msg);
    }

    sendVerboseState(v) {
        this.sendToWebview({ type: 'verboseState', verbose: v });
    }

    // ── Webview message handler ────────────────────────────────────────────────

    async _handleWebviewMessage(msg) {
        switch (msg.type) {

            case 'ready':
                await this._sendInitState();
                break;

            case 'send':
                if (!agentRunner.isRunning()) {
                    await this._handleUserMessage(msg.text);
                }
                break;

            case 'stop':
                agentRunner.stop();
                this._clearPendingApprovals();
                break;

            case 'newChat':
                this.newChat();
                break;

            case 'setMode':
                this._mode = msg.mode;
                break;

            case 'getModels':
                await this._fetchModels(true);
                break;

            case 'setModel':
                await vscode.workspace.getConfiguration('standaloneAgent')
                    .update('model', msg.model, vscode.ConfigurationTarget.Global);
                break;

            case 'setEndpoint':
                await vscode.workspace.getConfiguration('standaloneAgent')
                    .update('activeEndpoint', msg.name, vscode.ConfigurationTarget.Global);
                await this._fetchModels();
                break;

            case 'loadSession':
                this._loadSession(msg.id);
                break;

            case 'deleteSession':
                await this._history.deleteSession(msg.id);
                this.sendToWebview({ type: 'sessions', sessions: this._history.getSessions() });
                break;

            case 'getFileSuggestions':
                await this._sendFileSuggestions(msg.query);
                break;

            case 'fork':
                await this._handleFork(msg.userMsgIdx);
                break;

            case 'retry':
                if (!agentRunner.isRunning()) {
                    await this._retryLastMessage();
                }
                break;

            case 'updateToolPermission':
                await this._updateToolPermission(msg.tool, msg.level);
                break;

            case 'updateSetting':
                await this._updateSetting(msg.key, msg.value);
                break;

            case 'getMonthlyUsage':
                await this._fetchMonthlyUsage(true);
                break;

            case 'toolApprovalResponse': {
                const pending = this._pendingApprovals.get(msg.callId);
                if (pending) {
                    this._pendingApprovals.delete(msg.callId);
                    pending.resolve(msg.decision);
                }
                break;
            }

            case 'openTextWindow': {
                try {
                    const doc = await vscode.workspace.openTextDocument({
                        content: msg.content || '',
                        language: 'json'
                    });
                    await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
                } catch (e) {
                    logger.error('openTextWindow', e);
                }
                break;
            }

            case 'showDiff': {
                try {
                    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
                    const filePath = path.isAbsolute(msg.path) ? msg.path : path.join(root, msg.path);
                    const uri = vscode.Uri.file(filePath);
                    // Opens native side-by-side diff against git HEAD
                    await vscode.commands.executeCommand('git.openChange', uri);
                } catch {
                    // Fall back to just opening the file if git extension is unavailable
                    try {
                        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
                        const filePath = path.isAbsolute(msg.path) ? msg.path : path.join(root, msg.path);
                        await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(filePath));
                    } catch (e) {
                        logger.error('showDiff', e);
                    }
                }
                break;
            }

            case 'openSettings':
                vscode.commands.executeCommand(
                    'workbench.action.openSettings',
                    'standaloneAgent'
                );
                break;
        }
    }

    // ── Initialisation ─────────────────────────────────────────────────────────

    async _sendInitState() {
        // One-time migration: move any plain-text apiKey values from settings to secrets
        await this._migrateApiKeys();

        const cfg = api.getConfig();
        const supportsMonthlyUsage = this._supportsMonthlyUsage();
        const servers = await this._getServersForWebview();

        this.sendToWebview({
            type: 'init',
            sessions: this._history.getSessions(),
            session: this._session,
            mode: this._mode,
            servers,
            endpoints: api.getEndpoints(),
            activeEndpoint: cfg.get('activeEndpoint', ''),
            model: cfg.get('model', ''),
            streaming: cfg.get('streaming', true),
            enterToSend: cfg.get('enterToSend', true),
            verboseLogging: logger.isVerbose(),
            maxIterations: cfg.get('maxIterations', 20),
            toolPermissions: cfg.get('toolPermissions', {}),
            toolDefs: toolHandler.ALL_TOOLS.map(t => t.function.name),
            askSageToolMode: cfg.get('askSageToolMode', 'api'),
            supportsMonthlyUsage
        });

        this._fetchModels().catch(() => {});

        if (supportsMonthlyUsage) {
            this._fetchMonthlyUsage().catch(() => {});
        }
    }

    async _fetchModels(force = false) {
        if (!force) {
            const cached = this._readCache('sa_models_cache', MODELS_CACHE_TTL);
            if (cached) {
                const current = api.getConfig().get('model', '');
                this.sendToWebview({ type: 'models', models: cached.models, current });
                return;
            }
        }
        const models = await api.listModels();
        const current = api.getConfig().get('model', '');
        this._writeCache('sa_models_cache', { models });
        this.sendToWebview({ type: 'models', models, current });
    }

    // ── User message handling ──────────────────────────────────────────────────

    async _handleUserMessage(rawText) {
        if (!rawText.trim()) return;

        const { displayText, contextBlocks } = await this._resolveAtRefs(rawText);

        let apiContent = displayText;
        if (contextBlocks.length > 0) {
            apiContent += '\n\n' + contextBlocks.map(b =>
                `<file path="${b.path}">\n${b.content}\n</file>`
            ).join('\n\n');
        }

        const userMsg = { role: 'user', content: apiContent };
        this._session.messages.push(userMsg);

        if (this._session.messages.filter(m => m.role === 'user').length === 1) {
            this._session.title = rawText.slice(0, 60);
        }

        this.sendToWebview({
            type: 'userMessage',
            id: `u_${Date.now()}`,
            ts: Date.now(),
            text: rawText,
            contextFiles: contextBlocks.map(b => b.path)
        });

        await this._runAgent();
    }

    async _retryLastMessage() {
        const hasUser = this._session.messages.some(m => m.role === 'user');
        if (!hasUser) return;
        await this._runAgent();
    }

    async _handleFork(userMsgIdx) {
        if (agentRunner.isRunning()) agentRunner.stop();
        this._clearPendingApprovals();

        if (this._session.messages.length > 0) {
            this._history.saveSession(this._session);
        }

        let userCount = 0;
        let sliceAt = -1;
        for (let i = 0; i < this._session.messages.length; i++) {
            if (this._session.messages[i].role === 'user') {
                if (userCount === userMsgIdx) { sliceAt = i; break; }
                userCount++;
            }
        }
        if (sliceAt === -1) sliceAt = 0;

        const newSession = this._history.createSession();
        newSession.messages = this._session.messages.slice(0, sliceAt);
        if (newSession.messages.length > 0) {
            const firstUser = newSession.messages.find(m => m.role === 'user');
            if (firstUser) newSession.title = String(firstUser.content || '').slice(0, 60);
        }
        this._session = newSession;
        this._sessionState = null;

        this.sendToWebview({ type: 'forkReady', session: this._session });
        this.sendToWebview({ type: 'sessions', sessions: this._history.getSessions() });
    }

    async _runAgent() {
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Window,
            title: 'Standalone Agent',
            cancellable: true
        }, async (progress, token) => {
            token.onCancellationRequested(() => {
                agentRunner.stop();
                this._clearPendingApprovals();
            });

            await agentRunner.run(this._mode, [...this._session.messages], this._sessionState, {
                onMessageStart: (id) => {
                    this._streamMsgId = id;
                    this.sendToWebview({ type: 'assistantStart', id, ts: Date.now() });
                },
                onToken: (tok) => {
                    this.sendToWebview({ type: 'token', id: this._streamMsgId, text: tok });
                    const cur = this._streamBuffers.get(this._streamMsgId) || '';
                    this._streamBuffers.set(this._streamMsgId, cur + tok);
                },
                onStreamEnd: async () => {
                    this.sendToWebview({ type: 'streamEnd', id: this._streamMsgId });
                    // Render markdown on the extension host using VS Code's built-in renderer
                    // and push the safe HTML to replace client-side rendering in the webview.
                    const msgId = this._streamMsgId;
                    const text = this._streamBuffers.get(msgId);
                    this._streamBuffers.delete(msgId);
                    if (text) {
                        try {
                            const html = await vscode.commands.executeCommand('markdown.api.render', text);
                            if (html) this.sendToWebview({ type: 'renderedMarkdown', id: msgId, html });
                        } catch { /* markdown extension unavailable — webview falls back to built-in renderer */ }
                    }
                },
                onUsage: ({ usage, uuid, msgId }) => {
                    this.sendToWebview({ type: 'usage', msgId, usage, uuid });
                },
                onToolStart: (call) => {
                    this.sendToWebview({ type: 'toolStart', msgId: call.msgId, call });
                },
                onToolDenied: (call) => {
                    this.sendToWebview({ type: 'toolDenied', msgId: call.msgId, call });
                },
                onToolEnd: (call) => {
                    this.sendToWebview({ type: 'toolEnd', msgId: call.msgId, call });
                },
                onStatus: (text) => {
                    this.sendToWebview({ type: 'status', text });
                    if (text) progress.report({ message: text });
                },
                onComplete: ({ messages: finalMessages, sessionState }) => {
                    this._session.messages = finalMessages;
                    this._sessionState = sessionState;
                    this._history.saveSession(this._session);
                    this.sendToWebview({ type: 'sessions', sessions: this._history.getSessions() });
                    this.sendToWebview({ type: 'done' });
                    this._autoFetchMonthlyUsage();
                },
                onError: (errMsg) => {
                    this.sendToWebview({ type: 'error', text: errMsg });
                    this.sendToWebview({ type: 'done' });
                }
            });
        });
    }

    // ── @ reference resolution ─────────────────────────────────────────────────

    async _resolveAtRefs(text) {
        const atPattern = /@([\w./\\-]+)/g;
        const contextBlocks = [];
        let m;

        while ((m = atPattern.exec(text)) !== null) {
            const refPath = m[1];
            try {
                const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
                const absPath = path.isAbsolute(refPath) ? refPath : path.join(root, refPath);

                // Prefer open document buffer so unsaved changes are included
                const openDoc = vscode.workspace.textDocuments.find(doc =>
                    doc.uri.fsPath === absPath ||
                    vscode.workspace.asRelativePath(doc.uri) === refPath
                );

                const content = openDoc
                    ? openDoc.getText()
                    : new TextDecoder('utf-8').decode(
                        await vscode.workspace.fs.readFile(vscode.Uri.file(absPath))
                      );
                contextBlocks.push({ path: refPath, content });
            } catch {
                // File not found — leave the @ref in text as-is
            }
        }

        return { displayText: text, contextBlocks };
    }

    // ── File suggestions for @ autocomplete ───────────────────────────────────

    async _sendFileSuggestions(query) {
        const q = (query || '').toLowerCase();
        const glob = q ? `**/*${q}*` : '**/*';
        const uris = await vscode.workspace.findFiles(glob, '{**/node_modules/**,**/.git/**}', 30);
        const files = uris.map(u => vscode.workspace.asRelativePath(u)).sort();
        this.sendToWebview({ type: 'fileSuggestions', files, query });
    }

    // ── Session management ─────────────────────────────────────────────────────

    _loadSession(id) {
        const sessions = this._history.getSessions();
        const session = sessions.find(s => s.id === id);
        if (!session) return;

        if (agentRunner.isRunning()) agentRunner.stop();
        this._clearPendingApprovals();
        if (this._session.messages.length > 0 && this._session.id !== id) {
            this._history.saveSession(this._session);
        }
        this._session = session;
        this._sessionState = null;
        this.sendToWebview({ type: 'loadSession', session });
    }

    // ── Monthly usage ──────────────────────────────────────────────────────────

    _supportsMonthlyUsage() {
        try {
            const { adapter } = api.resolveActive();
            return typeof adapter.getMonthlyUsage === 'function';
        } catch { return false; }
    }

    async _fetchMonthlyUsage(force = false) {
        if (!force) {
            const cached = this._readCache('sa_monthly_cache', MONTHLY_CACHE_TTL);
            if (cached) {
                this.sendToWebview({ type: 'monthlyUsage', data: cached.data });
                return;
            }
        }
        let resolved;
        try { resolved = api.resolveActive(); } catch (e) {
            this.sendToWebview({ type: 'monthlyUsage', error: e.message });
            return;
        }
        const { server, endpoint, adapter } = resolved;
        if (typeof adapter.getMonthlyUsage !== 'function') {
            this.sendToWebview({ type: 'monthlyUsage', error: 'Not supported by this adapter' });
            return;
        }
        try {
            const data = await adapter.getMonthlyUsage(server, endpoint);
            this._writeCache('sa_monthly_cache', { data });
            this.sendToWebview({ type: 'monthlyUsage', data });
        } catch (e) {
            logger.error('getMonthlyUsage', e);
            this.sendToWebview({ type: 'monthlyUsage', error: e.message });
        }
    }

    _autoFetchMonthlyUsage() {
        if (this._supportsMonthlyUsage()) {
            this._fetchMonthlyUsage(true).catch(() => {});
        }
    }

    // ── Cache helpers ──────────────────────────────────────────────────────────

    _endpointCacheKey() {
        try {
            const { server, endpoint } = api.resolveActive();
            return `${server.url}::${endpoint.adapter}::${endpoint.name}`;
        } catch { return null; }
    }

    _readCache(storeKey, ttl) {
        const key = this._endpointCacheKey();
        if (!key) return null;
        const store = this._ctx.globalState.get(storeKey, {});
        const entry = store[key];
        if (!entry || Date.now() - entry.ts > ttl) return null;
        return entry;
    }

    _writeCache(storeKey, payload) {
        const key = this._endpointCacheKey();
        if (!key) return;
        const store = this._ctx.globalState.get(storeKey, {});
        store[key] = { ...payload, ts: Date.now() };
        this._ctx.globalState.update(storeKey, store);
    }

    // ── Pending approval cleanup ───────────────────────────────────────────────

    _clearPendingApprovals() {
        for (const [, { resolve }] of this._pendingApprovals) {
            resolve('deny');
        }
        this._pendingApprovals.clear();
        this.sendToWebview({ type: 'clearApprovals' });
    }

    // ── Settings updates ───────────────────────────────────────────────────────

    async _updateToolPermission(tool, level) {
        const cfg = vscode.workspace.getConfiguration('standaloneAgent');
        const perms = { ...cfg.get('toolPermissions', {}), [tool]: level };
        await cfg.update('toolPermissions', perms, vscode.ConfigurationTarget.Global);
    }

    async _updateSetting(key, value) {
        const cfg = vscode.workspace.getConfiguration('standaloneAgent');
        if (key === 'servers') {
            // Extract API keys → secrets; strip them (and the transient hasKey flag) from config
            const sanitized = await Promise.all((value || []).map(async srv => {
                const { apiKey, hasKey, ...rest } = srv;
                if (apiKey) {
                    await this._ctx.secrets.store(`secret_key_${srv.name}`, apiKey);
                }
                return rest;
            }));
            await cfg.update('servers', sanitized, vscode.ConfigurationTarget.Global);
            return;
        }
        await cfg.update(key, value, vscode.ConfigurationTarget.Global);
    }

    // ── Secure key storage helpers ─────────────────────────────────────────────

    // One-time migration: moves any plain-text apiKey values from settings.json into secrets.
    async _migrateApiKeys() {
        const cfg = vscode.workspace.getConfiguration('standaloneAgent');
        const servers = cfg.get('servers', []);
        const toMigrate = servers.filter(s => s.apiKey);
        if (toMigrate.length === 0) return;
        for (const srv of toMigrate) {
            await this._ctx.secrets.store(`secret_key_${srv.name}`, srv.apiKey);
        }
        const sanitized = servers.map(({ apiKey, ...rest }) => rest);
        await cfg.update('servers', sanitized, vscode.ConfigurationTarget.Global);
    }

    // Returns servers without apiKey but with a hasKey boolean for the UI.
    async _getServersForWebview() {
        const servers = api.getServers();
        return await Promise.all(servers.map(async srv => {
            const { apiKey, ...rest } = srv;
            const hasKey = !!(apiKey || await this._ctx.secrets.get(`secret_key_${srv.name}`));
            return { ...rest, hasKey };
        }));
    }

    // ── HTML generation ────────────────────────────────────────────────────────

    _buildHtml(webview) {
        const nonce = crypto.randomBytes(16).toString('hex');
        const mediaUri = vscode.Uri.joinPath(this._ctx.extensionUri, 'media');

        function uri(file) {
            return webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, file));
        }

        const cssUri = uri('chat.css');
        const jsUri  = uri('chat.js');

        return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none';
                 script-src 'nonce-${nonce}';
                 style-src ${webview.cspSource} 'unsafe-inline';
                 img-src ${webview.cspSource} data:;
                 font-src ${webview.cspSource};">
  <link rel="stylesheet" href="${cssUri}">
  <title>Standalone Agent</title>
</head>
<body>
  <script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
    }
}

module.exports = ChatViewProvider;
