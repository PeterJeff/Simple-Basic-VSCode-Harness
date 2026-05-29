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
            description: 'Send a command to the integrated terminal. Note: output is not captured; use read_file to verify results written to disk.',
            parameters: {
                type: 'object',
                properties: {
                    command: { type: 'string', description: 'Shell command to execute' }
                },
                required: ['command']
            }
        }
    }
];

const READ_ONLY_TOOLS = ['read_file', 'list_directory', 'search_files', 'get_diagnostics'];

// ── Permission check ──────────────────────────────────────────────────────────

async function checkPermission(toolName) {
    const cfg = vscode.workspace.getConfiguration('standaloneAgent');
    const perms = cfg.get('toolPermissions', {});
    const level = perms[toolName] || 'ask';

    if (level === 'allow') return 'allow';
    if (level === 'deny')  return 'deny';

    // 'ask'
    const choice = await vscode.window.showInformationMessage(
        `Agent wants to call: ${toolName}`,
        { modal: true },
        'Allow Once', 'Allow Always', 'Deny'
    );

    if (choice === 'Allow Always') {
        const updated = { ...perms, [toolName]: 'allow' };
        await cfg.update('toolPermissions', updated, vscode.ConfigurationTarget.Global);
        return 'allow';
    }
    if (choice === 'Allow Once') return 'allow';
    return 'deny';
}

// ── Public API ─────────────────────────────────────────────────────────────────

function getDefinitions(mode) {
    if (mode === 'chat')  return [];
    if (mode === 'plan')  return ALL_TOOLS.filter(t => READ_ONLY_TOOLS.includes(t.function.name));
    return ALL_TOOLS;
}

async function execute(toolName, args) {
    const decision = await checkPermission(toolName);
    if (decision === 'deny') {
        return { error: `Tool '${toolName}' was denied by permissions.` };
    }

    logger.log(`TOOL ${toolName}(${JSON.stringify(args)})`);

    try {
        return await _run(toolName, args);
    } catch (e) {
        logger.error(`TOOL ${toolName}`, e);
        return { error: e.message };
    }
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
            // Notify VSCode so editors refresh
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
            if (!terminal || terminal.exitStatus !== undefined) {
                terminal = vscode.window.createTerminal('Standalone Agent');
            }
            terminal.show(true);
            terminal.sendText(args.command);
            return { sent: true, note: 'Command sent to terminal. Terminal output is not captured.' };
        }

        default:
            return { error: `Unknown tool: ${toolName}` };
    }
}

module.exports = { getDefinitions, execute, ALL_TOOLS };
