const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const api = require('./apiClient');
const agentRunner = require('./agentRunner');
const toolHandler = require('./toolHandler');
const HistoryManager = require('./historyManager');
const logger = require('./logger');
const certLoader = require('./certLoader');

class ChatViewProvider {
    constructor(context) {
        this._ctx = context;
        this._view = null;
        this._history = new HistoryManager(context);
        this._session = this._history.createSession();
        this._mode = 'chat';
        this._streamMsgId = '';
        this._sessionState = null; // ephemeral adapter state (e.g. session ID for gemini-jank)
        certLoader.configure({ enabled: api.getConfig().get('winCertStore', true) });
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
        this.sendToWebview({
            type: 'configUpdate',
            servers: api.getServers(),
            endpoints: api.getEndpoints(),
            activeEndpoint: cfg.get('activeEndpoint', ''),
            model: cfg.get('model', ''),
            streaming: cfg.get('streaming', true),
            enterToSend: cfg.get('enterToSend', true),
            verboseLogging: cfg.get('verboseLogging', false),
            maxIterations: cfg.get('maxIterations', 20),
            toolPermissions: cfg.get('toolPermissions', {})
        });
        // Switching endpoints resets adapter session state
        this._sessionState = null;
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
                break;

            case 'newChat':
                this.newChat();
                break;

            case 'setMode':
                this._mode = msg.mode;
                break;

            case 'getModels':
                await this._fetchModels();
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
        const cfg = api.getConfig();
        this.sendToWebview({
            type: 'init',
            sessions: this._history.getSessions(),
            session: this._session,
            mode: this._mode,
            servers: api.getServers(),
            endpoints: api.getEndpoints(),
            activeEndpoint: cfg.get('activeEndpoint', ''),
            model: cfg.get('model', ''),
            streaming: cfg.get('streaming', true),
            enterToSend: cfg.get('enterToSend', true),
            verboseLogging: logger.isVerbose(),
            maxIterations: cfg.get('maxIterations', 20),
            toolPermissions: cfg.get('toolPermissions', {}),
            toolDefs: toolHandler.ALL_TOOLS.map(t => t.function.name)
        });

        // Auto-fetch models in background
        this._fetchModels().catch(() => {});
    }

    async _fetchModels() {
        const models = await api.listModels();
        const current = api.getConfig().get('model', '');
        this.sendToWebview({ type: 'models', models, current });
    }

    // ── User message handling ──────────────────────────────────────────────────

    async _handleUserMessage(rawText) {
        if (!rawText.trim()) return;

        // Resolve @file references
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

        if (this._session.messages.length > 0) {
            this._history.saveSession(this._session);
        }

        // Find the userMsgIdx-th user message and slice before it
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
        await agentRunner.run(this._mode, [...this._session.messages], this._sessionState, {
            onMessageStart: (id) => {
                this._streamMsgId = id;
                this.sendToWebview({ type: 'assistantStart', id, ts: Date.now() });
            },
            onToken: (tok) => {
                this.sendToWebview({ type: 'token', id: this._streamMsgId, text: tok });
            },
            onStreamEnd: () => {
                this.sendToWebview({ type: 'streamEnd', id: this._streamMsgId });
            },
            onToolStart: (call) => {
                this.sendToWebview({ type: 'toolStart', msgId: call.msgId, call });
            },
            onToolEnd: (call) => {
                this.sendToWebview({ type: 'toolEnd', msgId: call.msgId, call });
            },
            onStatus: (text) => {
                this.sendToWebview({ type: 'status', text });
            },
            onComplete: ({ messages: finalMessages, sessionState }) => {
                this._session.messages = finalMessages;
                this._sessionState = sessionState;
                this._history.saveSession(this._session);
                this.sendToWebview({ type: 'sessions', sessions: this._history.getSessions() });
                this.sendToWebview({ type: 'done' });
            },
            onError: (errMsg) => {
                this.sendToWebview({ type: 'error', text: errMsg });
                this.sendToWebview({ type: 'done' });
            }
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
                const abs = path.isAbsolute(refPath) ? refPath : path.join(root, refPath);
                const content = fs.readFileSync(abs, 'utf8');
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
        if (this._session.messages.length > 0 && this._session.id !== id) {
            this._history.saveSession(this._session);
        }
        this._session = session;
        this._sessionState = null; // session state is ephemeral — don't carry over to loaded session
        this.sendToWebview({ type: 'loadSession', session });
    }

    // ── Settings updates ───────────────────────────────────────────────────────

    async _updateToolPermission(tool, level) {
        const cfg = vscode.workspace.getConfiguration('standaloneAgent');
        const perms = { ...cfg.get('toolPermissions', {}), [tool]: level };
        await cfg.update('toolPermissions', perms, vscode.ConfigurationTarget.Global);
    }

    async _updateSetting(key, value) {
        const cfg = vscode.workspace.getConfiguration('standaloneAgent');
        await cfg.update(key, value, vscode.ConfigurationTarget.Global);
    }

    // ── HTML generation ────────────────────────────────────────────────────────

    _buildHtml(webview) {
        const nonce = crypto.randomBytes(16).toString('hex');
        const mediaUri = vscode.Uri.joinPath(this._ctx.extensionUri, 'media');

        function uri(file) {
            return webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, file));
        }

        const cssUri    = uri('chat.css');
        const jsUri     = uri('chat.js');
        const markedPath = path.join(this._ctx.extensionUri.fsPath, 'media', 'marked.min.js');
        const hasMarked = fs.existsSync(markedPath);
        const markedTag = hasMarked
            ? `<script nonce="${nonce}" src="${uri('marked.min.js')}"></script>`
            : '';

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
  ${markedTag}
  <script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
    }
}

module.exports = ChatViewProvider;
