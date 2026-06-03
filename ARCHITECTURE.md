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
│   ├── apiClient.js          HTTP client for OpenAI-compatible APIs. Streaming + model list.
│   ├── toolHandler.js        Tool definitions (OpenAI format) + permission gating + execution.
│   ├── agentRunner.js        The agent loop. Drives Chat/Plan/Agent modes.
│   └── chatProvider.js       WebviewViewProvider. Owns the webview, coordinates all modules.
│
└── media/                    Webview assets (sandboxed browser context, NO Node.js APIs)
    ├── chat.js               Entire webview UI — builds DOM, handles all user interaction,
    │                         renders messages, manages panels (chat/history/settings).
    ├── chat.css              VSCode-variable-based styles for all UI components.
    ├── icon.svg              Activity bar icon (SVG, currentColor).
    └── marked.min.js         OPTIONAL. Drop here for full markdown rendering.
                              If absent, the built-in fallback renderer is used.
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
- `getActiveEndpoint()` — resolves current endpoint from config.
- `getConfig()` — shorthand for `vscode.workspace.getConfiguration('standaloneAgent')`.

Streaming implementation: reads `response.body.getReader()`, parses SSE `data:` lines, reassembles tool call deltas from `delta.tool_calls[].index`. Returns a complete assembled message at the end.

### `src/toolHandler.js`
Singleton. Owns tool definitions (`ALL_TOOLS`) and execution.

- `getDefinitions(mode)` — returns tool array filtered by mode: `chat` → `[]`, `plan` → read-only subset, `agent` → all tools.
- `execute(toolName, args)` — checks permission, then runs `_run()`. Returns a plain object result (or `{ error: string }` on failure/denial).
- `checkPermission(toolName)` — reads `standaloneAgent.toolPermissions[toolName]`. If `'ask'`, shows a VS Code modal; "Allow Always" updates the config.

Adding a new tool:
1. Add a new entry to `ALL_TOOLS` with the OpenAI function-calling schema.
2. Add a `case 'your_tool':` block in the `_run()` switch.
3. Add a default permission entry to `package.json` under `standaloneAgent.toolPermissions.default`.
4. If read-only, add the name to `READ_ONLY_TOOLS` so it's available in Plan mode.

### `src/agentRunner.js`
Singleton. Drives the agent loop. Calls `api.chat()`, handles tool calls via `toolHandler.execute()`, manages `AbortController` for stop.

**Loop flow (per iteration):**
1. Generate `msgId = "a_<timestamp>_<iteration>"`
2. Call `onMessageStart(msgId)` — tells provider to create a new assistant message element
3. Call `api.chat()` — with or without streaming
4. Call `onStreamEnd()` — finalizes the streaming message
5. If `assistantMsg.tool_calls` is populated, loop over them calling `onToolStart` → `toolHandler.execute()` → `onToolEnd`
6. Push `tool` role messages into `runMessages` for next iteration
7. If no tool calls (or `plan` mode): break

**Callbacks passed by chatProvider:**
```js
{
  onMessageStart(id)             // new assistant msg div needed
  onToken(text)                  // streaming token
  onStreamEnd()                  // streaming complete
  onToolStart({ msgId, id, name, args })
  onToolEnd({ msgId, id, name, args, result })
  onStatus(text)                 // status bar text
  onComplete(messages)           // final messages array (sans system msg)
  onError(errorString)           // fatal error
}
```

`onComplete` always fires, even if stopped. `messages` param contains the full updated history.

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
- `_buildHtml(webview)` — generates the HTML shell. Injects CSP nonce, asset URIs. Checks if `marked.min.js` exists and conditionally adds a `<script>` tag.
- `_resolveAtRefs(text)` — extracts `@path` tokens, reads each file, returns `{ displayText, contextBlocks[] }`.
- `newChat()`, `clearHistory()`, `onConfigChange()` — called by commands registered in `extension.js`.

`_streamMsgId` tracks the ID of the currently-streaming assistant message. Updated by `onMessageStart` callback from agentRunner (not by the provider itself).

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
| `updateToolPermission` | `{ tool, level }` | Permission changed in settings panel |
| `updateSetting` | `{ key, value }` | Generic setting update |
| `openSettings` | — | Open VS Code settings UI |

### Extension Host → Webview

| `type` | Payload | Description |
|--------|---------|-------------|
| `init` | `{ sessions, session, mode, endpoints, activeEndpoint, model, streaming, enterToSend, verboseLogging, maxIterations, toolPermissions, toolDefs }` | Full initial state |
| `configUpdate` | subset of init fields | Config changed externally |
| `verboseState` | `{ verbose }` | Verbose toggle changed via command |
| `newChat` | — | Reset chat area |
| `userMessage` | `{ id, text, contextFiles[] }` | Display a user message |
| `assistantStart` | `{ id }` | Create a new (empty) assistant message element |
| `token` | `{ id, text }` | Append a streaming token to message `id` |
| `streamEnd` | `{ id }` | Finalize the streaming message `id` |
| `toolStart` | `{ msgId, call: { msgId, id, name, args } }` | Show a tool call (running state) |
| `toolEnd` | `{ msgId, call: { msgId, id, name, args, result } }` | Update tool call with result |
| `status` | `{ text }` | Update status bar text |
| `done` | — | Agent run complete, re-enable input |
| `error` | `{ text }` | Show an error message, re-enable input |
| `sessions` | `{ sessions[] }` | Updated session list |
| `loadSession` | `{ session }` | Load and render a session's messages |
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
  endpoints[], activeEndpoint, models[], currentModel,
  atQuery, atCursorStart, atDropdownItems[], atSelectedIdx,
  enterToSend   // bool: true = Enter sends; false = Shift+Enter sends
}
```

**Message display format (internal to webview):**
```js
// User message
{ id, role: 'user', raw: string, contextFiles: string[] }

// Assistant message
{ id, role: 'assistant', raw: string, toolCalls: ToolCall[], pending: bool }

// Error display
{ id, role: 'error', raw: string }
```

`raw` is always the unrendered source text. Markdown/plain rendering is applied at display time so the toggle can re-render without data loss.

**Tool call display format:**
```js
{ id, name, args, result, done: bool }
```

**Markdown rendering priority:**
1. `window.marked` (if `marked.min.js` was loaded) — full GFM rendering
2. `builtinMd()` — handles code blocks, inline code, headers, bold/italic, lists, links, blockquotes, HR

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
Drop `highlight.min.js` and a theme CSS file into `media/`. In `chat.js`, after rendering markdown, call `hljs.highlightAll()` on the new content. No other changes needed.

### More Tools
Ideas for additional tools:
- `get_open_editors` — list currently open tabs
- `get_symbols` — use `vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', uri)` to get outline
- `go_to_definition` — resolve a symbol's definition location
- `apply_edit` — use `vscode.workspace.applyEdit` for surgical edits (rather than full file overwrites)
- `get_git_diff` — shell out to `git diff` via `child_process`
- `create_file` — alias for `write_file` that errors if file already exists (safety)
- `delete_file` — `vscode.workspace.fs.delete()`

### Settings UI Polish
- Endpoint add/edit/delete directly from the settings panel (currently requires editing settings.json)
- Per-session system prompt override
- Token usage display (if the API returns `usage` in the response)

### Keyboard Shortcuts
- Command palette already exposes `newChat`, `toggleVerbose`, `showLogs`, `clearHistory`
- Could add keybindings in `package.json` under `contributes.keybindings`

---

## Key Constraints

- **Zero external dependencies.** No npm, no CDN, no `require()` of packages not bundled with Node.js or VS Code itself. Built-in modules (fs, path, crypto) are fine. VS Code API is fine.
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
| `vscode.window.showInformationMessage` | Tool permission modals |
| `vscode.workspace.getConfiguration` | Reading/writing settings |
| `vscode.workspace.findFiles` | @ autocomplete and search_files tool |
| `vscode.workspace.onDidChangeConfiguration` | Config change listener |
| `vscode.languages.getDiagnostics` | get_diagnostics tool |
| `vscode.window.terminals`, `createTerminal` | run_terminal tool (display only) |
| `child_process.exec` (Node.js built-in) | run_terminal output capture |
| `ExtensionContext.globalState` | Session history persistence |
| `ExtensionContext.extensionUri` | Resolving asset paths for webview |
| `vscode.Uri.joinPath`, `webview.asWebviewUri` | Converting local file paths to webview-accessible URIs |
| `vscode.commands.executeCommand` | Opening VS Code settings UI |
| `vscode.workspace.asRelativePath` | Making paths relative for display |
