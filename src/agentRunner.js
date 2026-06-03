const vscode = require('vscode');
const api = require('./apiClient');
const toolHandler = require('./toolHandler');
const logger = require('./logger');

const SYSTEM_PROMPTS = {
    chat: `You are a helpful, knowledgeable coding assistant integrated into VS Code. Answer questions clearly and concisely. You do not have access to tools in this mode.`,

    plan: `You are a senior software engineer performing a read-only analysis inside VS Code.
Your task: analyze the codebase using the available read tools, then produce a clear, numbered action plan.
Rules:
- Use read_file, list_directory, search_files, get_diagnostics, get_git_diff, get_symbols to gather information.
- Do NOT make any changes to files in this mode.
- When you have gathered enough information, output a detailed step-by-step plan clearly formatted with numbered steps.
- End with a summary of risks or things to watch out for.`,

    agent: `You are an autonomous coding agent operating inside VS Code with full tool access.
You can read files, edit files, write files, search the codebase, get diagnostics, run terminal commands, and inspect git diffs and symbol outlines.
Guidelines:
- Think step by step. You may call multiple tools in a single response when they are independent (e.g., reading several files at once) — this runs them in parallel and is more efficient.
- Wait for tool results before continuing with dependent operations.
- Prefer reading existing code before writing new code.
- Use get_symbols to understand a file's structure before editing it.
- Use edit_file for targeted changes to existing files (replacing a specific function, fixing a line, etc.). Use write_file only for new files or complete rewrites.
- When using write_file, write the complete file content — do not use placeholders.
- When you have completed the task, provide a clear summary of everything you did.
- If something is unclear or risky, ask the user before proceeding.`
};

class AgentRunner {
    constructor() {
        this._abort = null;
    }

    isRunning() {
        return this._abort !== null;
    }

    stop() {
        if (this._abort) {
            this._abort.abort();
            this._abort = null;
        }
    }

    /**
     * Run the agent loop.
     *
     * @param {string} mode                 'chat' | 'plan' | 'agent'
     * @param {Array}  sessionMessages      Conversation messages so far (no system msg)
     * @param {object} initialSessionState  Opaque adapter state from previous run (null to start fresh)
     *
     * Callbacks:
     *   onMessageStart(id)
     *   onToken(text)
     *   onStreamEnd()
     *   onToolStart(call)        — { msgId, id, name, args } — tool approved and running
     *   onToolDenied(call)       — { msgId, id, name, args } — tool was denied
     *   onToolEnd(call)          — { msgId, id, name, args, result }
     *   onComplete({ messages, sessionState })
     *   onError(message)
     *   onStatus(text)
     *   onUsage({ usage, uuid, msgId })
     */
    async run(mode, sessionMessages, initialSessionState, callbacks) {
        const {
            onMessageStart, onToken, onStreamEnd,
            onToolStart, onToolDenied, onToolEnd,
            onComplete, onError, onStatus, onUsage
        } = callbacks;

        this._abort = new AbortController();
        const signal = this._abort.signal;

        const cfg = api.getConfig();
        const maxIter = cfg.get('maxIterations', 20);
        const customPrompt = cfg.get('systemPrompt', '');
        const systemContent = customPrompt || SYSTEM_PROMPTS[mode] || SYSTEM_PROMPTS.agent;

        const tools = toolHandler.getDefinitions(mode);
        const runMessages = [{ role: 'system', content: systemContent }, ...sessionMessages];

        let sessionState = initialSessionState || null;
        let iteration = 0;

        try {
            while (iteration < maxIter) {
                if (signal.aborted) break;
                iteration++;

                const msgId = `a_${Date.now()}_${iteration}`;
                onMessageStart(msgId);
                onStatus(`${mode === 'agent' ? 'Agent' : mode === 'plan' ? 'Planning' : 'Thinking'} (step ${iteration}/${maxIter})…`);
                logger.log(`Run iteration ${iteration} [mode=${mode}]`);

                const result = await api.chat({
                    messages: runMessages,
                    tools,
                    onToken: (tok) => onToken(tok),
                    signal,
                    sessionState
                });

                const assistantMsg = result.message;
                sessionState = result.sessionState;

                onStreamEnd();
                if (onUsage && (result.usage || result.uuid)) {
                    onUsage({ usage: result.usage || null, uuid: result.uuid || null, msgId });
                }
                runMessages.push(assistantMsg);

                // No tool calls → done
                if (!assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0) {
                    break;
                }

                // ── Phase 1: request approvals for all tool calls simultaneously ────────
                // Pre-approved tools return instantly; 'ask' tools show in-chat cards.
                const toolCount = assistantMsg.tool_calls.length;
                if (toolCount > 1) {
                    onStatus(`Requesting approval for ${toolCount} tool calls…`);
                } else {
                    onStatus(`Requesting approval: ${assistantMsg.tool_calls[0].function.name}…`);
                }

                const decisions = await Promise.all(
                    assistantMsg.tool_calls.map(async (tc) => {
                        const name = tc.function.name;
                        let args = {};
                        try { args = JSON.parse(tc.function.arguments || '{}'); } catch { args = {}; }

                        if (signal.aborted) {
                            return { tc, name, args, approved: false };
                        }

                        const decision = await toolHandler.requestApproval(name, tc.id, args, msgId, tc);
                        return { tc, name, args, approved: decision === 'allow' };
                    })
                );

                // ── Phase 2: execute approved tools in parallel ───────────────────────
                const approvedNames = decisions.filter(d => d.approved).map(d => d.name);
                if (approvedNames.length > 1) {
                    onStatus(`Running ${approvedNames.length} tools in parallel: ${approvedNames.join(', ')}…`);
                } else if (approvedNames.length === 1) {
                    onStatus(`Running tool: ${approvedNames[0]}…`);
                }

                const results = await Promise.all(
                    decisions.map(async ({ tc, name, args, approved }) => {
                        if (!approved) {
                            if (onToolDenied) onToolDenied({ msgId, id: tc.id, name, args });
                            return { tc, name, toolResult: { error: `Tool '${name}' was denied.` } };
                        }

                        if (signal.aborted) {
                            return { tc, name, toolResult: { error: 'Aborted' } };
                        }

                        onToolStart({ msgId, id: tc.id, name, args });

                        const toolResult = await toolHandler.executeDirect(name, args);
                        logger.log(`TOOL RESULT ${name}: ${JSON.stringify(toolResult).slice(0, 120)}`);

                        onToolEnd({ msgId, id: tc.id, name, args, result: toolResult });
                        return { tc, name, toolResult };
                    })
                );

                // Add all tool results to message history (preserves original order)
                for (const { tc, name, toolResult } of results) {
                    runMessages.push({
                        role: 'tool',
                        tool_call_id: tc.id,
                        name,
                        content: JSON.stringify(toolResult)
                    });
                }

                // Plan mode: single pass only
                if (mode === 'plan') break;
            }

            if (iteration >= maxIter) {
                onStatus(`Stopped: reached maximum ${maxIter} iterations.`);
                logger.log(`Agent hit maxIterations (${maxIter})`);
            }

            onComplete({
                messages: runMessages.filter(m => m.role !== 'system'),
                sessionState
            });

        } catch (e) {
            if (e.name === 'AbortError') {
                logger.log('Agent aborted by user');
                onComplete({
                    messages: runMessages.filter(m => m.role !== 'system'),
                    sessionState
                });
            } else {
                logger.error('AgentRunner', e);
                onError(e.message);
            }
        } finally {
            this._abort = null;
            onStatus('');
        }
    }
}

module.exports = new AgentRunner();
