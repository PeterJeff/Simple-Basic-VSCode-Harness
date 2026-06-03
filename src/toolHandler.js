const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const logger = require('./logger');

// ── Tool definitions (OpenAI function-calling format) ─────────────────────────

const ALL_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'read_file',
            description: 'Read the full contents of a file in the workspace.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'File path relative to workspace root' }
                },
                required: ['path']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'write_file',
            description: 'Write or overwrite a file. Creates parent directories as needed.',
            parameters: {
                type: 'object',
                properties: {
                    path:    { type: 'string', description: 'File path relative to workspace root' },
                    content: { type: 'string', description: 'Content to write' }
                },
                required: ['path', 'content']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'list_directory',
            description: 'List entries in a directory. Omit path to list the workspace root.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Directory path relative to workspace root (optional)' }
                },
                required: []
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'search_files',
            description: 'Search for a regex pattern across workspace files. Returns matching lines with context.',
            parameters: {
                type: 'object',
                properties: {
                    pattern: { type: 'string', description: 'Regex or plain text pattern to search for' },
                    glob:    { type: 'string', description: 'File glob filter, e.g. **/*.ts (optional)' }
                },
                required: ['pattern']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'get_diagnostics',
            description: 'Get VSCode diagnostics (errors, warnings) for the workspace or a specific file.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'File path for targeted diagnostics (optional)' }
                },
                required: []
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'run_terminal',
            description: 'Run a command in the integrated terminal and capture its output. Output is captured for timeout_ms milliseconds (default 10000). Increase timeout_ms for slow commands (builds, installs, tests). The output includes the shell prompt and command echo — ignore those and read the actual result.',
            parameters: {
                type: 'object',
                properties: {
                    command:    { type: 'string', description: 'Shell command to execute' },
                    timeout_ms: { type: 'number', description: 'Milliseconds to wait for output (default 10000, max 120000). Increase for long-running commands.' }
                },
                required: ['command']
            }
        }
    }
];

const READ_ONLY_TOOLS = ['read_file', 'list_directory', 'search_files', 'get_diagnostics'];

// ── Approval callback (registered by chatProvider for in-chat approval UI) ────
// Signature: (toolName, callId, args, msgId, rawCall) → Promise<'allow-once'|'allow-always'|'deny'>
let _approvalCallback = null;

function setApprovalCallback(fn) {
    _approvalCallback = fn;
}

// ── Request approval for a tool call ──────────────────────────────────────────
// Returns 'allow' or 'deny'. Persists 'allow-always' decisions automatically.

async function requestApproval(toolName, callId, args, msgId, rawCall) {
    const cfg = vscode.workspace.getConfiguration('standaloneAgent');
    const perms = cfg.get('toolPermissions', {});
    const level = perms[toolName] || 'ask';

    if (level === 'allow') return 'allow';
    if (level === 'deny')  return 'deny';

    // 'ask' — need user input
    let choice;
    if (_approvalCallback) {
        choice = await _approvalCallback(toolName, callId, args, msgId, rawCall);
    } else {
        const picked = await vscode.window.showInformationMessage(
            `Agent wants to call: ${toolName}`,
            { modal: true },
            'Allow Once', 'Allow Always', 'Deny'
        );
        choice = picked === 'Allow Always' ? 'allow-always'
               : picked === 'Allow Once'   ? 'allow-once'
               : 'deny';
    }

    if (choice === 'allow-always') {
        const updated = { ...perms, [toolName]: 'allow' };
        await cfg.update('toolPermissions', updated, vscode.ConfigurationTarget.Global);
        return 'allow';
    }
    if (choice === 'allow-once') return 'allow';
    return 'deny';
}

// ── Execute tool directly (no permission check) ───────────────────────────────

async function executeDirect(toolName, args) {
    logger.log(`TOOL ${toolName}(${JSON.stringify(args)})`);
    try {
        return await _run(toolName, args);
    } catch (e) {
        logger.error(`TOOL ${toolName}`, e);
        return { error: e.message };
    }
}

// ── Public API ─────────────────────────────────────────────────────────────────

function getDefinitions(mode) {
    if (mode === 'chat')  return [];
    if (mode === 'plan')  return ALL_TOOLS.filter(t => READ_ONLY_TOOLS.includes(t.function.name));
    return ALL_TOOLS;
}

// Backwards-compatible wrapper used by any code that hasn't been updated.
async function execute(toolName, args, callId) {
    const decision = await requestApproval(toolName, callId || `tc_${Date.now()}`, args);
    if (decision === 'deny') {
        return { error: `Tool '${toolName}' was denied by permissions.` };
    }
    return executeDirect(toolName, args);
}

// ── Tool implementations ───────────────────────────────────────────────────────

async function _run(toolName, args) {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';

    function abs(p) {
        return p && path.isAbsolute(p) ? p : path.join(root, p || '');
    }

    switch (toolName) {

        case 'read_file': {
            const content = fs.readFileSync(abs(args.path), 'utf8');
            return { content, line_count: content.split('\n').length };
        }

        case 'write_file': {
            const target = abs(args.path);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, args.content, 'utf8');
            vscode.workspace.fs.stat(vscode.Uri.file(target)).then(() => {}, () => {});
            return { success: true, path: args.path };
        }

        case 'list_directory': {
            const dirPath = abs(args.path || '');
            const entries = fs.readdirSync(dirPath, { withFileTypes: true });
            return {
                path: args.path || '.',
                entries: entries.map(e => ({
                    name: e.name,
                    type: e.isDirectory() ? 'directory' : 'file'
                }))
            };
        }

        case 'search_files': {
            const files = await vscode.workspace.findFiles(
                args.glob || '**/*',
                '{**/node_modules/**,**/.git/**}',
                200
            );
            const pattern = new RegExp(args.pattern, 'gi');
            const results = [];

            for (const fileUri of files) {
                let content;
                try { content = fs.readFileSync(fileUri.fsPath, 'utf8'); } catch { continue; }
                const lines = content.split('\n');
                const matches = [];
                for (let i = 0; i < lines.length; i++) {
                    pattern.lastIndex = 0;
                    if (pattern.test(lines[i])) {
                        matches.push({ line: i + 1, text: lines[i].trimEnd() });
                    }
                }
                if (matches.length > 0) {
                    results.push({
                        file: vscode.workspace.asRelativePath(fileUri),
                        matches
                    });
                }
            }
            return { results, files_searched: files.length };
        }

        case 'get_diagnostics': {
            const items = [];
            const severityName = ['Error', 'Warning', 'Info', 'Hint'];

            if (args.path) {
                const uri = vscode.Uri.file(abs(args.path));
                for (const d of vscode.languages.getDiagnostics(uri)) {
                    items.push({
                        file: args.path,
                        severity: severityName[d.severity] || 'Unknown',
                        message: d.message,
                        line: d.range.start.line + 1,
                        source: d.source || ''
                    });
                }
            } else {
                for (const [uri, diags] of vscode.languages.getDiagnostics()) {
                    for (const d of diags) {
                        items.push({
                            file: vscode.workspace.asRelativePath(uri),
                            severity: severityName[d.severity] || 'Unknown',
                            message: d.message,
                            line: d.range.start.line + 1,
                            source: d.source || ''
                        });
                    }
                }
            }
            return { diagnostics: items, count: items.length };
        }

        case 'run_terminal': {
            let terminal = vscode.window.terminals.find(t => t.name === 'Standalone Agent');
            const isNew = !terminal || terminal.exitStatus !== undefined;
            if (isNew) {
                terminal = vscode.window.createTerminal('Standalone Agent');
                // Brief pause for the new terminal's shell to initialize before we start listening
                await new Promise(r => setTimeout(r, 400));
            }
            terminal.show(true);

            const timeoutMs = typeof args.timeout_ms === 'number' && args.timeout_ms > 0
                ? Math.min(args.timeout_ms, 120000)
                : 10000;

            const chunks = [];
            const listener = vscode.window.onDidWriteTerminalData(e => {
                if (e.terminal === terminal) chunks.push(e.data);
            });

            terminal.sendText(args.command);
            await new Promise(r => setTimeout(r, timeoutMs));
            listener.dispose();

            // Strip ANSI escape sequences (colors, cursor movement, OSC sequences) and normalize line endings
            const rawOutput = chunks.join('');
            const output = rawOutput
                .replace(/\x1b(?:\[[0-9;?]*[A-Za-z]|\][^\x07]*\x07|[()][AB012]|[=>78MH])/g, '')
                .replace(/\r\n/g, '\n')
                .replace(/\r/g, '\n')
                .trim();

            return {
                sent: true,
                output: output || '(no output captured)',
                timeout_ms: timeoutMs
            };
        }

        default:
            return { error: `Unknown tool: ${toolName}` };
    }
}

module.exports = { getDefinitions, execute, executeDirect, requestApproval, setApprovalCallback, ALL_TOOLS };
