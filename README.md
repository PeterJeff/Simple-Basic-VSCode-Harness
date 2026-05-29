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
┌────────────────────────────────────────────┐
│ [Mode▼] [Endpoint▼] [Model▼] [⟳] [☰] [⚙] │  ← Toolbar
├────────────────────────────────────────────┤
│                                            │
│  messages…                                 │  ← Chat area
│                                            │
├────────────────────────────────────────────┤
│ Agent (step 2/20)…          [■ Stop]       │  ← Status bar
├────────────────────────────────────────────┤
│ ┌──────────────────────────────────────┐   │
│ │ Type a message… (@ for file ref)   │ │  ← Input
│ └──────────────────────────────────────┘   │
│ [MD] [Stream] ──────────────────── [➤]    │  ← Toggles + send
└────────────────────────────────────────────┘
```

**Toolbar icons:**
| Icon | Action |
|------|--------|
| ⟳ | Refresh model list from API |
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
| `run_terminal` | Send a command to the integrated terminal | ask |

Tool output is not currently captured from the terminal — it only sends the command.

**Permission levels:**
- `allow` — runs silently
- `ask` — shows a confirmation dialog with "Allow Once / Allow Always / Deny"
- `deny` — always blocked, returns an error to the model

Change permissions in the Settings panel (⚙) or in VS Code settings under `standaloneAgent.toolPermissions`.

---

## @ File References

Type `@` in the input to trigger file autocomplete. As you type `@src/foo`, a dropdown appears with matching workspace files. Select with arrow keys + Enter/Tab or click. The selected file path is inserted as `@path/to/file`.

When you send, the extension reads the file contents and injects them into the API message as `<file path="...">content</file>` blocks. The display message shows only the original text with a "📎 filename" indicator.

---

## Settings Reference

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
| Anthropic sub-API | Use `adapter: "openai"` with `pathOverrides` (Claude-format assumed compatible) |

The `ask-sage` native adapter does not support streaming. No `adapterOptions` currently.

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

- **Terminal output is not captured.** `run_terminal` sends a command to the VS Code integrated terminal but cannot read stdout/stderr. The agent is informed of this. Use `read_file` on any output files instead.
- **No bundled syntax highlighting.** Code blocks in markdown responses are displayed without language-specific syntax colors unless you add a highlighting library to `media/`.
- **Tool call format requires function calling support.** The model must support OpenAI-compatible `tools` / `tool_calls` in the response. Models that only support plain text will not be able to use tools (they will still work in Chat mode).
- **Streaming partial JSON.** Some APIs send tool call arguments split across multiple stream chunks. The client reassembles these, but a very unusual chunk boundary could cause a parse failure. Disable streaming as a workaround.
- **Ask Sage native adapter is provisional.** The `ask-sage` adapter contains placeholder logic pending on-site API verification. Use the OpenAI sub-API path with `adapter: "openai"` and `pathOverrides` for a confirmed working connection.
- **No subagent / parallel processing** (planned — see ARCHITECTURE.md).
- **No vector search / embeddings** (planned).
