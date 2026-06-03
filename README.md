# Standalone Agent — VSCode Extension

A self-contained, autonomous agentic coding assistant for VS Code. Designed specifically for on-site instant deployment and editing in **air-gapped environments with no internet access and no npm**. All code is plain JavaScript files — no build step, no bundler, no CDN.

Obviously this project was 100% written by an LLM

---

## Requirements

- VS Code 1.80 or later (Node.js 18+ comes bundled inside vscode — required for native `fetch`)
- An OpenAI-compatible LLM API reachable from the machine (e.g. Ollama, vLLM, LM Studio, something running on localhost or a custom server)

---

## Installation

1. Copy the entire project folder to your machine.
2. Open the folder in VS Code.
3. Press **F5** to launch the Extension Development Host (for dev/testing), **or** package it as a `.vsix` if you have `vsce` available.
4. The **Standalone Agent** icon appears in the activity bar.

You can also use CTRL + SHIFT + P and use `Developer: Install Extension from location`

---

## Quick Start

1. Open the extension sidebar (chat bubble icon in the activity bar).
2. Set your **endpoint** and **model** in the toolbar dropdowns. Click ⟳ to refresh the model list from the API.
3. Type a message and press Enter (or Shift+Enter — see settings).
4. Switch modes depending on what you need:
   - **Chat** — plain Q&A, no tool access
   - **Plan** — reads the codebase and produces a numbered action plan (no file writes)
   - **Agent** — full autonomous loop with file read/write, search, diagnostics, terminal

---

## UI Reference

```
┌──────────────────────────────────────────────────┐
│ [Mode▼] [Endpoint▼] [Model▼] [⟳] [⬡] [☰] [⚙]  │  ← Toolbar
├──────────────────────────────────────────────────┤
│ X,XXX / Y,YYY tokens this month             [✕]  │  ← Usage bar (Ask Sage)
├──────────────────────────────────────────────────┤
│                                                  │
│  messages…                                       │  ← Chat area
│                  1,234 tokens  ← usage badge     │
├──────────────────────────────────────────────────┤
│ Agent (step 2/20)…              [■ Stop]         │  ← Status bar
├──────────────────────────────────────────────────┤
│ ┌────────────────────────────────────────────┐   │
│ │ Type a message… (@ for file ref)         │ │  ← Input
│ └────────────────────────────────────────────┘   │
│ [MD] [Stream] ────────────────────────── [➤]    │  ← Toggles + send
└──────────────────────────────────────────────────┘
```

**Toolbar icons:**
| Icon | Action |
|------|--------|
| ⟳ | Refresh model list from API |
| ⬡ | Manually trigger a monthly token usage refresh |
| ☰ | Open chat history panel |
| ⚙ | Open inline settings panel |

**Title bar icons (top of sidebar):**
| Icon | Action |
|------|--------|
| + | New chat |
| output | Show log output channel |

**Input toggles:**
| Toggle | Effect |
|--------|--------|
| MD | Toggle markdown rendering. Re-renders entire conversation. |
| Stream | Toggle streaming SSE responses. |
| TC:API / TC:TXT | Tool call mode — API-native function calling vs. text-injection prompt (Ask Sage native adapter only). |

**Per-message actions:**
| Action | How |
|--------|-----|
| Copy message | Copy button on each message bubble |
| Copy code block | Copy button in the top-right of every code block |
| Edit / Fork | Edit button on user messages — restores the message to the input box and creates a branching conversation from that point |

---

## Modes

### Chat
Single-pass Q&A. No tools. Fastest, lowest token cost. Good for questions, explanations, code review.

### Plan
Read-only analysis mode. The agent can call `read_file`, `list_directory`, `search_files`, `get_diagnostics`, `get_git_diff`, and `get_symbols` but **cannot write files or run commands**. Produces a numbered step-by-step plan and stops. Approve the plan manually before switching to Agent mode to execute it.

### Agent
Full autonomous loop. The agent can call all tools and will keep iterating (up to `maxIterations`) until the task is complete or it has nothing more to do. Each tool call is shown inline in the chat with collapsible args/result.

While a run is active the VS Code status bar shows the current step (e.g. *"Standalone Agent: Running tool: edit_file…"*) and a **Cancel** button — the agent stays visible even when the chat panel is collapsed.

---

## Tools

| Tool | Description | Default Permission |
|------|-------------|--------------------|
| `read_file` | Read a file's contents (prefers open editor buffer — includes unsaved changes) | allow |
| `list_directory` | List directory entries | allow |
| `search_files` | Regex search across workspace files (searches open buffers too) | allow |
| `get_diagnostics` | Get VS Code errors/warnings | allow |
| `get_git_diff` | Show uncommitted changes via VS Code git extension or `git diff` | allow |
| `get_symbols` | File symbol outline via VS Code language server | allow |
| `edit_file` | Replace an exact string in a file — uses WorkspaceEdit, preserves undo history | ask |
| `write_file` | Write or overwrite a file — uses WorkspaceEdit for open files, preserves undo history | ask |
| `run_terminal` | Run a command and capture its output | ask |

**`edit_file`** uses `vscode.workspace.openTextDocument` to get the in-memory document (including unsaved edits), then applies the change via `vscode.WorkspaceEdit`. This means the edit appears as a normal undo-able keystroke in VS Code. The file is saved automatically after the edit. The `⊕ Diff` button on a completed edit/write tool card opens a native side-by-side git diff view.

**`write_file`** behaves the same way for files that are already open in an editor. For new or non-open files it uses `vscode.workspace.fs.writeFile`, which works across remote sessions, WSL, and Dev Containers.

**`run_terminal`** uses VS Code's Shell Integration API (VS Code 1.93+) when available — the command runs exactly once inside the integrated terminal and output is captured natively. On older VS Code versions it falls back to `child_process.exec` for output capture (terminal is shown but the command is not echoed into it to avoid running it twice).

**Permission levels:**
- `allow` — runs silently with no prompt
- `ask` — shows an **inline approval card** in the chat (see below)
- `deny` — always blocked, returns an error to the model

Change permissions in the Settings panel (⚙) or in VS Code settings under `standaloneAgent.toolPermissions`.

### Tool Approval Cards

When a tool has `ask` permission, an approval card is rendered inline in the chat — no pop-up dialog. Each card shows:

- The tool name and a one-line summary (e.g. the file path, search pattern, or command)
- **▸ expand** — shows the full parsed arguments as formatted JSON
- **⧉ raw** — opens the exact JSON the model submitted in a VS Code editor panel beside the chat
- **Allow Once** — approve this single call
- **Allow Always** — approve and update the tool's permission to `allow` permanently
- **Deny** — reject the call; the model receives an error result and may try another approach

If the agent issues multiple tool calls in a single response (e.g. reading several files at once), each call gets its own approval card simultaneously. All cards can be acted on independently — approved calls execute in parallel as soon as their card is resolved.

**Background notification:** If the chat panel is not visible and an approval card is waiting, a non-modal toast notification appears after 3 seconds reading *"Standalone Agent: approve 'toolName' in chat"* with a **Focus Chat** button that brings the panel into view.

---

## @ File References

Type `@` in the input to trigger file autocomplete. As you type `@src/foo`, a dropdown appears with matching workspace files. Select with arrow keys + Enter/Tab or click. The selected file path is inserted as `@path/to/file`.

When you send, the extension reads the file contents (preferring the open editor buffer, so unsaved changes are included) and injects them into the API message as `<file path="...">content</file>` blocks. The display message shows only the original text with a "📎 filename" indicator.

---

## Markdown Rendering

Markdown is rendered using VS Code's built-in `markdown.api.render` command — the same engine that powers VS Code's own Markdown preview. This provides zero-dependency, XSS-safe rendering with full GFM support. After each streaming response completes, the extension re-renders the full message server-side and pushes the final HTML to the webview. During streaming, a lightweight client-side renderer provides live preview.

Toggle the **MD** button in the input row to switch between rendered and raw text views.

---

## Settings Reference

Servers and endpoints can be managed directly in the **⚙ Settings panel** — click ⚙ in the toolbar, then use the Servers and Endpoints sections to add, edit, or delete entries without touching JSON. All other settings below are also editable there or via VS Code settings.

All settings are under the `standaloneAgent` namespace in VS Code settings.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `servers` | array | see below | Physical server instances. Each: `{ name, url }` — API keys are stored separately in secure storage |
| `endpoints` | array | see below | Logical endpoints — each combines a server with an adapter and optional overrides |
| `activeEndpoint` | string | `"Local OpenAI"` | Name of the active endpoint (must match a name in `endpoints`) |
| `model` | string | `""` | Model identifier (set via dropdown or settings) |
| `streaming` | boolean | `true` | Enable SSE streaming responses |
| `enterToSend` | boolean | `true` | `true` = Enter sends, Shift+Enter = newline. `false` = Shift+Enter sends, Enter = newline |
| `winCertStore` | boolean | `true` | Merge Windows system CA certificates into the HTTPS trust bundle (see TLS section) |
| `verboseLogging` | boolean | `false` | Log full request/response payloads to the output channel |
| `maxIterations` | number | `20` | Max agent loop iterations before auto-stop |
| `systemPrompt` | string | `""` | Custom system prompt override (replaces built-in mode prompts when set) |
| `toolPermissions` | object | see Tools | Per-tool permission: `"allow"`, `"ask"`, or `"deny"` |

### Server Configuration

`standaloneAgent.servers` defines physical server instances. These are referenced by endpoints.

```json
[
  {
    "name": "Local",
    "url": "http://localhost:11434/v1"
  }
]
```

| Field | Required | Description |
|-------|----------|-------------|
| `name` | yes | Unique display name — referenced by endpoints' `server` field |
| `url` | yes | Base URL of the server (e.g. `http://192.168.1.50:8080/v1`) |

**API keys** are stored in VS Code's secure credential store (Windows Credential Manager / macOS Keychain) — **not** in `settings.json`. Enter the key in the server edit form (⚙ → Servers → edit). Existing users: any `apiKey` value found in `settings.json` on first load is automatically migrated to secure storage and removed from the file.

### Endpoint Configuration

`standaloneAgent.endpoints` defines logical endpoints — each binds a server to a protocol adapter and optional per-endpoint overrides.

```json
[
  {
    "name": "Local OpenAI",
    "server": "Local",
    "adapter": "openai"
  }
]
```

| Field | Required | Description |
|-------|----------|-------------|
| `name` | yes | Unique display name shown in the endpoint dropdown |
| `server` | yes | Must match a `name` in `standaloneAgent.servers` |
| `adapter` | yes | Protocol adapter: `"openai"`, `"gemini"`, `"gemini-jank"`, or `"ask-sage"` |
| `streaming` | no | Per-endpoint streaming override. Omit to use the global `streaming` setting. |
| `model` | no | Per-endpoint model override. Omit to use the sidebar model selector. |
| `pathOverrides` | no | Override URL paths for non-standard deployments (see below) |
| `adapterOptions` | no | Adapter-specific tuning options (see Adapters section) |

**`pathOverrides`** — useful when an API mounts its routes at non-standard paths:
```json
{
  "chat":   "/openai/v1/chat/completions",
  "models": "/openai/v1/models"
}
```

---

## Adapters

### `openai` — OpenAI-Compatible API

Calls `/v1/chat/completions` and `/v1/models`. Works with Ollama, vLLM, LM Studio, and any OpenAI-compatible server.

No `adapterOptions`. Use `pathOverrides` if the server mounts at non-standard paths.

### `gemini` — Google Gemini API

Calls Google's native Gemini API format (not OpenAI-compatible).

`adapterOptions`:
| Option | Default | Description |
|--------|---------|-------------|
| `apiVersion` | `"v1"` | API version path segment. Use `"v1beta"` for preview features. |
| `useQueryKey` | `false` | Pass the API key as `?key=` query param instead of the `x-goog-api-key` header. |
| `cachedContent` | — | Pre-created `cachedContents` resource name (e.g. `cachedContents/abc123`). Reduces token costs for large fixed context. |

### `gemini-jank` — Internal Gemini Proxy

Works around on-site Gemini proxy quirks: collapses the full conversation into a single XML-formatted user message, handles server-side session state, and applies a minimum word count if the proxy rejects short requests.

`adapterOptions`:
| Option | Default | Description |
|--------|---------|-------------|
| `sessionField` | `"session_id"` | Response/request field for the session ID |
| `modelField` | `"model"` | Request field for the model name |
| `minWordCount` | `0` (disabled) | Minimum word count for collapsed messages |
| `systemTag` | `"SystemPrompt"` | XML tag wrapping the system prompt |
| `historyTag` | `"ConversationHistory"` | XML tag wrapping conversation history |
| `currentTag` | `"CurrentRequest"` | XML tag wrapping the current request |

### `ask-sage` — Ask Sage

Ask Sage exposes three API surfaces on the same server:

| Surface | How to connect |
|---------|----------------|
| OpenAI sub-API | Use `adapter: "openai"` with `pathOverrides` pointing to `/openai/v1/...` |
| Native Ask Sage API | Use `adapter: "ask-sage"` |
| Anthropic sub-API | Use `adapter: "openai"` with `pathOverrides` |

The `ask-sage` native adapter uses the `/server/query` endpoint. Streaming is not supported (the full response is returned in one call). Multi-turn conversation history is sent as a `[{user, message}]` array; single-turn messages are sent as a plain string.

Auth: set the API key for the server in the Settings panel (⚙ → Servers → edit). It is stored securely in the OS keychain and maps to the `x-access-tokens` header. Obtain the token value from `/user/get-token-with-api-key`.

`adapterOptions`:
| Option | Type | Description |
|--------|------|-------------|
| `persona` | number | Persona ID. Omit to use server default. |
| `dataset` | string[] | Dataset names to include in the query (RAG). |
| `live` | 0 \| 1 | `1` = include live web search results. |
| `limitReferences` | number | Maximum RAG references to include. Default: 10. |
| `system_prompt` | string | System prompt override. Takes precedence over the global `systemPrompt` setting. |
| `reasoningEffort` | `"low"` \| `"medium"` \| `"high"` | Reasoning effort for o1/o3 models. |

**Token usage:** After each response, a dim usage badge appears beneath the assistant message showing token counts (total, ↑ input, ↓ output) and cost figures when the API returns them (e.g. `tc:1,234  in $0.000120  out $0.000480  = $0.000600`).

**Monthly usage bar:** For Ask Sage endpoints the monthly usage bar appears automatically when the extension loads and refreshes after every completed agent run. Click **⬡** to force a manual refresh. The bar also updates whenever you switch to an Ask Sage endpoint. Dismiss it with **✕**; it reappears on the next response.

**Tool call mode (TC:API / TC:TXT):** Controls how tool/function calls are sent:
- **TC:API** — sends tools as native `tools` + `tool_calls` fields in the API request. Requires the model to support function calling.
- **TC:TXT** — injects a tool schema into the system prompt and parses JSON tool calls from the response text. Use this if the model does not support native function calling.

---

## TLS / Self-Signed Certificates

When connecting to on-site servers over HTTPS with self-signed certificates, the extension automatically reads the Windows system certificate store (Root and CA stores) and merges those certificates into Node's trust bundle. No manual cert configuration required — if your machine trusts the server's cert, the extension will too.

This is enabled by default and runs once per session (the result is cached). Set `standaloneAgent.winCertStore` to `false` if your endpoints use publicly-trusted certificates and you want to skip the startup PowerShell cert-read. Changing the setting takes effect immediately without restarting VS Code.

This only applies on Windows and falls back silently on other platforms.

---

## Chat History

The extension persists up to 50 chat sessions using VS Code's `ExtensionContext.globalState`. Sessions are stored locally in your VS Code user profile.

- Click ☰ to open the history panel
- Click a session to load it
- Click ✕ next to a session to delete it
- "New Chat" in the title bar saves the current session and starts fresh
- "Clear All History" (command palette) deletes all saved sessions

---

## Output / Logging

Open the **Standalone Agent** output channel (View → Output → "Standalone Agent") or click the output icon in the sidebar title bar.

Verbose logging (toggle via command palette: "Standalone Agent: Toggle Verbose Logging") writes full API request and response payloads to the channel.

---

## Limitations / Known Issues

- **No bundled syntax highlighting.** Code blocks in markdown responses are displayed without language-specific syntax colors. Drop `highlight.min.js` and a theme CSS into `media/` and call `hljs.highlightAll()` after rendering for full highlighting.
- **Tool call format requires function calling support.** The model must support OpenAI-compatible `tools` / `tool_calls`. Use **TC:TXT** mode (prompt injection) as a fallback for models that only output plain text.
- **Streaming partial JSON.** Some APIs send tool call arguments split across multiple stream chunks. The client reassembles these, but an unusual chunk boundary could cause a parse failure. Disable streaming as a workaround.
- **Multiple parallel tool calls.** When the agent emits several tool calls in one response, approval cards and execution all run in parallel. The agent system prompt encourages this pattern for efficiency.
- **Shell Integration for terminal capture** requires VS Code 1.93+ and a shell that supports shell integration (bash, zsh, pwsh). On older versions or unsupported shells, the fallback `child_process.exec` captures output invisibly — the terminal panel is shown but does not echo the command.
- **Ask Sage `usage` field names are not in the public spec.** Token/cost sub-fields inside the `usage` object are discovered empirically. Enable verbose logging and inspect the RESPONSE log after your first query to confirm the field names your deployment returns.
- **No subagent / parallel processing** (planned).
- **No vector search / embeddings** (planned).
