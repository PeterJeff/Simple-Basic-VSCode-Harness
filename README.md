# Standalone Agent — VSCode Extension

A self-contained, autonomous agentic coding assistant for VS Code. Designed specifically for **air-gapped environments with no internet access and no npm**. All code is plain JavaScript files — no build step, no bundler, no CDN.

---

## Requirements

- VS Code 1.80 or later (Node.js 18+ bundled — required for native `fetch`)
- An OpenAI-compatible LLM API reachable from the machine (e.g. Ollama, vLLM, LM Studio, or a custom server)
- No npm, no internet required

---

## Installation

1. Copy the entire project folder to your machine.
2. Open the folder in VS Code.
3. Press **F5** to launch the Extension Development Host (for dev/testing), **or** package it as a `.vsix` if you have `vsce` available.
4. The **Standalone Agent** icon appears in the activity bar.

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
┌─────────────────────────────────────────┐
│ [Mode▼] [Endpoint▼] [Model▼] [⟳] [☰] [⚙] │  ← Toolbar
├─────────────────────────────────────────┤
│                                         │
│  messages…                              │  ← Chat area
│                                         │
├─────────────────────────────────────────┤
│ Agent (step 2/20)…          [■ Stop]    │  ← Status bar
├─────────────────────────────────────────┤
│ ┌─────────────────────────────────────┐ │
│ │ Type a message… (@ for file ref)   │ │  ← Input
│ └─────────────────────────────────────┘ │
│ [MD] [Stream] ──────────────────── [➤] │  ← Toggles + send
└─────────────────────────────────────────┘
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
| `endpoints` | array | `[{name:"Local", url:"http://localhost:11434/v1"}]` | LLM API endpoints. Each: `{ name, url, apiKey?, type }` |
| `activeEndpoint` | string | `"Local"` | Name of the active endpoint |
| `model` | string | `""` | Model identifier (set via dropdown or settings) |
| `streaming` | boolean | `true` | Enable SSE streaming responses |
| `enterToSend` | boolean | `true` | `true` = Enter sends, Shift+Enter = newline. `false` = Shift+Enter sends, Enter = newline |
| `verboseLogging` | boolean | `false` | Log full request/response payloads to the output channel |
| `maxIterations` | number | `20` | Max agent loop iterations before auto-stop |
| `systemPrompt` | string | `""` | Custom system prompt override (replaces built-in mode prompts when set) |
| `toolPermissions` | object | see above | Per-tool permission: `"allow"`, `"ask"`, or `"deny"` |

### Endpoint Configuration

Each endpoint object:
```json
{
  "name": "My Server",
  "url": "http://192.168.1.50:8080/v1",
  "apiKey": "optional-key",
  "type": "openai"
}
```

`type` must always be `"openai"` (OpenAI-compatible API). The extension calls `/v1/chat/completions` for inference and `/v1/models` for model listing.

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
- **No subagent / parallel processing** (planned — see ARCHITECTURE.md).
- **No vector search / embeddings** (planned).
