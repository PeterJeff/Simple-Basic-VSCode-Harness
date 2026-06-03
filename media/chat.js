/* Standalone Agent — webview UI
 * Runs inside VSCode's sandboxed webview context.
 * All extension-host calls go through vscode.postMessage / window.addEventListener('message').
 */
(function () {
    'use strict';

    const vscode = acquireVsCodeApi();

    // ── State ────────────────────────────────────────────────────────────────
    const state = {
        mode:             'chat',
        isProcessing:     false,
        markdownEnabled:  true,
        streamingEnabled: true,
        enterToSend:      true,     // true = Enter sends; false = Shift+Enter sends
        verbose:          false,
        sessions:         [],
        messages:         [],      // { id, role, raw, toolCalls:[], pending? }
        toolPermissions:  {},
        toolDefs:         [],
        servers:          [],
        endpoints:        [],
        activeEndpoint:   '',
        models:           [],
        currentModel:     '',
        atQuery:          '',
        atCursorStart:    -1,
        atDropdownItems:  [],
        atSelectedIdx:    -1,
        usageByMsgId:     {},
        toolCallMode:     'api',
    };

    // ── Build DOM ────────────────────────────────────────────────────────────

    document.body.innerHTML = `
<div id="toolbar">
  <select id="mode-select" title="Mode">
    <option value="chat">Chat</option>
    <option value="plan">Plan</option>
    <option value="agent">Agent</option>
  </select>
  <select id="endpoint-select" title="Endpoint"></select>
  <select id="model-select" title="Model"><option value="">-- model --</option></select>
  <button class="icon-btn" id="refresh-models-btn" title="Refresh model list">⟳</button>
  <button class="icon-btn" id="monthly-usage-btn" title="Show monthly token usage">⬡</button>
  <button class="icon-btn" id="history-btn" title="Chat history">☰</button>
  <button class="icon-btn" id="settings-btn" title="Settings">⚙</button>
</div>

<div id="monthly-usage-bar">
  <span id="monthly-usage-display"></span>
  <button class="icon-btn" id="monthly-usage-close">✕</button>
</div>

<div id="main">
  <div id="chat-panel">
    <div id="messages"></div>
    <div id="statusbar">
      <span id="status-text"></span>
      <button id="stop-btn">■ Stop</button>
    </div>
    <div id="input-area" style="position:relative;">
      <div id="at-dropdown"></div>
      <div id="input-row">
        <textarea id="msg-input" rows="2" placeholder="Message… (@ = insert file)"></textarea>
        <button id="send-btn" title="Send (Enter)">➤</button>
      </div>
      <div id="input-toggles">
        <button class="toggle-btn active" id="md-toggle" title="Toggle markdown rendering">MD</button>
        <button class="toggle-btn active" id="stream-toggle" title="Toggle streaming">Stream</button>
        <button class="toggle-btn active" id="tc-mode-btn" title="Tool call mode: API-native (click to switch to text-injection)">TC:API</button>
        <span style="flex:1"></span>
        <span id="iter-badge" style="font-size:10px; color:var(--vscode-descriptionForeground);"></span>
      </div>
    </div>
  </div>

  <div id="history-panel">
    <div class="panel-header">
      History
      <button class="panel-close" id="history-close">✕</button>
    </div>
    <div id="session-list"></div>
  </div>

  <div id="settings-panel">
    <div class="panel-header">
      Settings
      <button class="panel-close" id="settings-close">✕</button>
    </div>
    <div class="settings-body">
      <div class="settings-group">
        <label>Max Iterations</label>
        <input type="number" id="set-max-iter" min="1" max="100" value="20">
      </div>
      <div class="settings-group">
        <label>System Prompt Override</label>
        <textarea id="set-system-prompt" placeholder="Leave empty to use built-in mode prompts"></textarea>
      </div>
      <div class="settings-group">
        <label>Options</label>
        <div class="settings-row">
          <span>Enter sends message</span>
          <label class="toggle-switch">
            <input type="checkbox" id="set-enter-to-send" checked>
            <span class="toggle-track"></span>
          </label>
        </div>
        <div style="font-size:10px; color:var(--vscode-descriptionForeground); margin-top:2px;" id="enter-hint">
          ON: Enter = send, Shift+Enter = newline
        </div>
        <div class="settings-row" style="margin-top:6px;">
          <span>Verbose logging</span>
          <label class="toggle-switch">
            <input type="checkbox" id="set-verbose">
            <span class="toggle-track"></span>
          </label>
        </div>
      </div>
      <div class="settings-group">
        <div class="config-section-header">
          <label>Servers</label>
          <button class="link-btn" id="add-server-btn">+ Add</button>
        </div>
        <div id="server-list"></div>
      </div>
      <div class="settings-group">
        <div class="config-section-header">
          <label>Endpoints</label>
          <button class="link-btn" id="add-endpoint-btn">+ Add</button>
        </div>
        <div id="endpoint-list"></div>
      </div>
      <div class="settings-group">
        <label>Tool Permissions</label>
        <table class="perm-table">
          <thead><tr><th>Tool</th><th>Permission</th></tr></thead>
          <tbody id="perm-tbody"></tbody>
        </table>
      </div>
    </div>
    <div class="settings-footer">
      <button class="open-settings-btn" id="open-vscode-settings">Open Full Settings (settings.json) ↗</button>
    </div>
  </div>
</div>`;

    // ── Element refs ─────────────────────────────────────────────────────────
    const el = {
        modeSelect:       q('#mode-select'),
        endpointSelect:   q('#endpoint-select'),
        modelSelect:      q('#model-select'),
        refreshModels:    q('#refresh-models-btn'),
        historyBtn:       q('#history-btn'),
        settingsBtn:      q('#settings-btn'),
        messages:         q('#messages'),
        statusText:       q('#status-text'),
        stopBtn:          q('#stop-btn'),
        msgInput:         q('#msg-input'),
        sendBtn:          q('#send-btn'),
        mdToggle:         q('#md-toggle'),
        streamToggle:     q('#stream-toggle'),
        tcModeBtn:        q('#tc-mode-btn'),
        iterBadge:        q('#iter-badge'),
        atDropdown:       q('#at-dropdown'),
        historyPanel:     q('#history-panel'),
        historyClose:     q('#history-close'),
        sessionList:      q('#session-list'),
        settingsPanel:    q('#settings-panel'),
        settingsClose:    q('#settings-close'),
        setMaxIter:       q('#set-max-iter'),
        setSystemPrompt:  q('#set-system-prompt'),
        setEnterToSend:   q('#set-enter-to-send'),
        enterHint:        q('#enter-hint'),
        setVerbose:       q('#set-verbose'),
        permTbody:        q('#perm-tbody'),
        openVscodeSettings: q('#open-vscode-settings'),
        serverList:         q('#server-list'),
        addServerBtn:       q('#add-server-btn'),
        endpointList:         q('#endpoint-list'),
        addEndpointBtn:       q('#add-endpoint-btn'),
        monthlyUsageBtn:      q('#monthly-usage-btn'),
        monthlyUsageBar:      q('#monthly-usage-bar'),
        monthlyUsageDisplay:  q('#monthly-usage-display'),
        monthlyUsageClose:    q('#monthly-usage-close'),
    };

    function q(sel) { return document.querySelector(sel); }

    // ── Markdown renderer ────────────────────────────────────────────────────
    // Uses window.marked if available (place marked.min.js in media/), otherwise falls back.

    function renderMarkdown(raw) {
        if (!raw) return '';
        if (window.marked) {
            try {
                marked.setOptions({ breaks: true, gfm: true });
                return marked.parse(raw);
            } catch { /* fall through */ }
        }
        return builtinMd(raw);
    }

    function builtinMd(text) {
        let h = esc(text);

        // Fenced code blocks
        h = h.replace(/```([a-zA-Z0-9]*)\n?([\s\S]*?)```/g, (_, lang, code) => {
            return `<pre><button class="copy-btn" onclick="copyCode(this)">Copy</button>`
                 + `<code class="lang-${esc(lang)}">${code}</code></pre>`;
        });

        // Inline code
        h = h.replace(/`([^`\n]+)`/g, '<code>$1</code>');

        // Headers
        h = h.replace(/^###### (.+)$/gm, '<h6>$1</h6>');
        h = h.replace(/^##### (.+)$/gm,  '<h5>$1</h5>');
        h = h.replace(/^#### (.+)$/gm,   '<h4>$1</h4>');
        h = h.replace(/^### (.+)$/gm,    '<h3>$1</h3>');
        h = h.replace(/^## (.+)$/gm,     '<h2>$1</h2>');
        h = h.replace(/^# (.+)$/gm,      '<h1>$1</h1>');

        // Bold / italic
        h = h.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
        h = h.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
        h = h.replace(/\*(.+?)\*/g, '<em>$1</em>');

        // HR
        h = h.replace(/^---+$/gm, '<hr>');

        // Blockquote
        h = h.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');

        // Unordered lists
        h = h.replace(/((?:^- .+\n?)+)/gm, (block) => {
            const items = block.trim().split('\n').map(l => `<li>${l.replace(/^- /, '')}</li>`).join('');
            return `<ul>${items}</ul>`;
        });

        // Ordered lists
        h = h.replace(/((?:^\d+\. .+\n?)+)/gm, (block) => {
            const items = block.trim().split('\n').map(l => `<li>${l.replace(/^\d+\. /, '')}</li>`).join('');
            return `<ol>${items}</ol>`;
        });

        // Links
        h = h.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

        // Paragraphs: double newlines → <p>
        h = h.split(/\n{2,}/).map(para => {
            para = para.trim();
            if (!para) return '';
            if (/^<(h[1-6]|ul|ol|pre|hr|blockquote)/.test(para)) return para;
            return `<p>${para.replace(/\n/g, '<br>')}</p>`;
        }).join('\n');

        return h;
    }

    function esc(str) {
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function fmtTime(ts) {
        if (!ts) return '';
        return new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    }

    // Global for copy button (inline onclick)
    window.copyCode = function(btn) {
        const code = btn.nextElementSibling?.textContent || '';
        navigator.clipboard?.writeText(code).then(() => {
            btn.textContent = 'Copied!';
            setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
        });
    };

    // ── Message rendering ────────────────────────────────────────────────────

    function _applyUsageBadge(msgEl, usage) {
        if (!usage) return;
        msgEl.querySelector('.usage-badge')?.remove();
        const total = usage.total_tokens || usage.totalTokens
                   || ((usage.prompt_tokens || 0) + (usage.completion_tokens || 0)) || null;
        if (!total) return;
        const badge = document.createElement('div');
        badge.className = 'usage-badge';
        badge.textContent = `${total.toLocaleString()} tokens`;
        const footer = msgEl.querySelector('.msg-footer');
        footer ? msgEl.insertBefore(badge, footer) : msgEl.appendChild(badge);
    }

    function createUserEl(msg) {
        const div = document.createElement('div');
        div.className = 'msg msg-user';
        div.dataset.id = msg.id;

        let html = `<div>${esc(msg.raw).replace(/\n/g, '<br>')}</div>`;
        if (msg.contextFiles && msg.contextFiles.length > 0) {
            html += `<div class="ctx-files">📎 ${msg.contextFiles.map(esc).join(', ')}</div>`;
        }
        const ts = msg.ts ? fmtTime(msg.ts) : '';
        html += `<div class="msg-footer">
  <button class="msg-action-btn msg-edit-btn" title="Edit &amp; fork conversation from here">✎</button>
  <button class="msg-action-btn msg-copy-btn" title="Copy raw text">⎘</button>
  <span style="flex:1"></span>
  <span class="msg-ts">${ts}</span>
</div>`;
        div.innerHTML = html;

        div.querySelector('.msg-edit-btn').addEventListener('click', () => handleEdit(msg.id));
        div.querySelector('.msg-copy-btn').addEventListener('click', function() {
            navigator.clipboard?.writeText(msg.raw).then(() => {
                this.textContent = '✓';
                setTimeout(() => { this.textContent = '⎘'; }, 1500);
            });
        });

        return div;
    }

    function createAssistantEl(msg) {
        const div = document.createElement('div');
        div.className = 'msg msg-assistant';
        div.dataset.id = msg.id;
        if (msg.pending) div.classList.add('streaming');

        const contentDiv = document.createElement('div');
        contentDiv.className = 'md-content';
        contentDiv.innerHTML = msg.raw
            ? (state.markdownEnabled ? renderMarkdown(msg.raw) : `<pre>${esc(msg.raw)}</pre>`)
            : '';
        div.appendChild(contentDiv);

        if (msg.toolCalls && msg.toolCalls.length > 0) {
            for (const tc of msg.toolCalls) {
                div.appendChild(createToolBlock(tc));
            }
        }

        const footer = document.createElement('div');
        footer.className = 'msg-footer';
        const copyBtn = document.createElement('button');
        copyBtn.className = 'msg-action-btn msg-copy-btn';
        copyBtn.title = 'Copy raw text';
        copyBtn.textContent = '⎘';
        copyBtn.addEventListener('click', function() {
            navigator.clipboard?.writeText(msg.raw).then(() => {
                this.textContent = '✓';
                setTimeout(() => { this.textContent = '⎘'; }, 1500);
            });
        });
        const spacer = document.createElement('span');
        spacer.style.flex = '1';
        const tsSpan = document.createElement('span');
        tsSpan.className = 'msg-ts';
        tsSpan.textContent = msg.ts ? fmtTime(msg.ts) : '';
        footer.appendChild(copyBtn);
        footer.appendChild(spacer);
        footer.appendChild(tsSpan);
        div.appendChild(footer);

        return div;
    }

    function createErrorEl(text) {
        const div = document.createElement('div');
        div.className = 'msg-error';
        const msgSpan = document.createElement('span');
        msgSpan.textContent = '⚠ ' + text;
        div.appendChild(msgSpan);
        const retryBtn = document.createElement('button');
        retryBtn.className = 'retry-btn';
        retryBtn.textContent = '↻ Retry';
        retryBtn.addEventListener('click', handleRetry);
        div.appendChild(retryBtn);
        return div;
    }

    function createToolBlock(tc) {
        const block = document.createElement('div');
        block.className = 'tool-block';
        block.dataset.tcid = tc.id;

        const stateIcon = tc.done ? (tc.result?.error ? '✕' : '✓') : '<span class="tool-spinner">⟳</span>';
        const stateText = tc.done ? (tc.result?.error ? 'error' : 'done') : 'running…';

        const args = tc.args ? JSON.stringify(tc.args, null, 2) : '';
        const resultText = tc.result ? JSON.stringify(tc.result, null, 2) : '';

        block.innerHTML = `
<div class="tool-header" onclick="this.parentElement.classList.toggle('open')">
  <span>${stateIcon}</span>
  <span class="tool-name">${esc(tc.name)}</span>
  <span class="tool-state">${stateText}</span>
</div>
<div class="tool-body">${tc.done
    ? `<b>args:</b>\n${esc(args)}\n\n<b>result:</b>\n${esc(resultText)}`
    : `<b>args:</b>\n${esc(args)}`
}</div>`;
        return block;
    }

    function rerenderAll() {
        el.messages.innerHTML = '';
        for (const msg of state.messages) {
            if (msg.role === 'user') {
                el.messages.appendChild(createUserEl(msg));
            } else if (msg.role === 'assistant') {
                const domEl = createAssistantEl(msg);
                if (state.usageByMsgId[msg.id]) _applyUsageBadge(domEl, state.usageByMsgId[msg.id].usage);
                el.messages.appendChild(domEl);
            } else if (msg.role === 'error') {
                el.messages.appendChild(createErrorEl(msg.raw));
            }
        }
        scrollBottom();
    }

    function scrollBottom() {
        el.messages.scrollTop = el.messages.scrollHeight;
    }

    // ── Processing state helpers ─────────────────────────────────────────────

    function setProcessing(v) {
        state.isProcessing = v;
        el.sendBtn.disabled = v;
        el.msgInput.disabled = v;
        el.stopBtn.classList.toggle('visible', v);
        if (!v) el.statusText.textContent = '';
    }

    // ── Edit / retry ─────────────────────────────────────────────────────────

    function handleEdit(msgId) {
        const idx = state.messages.findIndex(m => m.id === msgId);
        if (idx === -1) return;
        const msg = state.messages[idx];

        // Count user messages strictly before this one so host can slice correctly
        const userMsgIdx = state.messages.slice(0, idx).filter(m => m.role === 'user').length;

        // Restore text to input
        el.msgInput.value = msg.raw;
        el.msgInput.style.height = 'auto';
        el.msgInput.style.height = Math.min(el.msgInput.scrollHeight, 160) + 'px';
        el.msgInput.focus();

        // Truncate display and tell host to fork the session
        state.messages = state.messages.slice(0, idx);
        rerenderAll();
        vscode.postMessage({ type: 'fork', userMsgIdx });
    }

    function handleRetry() {
        if (state.isProcessing) return;
        // Remove trailing errors and any pending assistant bubble
        while (state.messages.length > 0) {
            const last = state.messages[state.messages.length - 1];
            if (last.role === 'error' || last.pending) { state.messages.pop(); }
            else break;
        }
        rerenderAll();
        vscode.postMessage({ type: 'retry' });
    }

    // ── Toolbar interactions ─────────────────────────────────────────────────

    el.modeSelect.addEventListener('change', () => {
        state.mode = el.modeSelect.value;
        vscode.postMessage({ type: 'setMode', mode: state.mode });
    });

    el.endpointSelect.addEventListener('change', () => {
        vscode.postMessage({ type: 'setEndpoint', name: el.endpointSelect.value });
    });

    el.modelSelect.addEventListener('change', () => {
        vscode.postMessage({ type: 'setModel', model: el.modelSelect.value });
    });

    el.refreshModels.addEventListener('click', () => {
        el.refreshModels.textContent = '…';
        vscode.postMessage({ type: 'getModels' });
        setTimeout(() => { el.refreshModels.textContent = '⟳'; }, 2000);
    });

    el.monthlyUsageBtn.addEventListener('click', () => {
        el.monthlyUsageDisplay.textContent = 'Loading…';
        el.monthlyUsageBar.style.display = 'flex';
        vscode.postMessage({ type: 'getMonthlyUsage' });
    });
    el.monthlyUsageClose.addEventListener('click', () => {
        el.monthlyUsageBar.style.display = 'none';
    });

    el.historyBtn.addEventListener('click', () => {
        el.historyPanel.classList.add('visible');
        renderSessionList();
    });
    el.historyClose.addEventListener('click', () => el.historyPanel.classList.remove('visible'));

    el.settingsBtn.addEventListener('click', () => el.settingsPanel.classList.add('visible'));
    el.settingsClose.addEventListener('click', () => el.settingsPanel.classList.remove('visible'));

    el.stopBtn.addEventListener('click', () => vscode.postMessage({ type: 'stop' }));

    // ── Input toggles ────────────────────────────────────────────────────────

    el.mdToggle.addEventListener('click', () => {
        state.markdownEnabled = !state.markdownEnabled;
        el.mdToggle.classList.toggle('active', state.markdownEnabled);
        rerenderAll();
    });

    el.streamToggle.addEventListener('click', () => {
        state.streamingEnabled = !state.streamingEnabled;
        el.streamToggle.classList.toggle('active', state.streamingEnabled);
        vscode.postMessage({ type: 'updateSetting', key: 'streaming', value: state.streamingEnabled });
    });

    el.tcModeBtn.addEventListener('click', () => {
        state.toolCallMode = state.toolCallMode === 'api' ? 'prompt' : 'api';
        const isApi = state.toolCallMode === 'api';
        el.tcModeBtn.textContent = isApi ? 'TC:API' : 'TC:TXT';
        el.tcModeBtn.title = isApi
            ? 'Tool call mode: API-native (click to switch to text-injection)'
            : 'Tool call mode: Text-injection (click to switch to API-native)';
        el.tcModeBtn.classList.toggle('active', isApi);
        vscode.postMessage({ type: 'updateSetting', key: 'askSageToolMode', value: state.toolCallMode });
    });

    // ── Send message ─────────────────────────────────────────────────────────

    function sendMessage() {
        const text = el.msgInput.value.trim();
        if (!text || state.isProcessing) return;
        closeAtDropdown();
        el.msgInput.value = '';
        el.msgInput.style.height = '';
        vscode.postMessage({ type: 'send', text });
    }

    el.sendBtn.addEventListener('click', sendMessage);

    el.msgInput.addEventListener('keydown', (e) => {
        if (el.atDropdown.classList.contains('visible')) {
            if (e.key === 'ArrowDown') { e.preventDefault(); moveAtSelection(1); return; }
            if (e.key === 'ArrowUp')   { e.preventDefault(); moveAtSelection(-1); return; }
            if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault();
                confirmAtSelection();
                return;
            }
            if (e.key === 'Escape') { e.preventDefault(); closeAtDropdown(); return; }
        }
        // Send key behaviour depends on enterToSend setting
        const sendPressed  = state.enterToSend  ? (e.key === 'Enter'  && !e.shiftKey) : (e.key === 'Enter' && e.shiftKey);
        if (sendPressed) {
            e.preventDefault();
            sendMessage();
        }
    });

    // Auto-resize textarea
    el.msgInput.addEventListener('input', () => {
        el.msgInput.style.height = 'auto';
        el.msgInput.style.height = Math.min(el.msgInput.scrollHeight, 160) + 'px';
        handleAtInput();
    });

    // ── @ autocomplete ───────────────────────────────────────────────────────

    function handleAtInput() {
        const val = el.msgInput.value;
        const cursor = el.msgInput.selectionStart;

        // Find the @ that's "active": scan back from cursor
        let atPos = -1;
        for (let i = cursor - 1; i >= 0; i--) {
            if (val[i] === '@') { atPos = i; break; }
            if (val[i] === ' ' || val[i] === '\n') break;
        }

        if (atPos === -1) { closeAtDropdown(); return; }

        const query = val.slice(atPos + 1, cursor);
        // Only trigger if query has no spaces
        if (query.includes(' ') || query.includes('\n')) { closeAtDropdown(); return; }

        state.atCursorStart = atPos;
        state.atQuery = query;
        vscode.postMessage({ type: 'getFileSuggestions', query });
    }

    function showAtDropdown(files) {
        state.atDropdownItems = files;
        state.atSelectedIdx = files.length > 0 ? 0 : -1;

        if (files.length === 0) { closeAtDropdown(); return; }

        el.atDropdown.innerHTML = files.map((f, i) =>
            `<div class="at-item${i === 0 ? ' selected' : ''}" data-idx="${i}">${esc(f)}</div>`
        ).join('');

        el.atDropdown.querySelectorAll('.at-item').forEach(item => {
            item.addEventListener('mousedown', (e) => {
                e.preventDefault();
                state.atSelectedIdx = parseInt(item.dataset.idx);
                confirmAtSelection();
            });
        });

        el.atDropdown.classList.add('visible');
    }

    function closeAtDropdown() {
        el.atDropdown.classList.remove('visible');
        state.atDropdownItems = [];
        state.atSelectedIdx = -1;
        state.atCursorStart = -1;
    }

    function moveAtSelection(delta) {
        const n = state.atDropdownItems.length;
        if (n === 0) return;
        state.atSelectedIdx = (state.atSelectedIdx + delta + n) % n;
        el.atDropdown.querySelectorAll('.at-item').forEach((item, i) => {
            item.classList.toggle('selected', i === state.atSelectedIdx);
        });
        el.atDropdown.querySelectorAll('.at-item')[state.atSelectedIdx]?.scrollIntoView({ block: 'nearest' });
    }

    function confirmAtSelection() {
        if (state.atSelectedIdx < 0 || state.atDropdownItems.length === 0) return;
        const chosen = state.atDropdownItems[state.atSelectedIdx];
        const val = el.msgInput.value;
        const cursor = el.msgInput.selectionStart;
        const before = val.slice(0, state.atCursorStart);
        const after  = val.slice(cursor);
        el.msgInput.value = before + '@' + chosen + ' ' + after;
        const newCursor = before.length + chosen.length + 2;
        el.msgInput.setSelectionRange(newCursor, newCursor);
        closeAtDropdown();
    }

    // ── History panel ────────────────────────────────────────────────────────

    function renderSessionList() {
        if (state.sessions.length === 0) {
            el.sessionList.innerHTML = '<div class="no-sessions">No saved chats yet</div>';
            return;
        }
        el.sessionList.innerHTML = '';
        for (const s of state.sessions) {
            const item = document.createElement('div');
            item.className = 'session-item';
            const date = new Date(s.created).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
            item.innerHTML = `
<span class="session-title">${esc(s.title || 'Untitled')}</span>
<span class="session-date">${esc(date)}</span>
<button class="session-del" title="Delete" data-id="${esc(s.id)}">✕</button>`;

            item.querySelector('.session-del').addEventListener('click', (e) => {
                e.stopPropagation();
                vscode.postMessage({ type: 'deleteSession', id: s.id });
            });

            item.addEventListener('click', (e) => {
                if (e.target.classList.contains('session-del')) return;
                vscode.postMessage({ type: 'loadSession', id: s.id });
                el.historyPanel.classList.remove('visible');
            });

            el.sessionList.appendChild(item);
        }
    }

    // ── Settings panel ───────────────────────────────────────────────────────

    function buildPermTable() {
        el.permTbody.innerHTML = '';
        const tools = state.toolDefs.length > 0
            ? state.toolDefs
            : Object.keys(state.toolPermissions);

        for (const tool of tools) {
            const current = state.toolPermissions[tool] || 'ask';
            const tr = document.createElement('tr');
            tr.innerHTML = `
<td style="font-family:monospace">${esc(tool)}</td>
<td>
  <select data-tool="${esc(tool)}">
    <option value="allow" ${current==='allow'?'selected':''}>allow</option>
    <option value="ask"   ${current==='ask'  ?'selected':''}>ask</option>
    <option value="deny"  ${current==='deny' ?'selected':''}>deny</option>
  </select>
</td>`;
            tr.querySelector('select').addEventListener('change', (e) => {
                const t = e.target.dataset.tool;
                const v = e.target.value;
                state.toolPermissions[t] = v;
                vscode.postMessage({ type: 'updateToolPermission', tool: t, level: v });
            });
            el.permTbody.appendChild(tr);
        }
    }

    // ── Servers & Endpoints management ──────────────────────────────────────

    function saveServers() {
        vscode.postMessage({ type: 'updateSetting', key: 'servers', value: state.servers });
    }

    function saveEndpoints() {
        vscode.postMessage({ type: 'updateSetting', key: 'endpoints', value: state.endpoints });
    }

    function makeServerForm(server, onSave, onCancel) {
        const form = document.createElement('div');
        form.className = 'config-edit-form';
        form.innerHTML = `
<input type="text" class="ef-name" placeholder="Name (e.g. Local)" value="${esc(server.name || '')}">
<input type="text" class="ef-url" placeholder="URL (e.g. http://localhost:11434/v1)" value="${esc(server.url || '')}">
<input type="password" class="ef-key" placeholder="API Key (optional)" value="${esc(server.apiKey || '')}">
<div class="config-form-actions">
  <button class="config-save-btn">Save</button>
  <button class="config-cancel-btn">Cancel</button>
</div>`;
        form.querySelector('.config-save-btn').addEventListener('click', () => {
            const name = form.querySelector('.ef-name').value.trim();
            const url  = form.querySelector('.ef-url').value.trim();
            if (!name || !url) return;
            onSave({ name, url, apiKey: form.querySelector('.ef-key').value });
        });
        form.querySelector('.config-cancel-btn').addEventListener('click', onCancel);
        return form;
    }

    function renderServerList() {
        el.serverList.innerHTML = '';
        state.servers.forEach((srv, i) => {
            const row = document.createElement('div');
            row.className = 'config-item';
            row.innerHTML = `
<span class="config-item-name" title="${esc(srv.name)}">${esc(srv.name)}</span>
<span class="config-item-detail" title="${esc(srv.url)}">${esc(srv.url)}</span>
<button class="config-edit-btn" title="Edit">✎</button>
<button class="config-del-btn" title="Delete">✕</button>`;
            row.querySelector('.config-del-btn').addEventListener('click', () => {
                state.servers.splice(i, 1);
                saveServers();
                renderServerList();
            });
            row.querySelector('.config-edit-btn').addEventListener('click', () => {
                const form = makeServerForm(srv, (updated) => {
                    state.servers[i] = updated;
                    saveServers();
                    renderServerList();
                }, renderServerList);
                row.replaceWith(form);
                form.querySelector('.ef-name').focus();
            });
            el.serverList.appendChild(row);
        });
    }

    el.addServerBtn.addEventListener('click', () => {
        const form = makeServerForm({ name: '', url: '', apiKey: '' }, (newSrv) => {
            state.servers.push(newSrv);
            saveServers();
            renderServerList();
        }, renderServerList);
        el.serverList.appendChild(form);
        form.querySelector('.ef-name').focus();
    });

    function makeEndpointForm(ep, onSave, onCancel) {
        const serverOptions = state.servers.map(s =>
            `<option value="${esc(s.name)}" ${s.name === ep.server ? 'selected' : ''}>${esc(s.name)}</option>`
        ).join('');
        const adapters = ['openai', 'gemini', 'gemini-jank', 'ask-sage'];
        const adapterOptions = adapters.map(a =>
            `<option value="${a}" ${a === ep.adapter ? 'selected' : ''}>${a}</option>`
        ).join('');
        const streamingVal = ep.streaming === true ? 'true' : ep.streaming === false ? 'false' : 'default';

        const form = document.createElement('div');
        form.className = 'config-edit-form';
        form.innerHTML = `
<input type="text" class="ef-name" placeholder="Name (e.g. Local OpenAI)" value="${esc(ep.name || '')}">
<select class="ef-server">${serverOptions || '<option value="">-- no servers --</option>'}</select>
<select class="ef-adapter">${adapterOptions}</select>
<details>
  <summary>Advanced</summary>
  <div style="display:flex;flex-direction:column;gap:4px;margin-top:4px;">
    <input type="text" class="ef-model" placeholder="Model override (optional)" value="${esc(ep.model || '')}">
    <input type="text" class="ef-chat-path" placeholder="Chat path override (e.g. /v1/chat/completions)" value="${esc((ep.pathOverrides || {}).chat || '')}">
    <input type="text" class="ef-models-path" placeholder="Models path override (e.g. /v1/models)" value="${esc((ep.pathOverrides || {}).models || '')}">
    <select class="ef-streaming">
      <option value="default" ${streamingVal === 'default' ? 'selected' : ''}>Streaming: default</option>
      <option value="true"    ${streamingVal === 'true'    ? 'selected' : ''}>Streaming: on</option>
      <option value="false"   ${streamingVal === 'false'   ? 'selected' : ''}>Streaming: off</option>
    </select>
  </div>
</details>
<div class="config-form-actions">
  <button class="config-save-btn">Save</button>
  <button class="config-cancel-btn">Cancel</button>
</div>`;
        form.querySelector('.config-save-btn').addEventListener('click', () => {
            const name = form.querySelector('.ef-name').value.trim();
            if (!name) return;
            const chatPath   = form.querySelector('.ef-chat-path').value.trim();
            const modelsPath = form.querySelector('.ef-models-path').value.trim();
            const streamSel  = form.querySelector('.ef-streaming').value;
            const built = {
                name,
                server:  form.querySelector('.ef-server').value,
                adapter: form.querySelector('.ef-adapter').value,
            };
            const modelVal = form.querySelector('.ef-model').value.trim();
            if (modelVal) built.model = modelVal;
            if (chatPath || modelsPath) {
                built.pathOverrides = {};
                if (chatPath)   built.pathOverrides.chat   = chatPath;
                if (modelsPath) built.pathOverrides.models = modelsPath;
            }
            if (streamSel !== 'default') built.streaming = streamSel === 'true';
            onSave(built);
        });
        form.querySelector('.config-cancel-btn').addEventListener('click', onCancel);
        return form;
    }

    function renderEndpointList() {
        el.endpointList.innerHTML = '';
        state.endpoints.forEach((ep, i) => {
            const row = document.createElement('div');
            row.className = 'config-item';
            const detail = `${esc(ep.server)} → ${esc(ep.adapter)}`;
            row.innerHTML = `
<span class="config-item-name" title="${esc(ep.name)}">${esc(ep.name)}</span>
<span class="config-item-detail" title="${detail}">${detail}</span>
<button class="config-edit-btn" title="Edit">✎</button>
<button class="config-del-btn" title="Delete">✕</button>`;
            row.querySelector('.config-del-btn').addEventListener('click', () => {
                const wasActive = state.endpoints[i].name === state.activeEndpoint;
                state.endpoints.splice(i, 1);
                saveEndpoints();
                if (wasActive && state.endpoints.length > 0) {
                    vscode.postMessage({ type: 'setEndpoint', name: state.endpoints[0].name });
                }
                renderEndpointList();
            });
            row.querySelector('.config-edit-btn').addEventListener('click', () => {
                const form = makeEndpointForm(ep, (updated) => {
                    state.endpoints[i] = updated;
                    saveEndpoints();
                    renderEndpointList();
                }, renderEndpointList);
                row.replaceWith(form);
                form.querySelector('.ef-name').focus();
            });
            el.endpointList.appendChild(row);
        });
    }

    el.addEndpointBtn.addEventListener('click', () => {
        const form = makeEndpointForm({ name: '', server: state.servers[0]?.name || '', adapter: 'openai' }, (newEp) => {
            state.endpoints.push(newEp);
            saveEndpoints();
            renderEndpointList();
        }, renderEndpointList);
        el.endpointList.appendChild(form);
        form.querySelector('.ef-name').focus();
    });

    el.setMaxIter.addEventListener('change', () => {
        const v = parseInt(el.setMaxIter.value);
        if (!isNaN(v)) vscode.postMessage({ type: 'updateSetting', key: 'maxIterations', value: v });
    });

    el.setSystemPrompt.addEventListener('blur', () => {
        vscode.postMessage({ type: 'updateSetting', key: 'systemPrompt', value: el.setSystemPrompt.value });
    });

    el.setEnterToSend.addEventListener('change', () => {
        state.enterToSend = el.setEnterToSend.checked;
        el.enterHint.textContent = state.enterToSend
            ? 'ON: Enter = send, Shift+Enter = newline'
            : 'OFF: Shift+Enter = send, Enter = newline';
        vscode.postMessage({ type: 'updateSetting', key: 'enterToSend', value: state.enterToSend });
    });

    el.setVerbose.addEventListener('change', () => {
        state.verbose = el.setVerbose.checked;
        vscode.postMessage({ type: 'updateSetting', key: 'verboseLogging', value: state.verbose });
    });

    el.openVscodeSettings.addEventListener('click', () => {
        vscode.postMessage({ type: 'openSettings' });
    });

    // ── Endpoint/model dropdowns ─────────────────────────────────────────────

    function populateEndpoints() {
        el.endpointSelect.innerHTML = state.endpoints.map(ep =>
            `<option value="${esc(ep.name)}" ${ep.name === state.activeEndpoint ? 'selected' : ''}>${esc(ep.name)}</option>`
        ).join('');
    }

    function populateModels() {
        const cur = state.currentModel;
        el.modelSelect.innerHTML = state.models.length === 0
            ? '<option value="">-- no models --</option>'
            : state.models.map(m =>
                `<option value="${esc(m)}" ${m === cur ? 'selected' : ''}>${esc(m)}</option>`
              ).join('');
        if (state.models.length > 0 && !cur) {
            // Auto-select first
            el.modelSelect.selectedIndex = 0;
            vscode.postMessage({ type: 'setModel', model: el.modelSelect.value });
        }
    }

    // ── Extension → webview messages ─────────────────────────────────────────

    window.addEventListener('message', ({ data: msg }) => {
        switch (msg.type) {

            case 'init': {
                state.sessions       = msg.sessions       || [];
                state.mode           = msg.mode           || 'chat';
                state.servers        = msg.servers        || [];
                state.endpoints      = msg.endpoints      || [];
                state.activeEndpoint = msg.activeEndpoint || '';
                state.currentModel   = msg.model          || '';
                state.streamingEnabled = msg.streaming !== undefined ? msg.streaming : true;
                state.enterToSend    = msg.enterToSend !== undefined ? msg.enterToSend : true;
                state.verbose        = msg.verboseLogging || false;
                state.toolPermissions= msg.toolPermissions|| {};
                state.toolDefs       = msg.toolDefs       || [];
                state.toolCallMode   = msg.askSageToolMode || 'api';

                el.modeSelect.value  = state.mode;
                el.setVerbose.checked = state.verbose;
                el.setEnterToSend.checked = state.enterToSend;
                el.enterHint.textContent = state.enterToSend
                    ? 'ON: Enter = send, Shift+Enter = newline'
                    : 'OFF: Shift+Enter = send, Enter = newline';
                el.streamToggle.classList.toggle('active', state.streamingEnabled);
                el.tcModeBtn.textContent = state.toolCallMode === 'api' ? 'TC:API' : 'TC:TXT';
                el.tcModeBtn.classList.toggle('active', state.toolCallMode === 'api');

                // Load existing session messages if any
                if (msg.session && msg.session.messages.length > 0) {
                    _loadMessages(msg.session.messages);
                }

                populateEndpoints();
                populateModels();
                buildPermTable();
                renderServerList();
                renderEndpointList();
                break;
            }

            case 'models': {
                state.models      = msg.models  || [];
                state.currentModel= msg.current || '';
                populateModels();
                break;
            }

            case 'configUpdate': {
                state.servers         = msg.servers         || state.servers;
                state.endpoints       = msg.endpoints       || state.endpoints;
                state.activeEndpoint  = msg.activeEndpoint  || state.activeEndpoint;
                state.currentModel    = msg.model           || state.currentModel;
                state.streamingEnabled= msg.streaming   !== undefined ? msg.streaming   : state.streamingEnabled;
                state.enterToSend     = msg.enterToSend !== undefined ? msg.enterToSend : state.enterToSend;
                state.verbose         = msg.verboseLogging !== undefined ? msg.verboseLogging : state.verbose;
                state.toolPermissions = msg.toolPermissions || state.toolPermissions;
                if (msg.askSageToolMode !== undefined) {
                    state.toolCallMode = msg.askSageToolMode;
                    el.tcModeBtn.textContent = state.toolCallMode === 'api' ? 'TC:API' : 'TC:TXT';
                    el.tcModeBtn.classList.toggle('active', state.toolCallMode === 'api');
                }
                if (el.setEnterToSend) {
                    el.setEnterToSend.checked = state.enterToSend;
                    el.enterHint.textContent = state.enterToSend
                        ? 'ON: Enter = send, Shift+Enter = newline'
                        : 'OFF: Shift+Enter = send, Enter = newline';
                }
                populateEndpoints();
                buildPermTable();
                renderServerList();
                renderEndpointList();
                break;
            }

            case 'verboseState': {
                state.verbose = msg.verbose;
                el.setVerbose.checked = msg.verbose;
                break;
            }

            case 'newChat': {
                state.messages = [];
                el.messages.innerHTML = '';
                setProcessing(false);
                break;
            }

            case 'userMessage': {
                const uMsg = {
                    id: msg.id,
                    role: 'user',
                    raw: msg.text,
                    contextFiles: msg.contextFiles || [],
                    ts: msg.ts || Date.now()
                };
                state.messages.push(uMsg);
                el.messages.appendChild(createUserEl(uMsg));
                scrollBottom();
                break;
            }

            case 'assistantStart': {
                setProcessing(true);
                const aMsg = { id: msg.id, role: 'assistant', raw: '', toolCalls: [], pending: true, ts: msg.ts || Date.now() };
                state.messages.push(aMsg);
                el.messages.appendChild(createAssistantEl(aMsg));
                scrollBottom();
                break;
            }

            case 'token': {
                const aMsg = state.messages.find(m => m.id === msg.id);
                if (!aMsg) break;
                aMsg.raw += msg.text;
                const domEl = el.messages.querySelector(`[data-id="${CSS.escape(msg.id)}"]`);
                if (domEl) {
                    const contentDiv = domEl.querySelector('.md-content');
                    if (contentDiv) {
                        contentDiv.innerHTML = state.markdownEnabled
                            ? renderMarkdown(aMsg.raw)
                            : `<pre>${esc(aMsg.raw)}</pre>`;
                    }
                    scrollBottom();
                }
                break;
            }

            case 'streamEnd': {
                const aMsg = state.messages.find(m => m.id === msg.id);
                if (aMsg) aMsg.pending = false;
                const domEl = el.messages.querySelector(`[data-id="${CSS.escape(msg.id)}"]`);
                if (domEl) domEl.classList.remove('streaming');
                break;
            }

            case 'usage': {
                state.usageByMsgId[msg.msgId] = { usage: msg.usage, uuid: msg.uuid };
                const domEl = el.messages.querySelector(`[data-id="${CSS.escape(msg.msgId)}"]`);
                if (domEl) _applyUsageBadge(domEl, msg.usage);
                break;
            }

            case 'monthlyUsage': {
                if (msg.error) {
                    el.monthlyUsageDisplay.textContent = 'Error: ' + msg.error;
                } else {
                    const d = msg.data || {};
                    const used  = d.tokens_used  || d.tokensUsed  || d.used  || d.count  || '?';
                    const limit = d.token_limit   || d.tokenLimit  || d.limit || null;
                    el.monthlyUsageDisplay.textContent = limit
                        ? `${Number(used).toLocaleString()} / ${Number(limit).toLocaleString()} tokens this month`
                        : `${Number(used).toLocaleString()} tokens used this month`;
                }
                break;
            }

            case 'toolStart': {
                // Find or create the current assistant message
                let aMsg = state.messages.find(m => m.id === msg.msgId);
                if (!aMsg) break;

                const call = { ...msg.call, done: false };
                aMsg.toolCalls.push(call);

                const domEl = el.messages.querySelector(`[data-id="${CSS.escape(msg.msgId)}"]`);
                if (domEl) {
                    const block = createToolBlock(call);
                    domEl.appendChild(block);
                    scrollBottom();
                }
                break;
            }

            case 'toolEnd': {
                // Update tool call with result
                for (const m of state.messages) {
                    const tc = m.toolCalls?.find(t => t.id === msg.call.id);
                    if (tc) {
                        Object.assign(tc, msg.call, { done: true });
                        break;
                    }
                }

                const block = el.messages.querySelector(`.tool-block[data-tcid="${CSS.escape(msg.call.id)}"]`);
                if (block) {
                    const stateIcon = msg.call.result?.error ? '✕' : '✓';
                    const stateText = msg.call.result?.error ? 'error' : 'done';
                    const header = block.querySelector('.tool-header');
                    if (header) {
                        header.querySelector('.tool-spinner')?.replaceWith(document.createTextNode(stateIcon));
                        const st = header.querySelector('.tool-state');
                        if (st) st.textContent = stateText;
                    }
                    const body = block.querySelector('.tool-body');
                    if (body) {
                        const args = msg.call.args ? JSON.stringify(msg.call.args, null, 2) : '';
                        const result = msg.call.result ? JSON.stringify(msg.call.result, null, 2) : '';
                        body.innerHTML = `<b>args:</b>\n${esc(args)}\n\n<b>result:</b>\n${esc(result)}`;
                    }
                    scrollBottom();
                }
                break;
            }

            case 'status': {
                el.statusText.textContent = msg.text || '';
                break;
            }

            case 'done': {
                setProcessing(false);
                break;
            }

            case 'error': {
                // Remove any blank pending assistant bubble so the error stands alone
                const pendingIdx = state.messages.findIndex(m => m.pending);
                if (pendingIdx !== -1) {
                    state.messages.splice(pendingIdx, 1);
                    el.messages.querySelector('.msg-assistant.streaming')?.remove();
                }
                const errEl = createErrorEl(msg.text);
                el.messages.appendChild(errEl);
                state.messages.push({ id: `e_${Date.now()}`, role: 'error', raw: msg.text });
                setProcessing(false);
                scrollBottom();
                break;
            }

            case 'forkReady': {
                state.messages = [];
                el.messages.innerHTML = '';
                setProcessing(false);
                if (msg.session && msg.session.messages.length > 0) {
                    _loadMessages(msg.session.messages);
                }
                el.msgInput.focus();
                break;
            }

            case 'sessions': {
                state.sessions = msg.sessions || [];
                if (el.historyPanel.classList.contains('visible')) renderSessionList();
                break;
            }

            case 'loadSession': {
                state.messages = [];
                el.messages.innerHTML = '';
                setProcessing(false);
                _loadMessages(msg.session.messages);
                break;
            }

            case 'fileSuggestions': {
                showAtDropdown(msg.files || []);
                break;
            }
        }
    });

    // ── Helper: load messages array from session ─────────────────────────────

    function _loadMessages(apiMessages) {
        // apiMessages are { role, content, tool_calls? } — the OpenAI format
        // We need to convert to display format
        for (const m of apiMessages) {
            if (m.role === 'user') {
                const dm = { id: `u_${Math.random().toString(36).slice(2)}`, role: 'user', raw: m.content || '', contextFiles: [] };
                state.messages.push(dm);
                el.messages.appendChild(createUserEl(dm));
            } else if (m.role === 'assistant') {
                const toolCalls = (m.tool_calls || []).map(tc => ({
                    id: tc.id,
                    name: tc.function?.name || '',
                    args: (() => { try { return JSON.parse(tc.function?.arguments || '{}'); } catch { return {}; } })(),
                    result: null,
                    done: true
                }));
                const dm = {
                    id: `a_${Math.random().toString(36).slice(2)}`,
                    role: 'assistant',
                    raw: m.content || '',
                    toolCalls,
                    pending: false
                };
                state.messages.push(dm);
                el.messages.appendChild(createAssistantEl(dm));
            }
            // Skip tool-role messages (they're internal API messages, not display messages)
        }
        scrollBottom();
    }

    // ── Boot ─────────────────────────────────────────────────────────────────
    vscode.postMessage({ type: 'ready' });

})();
