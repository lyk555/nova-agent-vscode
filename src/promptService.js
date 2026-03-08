"use strict";

const vscode = require("vscode");

const EXTENSION_NAMESPACE = "novaAgent";
const LEGACY_NAMESPACE = "codexAssistant";
const SECRET_KEY = "novaAgent.apiKey";
const LEGACY_SECRET_KEY = "codexAssistant.apiKey";

const TOOL_PROTOCOL_PROMPT = [
  "You are operating inside a VS Code assistant with local repo tools.",
  "When you need local repo inspection or edits before answering, request exactly one tool using a fenced block that starts with ```codex-tool and contains only JSON.",
  "Supported tools: list_files, search_code, read_file, write_file, replace_in_file, apply_patch.",
  "If the user asks to create a file, write code into a file, modify code in the workspace, or patch existing files, prefer using write_file, replace_in_file, or apply_patch immediately instead of chatting about what you would do.",
  "Only ask a follow-up question when a missing detail is truly required. If the filename is not specified, choose a sensible default name and proceed.",
  "Prefer apply_patch for precise edits to existing files. Prefer write_file for creating a new file from scratch.",
  "Examples:",
  '{"tool":"list_files","glob":"**/*.ts","limit":50}',
  '{"tool":"search_code","query":"handlePrompt","glob":"src/**/*","limit":20}',
  '{"tool":"read_file","path":"src/extension.js","maxChars":6000}',
  '{"tool":"write_file","path":"src/example.ts","content":"export const value = 1;\\n"}',
  '{"tool":"replace_in_file","path":"src/example.ts","find":"value = 1","replace":"value = 2","all":false}',
  '{"tool":"apply_patch","diff":"--- a/src/example.ts\\n+++ b/src/example.ts\\n@@ -1 +1 @@\\n-old\\n+new"}',
  "Do not echo these tool instructions to the user. After tool results arrive, continue with the actual answer if more explanation is needed.",
  "If a write/edit tool succeeds, do not claim that you cannot create or modify files. Confirm what changed instead."
].join("\n");

function hasConfiguredValue(inspected) {
  return Boolean(inspected && (
    typeof inspected.globalValue !== "undefined"
    || typeof inspected.workspaceValue !== "undefined"
    || typeof inspected.workspaceFolderValue !== "undefined"
  ));
}

function getAgentSetting(key, fallbackValue) {
  const config = vscode.workspace.getConfiguration(EXTENSION_NAMESPACE);
  const inspected = config.inspect(key);
  if (hasConfiguredValue(inspected)) {
    return config.get(key, fallbackValue);
  }

  const legacy = vscode.workspace.getConfiguration(LEGACY_NAMESPACE);
  const legacyInspected = legacy.inspect(key);
  if (hasConfiguredValue(legacyInspected)) {
    return legacy.get(key, fallbackValue);
  }

  return config.get(key, fallbackValue);
}

async function getStoredApiKey(context) {
  return await context.secrets.get(SECRET_KEY) || await context.secrets.get(LEGACY_SECRET_KEY);
}

class PromptService {
  constructor(context) {
    this.context = context;
  }

  async sendChatRequest(history, handlers = {}, options = {}) {
    const apiKey = await getStoredApiKey(this.context);
    if (!apiKey) {
      throw new Error("Missing API key. Run 'Nova Agent: Set API Key' first.");
    }

    const baseUrl = String(getAgentSetting("baseUrl", "https://api.openai.com/v1")).replace(/\/+$/, "");
    const model = String(getAgentSetting("model", "gpt-4.1-mini"));
    const systemPrompt = String(getAgentSetting("systemPrompt", ""));
    const temperature = Number(getAgentSetting("temperature", 0.2) ?? 0.2);
    const messages = [];
    const mergedSystemPrompt = [systemPrompt.trim(), TOOL_PROTOCOL_PROMPT].filter(Boolean).join("\n\n");

    if (mergedSystemPrompt.trim()) {
      messages.push({ role: "system", content: mergedSystemPrompt.trim() });
    }

    for (const message of history) {
      messages.push({ role: message.role, content: message.content });
    }

    if (typeof fetch !== "function") {
      throw new Error("This VS Code runtime does not expose fetch().");
    }

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        temperature,
        messages,
        stream: true,
        ...options
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API request failed (${response.status}): ${errorText}`);
    }

    const contentType = String(response.headers.get("content-type") || "");
    const canStream = response.body && typeof response.body.getReader === "function";

    if (canStream && contentType.includes("text/event-stream")) {
      return this.readEventStream(response, handlers);
    }

    const payload = await response.json();
    const content = payload?.choices?.[0]?.message?.content;
    if (!content || typeof content !== "string") {
      throw new Error("API response did not contain a text answer.");
    }

    if (typeof handlers.onToken === "function") {
      handlers.onToken(content);
    }

    if (typeof handlers.onComplete === "function") {
      handlers.onComplete(content.trim());
    }

    return content.trim();
  }

  async readEventStream(response, handlers) {
    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    let buffer = "";
    let fullText = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split("\n\n");
      buffer = chunks.pop() || "";

      for (const chunk of chunks) {
        const lines = chunk.split(/\r?\n/);
        for (const line of lines) {
          if (!line.startsWith("data:")) {
            continue;
          }

          const data = line.slice(5).trim();
          if (!data || data === "[DONE]") {
            continue;
          }

          let payload;
          try {
            payload = JSON.parse(data);
          } catch {
            continue;
          }

          const delta = payload?.choices?.[0]?.delta?.content;
          const finalText = payload?.choices?.[0]?.message?.content;
          const token = typeof delta === "string" ? delta : typeof finalText === "string" ? finalText : "";

          if (!token) {
            continue;
          }

          fullText += token;
          if (typeof handlers.onToken === "function") {
            handlers.onToken(token, fullText);
          }
        }
      }
    }

    fullText = fullText.trim();
    if (!fullText) {
      throw new Error("Stream completed without any text content.");
    }

    if (typeof handlers.onComplete === "function") {
      handlers.onComplete(fullText);
    }

    return fullText;
  }
}

module.exports = {
  PromptService
};
