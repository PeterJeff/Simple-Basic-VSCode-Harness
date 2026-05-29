const vscode = require('vscode');
const api = require('./apiClient');
const toolHandler = require('./toolHandler');
const logger = require('./logger');

const SYSTEM_PROMPTS = {
    chat: `You are a helpful, knowledgeable coding assistant integrated into VS Code. Answer questions clearly and concisely. You do not have access to tools in this mode.`,

    plan: `You are a senior software engineer performing a read-only analysis inside VS Code.
Your task: analyze the codebase using the available read tools, then produce a clear, numbered action plan.
Rules:
- Use read_file, list_directory, search_files, get_diagnostics to gather information.
- Do NOT make any changes to files in this mode.
- When you have gathered enough information, output a detailed step-by-step plan clearly formatted with numbered steps.
- End with a summary of risks or things to watch out for.`,

    agent: `You are an autonomous coding agent operating inside VS Code with full tool access.
You can read files, write files, search the codebase, get diagnostics, and run terminal commands.
Guidelines:
- Think step by step. Use one tool per turn. Wait for results before continuing.
- Prefer reading existing code before writing new code.
- When writing files, write the complete file content — do not use placeholders.
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
     *   onMessageStart(id)              — new assistant message about to stream
     *   onToken(text)                   — streaming text token
     *   onStreamEnd()                   — streaming response complete
     *   onToolStart(call)               — { id, name, args }
     *   onToolEnd(call)                 — { id, name, args, result }
     *   onComplete({ messages, sessionState }) — final messages array + updated adapter state
     *   onError(message)                — fatal error string
     *   onStatus(text)                  — status line update
     */
    async run(mode, sessionMessages, initialSessionState, callbacks) {
        const { onMessageStart, onToken, onStreamEnd, onToolStart, onToolEnd, onComplete, onError, onStatus } = callbacks;

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
                runMessages.push(assistantMsg);

                // No tool calls → done
                if (!assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0) {
                    break;
                }

                // Process each tool call
                for (const tc of assistantMsg.tool_calls) {
                    if (signal.aborted) break;

                    const name = tc.function.name;
                    let args = {};
                    try { args = JSON.parse(tc.function.arguments || '{}'); } catch { args = {}; }

                    onToolStart({ msgId, id: tc.id, name, args });
                    onStatus(`Running tool: ${name}…`);

                    const toolResult = await toolHandler.execute(name, args);

                    onToolEnd({ msgId, id: tc.id, name, args, result: toolResult });
                    logger.log(`TOOL RESULT ${name}: ${JSON.stringify(toolResult).slice(0, 120)}`);

                    runMessages.push({
                        role: 'tool',
                        tool_call_id: tc.id,
                        name: name,
                        content: JSON.stringify(toolResult)
                    });
                }

                // Plan mode: read-only single pass — present plan then stop
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
