# Standalone Agent — VSCode Extension

A self-contained, autonomous agentic coding assistant for VS Code. Designed specifically for on-site instant deployment and editing in **air-gapped environments with no internet access and no npm**. All code is plain JavaScript files — no build step, no bundler, no CDN.

Obviously this project was 100% writen by an LLM

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

### Optional: Better Markdown Rendering

Drop [`marked.min.js`](https://github.com/markedjs/marked/releases) into the `media/` folder. The extension detects it at startup and uses it instead of the built-in fallback renderer. Single file, MIT license, no sub-dependencies.

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
Read-only analysis mode. The agent can call `read_file`, `list_directory`, `search_files`, and `get_diagnostics` but **cannot write files or run commands**. Produces a numbered step-by-step plan and stops. Approve the plan manually before switching to Agent mode to execute it.

### Agent
Full autonomous loop. The agent can call all tools and will keep iterating (up to `maxIterations`) until the task is complete or it has nothing more to do. Each tool call is shown inline in the chat with collapsible args/result.

---

## Tools

| Tool | Description | Default Permission |
|------|-------------|--------------------|
| `read_file` | Read a file's contents | allow |
| `list_directory` | List directory entries | allow |
| `search_files` | Regex search across workspace files | allow |
| `get_diagnostics` | Get VS Code errors/warnings | allow |
| `write_file` | Write or overwrite a file | ask |
| `run_terminal` | Run a command and capture its output | ask |

**`run_terminal` output capture:** The tool captures everything written to the terminal for `timeout_ms` milliseconds (default 10 seconds) using VSCode's `onDidWriteTerminalData` API, then returns the stripped output to the model. Increase `timeout_ms` for slow commands:

```
run_terminal({ command: "npm install", timeout_ms: 30000 })
```

Output includes the shell prompt and echoed command — the model ignores those and reads the actual result. ANSI escape sequences (colors, cursor codes) are stripped automatically.

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

**Background notification:** If the chat panel is not visible and an approval card is waiting, a non-modal toast notification appears after 3 seconds reading *"Standalone Agent: approve 'toolName' in chat"* with a **Focus Chat** button that brings the panel into view. The notification only appears if you haven't already responded via the card.

---

## @ File References

Type `@` in the input to trigger file autocomplete. As you type `@src/foo`, a dropdown appears with matching workspace files. Select with arrow keys + Enter/Tab or click. The selected file path is inserted as `@path/to/file`.

When you send, the extension reads the file contents and injects them into the API message as `<file path="...">content</file>` blocks. The display message shows only the original text with a "📎 filename" indicator.

---

## Settings Reference

Servers and endpoints can be managed directly in the **⚙ Settings panel** — click ⚙ in the toolbar, then use the Servers and Endpoints sections to add, edit, or delete entries without touching JSON. All other settings below are also editable there or via VS Code settings.

All settings are under the `standaloneAgent` namespace in VS Code settings.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `servers` | array | see below | Physical server instances. Each: `{ name, url, apiKey? }` |
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
    "url": "http://localhost:11434/v1",
    "apiKey": ""
  }
]
```

| Field | Required | Description |
|-------|----------|-------------|
| `name` | yes | Unique display name — referenced by endpoints' `server` field |
| `url` | yes | Base URL of the server (e.g. `http://192.168.1.50:8080/v1`) |
| `apiKey` | no | Bearer token / API key. Leave empty if not required. |

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

Auth: set `apiKey` on the server to the `x-access-tokens` value obtained from `/user/get-token-with-api-key`.

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

- **Terminal output capture is time-boxed.** `run_terminal` waits `timeout_ms` ms (default 10 s) for output. Commands that produce output after the window closes will be missed. The output includes the echoed command and shell prompt, which the model is instructed to ignore.
- **No bundled syntax highlighting.** Code blocks in markdown responses are displayed without language-specific syntax colors unless you add a highlighting library to `media/`.
- **Tool call format requires function calling support.** The model must support OpenAI-compatible `tools` / `tool_calls`. Use **TC:TXT** mode (prompt injection) as a fallback for models that only output plain text.
- **Streaming partial JSON.** Some APIs send tool call arguments split across multiple stream chunks. The client reassembles these, but an unusual chunk boundary could cause a parse failure. Disable streaming as a workaround.
- **Multiple parallel tool calls.** When the agent emits several tool calls in one response, approval cards and execution all run in parallel. The agent system prompt encourages this pattern for efficiency.
- **Ask Sage `usage` field names are not in the public spec.** Token/cost sub-fields inside the `usage` object are discovered empirically. Enable verbose logging and inspect the RESPONSE log after your first query to confirm the field names your deployment returns.
- **No subagent / parallel processing** (planned).
- **No vector search / embeddings** (planned).
