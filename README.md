# Nova Agent for VS Code

`Nova Agent for VS Code` is an unofficial local VS Code extension scaffold inspired by the official OpenAI Codex workflow. It is a replica-style project for learning and experimentation, not an official OpenAI product. It provides a persistent sidebar chat, OpenAI-compatible model access, streamed answers, smarter workspace-aware prompts, editor insertion actions, code-block application, multi-file workspace edits, terminal command handoff, and a local repo tool loop.

## Current capabilities

- Dedicated assistant activity bar entry with a chat sidebar
- Secure API key storage through VS Code secret storage
- OpenAI-compatible `POST /chat/completions` requests
- Streaming response rendering when the backend supports SSE
- Persistent local chat history via workspace state
- Optional prompt context from the current selection, with size limits
- Optional prompt context from relevant workspace files instead of a raw full file list dump
- Local tool loop for `list_files`, `search_code`, `read_file`, `write_file`, `replace_in_file`, and `apply_patch`
- Visible tool activity in the sidebar while the assistant is inspecting the repo
- `Ask About Selection` command
- `Insert Last Response` command
- `Insert Last Code Block` command
- `Apply Last Code Block` command
- `Apply File Edits` command
- `Run Last Shell Block` command
- `Run Last Shell Block With Capture` command

## Naming note

This project is intentionally documented as an unofficial Codex-inspired replica. If you plan to distribute it, you should also rename the extension display name, activity bar title, command labels, and in-product strings so it does not look like an official OpenAI Codex release.

## Settings keys

Preferred settings keys now use the `novaAgent.*` namespace:

- `novaAgent.baseUrl`
- `novaAgent.model`
- `novaAgent.systemPrompt`
- `novaAgent.temperature`
- `novaAgent.includeSelectionByDefault`
- `novaAgent.includeWorkspaceContextByDefault`
- `novaAgent.maxWorkspaceFiles`
- `novaAgent.maxContextFiles`
- `novaAgent.maxFileContextChars`

For backward compatibility, the extension still reads legacy `codexAssistant.*` values if you already had them in your VS Code settings.

## Local tool loop

The assistant can ask the extension to inspect or edit the repo before answering by returning a fenced `codex-tool` block.

Supported tools:

- `list_files`
- `search_code`
- `read_file`
- `write_file`
- `replace_in_file`
- `apply_patch`

Example shapes:

```json
{"tool":"list_files","glob":"**/*.ts","limit":50}
```

```json
{"tool":"search_code","query":"activate(","glob":"src/**/*","limit":20}
```

```json
{"tool":"read_file","path":"src/extension.js","maxChars":6000}
```

```json
{"tool":"write_file","path":"src/example.ts","content":"export const value = 1;\n"}
```

```json
{"tool":"replace_in_file","path":"src/example.ts","find":"value = 1","replace":"value = 2","all":false}
```

```json
{"tool":"apply_patch","diff":"--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1 +1 @@\n-export const value = 1;\n+export const value = 2;"}
```

`apply_patch` is the preferred tool for precise multi-file edits.