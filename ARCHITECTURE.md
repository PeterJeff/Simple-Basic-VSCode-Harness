# Architecture — Standalone Agent

This document is the technical reference for understanding, maintaining, and extending this extension. It is intentionally written to be useful as context for an LLM agent working on this codebase.

---

## File Map

```
basic interface/
├── extension.js              Entry point. Registers providers and commands.
├── package.json              VS Code extension manifest. Defines settings schema,
│                             commands, menus, and the activity bar container.
├── README.md                 User-facing documentation.
├── ARCHITECTURE.md           This file.
│
├── src/                      Extension host modules (Node.js context, full API access)
│   ├── logger.js             Output channel wrapper + verbose flag.
│   ├── historyManager.js     Chat session CRUD via ExtensionContext.globalState.
│   ├── apiClient.js          HTTP client. Resolves active server/endpoint, injects API
│   │                         key from OS keychain at request time.
│   ├── toolHandler.js        Tool definitions (OpenAI format) + permission gating +
│   │                         execution. Uses VS Code APIs (workspace.fs, WorkspaceEdit,
│   │                         shell integration) rather than raw Node fs/child_process.
│   ├── agentRunner.js        The agent loop. Drives Chat/Plan/Agent modes.
│   └── chatProvider.js       WebviewViewProvider. Owns the webview, coordinates all
│                             modules, manages secure key storage and markdown rendering.
│
└── media/                    Webview assets (sandboxed browser context, NO Node.js APIs)
    ├── chat.js               Entire webview UI — builds DOM, handles all user interaction,
    │                         renders messages, manages panels (chat/history/settings).
    ├── chat.css              VSCode-variable-based styles for all UI components.
    └── icon.svg              Activity bar icon (SVG, currentColor).
```

---

## Architecture Overview

```
┌─ VS Code Extension Host (Node.js) ──────────────────────┐
│                                                          │
│  extension.js                                            │
│    └─ registers ChatViewProvider                         │
│         ├─ owns: HistoryManager, AgentRunner ref         │
│         ├─ coordinates: apiClient, agentRunner,          │
│         │               toolHandler, historyManager      │
│         └─ owns: Webview                                 │
│                    │  postMessage / onDidReceiveMessage  │
└────────────────────┼─────────────────────────────────────┘
                     │  (serialized JSON messages)
┌─ Webview (Chromium sandbox) ────────────────────────────┐
│  chat.js                                                 │
│    ├─ builds all DOM on load                             │
│    ├─ manages display state (messages, panels, toggles)  │
│    └─ posts user actions up to extension host            │
└─────────────────────────────────────────────────────────┘
```

The **extension host** owns all state, all API calls, all file I/O, and all VS Code API access.
The **webview** is a pure display/input layer — it has no direct access to the file system or VS Code APIs.

---

## Module Responsibilities

### `extension.js`
Minimal entry point. Calls `logger.init(context)`, creates `ChatViewProvider`, registers webview and all commands. Wires `onDidChangeConfiguration` to `provider.onConfigChange()`.

No business logic lives here.

### `src/logger.js`
Singleton (exported object, not class). Wraps `vscode.window.createOutputChannel`. Call `logger.init(context)` once on activation. 

API:
- `log(msg)` — always writes to output channel
- `verbose(label, payload?)` — only writes if verbose mode is on; `payload` is JSON-serialized
- `error(msg, err?)` — logs with `[ERROR]` prefix
- `setVerbose(bool)`, `isVerbose()`, `show()` — control verbose and channel visibility

### `src/historyManager.js`
Instance (created once in ChatViewProvider). Persists session data to `ExtensionContext.globalState` under key `sa_sessions`.

Session schema:
```js
{
  id: string,          // "s_<timestamp>"
  title: string,       // first ~60 chars of first user message
  created: string,     // ISO date string
  messages: Message[]  // OpenAI-format messages (role, content, tool_calls?, tool_call_id?)
}
```

Keeps a maximum of 50 sessions (oldest are dropped). Does not save system messages — those are generated at runtime.

### `src/apiClient.js`
Singleton (exported object). All HTTP calls go through here.

Key functions:
- `chat({ messages, tools, onToken, signal })` — main inference call. Streams if `onToken` is provided AND `standaloneAgent.streaming` is true. Returns a full `{ role, content, tool_calls? }` message object.
- `listModels()` — GET `/models`, returns sorted string array of model IDs.
- `setSecrets(secrets)` — called once at startup with `context.secrets`. Enables secure key resolution.
- `resolveActive()` — resolves current `{ server, endpoint, adapter }` from config.
- `getConfig()` — shorthand for `vscode.workspace.getConfiguration('standaloneAgent')`.

**Secure key injection:** `_withKey(server)` is called inside `chat()` and `listModels()`. It reads the API key for the server from `context.secrets` (OS keychain) and merges it into the server object before passing to the adapter. The key never appears in `settings.json`.

Streaming implementation: reads `response.body.getReader()`, parses SSE `data:` lines, reassembles tool call deltas from `delta.tool_calls[].index`. Returns a complete assembled message at the end.

### `src/toolHandler.js`
Singleton. Owns tool definitions (`ALL_TOOLS`) and execution. Uses VS Code APIs throughout — no raw `fs` module.

- `getDefinitions(mode)` — returns tool array filtered by mode: `chat` → `[]`, `plan` → read-only subset, `agent` → all tools.
- `execute(toolName, args)` — checks permission, then runs `_run()`. Returns a plain object result (or `{ error: string }` on failure/denial).
- `requestApproval(toolName, ...)` — reads `standaloneAgent.toolPermissions[toolName]`. If `'ask'`, delegates to the in-chat approval callback (registered by chatProvider). "Allow Always" updates config.

**Tool implementations:**

| Tool | Implementation notes |
|------|---------------------|
| `read_file` | `vscode.workspace.textDocuments` first (includes unsaved edits), then `workspace.fs.readFile` |
| `write_file` | `WorkspaceEdit` if file is open (preserves undo); `workspace.fs.writeFile` + `createDirectory` for new files |
| `list_directory` | `workspace.fs.readDirectory` — works across local, remote, WSL, and Dev Container filesystems |
| `search_files` | `workspace.findFiles` for discovery; reads each via open doc buffer or `workspace.fs` |
| `get_diagnostics` | `vscode.languages.getDiagnostics` |
| `edit_file` | `openTextDocument` (in-memory content) + `WorkspaceEdit.replace` — auto-saves after apply |
| `get_git_diff` | VS Code git extension API (`repo.diff()`) for full-workspace diffs; `child_process.execFile('git')` fallback for path-scoped diffs |
| `run_terminal` | Shell Integration API (`terminal.shellIntegration.executeCommand`) if VS Code 1.93+; `child_process.exec` fallback — in both cases the command executes exactly once |
| `get_symbols` | `vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', uri)` |

Adding a new tool:
1. Add a new entry to `ALL_TOOLS` with the OpenAI function-calling schema.
2. Add a `case 'your_tool':` block in the `_run()` switch.
3. Add a default permission entry to `package.json` under `standaloneAgent.toolPermissions.default`.
4. If read-only, add the name to `READ_ONLY_TOOLS` so it's available in Plan mode.

### `src/agentRunner.js`
Singleton. Drives the agent loop. Calls `api.chat()`, handles tool calls via `toolHandler`, manages `AbortController` for stop.

**Loop flow (per iteration):**
1. Generate `msgId = "a_<timestamp>_<iteration>"`
2. Call `onMessageStart(msgId)` — tells provider to create a new assistant message element
3. Call `api.chat()` — with or without streaming
4. Call `onStreamEnd()` — finalizes the streaming message
5. Phase 1: call `toolHandler.requestApproval()` for all tool calls simultaneously (pre-approved tools resolve instantly; `ask` tools show in-chat cards)
6. Phase 2: execute all approved tools in parallel via `toolHandler.executeDirect()`
7. Push `tool` role messages into `runMessages` for next iteration
8. If no tool calls (or `plan` mode): break

**Callbacks passed by chatProvider:**
```js
{
  onMessageStart(id)             // new assistant msg div needed
  onToken(text)                  // streaming token
  onStreamEnd()                  // streaming complete
  onToolStart({ msgId, id, name, args })
  onToolDenied({ msgId, id, name, args })
  onToolEnd({ msgId, id, name, args, result })
  onStatus(text)                 // status bar + progress bar text
  onUsage({ usage, uuid, msgId })
  onComplete({ messages, sessionState })
  onError(errorString)
}
```

`onComplete` always fires, even if stopped. `messages` contains the full updated history (system message excluded).

**Mode behavior:**
- `chat`: No tools. Single pass.
- `plan`: Read-only tools only. Single pass (loop breaks after first iteration).
- `agent`: All tools. Loop continues until no tool calls returned or `maxIterations` reached.

**System prompts** are hardcoded per mode in `SYSTEM_PROMPTS` at the top of the file. `standaloneAgent.systemPrompt` overrides all modes when non-empty.

### `src/chatProvider.js`
Class (one instance). The central coordinator.

Key responsibilities:
- `resolveWebviewView()` — called by VS Code when the sidebar is shown. Sets up webview options (CSP, allowed resources), generates HTML, wires `onDidReceiveMessage`.
- `_handleWebviewMessage(msg)` — dispatches all messages from the webview. See message protocol below.
- `_handleUserMessage(text)` — resolves `@` refs, appends to session, fires `agentRunner.run()`.
- `_buildHtml(webview)` — generates the HTML shell. Injects CSP nonce and asset URIs. No external script tags beyond `chat.js`.
- `_resolveAtRefs(text)` — extracts `@path` tokens. Checks `vscode.workspace.textDocuments` first (in-memory, includes unsaved edits), falls back to `workspace.fs.readFile`.
- `_runAgent()` — wraps the agent run in `vscode.window.withProgress` (Window location, cancellable). Accumulates streaming tokens in `_streamBuffers`; after `streamEnd` renders the full text via `vscode.commands.executeCommand('markdown.api.render', text)` and pushes the safe HTML to the webview as `renderedMarkdown`.
- `_migrateApiKeys()` — runs once at startup. Reads any `apiKey` fields from `standaloneAgent.servers` in settings, stores them in `context.secrets`, then removes them from the config.
- `_getServersForWebview()` — returns servers with `apiKey` stripped and a `hasKey: boolean` added (async — queries secrets).
- `_updateSetting('servers', ...)` — extracts `apiKey` values, stores in secrets, saves config without keys.
- `newChat()`, `clearHistory()`, `onConfigChange()` — called by commands registered in `extension.js`.

`_streamMsgId` tracks the ID of the currently-streaming assistant message. `_streamBuffers` is a `Map<msgId, string>` for token accumulation.

---

## Message Protocol

All cross-boundary communication uses `JSON` objects passed via `postMessage`.

### Webview → Extension Host

| `type` | Payload | Description |
|--------|---------|-------------|
| `ready` | — | Webview loaded, request initial state |
| `send` | `{ text }` | User submitted a message |
| `stop` | — | Stop button clicked |
| `newChat` | — | New chat button clicked |
| `setMode` | `{ mode }` | Mode dropdown changed (`chat`/`plan`/`agent`) |
| `getModels` | — | Refresh model list |
| `setModel` | `{ model }` | Model dropdown changed |
| `setEndpoint` | `{ name }` | Endpoint dropdown changed |
| `loadSession` | `{ id }` | Load a history session |
| `deleteSession` | `{ id }` | Delete a history session |
| `getFileSuggestions` | `{ query }` | @ autocomplete query |
| `fork` | `{ userMsgIdx }` | Edit/fork conversation from a past user message |
| `retry` | — | Retry last assistant turn |
| `updateToolPermission` | `{ tool, level }` | Permission changed in settings panel |
| `updateSetting` | `{ key, value }` | Generic setting update (servers array: apiKey extracted → secrets) |
| `getMonthlyUsage` | — | Force monthly usage refresh |
| `toolApprovalResponse` | `{ callId, decision }` | User responded to an approval card |
| `openTextWindow` | `{ content }` | Open raw tool call JSON in an editor tab |
| `showDiff` | `{ path }` | Open native git diff (git.openChange) for a file |
| `openSettings` | — | Open VS Code settings UI |

### Extension Host → Webview

| `type` | Payload | Description |
|--------|---------|-------------|
| `init` | `{ sessions, session, mode, servers, endpoints, activeEndpoint, model, streaming, enterToSend, verboseLogging, maxIterations, toolPermissions, toolDefs, askSageToolMode, supportsMonthlyUsage }` | Full initial state |
| `configUpdate` | subset of init fields | Config changed externally |
| `verboseState` | `{ verbose }` | Verbose toggle changed via command |
| `newChat` | — | Reset chat area |
| `userMessage` | `{ id, ts, text, contextFiles[] }` | Display a user message |
| `assistantStart` | `{ id, ts }` | Create a new (empty) assistant message element |
| `token` | `{ id, text }` | Append a streaming token to message `id` |
| `streamEnd` | `{ id }` | Finalize the streaming message `id` |
| `renderedMarkdown` | `{ id, html }` | Replace client-rendered markdown with VS Code-rendered HTML |
| `usage` | `{ msgId, usage, uuid }` | Token/cost usage badge data |
| `monthlyUsage` | `{ data }` or `{ error }` | Monthly usage bar data |
| `toolApprovalRequest` | `{ callId, toolName, args, rawCall, msgId }` | Show an approval card |
| `toolStart` | `{ msgId, call }` | Show a tool call (running state) |
| `toolDenied` | `{ msgId, call }` | Mark tool call as denied |
| `toolEnd` | `{ msgId, call }` | Update tool call with result (add ⊕ Diff button for write/edit) |
| `clearApprovals` | — | Remove all pending approval cards (on stop/new chat) |
| `status` | `{ text }` | Update status bar text (also reflected in VS Code progress bar) |
| `done` | — | Agent run complete, re-enable input |
| `error` | `{ text }` | Show an error message, re-enable input |
| `sessions` | `{ sessions[] }` | Updated session list |
| `loadSession` | `{ session }` | Load and render a session's messages |
| `forkReady` | `{ session }` | Fork complete, re-render truncated history |
| `models` | `{ models[], current }` | Populate model dropdown |
| `fileSuggestions` | `{ files[], query }` | @ autocomplete results |

---

## Webview UI (`media/chat.js`)

The webview builds its entire DOM via `document.body.innerHTML = ...` at load time. No external HTML template is used.

**State object:**
```js
state = {
  mode, isProcessing, markdownEnabled, streamingEnabled, verbose,
  sessions[], messages[], toolPermissions{}, toolDefs[],
  servers[], endpoints[], activeEndpoint, models[], currentModel,
  atQuery, atCursorStart, atDropdownItems[], atSelectedIdx,
  enterToSend,         // bool: true = Enter sends; false = Shift+Enter sends
  toolCallMode,        // 'api' | 'prompt'
  supportsMonthlyUsage,
  usageByMsgId{}       // keyed by msgId → { usage, uuid }
}
```

**Message display format (internal to webview):**
```js
// User message
{ id, role: 'user', raw: string, contextFiles: string[], ts: number }

// Assistant message
{ id, role: 'assistant', raw: string, renderedHtml?: string, toolCalls: ToolCall[], pending: bool, ts: number }

// Error display
{ id, role: 'error', raw: string }
```

`raw` is always the unrendered source text. `renderedHtml` is populated when the extension sends a `renderedMarkdown` message. Markdown rendering priority on display:
1. `renderedHtml` (VS Code `markdown.api.render` output) — used when available and MD toggle is on
2. `renderMarkdown(raw)` — client-side fallback using `builtinMd()` (handles code blocks, headers, bold/italic, lists, links, blockquotes, HR)
3. `<pre>raw</pre>` — when MD toggle is off

**Tool call display format:**
```js
{ id, name, args, result, done: bool }
```

Completed `write_file` and `edit_file` tool blocks display a **⊕ Diff** button that posts `showDiff` to the extension host, which opens VS Code's native `git.openChange` diff view.

**@ autocomplete flow:**
1. On `input` event: scan back from cursor to find `@` with no intervening spaces
2. Send `getFileSuggestions` with the partial query
3. On `fileSuggestions` response: render dropdown above input
4. Arrow keys navigate, Enter/Tab/click confirms, Escape closes
5. On confirm: replace `@<partial>` with `@<chosen-path> ` in textarea

---

## Configuration Schema

Defined in `package.json` under `contributes.configuration.properties`. All keys are prefixed `standaloneAgent.`.

To add a new setting:
1. Add the property to `package.json` with type, default, and description.
2. Read it in the relevant module via `vscode.workspace.getConfiguration('standaloneAgent').get('yourKey', defaultValue)`.
3. If it needs to be known by the webview, add it to the `init` payload in `chatProvider._sendInitState()` and to the `configUpdate` payload in `chatProvider.onConfigChange()`.
4. Handle it in `chat.js` in the `'init'` and `'configUpdate'` message cases.

---

## What Is NOT Implemented (Planned)

### Subagent Processing
The idea: run a focused sub-loop (e.g., "investigate this bug", "draft a plan") that produces a clean summary injected into the main context, without polluting it with all the intermediate tool calls and reasoning.

**Design sketch:**
- New `agentRunner.runSubagent(task, messages, callbacks)` method
- Separate system prompt instructing it to summarize its findings
- Result returned as a single synthetic `assistant` message
- Main loop consumes this as if a human provided the summary
- Provider sends a special `subagentResult` webview message for display

### Vector Search / Embeddings
Would require the API to support `/v1/embeddings`. Pure JS is feasible:
- On demand (or background), chunk workspace files and call the embeddings endpoint
- Store `{ path, chunk, vector: float[] }` objects in a JSON file in the extension storage path
- At query time, embed the query, compute cosine similarity, return top-N chunks
- ~100 lines of vanilla JS math, no library needed

Storage: `context.globalStorageUri` for the vectors JSON (persists across sessions).
Challenge: keeping embeddings fresh when files change — use `vscode.workspace.onDidSaveTextDocument`.

### Syntax Highlighting in Code Blocks
Drop `highlight.min.js` and a theme CSS file into `media/`. In `chat.js`, after rendering markdown (or receiving `renderedMarkdown`), call `hljs.highlightAll()` on the new content. No other changes needed.

### Virtual Diff Preview (Pre-apply Review)
Register a `TextDocumentContentProvider` for a custom URI scheme (e.g. `agent-preview://`). Before applying a write/edit, store the proposed content in a memory cache keyed by path. Open a native VS Code diff with `vscode.commands.executeCommand('vscode.diff', originalUri, previewUri, 'Agent Proposed Changes')`. Add Accept/Reject buttons to the tool approval card.

The current `⊕ Diff` button shows a post-apply `git diff` — the pre-apply virtual diff would allow rejecting changes before they hit disk.

### More Tools
- `delete_file` — `vscode.workspace.fs.delete()`
- `create_file` — alias for `write_file` that errors if file already exists
- `get_open_editors` — list currently open editor tabs
- `go_to_definition` — resolve a symbol's definition location via `vscode.executeDefinitionProvider`

---

## Key Constraints

- **Zero external dependencies.** No npm, no CDN, no `require()` of packages not bundled with Node.js or VS Code itself. Built-in modules (`path`, `crypto`, `child_process`) are fine. VS Code API is fine.
- **No Chinese AI models.** Do not suggest or integrate Qwen or other models from Chinese vendors.
- **Air-gapped deployment.** All files must be self-contained. No network calls except to the configured LLM API endpoint.
- **VS Code 1.80+ / Node.js 18+.** `fetch` is used as a built-in. Do not introduce `node-fetch` or `axios`.
- **No build step.** Files are deployed as-is. No webpack, esbuild, or transpilation.

---

## VS Code Extension APIs Used

| API | Usage |
|-----|-------|
| `vscode.window.registerWebviewViewProvider` | Registers the sidebar chat panel |
| `vscode.window.createOutputChannel` | Logging output channel |
| `vscode.window.showInformationMessage` | Tool permission modals and approval toasts |
| `vscode.window.withProgress` | Status bar progress indicator during agent runs |
| `vscode.window.terminals`, `createTerminal` | `run_terminal` tool — shows terminal, executes command |
| `vscode.workspace.getConfiguration` | Reading/writing settings |
| `vscode.workspace.findFiles` | @ autocomplete and `search_files` tool |
| `vscode.workspace.fs.readFile` | Reading files (remote-safe; replaces `fs.readFileSync`) |
| `vscode.workspace.fs.writeFile` | Writing new/non-open files (remote-safe) |
| `vscode.workspace.fs.readDirectory` | Listing directories (replaces `fs.readdirSync`) |
| `vscode.workspace.fs.createDirectory` | Creating parent directories before writes |
| `vscode.workspace.openTextDocument` | Opening document for WorkspaceEdit or buffer access |
| `vscode.workspace.applyEdit` | Applying WorkspaceEdit (preserves undo history) |
| `vscode.workspace.textDocuments` | Accessing open editor buffers (includes unsaved changes) |
| `vscode.workspace.asRelativePath` | Making paths relative for display |
| `vscode.workspace.onDidChangeConfiguration` | Config change listener |
| `vscode.languages.getDiagnostics` | `get_diagnostics` tool |
| `vscode.WorkspaceEdit`, `vscode.Range` | Surgical file edits in `edit_file` and `write_file` |
| `vscode.commands.executeCommand('markdown.api.render')` | Server-side markdown → HTML rendering |
| `vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider')` | `get_symbols` tool |
| `vscode.commands.executeCommand('git.openChange')` | Native git diff view for ⊕ Diff button |
| `vscode.extensions.getExtension('vscode.git')` | Git extension API for `get_git_diff` |
| `terminal.shellIntegration.executeCommand` | Single-execution terminal capture (VS Code 1.93+) |
| `ExtensionContext.globalState` | Session history and model/usage cache persistence |
| `ExtensionContext.secrets` | Secure API key storage (OS keychain) |
| `ExtensionContext.extensionUri` | Resolving asset paths for webview |
| `vscode.Uri.joinPath`, `webview.asWebviewUri` | Converting local file paths to webview-accessible URIs |
| `vscode.ProgressLocation.Window` | Bottom status bar progress with cancel support |
