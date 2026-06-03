/* Standalone Agent — webview UI
 * Runs inside VSCode's sandboxed webview context.
 * All extension-host calls go through vscode.postMessage / window.addEventListener('message').
 */
(function () {
    'use strict';

    const vscode = acquireVsCodeApi();

    // ── State ────────────────────────────────────────────────────────────────
    const state = {
        mode:                 'chat',
        isProcessing:         false,
        markdownEnabled:      true,
        streamingEnabled:     true,
        enterToSend:          true,
        verbose:              false,
        sessions:             [],
        messages:             [],      // { id, role, raw, toolCalls:[], pending? }
        toolPermissions:      {},
        toolDefs:             [],
        servers:              [],
        endpoints:            [],
        activeEndpoint:       '',
        models:               [],
        currentModel:         '',
        atQuery:              '',
        atCursorStart:        -1,
        atDropdownItems:      [],
        atSelectedIdx:        -1,
        usageByMsgId:         {},
        toolCallMode:         'api',
        supportsMonthlyUsage: false,
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
        modeSelect:           q('#mode-select'),
        endpointSelect:       q('#endpoint-select'),
        modelSelect:          q('#model-select'),
        refreshModels:        q('#refresh-models-btn'),
        historyBtn:           q('#history-btn'),
        settingsBtn:          q('#settings-btn'),
        messages:             q('#messages'),
        statusText:           q('#status-text'),
        stopBtn:              q('#stop-btn'),
        msgInput:             q('#msg-input'),
        sendBtn:              q('#send-btn'),
        mdToggle:             q('#md-toggle'),
        streamToggle:         q('#stream-toggle'),
        tcModeBtn:            q('#tc-mode-btn'),
        iterBadge:            q('#iter-badge'),
        atDropdown:           q('#at-dropdown'),
        historyPanel:         q('#history-panel'),
        historyClose:         q('#history-close'),
        sessionList:          q('#session-list'),
        settingsPanel:        q('#settings-panel'),
        settingsClose:        q('#settings-close'),
        setMaxIter:           q('#set-max-iter'),
        setSystemPrompt:      q('#set-system-prompt'),
        setEnterToSend:       q('#set-enter-to-send'),
        enterHint:            q('#enter-hint'),
        setVerbose:           q('#set-verbose'),
        permTbody:            q('#perm-tbody'),
        openVscodeSettings:   q('#open-vscode-settings'),
        serverList:           q('#server-list'),
        addServerBtn:         q('#add-server-btn'),
        endpointList:         q('#endpoint-list'),
        addEndpointBtn:       q('#add-endpoint-btn'),
        monthlyUsageBtn:      q('#monthly-usage-btn'),
        monthlyUsageBar:      q('#monthly-usage-bar'),
        monthlyUsageDisplay:  q('#monthly-usage-display'),
        monthlyUsageClose:    q('#monthly-usage-close'),
    };

    function q(sel) { return document.querySelector(sel); }

    // ── Markdown renderer ────────────────────────────────────────────────────

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
        h = h.replace(/```([a-zA-Z0-9]*)\n?([\s\S]*?)```/g, (_, lang, code) => {
            return `<pre><button class="copy-btn" onclick="copyCode(this)">Copy</button>`
                 + `<code class="lang-${esc(lang)}">${code}</code></pre>`;
        });
        h = h.replace(/`([^`\n]+)`/g, '<code>$1</code>');
        h = h.replace(/^###### (.+)$/gm, '<h6>$1</h6>');
        h = h.replace(/^##### (.+)$/gm,  '<h5>$1</h5>');
        h = h.replace(/^#### (.+)$/gm,   '<h4>$1</h4>');
        h = h.replace(/^### (.+)$/gm,    '<h3>$1</h3>');
        h = h.replace(/^## (.+)$/gm,     '<h2>$1</h2>');
        h = h.replace(/^# (.+)$/gm,      '<h1>$1</h1>');
        h = h.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
        h = h.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
        h = h.replace(/\*(.+?)\*/g, '<em>$1</em>');
        h = h.replace(/^---+$/gm, '<hr>');
        h = h.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');
        h = h.replace(/((?:^- .+\n?)+)/gm, (block) => {
            const items = block.trim().split('\n').map(l => `<li>${l.replace(/^- /, '')}</li>`).join('');
            return `<ul>${items}</ul>`;
        });
        h = h.replace(/((?:^\d+\. .+\n?)+)/gm, (block) => {
            const items = block.trim().split('\n').map(l => `<li>${l.replace(/^\d+\. /, '')}</li>`).join('');
            return `<ol>${items}</ol>`;
        });
        h = h.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
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

    window.copyCode = function(btn) {
        const code = btn.nextElementSibling?.textContent || '';
        navigator.clipboard?.writeText(code).then(() => {
            btn.textContent = 'Copied!';
            setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
        });
    };

    // ── Tool call summary (human-readable one-liner for approval cards) ───────

    function toolCallSummary(name, args) {
        switch (name) {
            case 'read_file':       return args.path || '';
            case 'write_file':      return `${args.path || ''} (${String(args.content || '').length} chars)`;
            case 'edit_file':       return `${args.path || ''} — "${String(args.old_string || '').split('\n')[0].slice(0, 40)}"`;
            case 'list_directory':  return args.path || '.';
            case 'search_files':    return `"${args.pattern || ''}"${args.glob ? ` in ${args.glob}` : ''}`;
            case 'get_diagnostics': return args.path || 'workspace';
            case 'run_terminal':    return String(args.command || '').slice(0, 80);
            case 'get_git_diff':    return args.path ? `${args.path}${args.staged ? ' (staged)' : ''}` : (args.staged ? 'staged' : 'workspace');
            case 'get_symbols':     return args.path || '';
            default: {
                const j = JSON.stringify(args);
                return (j && j !== '{}') ? j.slice(0, 60) : '';
            }
        }
    }

    // ── Message rendering ────────────────────────────────────────────────────

    function _applyUsageBadge(msgEl, usage) {
        if (!usage || typeof usage !== 'object') return;
        msgEl.querySelector('.usage-badge')?.remove();

        const promptTok     = usage.prompt_tokens     ?? usage.input_tokens    ?? null;
        const completionTok = usage.completion_tokens ?? usage.output_tokens   ?? null;
        const totalTok      = usage.total_tokens      ?? usage.totalTokens
                           ?? (promptTok != null && completionTok != null ? promptTok + completionTok : null);

        const inputCost  = usage.input_cost   ?? usage.prompt_cost       ?? usage.token_input_cost  ?? usage.cost_input  ?? null;
        const outputCost = usage.output_cost  ?? usage.completion_cost   ?? usage.token_output_cost ?? usage.cost_output ?? null;
        const tokenCost  = usage.token_cost   ?? null;  // Ask Sage flat "cost of this call in tokens"
        const totalCost  = usage.total_cost   ?? usage.cost              ?? usage.totalCost         ?? null;

        const hasCost = inputCost != null || outputCost != null || totalCost != null || tokenCost != null;
        if (totalTok == null && promptTok == null && !hasCost) return;

        const badge = document.createElement('div');
        badge.className = 'usage-badge';

        // Token counts line
        if (totalTok != null || promptTok != null) {
            const tokenLine = document.createElement('div');
            tokenLine.className = 'usage-line usage-tokens';
            const parts = [];
            if (totalTok != null) parts.push(Number(totalTok).toLocaleString() + ' tokens');
            if (promptTok != null) parts.push('↑' + Number(promptTok).toLocaleString());
            if (completionTok != null) parts.push('↓' + Number(completionTok).toLocaleString());
            tokenLine.textContent = parts.join('  ');
            badge.appendChild(tokenLine);
        }

        // Cost line (dollar amounts)
        if (hasCost) {
            const costLine = document.createElement('div');
            costLine.className = 'usage-line usage-cost';
            const parts = [];
            if (tokenCost != null)  parts.push('tc:' + Number(tokenCost).toLocaleString());
            if (inputCost != null)  parts.push('in $' + Number(inputCost).toFixed(6));
            if (outputCost != null) parts.push('out $' + Number(outputCost).toFixed(6));
            if (totalCost != null && (inputCost != null || outputCost != null)) {
                parts.push('= $' + Number(totalCost).toFixed(6));
            } else if (totalCost != null) {
                parts.push('$' + Number(totalCost).toFixed(6));
            }
            costLine.textContent = parts.join('  ');
            badge.appendChild(costLine);
        }

        if (badge.children.length === 0) return;
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
        if (msg.raw) {
            if (!state.markdownEnabled) {
                contentDiv.innerHTML = `<pre>${esc(msg.raw)}</pre>`;
            } else if (msg.renderedHtml) {
                contentDiv.innerHTML = msg.renderedHtml;
            } else {
                contentDiv.innerHTML = renderMarkdown(msg.raw);
            }
        }
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
        const isDiffable = tc.done && !tc.result?.error &&
            (tc.name === 'write_file' || tc.name === 'edit_file') && tc.args?.path;

        block.innerHTML = `
<div class="tool-header" onclick="this.parentElement.classList.toggle('open')">
  <span>${stateIcon}</span>
  <span class="tool-name">${esc(tc.name)}</span>
  <span class="tool-state">${stateText}</span>
  ${isDiffable ? `<button class="tool-diff-btn" title="View git diff">⊕ Diff</button>` : ''}
</div>
<div class="tool-body">${tc.done
    ? `<b>args:</b>\n${esc(args)}\n\n<b>result:</b>\n${esc(resultText)}`
    : `<b>args:</b>\n${esc(args)}`
}</div>`;

        if (isDiffable) {
            block.querySelector('.tool-diff-btn')?.addEventListener('click', (e) => {
                e.stopPropagation();
                vscode.postMessage({ type: 'showDiff', path: tc.args.path });
            });
        }

        return block;
    }

    // ── Tool approval card ────────────────────────────────────────────────────

    function createApprovalCard(msg) {
        const { callId, toolName, args, rawCall } = msg;
        const summary = toolCallSummary(toolName, args || {});
        const argsJson = JSON.stringify(args || {}, null, 2);
        const rawJson  = JSON.stringify(rawCall || { name: toolName, arguments: args }, null, 2);

        const card = document.createElement('div');
        card.className = 'tool-approval-card';
        card.dataset.callid = callId;

        // Header
        const header = document.createElement('div');
        header.className = 'tool-approval-header';

        const icon = document.createElement('span');
        icon.className = 'tap-icon';
        icon.textContent = '?';

        const nameSpan = document.createElement('span');
        nameSpan.className = 'tap-name';
        nameSpan.textContent = toolName;

        const summarySpan = document.createElement('span');
        summarySpan.className = 'tap-summary';
        summarySpan.textContent = summary;

        const statusSpan = document.createElement('span');
        statusSpan.className = 'tool-approval-status';
        statusSpan.textContent = 'awaiting approval';

        const expandBtn = document.createElement('button');
        expandBtn.className = 'tap-expand-btn';
        expandBtn.title = 'Show details';
        expandBtn.textContent = '▸';

        const rawBtn = document.createElement('button');
        rawBtn.className = 'tap-rawbtn';
        rawBtn.title = 'Open raw tool call in editor';
        rawBtn.textContent = '⧉';

        header.appendChild(icon);
        header.appendChild(nameSpan);
        if (summary) header.appendChild(summarySpan);
        header.appendChild(statusSpan);
        header.appendChild(expandBtn);
        header.appendChild(rawBtn);

        // Expandable body
        const body = document.createElement('div');
        body.className = 'tool-approval-body';
        body.style.display = 'none';
        const pre = document.createElement('pre');
        pre.className = 'tap-pre';
        pre.textContent = argsJson;
        body.appendChild(pre);

        // Actions
        const actions = document.createElement('div');
        actions.className = 'tool-approval-actions';

        const allowOnceBtn   = document.createElement('button');
        allowOnceBtn.className = 'tap-allow-once';
        allowOnceBtn.textContent = 'Allow Once';

        const allowAlwaysBtn = document.createElement('button');
        allowAlwaysBtn.className = 'tap-allow-always';
        allowAlwaysBtn.textContent = 'Allow Always';

        const denyBtn        = document.createElement('button');
        denyBtn.className = 'tap-deny';
        denyBtn.textContent = 'Deny';

        actions.appendChild(allowOnceBtn);
        actions.appendChild(allowAlwaysBtn);
        actions.appendChild(denyBtn);

        card.appendChild(header);
        card.appendChild(body);
        card.appendChild(actions);

        // Event handlers
        expandBtn.addEventListener('click', () => {
            const open = body.style.display !== 'none';
            body.style.display = open ? 'none' : 'block';
            expandBtn.textContent = open ? '▸' : '▾';
            expandBtn.title = open ? 'Show details' : 'Hide details';
        });

        rawBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'openTextWindow', content: rawJson, title: `Tool: ${toolName}` });
        });

        const respond = (decision) => {
            if (decision === 'deny') {
                // Mark the card as denied visually
                card.classList.add('tap-denied');
                actions.remove();
                statusSpan.textContent = '✕ Denied';
                icon.textContent = '✕';
                icon.style.color = 'var(--vscode-errorForeground, #f66)';
            } else {
                // Approved — remove card; toolStart event will add the running tool block
                card.remove();
            }
            vscode.postMessage({ type: 'toolApprovalResponse', callId, decision });
        };

        allowOnceBtn.addEventListener('click', () => respond('allow-once'));
        allowAlwaysBtn.addEventListener('click', () => respond('allow-always'));
        denyBtn.addEventListener('click', () => respond('deny'));

        return card;
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

        const userMsgIdx = state.messages.slice(0, idx).filter(m => m.role === 'user').length;

        el.msgInput.value = msg.raw;
        el.msgInput.style.height = 'auto';
        el.msgInput.style.height = Math.min(el.msgInput.scrollHeight, 160) + 'px';
        el.msgInput.focus();

        state.messages = state.messages.slice(0, idx);
        rerenderAll();
        vscode.postMessage({ type: 'fork', userMsgIdx });
    }

    function handleRetry() {
        if (state.isProcessing) return;
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
        const sendPressed = state.enterToSend ? (e.key === 'Enter' && !e.shiftKey) : (e.key === 'Enter' && e.shiftKey);
        if (sendPressed) {
            e.preventDefault();
            sendMessage();
        }
    });

    el.msgInput.addEventListener('input', () => {
        el.msgInput.style.height = 'auto';
        el.msgInput.style.height = Math.min(el.msgInput.scrollHeight, 160) + 'px';
        handleAtInput();
    });

    // ── @ autocomplete ───────────────────────────────────────────────────────

    function handleAtInput() {
        const val = el.msgInput.value;
        const cursor = el.msgInput.selectionStart;

        let atPos = -1;
        for (let i = cursor - 1; i >= 0; i--) {
            if (val[i] === '@') { atPos = i; break; }
            if (val[i] === ' ' || val[i] === '\n') break;
        }

        if (atPos === -1) { closeAtDropdown(); return; }

        const query = val.slice(atPos + 1, cursor);
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
        const keyPlaceholder = server.hasKey
            ? 'Leave blank to keep existing key'
            : 'API Key (optional)';
        const keyHint = server.hasKey
            ? '<span style="font-size:10px;opacity:0.6;">🔐 Key stored securely</span>'
            : '';
        const form = document.createElement('div');
        form.className = 'config-edit-form';
        form.innerHTML = `
<input type="text" class="ef-name" placeholder="Name (e.g. Local)" value="${esc(server.name || '')}">
<input type="text" class="ef-url" placeholder="URL (e.g. http://localhost:11434/v1)" value="${esc(server.url || '')}">
<input type="password" class="ef-key" placeholder="${esc(keyPlaceholder)}">
${keyHint}
<div class="config-form-actions">
  <button class="config-save-btn">Save</button>
  <button class="config-cancel-btn">Cancel</button>
</div>`;
        form.querySelector('.config-save-btn').addEventListener('click', () => {
            const name = form.querySelector('.ef-name').value.trim();
            const url  = form.querySelector('.ef-url').value.trim();
            if (!name || !url) return;
            const keyValue = form.querySelector('.ef-key').value;
            // Only include apiKey when the user explicitly typed a value;
            // empty = keep whatever is already stored in secrets.
            const serverData = { name, url };
            if (keyValue) serverData.apiKey = keyValue;
            onSave(serverData);
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
            el.modelSelect.selectedIndex = 0;
            vscode.postMessage({ type: 'setModel', model: el.modelSelect.value });
        }
    }

    // ── Monthly usage bar helpers ─────────────────────────────────────────────

    function _showMonthlyUsageBar(text) {
        el.monthlyUsageBar.style.display = 'flex';
        if (text) el.monthlyUsageDisplay.textContent = text;
    }

    function _updateMonthlyUsageDisplay(data) {
        const d = data || {};
        const used  = d.response     || d.tokens_used || d.tokensUsed || d.used || d.count || '?';
        const limit = d.token_limit   || d.tokenLimit  || d.limit || null;
        el.monthlyUsageDisplay.textContent = limit
            ? `${Number(used).toLocaleString()} / ${Number(limit).toLocaleString()} tokens this month`
            : `${Number(used).toLocaleString()} tokens used this month`;
    }

    // ── Extension → webview messages ─────────────────────────────────────────

    window.addEventListener('message', ({ data: msg }) => {
        switch (msg.type) {

            case 'init': {
                state.sessions            = msg.sessions       || [];
                state.mode                = msg.mode           || 'chat';
                state.servers             = msg.servers        || [];
                state.endpoints           = msg.endpoints      || [];
                state.activeEndpoint      = msg.activeEndpoint || '';
                state.currentModel        = msg.model          || '';
                state.streamingEnabled    = msg.streaming !== undefined ? msg.streaming : true;
                state.enterToSend         = msg.enterToSend !== undefined ? msg.enterToSend : true;
                state.verbose             = msg.verboseLogging || false;
                state.toolPermissions     = msg.toolPermissions || {};
                state.toolDefs            = msg.toolDefs       || [];
                state.toolCallMode        = msg.askSageToolMode || 'api';
                state.supportsMonthlyUsage = !!msg.supportsMonthlyUsage;

                el.modeSelect.value = state.mode;
                el.setVerbose.checked = state.verbose;
                el.setEnterToSend.checked = state.enterToSend;
                el.enterHint.textContent = state.enterToSend
                    ? 'ON: Enter = send, Shift+Enter = newline'
                    : 'OFF: Shift+Enter = send, Enter = newline';
                el.streamToggle.classList.toggle('active', state.streamingEnabled);
                el.tcModeBtn.textContent = state.toolCallMode === 'api' ? 'TC:API' : 'TC:TXT';
                el.tcModeBtn.classList.toggle('active', state.toolCallMode === 'api');

                // Auto-show monthly usage bar when endpoint supports it
                if (state.supportsMonthlyUsage) {
                    _showMonthlyUsageBar('Loading usage…');
                }

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
                state.models       = msg.models  || [];
                state.currentModel = msg.current || '';
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
                if (msg.supportsMonthlyUsage !== undefined) {
                    state.supportsMonthlyUsage = !!msg.supportsMonthlyUsage;
                    if (state.supportsMonthlyUsage) {
                        _showMonthlyUsageBar('Loading usage…');
                    } else {
                        el.monthlyUsageBar.style.display = 'none';
                    }
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

            case 'renderedMarkdown': {
                // Replace client-rendered markdown with VS Code's built-in server-rendered HTML
                const aMsg = state.messages.find(m => m.id === msg.id);
                if (aMsg) aMsg.renderedHtml = msg.html;
                const domEl = el.messages.querySelector(`[data-id="${CSS.escape(msg.id)}"]`);
                if (domEl && state.markdownEnabled) {
                    const contentDiv = domEl.querySelector('.md-content');
                    if (contentDiv) contentDiv.innerHTML = msg.html;
                }
                break;
            }

            case 'usage': {
                state.usageByMsgId[msg.msgId] = { usage: msg.usage, uuid: msg.uuid };
                const domEl = el.messages.querySelector(`[data-id="${CSS.escape(msg.msgId)}"]`);
                if (domEl) _applyUsageBadge(domEl, msg.usage);
                break;
            }

            case 'monthlyUsage': {
                // Always show the bar when data arrives
                el.monthlyUsageBar.style.display = 'flex';
                if (msg.error) {
                    el.monthlyUsageDisplay.textContent = '⚠ ' + msg.error;
                } else {
                    _updateMonthlyUsageDisplay(msg.data);
                }
                break;
            }

            // ── Tool approval flow ─────────────────────────────────────────────

            case 'toolApprovalRequest': {
                const card = createApprovalCard(msg);
                const domEl = el.messages.querySelector(`[data-id="${CSS.escape(msg.msgId)}"]`);
                if (domEl) {
                    // Insert before the msg-footer so it appears above timestamp
                    const footer = domEl.querySelector('.msg-footer');
                    footer ? domEl.insertBefore(card, footer) : domEl.appendChild(card);
                } else {
                    // Fallback: message bubble not found, append directly to messages
                    el.messages.appendChild(card);
                }
                scrollBottom();
                break;
            }

            case 'toolDenied': {
                // If the user already clicked Deny on the card, the card is already styled denied.
                // This handles the case where the denial came from a config-level 'deny' (no card shown)
                // or from a Stop action clearing approvals.
                const card = el.messages.querySelector(
                    `.tool-approval-card[data-callid="${CSS.escape(msg.call.id)}"]`
                );
                if (card && !card.classList.contains('tap-denied')) {
                    card.classList.add('tap-denied');
                    card.querySelector('.tool-approval-actions')?.remove();
                    const statusEl = card.querySelector('.tool-approval-status');
                    if (statusEl) statusEl.textContent = '✕ Denied';
                    const iconEl = card.querySelector('.tap-icon');
                    if (iconEl) {
                        iconEl.textContent = '✕';
                        iconEl.style.color = 'var(--vscode-errorForeground, #f66)';
                    }
                }
                break;
            }

            case 'clearApprovals': {
                el.messages.querySelectorAll('.tool-approval-card').forEach(c => c.remove());
                break;
            }

            // ── Tool execution events ──────────────────────────────────────────

            case 'toolStart': {
                let aMsg = state.messages.find(m => m.id === msg.msgId);
                if (!aMsg) break;

                const call = { ...msg.call, done: false };
                aMsg.toolCalls.push(call);

                const domEl = el.messages.querySelector(`[data-id="${CSS.escape(msg.msgId)}"]`);
                if (domEl) {
                    const block = createToolBlock(call);
                    // Replace pending approval card if present, otherwise append
                    const pendingCard = domEl.querySelector(`.tool-approval-card[data-callid="${CSS.escape(msg.call.id)}"]`);
                    if (pendingCard) {
                        pendingCard.replaceWith(block);
                    } else {
                        const footer = domEl.querySelector('.msg-footer');
                        footer ? domEl.insertBefore(block, footer) : domEl.appendChild(block);
                    }
                    scrollBottom();
                }
                break;
            }

            case 'toolEnd': {
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

                        // Add diff button for successful write/edit operations
                        const name = msg.call.name;
                        const argPath = msg.call.args?.path;
                        if (!msg.call.result?.error &&
                            (name === 'write_file' || name === 'edit_file') &&
                            argPath && !header.querySelector('.tool-diff-btn')) {
                            const diffBtn = document.createElement('button');
                            diffBtn.className = 'tool-diff-btn';
                            diffBtn.title = 'View git diff';
                            diffBtn.textContent = '⊕ Diff';
                            diffBtn.addEventListener('click', (e) => {
                                e.stopPropagation();
                                vscode.postMessage({ type: 'showDiff', path: argPath });
                            });
                            header.appendChild(diffBtn);
                        }
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
        }
        scrollBottom();
    }

    // ── Boot ─────────────────────────────────────────────────────────────────
    vscode.postMessage({ type: 'ready' });

})();
