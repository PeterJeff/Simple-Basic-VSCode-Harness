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
    },
    {
        type: 'function',
        function: {
            name: 'edit_file',
            description: 'Edit a file by replacing an exact string with new content. old_string must match exactly (including whitespace and indentation). Errors if the string is not found or appears more than once — add surrounding context lines to make it unique. Use replace_all: true only for intentional bulk replacements (e.g. renaming a symbol). Prefer this over write_file for changes to existing files.',
            parameters: {
                type: 'object',
                properties: {
                    path:        { type: 'string',  description: 'File path relative to workspace root' },
                    old_string:  { type: 'string',  description: 'Exact string to find and replace, including surrounding context if needed for uniqueness' },
                    new_string:  { type: 'string',  description: 'Replacement string' },
                    replace_all: { type: 'boolean', description: 'Replace every occurrence instead of requiring exactly one match. Default: false.' }
                },
                required: ['path', 'old_string', 'new_string']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'get_git_diff',
            description: 'Get the git diff for the workspace or a specific file. Shows uncommitted changes. Use staged: true to see changes already staged for commit.',
            parameters: {
                type: 'object',
                properties: {
                    path:   { type: 'string',  description: 'File path to scope the diff (optional — omit for full workspace diff)' },
                    staged: { type: 'boolean', description: 'Show staged (index) diff instead of unstaged working-tree diff. Default: false.' }
                },
                required: []
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'get_symbols',
            description: 'Get the symbol outline (classes, functions, variables, etc.) for a file using the VS Code language server. Useful for understanding a file\'s structure before editing it.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'File path relative to workspace root' }
                },
                required: ['path']
            }
        }
    }
];

const READ_ONLY_TOOLS = ['read_file', 'list_directory', 'search_files', 'get_diagnostics', 'get_git_diff', 'get_symbols'];

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
            const timeoutMs = typeof args.timeout_ms === 'number' && args.timeout_ms > 0
                ? Math.min(args.timeout_ms, 120000)
                : 10000;

            const cp = require('child_process');
            const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();

            const output = await new Promise((resolve) => {
                cp.exec(args.command, { cwd: root, timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024 }, (err, stdout, stderr) => {
                    const combined = [stdout, stderr].filter(Boolean).join('\n').trim();
                    resolve(combined || (err ? `exit ${err.code}` : '(no output)'));
                });
            });

            // Also show the command in the integrated terminal so the user can see it ran
            let terminal = vscode.window.terminals.find(t => t.name === 'Standalone Agent');
            if (!terminal || terminal.exitStatus !== undefined) {
                terminal = vscode.window.createTerminal('Standalone Agent');
            }
            terminal.show(true);
            terminal.sendText(args.command);

            return { output, timeout_ms: timeoutMs };
        }

        case 'edit_file': {
            const target = abs(args.path);
            const content = fs.readFileSync(target, 'utf8');
            const { old_string, new_string, replace_all = false } = args;
            const count = content.split(old_string).length - 1;
            if (count === 0) return { error: `old_string not found in ${args.path}` };
            if (!replace_all && count > 1) return { error: `old_string found ${count} times in ${args.path} — add more surrounding context to make it unique, or set replace_all: true` };
            const updated = replace_all ? content.split(old_string).join(new_string) : content.replace(old_string, new_string);
            fs.writeFileSync(target, updated, 'utf8');
            vscode.workspace.fs.stat(vscode.Uri.file(target)).then(() => {}, () => {});
            return { success: true, path: args.path, replacements: replace_all ? count : 1 };
        }

        case 'get_git_diff': {
            const cp = require('child_process');
            const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
            const gitArgs = ['diff'];
            if (args.staged) gitArgs.push('--staged');
            if (args.path)   { gitArgs.push('--'); gitArgs.push(abs(args.path)); }
            const diff = await new Promise((resolve) => {
                cp.execFile('git', gitArgs, { cwd: root, maxBuffer: 1024 * 1024 }, (err, stdout) => {
                    resolve(stdout || '');
                });
            });
            return { diff: diff.trim(), has_changes: diff.trim().length > 0 };
        }

        case 'get_symbols': {
            const uri = vscode.Uri.file(abs(args.path));
            const raw = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', uri);
            if (!raw || raw.length === 0) return { symbols: [] };
            const KINDS = ['File','Module','Namespace','Package','Class','Method','Property','Field','Constructor','Enum','Interface','Function','Variable','Constant','String','Number','Boolean','Array','Object','Key','Null','EnumMember','Struct','Event','Operator','TypeParameter'];
            function flatten(syms, depth) {
                const out = [];
                for (const s of syms || []) {
                    out.push({
                        name:  s.name,
                        kind:  KINDS[s.kind] || String(s.kind),
                        range: { start_line: s.range.start.line + 1, end_line: s.range.end.line + 1 },
                        depth
                    });
                    if (s.children?.length) out.push(...flatten(s.children, depth + 1));
                }
                return out;
            }
            return { symbols: flatten(raw, 0) };
        }

        default:
            return { error: `Unknown tool: ${toolName}` };
    }
}

module.exports = { getDefinitions, execute, executeDirect, requestApproval, setApprovalCallback, ALL_TOOLS };
