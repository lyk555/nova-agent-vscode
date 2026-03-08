"use strict";

const crypto = require("crypto");
const path = require("path");
const { spawn } = require("child_process");
const vscode = require("vscode");
const { PromptService } = require("./promptService");
const { applyUnifiedDiff } = require("./patchTool");
const {
  buildWorkspaceContext,
  extractCodeBlocks,
  extractLastCodeBlock,
  extractLastRunnableBlock,
  extractFileEdits,
  resolveEditUri,
  truncateText
} = require("./workspaceContext");

const CHAT_STATE_KEY = "codexAssistant.chatState";
const HISTORY_STATE_KEY = "codexAssistant.chatHistory";
const LAST_RESPONSE_KEY = "codexAssistant.lastResponse";
const TERMINAL_NAME = "Nova Agent";
const OUTPUT_CHANNEL_NAME = "Nova Agent";
const MAX_TOOL_STEPS = 4;
const MUTATING_TOOLS = new Set(["write_file", "replace_in_file", "apply_patch"]);
const ATTACHED_FILES_STATE_KEY = "codexAssistant.attachedFiles";
const EXTENSION_NAMESPACE = "novaAgent";
const LEGACY_NAMESPACE = "codexAssistant";
const SECRET_KEY = "novaAgent.apiKey";
const LEGACY_SECRET_KEY = "codexAssistant.apiKey";

function getAgentConfiguration() {
  return vscode.workspace.getConfiguration(EXTENSION_NAMESPACE);
}

function getLegacyConfiguration() {
  return vscode.workspace.getConfiguration(LEGACY_NAMESPACE);
}

function hasConfiguredValue(inspected) {
  return Boolean(inspected && (
    typeof inspected.globalValue !== "undefined"
    || typeof inspected.workspaceValue !== "undefined"
    || typeof inspected.workspaceFolderValue !== "undefined"
  ));
}

function getAgentSetting(key, fallbackValue) {
  const config = getAgentConfiguration();
  const inspected = config.inspect(key);
  if (hasConfiguredValue(inspected)) {
    return config.get(key, fallbackValue);
  }

  const legacy = getLegacyConfiguration();
  const legacyInspected = legacy.inspect(key);
  if (hasConfiguredValue(legacyInspected)) {
    return legacy.get(key, fallbackValue);
  }

  return config.get(key, fallbackValue);
}

async function updateAgentSetting(key, value, target = vscode.ConfigurationTarget.Global) {
  await getAgentConfiguration().update(key, value, target);
}

async function getStoredApiKey(context) {
  return await context.secrets.get(SECRET_KEY) || await context.secrets.get(LEGACY_SECRET_KEY);
}

async function storeApiKey(context, value) {
  await context.secrets.store(SECRET_KEY, String(value || "").trim());
}

function activate(context) {
  const promptService = new PromptService(context);
  const outputChannel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
  context.subscriptions.push(outputChannel);
  const provider = new NovaSidebarProvider(context, promptService, outputChannel);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("codexAssistant.chatView", provider, {
      webviewOptions: {
        retainContextWhenHidden: true
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexAssistant.focusChat", async () => {
      await vscode.commands.executeCommand("workbench.view.extension.codexAssistant");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexAssistant.setApiKey", async () => {
      const value = await vscode.window.showInputBox({
        title: "Nova Agent API Key",
        prompt: "Enter the API key for your OpenAI-compatible endpoint.",
        password: true,
        ignoreFocusOut: true
      });

      if (typeof value !== "string") {
        return;
      }

      await storeApiKey(context, value);
      vscode.window.showInformationMessage("Nova Agent API key saved.");
      await provider.notifySecretsChanged();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexAssistant.configureSettings", async () => {
      await configureSettings(provider);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexAssistant.insertLastResponse", async () => {
      const lastResponse = context.workspaceState.get(LAST_RESPONSE_KEY, "");
      await insertIntoEditor(lastResponse, "No assistant response is available yet.");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexAssistant.insertLastCodeBlock", async () => {
      const lastResponse = context.workspaceState.get(LAST_RESPONSE_KEY, "");
      const codeBlock = extractLastCodeBlock(lastResponse);
      await insertIntoEditor(codeBlock, "The last assistant response did not contain a code block.");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexAssistant.createFileFromLastCodeBlock", async () => {
      const lastResponse = context.workspaceState.get(LAST_RESPONSE_KEY, "");
      await createFileFromLastCodeBlock(lastResponse);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexAssistant.applyLastCodeBlock", async () => {
      const lastResponse = context.workspaceState.get(LAST_RESPONSE_KEY, "");
      const codeBlock = extractLastCodeBlock(lastResponse);
      await applyCodeBlock(codeBlock);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexAssistant.runLastShellBlock", async () => {
      const lastResponse = context.workspaceState.get(LAST_RESPONSE_KEY, "");
      const runnableBlock = extractLastRunnableBlock(lastResponse);
      await runInTerminal(runnableBlock);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexAssistant.runLastShellBlockWithCapture", async () => {
      const lastResponse = context.workspaceState.get(LAST_RESPONSE_KEY, "");
      const runnableBlock = extractLastRunnableBlock(lastResponse);
      const result = await executeShellBlockWithCapture(runnableBlock, outputChannel);
      if (result) {
        await provider.analyzeCommandResult(runnableBlock, result);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexAssistant.applyFileEdits", async () => {
      const lastResponse = context.workspaceState.get(LAST_RESPONSE_KEY, "");
      const edits = extractFileEdits(lastResponse);
      await applyFileEdits(edits);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexAssistant.sendSelection", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage("Open a file and select some code first.");
        return;
      }

      const selection = editor.document.getText(editor.selection);
      if (!selection.trim()) {
        vscode.window.showWarningMessage("Select some code before sending it to Nova Agent.");
        return;
      }

      await vscode.commands.executeCommand("workbench.view.extension.codexAssistant");
      await provider.enqueueSelectionPrompt(selection, editor.document.languageId, editor.document.uri);
    })
  );
}

async function configureSettings(provider) {
  const config = getAgentConfiguration();
  const baseUrl = await vscode.window.showInputBox({
    title: "Nova Agent Base URL",
    prompt: "OpenAI-compatible base URL, usually ending with /v1.",
    value: String(getAgentSetting("baseUrl", "https://api.openai.com/v1")),
    ignoreFocusOut: true
  });

  if (typeof baseUrl !== "string") {
    return;
  }

  const model = await vscode.window.showInputBox({
    title: "Nova Agent Model",
    prompt: "Model name used for chat requests.",
    value: String(getAgentSetting("model", "gpt-4.1-mini")),
    ignoreFocusOut: true
  });

  if (typeof model !== "string") {
    return;
  }

  const trimmedBaseUrl = baseUrl.trim();
  const trimmedModel = model.trim();
  if (!trimmedBaseUrl || !trimmedModel) {
    vscode.window.showWarningMessage("Base URL and model are both required.");
    return;
  }

  await updateAgentSetting("baseUrl", trimmedBaseUrl, vscode.ConfigurationTarget.Global);
  await updateAgentSetting("model", trimmedModel, vscode.ConfigurationTarget.Global);
  vscode.window.showInformationMessage("Nova Agent settings updated.");
  await provider.postState();
}

async function insertIntoEditor(text, emptyMessage) {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage("Open an editor before inserting assistant output.");
    return;
  }

  if (!text) {
    vscode.window.showWarningMessage(emptyMessage);
    return;
  }

  await editor.edit((editBuilder) => {
    const selection = editor.selection;
    if (selection && !selection.isEmpty) {
      editBuilder.replace(selection, text);
    } else {
      editBuilder.insert(selection.active, text);
    }
  });
}

async function createFileFromLastCodeBlock(lastResponse) {
  const root = vscode.workspace.workspaceFolders?.[0];
  if (!root) {
    vscode.window.showWarningMessage("Open a workspace folder before creating a file.");
    return;
  }

  const blocks = extractCodeBlocks(lastResponse);
  const block = blocks.length ? blocks[blocks.length - 1] : null;
  if (!block || !block.content) {
    vscode.window.showWarningMessage("The last assistant response did not contain a code block.");
    return;
  }

  const defaultName = suggestFileName(block);
  const relativePath = await vscode.window.showInputBox({
    title: "Create File From Assistant Code",
    prompt: "Enter a relative file path inside the current workspace.",
    value: defaultName,
    ignoreFocusOut: true
  });

  if (typeof relativePath !== "string") {
    return;
  }

  const uri = resolveEditUri(relativePath.trim());
  if (!uri) {
    vscode.window.showWarningMessage("Invalid file path.");
    return;
  }

  await ensureParentDirectory(uri);
  await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(block.content));
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc, { preview: false });
  vscode.window.showInformationMessage(`Created ${vscode.workspace.asRelativePath(uri, false)} from assistant code.`);
}

function suggestFileName(block) {
  const language = String(block?.language || "").toLowerCase();
  const extensionMap = {
    python: "py",
    py: "py",
    javascript: "js",
    js: "js",
    typescript: "ts",
    ts: "ts",
    tsx: "tsx",
    jsx: "jsx",
    json: "json",
    bash: "sh",
    sh: "sh",
    shell: "sh",
    powershell: "ps1",
    ps1: "ps1"
  };
  const ext = extensionMap[language] || "txt";
  return `new_file.${ext}`;
}

async function applyCodeBlock(codeBlock) {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage("Open an editor before applying a code block.");
    return;
  }

  if (!codeBlock) {
    vscode.window.showWarningMessage("The last assistant response did not contain a code block.");
    return;
  }

  const selection = editor.selection;
  const target = selection && !selection.isEmpty
    ? selection
    : new vscode.Range(editor.document.positionAt(0), editor.document.positionAt(editor.document.getText().length));

  const label = selection && !selection.isEmpty ? "replace the current selection" : "replace the entire active file";
  const choice = await vscode.window.showWarningMessage(
    `Apply assistant code block and ${label}?`,
    { modal: true },
    "Apply"
  );

  if (choice !== "Apply") {
    return;
  }

  await editor.edit((editBuilder) => {
    editBuilder.replace(target, codeBlock);
  });
}

async function runInTerminal(runnableBlock) {
  if (!runnableBlock || !runnableBlock.content) {
    vscode.window.showWarningMessage("The last assistant response did not contain a runnable shell block.");
    return;
  }

  const choice = await vscode.window.showWarningMessage(
    "Send the last assistant shell command block to the VS Code terminal?",
    { modal: true },
    "Run"
  );

  if (choice !== "Run") {
    return;
  }

  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const terminal = vscode.window.terminals.find((item) => item.name === TERMINAL_NAME)
    || vscode.window.createTerminal({ name: TERMINAL_NAME, cwd });

  terminal.show(true);
  terminal.sendText(runnableBlock.content, true);
}

async function applyFileEdits(edits) {
  if (!Array.isArray(edits) || !edits.length) {
    vscode.window.showWarningMessage("The last assistant response did not contain any file edits.");
    return;
  }

  const resolved = edits.map((edit) => ({
    ...edit,
    uri: resolveEditUri(edit.path)
  }));

  const invalid = resolved.filter((edit) => !edit.uri);
  if (invalid.length) {
    vscode.window.showWarningMessage(`Blocked ${invalid.length} file edit(s) with invalid paths.`);
    return;
  }

  const preview = resolved.slice(0, 8).map((edit) => edit.path).join(", ");
  const suffix = resolved.length > 8 ? ` and ${resolved.length - 8} more` : "";
  const choice = await vscode.window.showWarningMessage(
    `Apply ${resolved.length} file edit(s): ${preview}${suffix}?`,
    { modal: true },
    "Apply"
  );

  if (choice !== "Apply") {
    return;
  }

  for (const edit of resolved) {
    await ensureParentDirectory(edit.uri);
    await vscode.workspace.fs.writeFile(edit.uri, new TextEncoder().encode(edit.content));
  }

  const first = resolved[0];
  if (first) {
    const doc = await vscode.workspace.openTextDocument(first.uri);
    await vscode.window.showTextDocument(doc, { preview: false });
  }

  vscode.window.showInformationMessage(`Applied ${resolved.length} file edit(s) from assistant output.`);
}

async function executeShellBlockWithCapture(runnableBlock, outputChannel) {
  if (!runnableBlock || !runnableBlock.content) {
    vscode.window.showWarningMessage("The last assistant response did not contain a runnable shell block.");
    return null;
  }

  const choice = await vscode.window.showWarningMessage(
    "Execute the last assistant shell block, capture stdout/stderr, and send the result back to the assistant?",
    { modal: true },
    "Run and Analyze"
  );

  if (choice !== "Run and Analyze") {
    return null;
  }

  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const command = String(runnableBlock.content || "").trim();
  const execution = getExecutionTarget(runnableBlock.language, command);
  if (!execution) {
    vscode.window.showWarningMessage("No supported shell was found for the assistant command block.");
    return null;
  }

  outputChannel.show(true);
  outputChannel.appendLine("$ " + command);

  const result = await new Promise((resolve) => {
    const child = spawn(execution.command, execution.args, {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      outputChannel.append(text);
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      outputChannel.append(text);
    });

    child.on("error", (error) => {
      resolve({ exitCode: -1, stdout, stderr: stderr + String(error) });
    });

    child.on("close", (code) => {
      outputChannel.appendLine("");
      outputChannel.appendLine(`[exit ${typeof code === "number" ? code : -1}]`);
      resolve({ exitCode: typeof code === "number" ? code : -1, stdout, stderr });
    });
  });

  return {
    ...result,
    command,
    language: runnableBlock.language || "shell"
  };
}

function getExecutionTarget(language, commandText) {
  const lang = String(language || "").toLowerCase();

  if (["powershell", "ps1"].includes(lang)) {
    return { command: "powershell.exe", args: ["-NoProfile", "-Command", commandText] };
  }

  if (["cmd", "bat"].includes(lang)) {
    return { command: "cmd.exe", args: ["/d", "/s", "/c", commandText] };
  }

  if (["bash", "sh", "shell", "zsh"].includes(lang)) {
    return { command: "bash", args: ["-lc", commandText] };
  }

  return process.platform === "win32"
    ? { command: "powershell.exe", args: ["-NoProfile", "-Command", commandText] }
    : { command: "/bin/sh", args: ["-lc", commandText] };
}

function extractToolRequest(text) {
  const source = String(text || "").trim();
  const fenced = source.match(/```codex-tool\n([\s\S]*?)```/i);
  const candidates = [];

  if (fenced) {
    candidates.push(String(fenced[1] || "").trim());
  }

  if (source.startsWith("{") && source.endsWith("}")) {
    candidates.push(source);
  }

  for (const candidate of candidates) {
    try {
      const payload = JSON.parse(candidate);
      if (payload && typeof payload === "object" && payload.tool) {
        return payload;
      }
    } catch {
    }
  }

  return null;
}

function stripToolBlock(text) {
  const source = String(text || "").trim();
  if (source.startsWith("{") && source.endsWith("}")) {
    try {
      const payload = JSON.parse(source);
      if (payload && typeof payload === "object" && payload.tool) {
        return "";
      }
    } catch {
    }
  }

  return source.replace(/```codex-tool\n[\s\S]*?```/ig, "").trim();
}

function renderToolSummary(request) {
  switch (request.tool) {
    case "read_file":
      return `[Tool] read_file ${request.path || ""}`.trim();
    case "search_code":
      return `[Tool] search_code ${request.query || request.pattern || ""}`.trim();
    case "list_files":
      return `[Tool] list_files ${request.glob || ""}`.trim();
    case "write_file":
      return `[Tool] write_file ${request.path || ""}`.trim();
    case "replace_in_file":
      return `[Tool] replace_in_file ${request.path || ""}`.trim();
    case "apply_patch":
      return "[Tool] apply_patch";
    default:
      return `[Tool] ${request.tool}`;
  }
}

async function executeLocalTool(request) {
  switch (String(request.tool || "")) {
    case "list_files":
      return executeListFilesTool(request);
    case "search_code":
      return executeSearchCodeTool(request);
    case "read_file":
      return executeReadFileTool(request);
    case "write_file":
      return executeWriteFileTool(request);
    case "replace_in_file":
      return executeReplaceInFileTool(request);
    case "apply_patch":
      return executeApplyPatchTool(request);
    default:
      return { ok: false, tool: String(request.tool || "unknown"), error: "Unsupported tool request." };
  }
}

async function executeListFilesTool(request) {
  const limit = Math.min(Math.max(Number(request.limit) || 50, 1), 200);
  const glob = String(request.glob || "**/*");
  const uris = await vscode.workspace.findFiles(glob, "**/{.git,node_modules,.venv,venv,dist,build,out,.next,coverage,.turbo,.cache,bin,obj,target}/**", limit);
  return { ok: true, tool: "list_files", files: uris.map((uri) => vscode.workspace.asRelativePath(uri, false)) };
}

async function executeSearchCodeTool(request) {
  const pattern = String(request.query || request.pattern || "").trim();
  if (!pattern) {
    return { ok: false, tool: "search_code", error: "Missing query." };
  }

  const limit = Math.min(Math.max(Number(request.limit) || 20, 1), 100);
  const results = [];
  await vscode.workspace.findTextInFiles(
    { pattern },
    { includes: String(request.glob || "**/*"), excludes: "**/{.git,node_modules,.venv,venv,dist,build,out,.next,coverage,.turbo,.cache,bin,obj,target}/**" },
    (match) => {
      if (results.length >= limit) {
        return;
      }
      results.push({
        path: vscode.workspace.asRelativePath(match.uri, false),
        line: match.ranges[0].start.line + 1,
        preview: match.preview.text.trim()
      });
    }
  );

  return { ok: true, tool: "search_code", query: pattern, matches: results };
}

async function executeReadFileTool(request) {
  const relativePath = String(request.path || "").trim();
  const uri = resolveEditUri(relativePath);
  if (!uri) {
    return { ok: false, tool: "read_file", error: "Invalid path.", path: relativePath };
  }

  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    const content = truncateText(Buffer.from(bytes).toString("utf8"), Math.min(Math.max(Number(request.maxChars) || 6000, 200), 20000));
    return { ok: true, tool: "read_file", path: relativePath, content };
  } catch (error) {
    return { ok: false, tool: "read_file", path: relativePath, error: error instanceof Error ? error.message : String(error) };
  }
}

async function executeWriteFileTool(request) {
  const relativePath = String(request.path || "").trim();
  const content = typeof request.content === "string" ? request.content : "";
  const uri = resolveEditUri(relativePath);
  if (!uri) {
    return { ok: false, tool: "write_file", path: relativePath, error: "Invalid path." };
  }

  try {
    const existed = await fileExists(uri);
    await ensureParentDirectory(uri);
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content));
    await openDocument(uri);
    return {
      ok: true,
      tool: "write_file",
      path: relativePath,
      action: existed ? "updated" : "created",
      chars: content.length
    };
  } catch (error) {
    return { ok: false, tool: "write_file", path: relativePath, error: error instanceof Error ? error.message : String(error) };
  }
}

async function executeReplaceInFileTool(request) {
  const relativePath = String(request.path || "").trim();
  const find = typeof request.find === "string" ? request.find : "";
  const replace = typeof request.replace === "string" ? request.replace : "";
  const replaceAll = Boolean(request.all);
  const uri = resolveEditUri(relativePath);

  if (!uri) {
    return { ok: false, tool: "replace_in_file", path: relativePath, error: "Invalid path." };
  }

  if (!find) {
    return { ok: false, tool: "replace_in_file", path: relativePath, error: "Missing find text." };
  }

  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    const source = Buffer.from(bytes).toString("utf8");
    const occurrences = source.split(find).length - 1;
    if (occurrences < 1) {
      return { ok: false, tool: "replace_in_file", path: relativePath, error: "Find text was not found." };
    }

    const next = replaceAll ? source.split(find).join(replace) : source.replace(find, replace);
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(next));
    await openDocument(uri);
    return {
      ok: true,
      tool: "replace_in_file",
      path: relativePath,
      replacements: replaceAll ? occurrences : 1
    };
  } catch (error) {
    return { ok: false, tool: "replace_in_file", path: relativePath, error: error instanceof Error ? error.message : String(error) };
  }
}

async function executeApplyPatchTool(request) {
  const diff = typeof request.diff === "string" ? request.diff : "";
  if (!diff.trim()) {
    return { ok: false, tool: "apply_patch", error: "Missing diff." };
  }

  try {
    const summary = await applyUnifiedDiff(diff, resolveEditUri);
    const firstChanged = summary.find((item) => item.type !== "delete");
    if (firstChanged?.path) {
      const uri = resolveEditUri(firstChanged.path);
      if (uri) {
        await openDocument(uri);
      }
    }
    return { ok: true, tool: "apply_patch", files: summary };
  } catch (error) {
    return { ok: false, tool: "apply_patch", error: error instanceof Error ? error.message : String(error) };
  }
}

function formatToolResult(toolResult) {
  return [
    `Tool result for ${toolResult.tool}:`,
    "```json",
    JSON.stringify(toolResult, null, 2),
    "```"
  ].join("\n");
}

function summarizeToolResult(toolResult) {
  if (!toolResult.ok) {
    return `[Tool Result] ${toolResult.tool} failed: ${toolResult.error || "Unknown error."}`;
  }

  switch (toolResult.tool) {
    case "list_files":
      return `[Tool Result] list_files: ${toolResult.files.length} file(s)`;
    case "search_code":
      return `[Tool Result] search_code: ${toolResult.matches.length} match(es)`;
    case "read_file":
      return `[Tool Result] read_file: ${toolResult.path}`;
    case "write_file":
      return `[Tool Result] write_file: ${toolResult.action} ${toolResult.path}`;
    case "replace_in_file":
      return `[Tool Result] replace_in_file: ${toolResult.replacements} replacement(s) in ${toolResult.path}`;
    case "apply_patch":
      return `[Tool Result] apply_patch: ${toolResult.files.length} file change(s)`;
    default:
      return `[Tool Result] ${toolResult.tool}`;
  }
}

function shouldStopAfterTool(toolResult) {
  return Boolean(toolResult?.ok && MUTATING_TOOLS.has(String(toolResult.tool || "")));
}

function looksLikeFileMutationRequest(prompt) {
  const text = String(prompt || "").toLowerCase();
  return /(创建|新建|生成|写入|保存|修改|编辑|patch|diff|create|write|save|modify|edit)/.test(text)
    && /(文件|file|py|js|ts|json|md|代码|code)/.test(text);
}

function normalizeAttachedFilePath(uri) {
  const relative = String(vscode.workspace.asRelativePath(uri, false) || "").trim();
  if (relative) {
    return relative;
  }

  const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!rootPath) {
    return path.basename(uri.fsPath);
  }

  const fallback = path.relative(rootPath, uri.fsPath).replace(/\\/g, "/").trim();
  return fallback || path.basename(uri.fsPath);
}

function extractReferencedPaths(prompt) {
  const matches = String(prompt || "").match(/(?:\.\.?[\\/])?[A-Za-z0-9_./\\-]+\.[A-Za-z0-9_-]+/g) || [];
  const seen = new Set();
  const paths = [];

  for (const raw of matches) {
    const cleaned = String(raw || "").trim().replace(/^['"`(\[]+|['"`),.\]]+$/g, "");
    if (!cleaned || /^https?:\/\//i.test(cleaned)) {
      continue;
    }

    const normalized = cleaned.replace(/\\/g, "/");
    if (!seen.has(normalized)) {
      seen.add(normalized);
      paths.push(normalized);
    }
  }

  return paths.slice(0, 4);
}

async function buildFileContextBlock(label, relativePaths) {
  const cleanPaths = [...new Set((relativePaths || []).map((item) => String(item || "").trim()).filter(Boolean))].slice(0, 6);
  if (!cleanPaths.length) {
    return "";
  }

  const entries = [];
  for (const relativePath of cleanPaths) {
    const uri = resolveEditUri(relativePath);
    if (!uri) {
      continue;
    }

    const exists = await fileExists(uri);
    if (!exists) {
      entries.push(`${label} path (not found yet): ${relativePath}`);
      continue;
    }

    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const content = truncateText(Buffer.from(bytes).toString("utf8"), 5000);
      const language = path.extname(relativePath).replace(/^\./, "") || "text";
      entries.push([
        `${label} file: ${relativePath}`,
        "```" + language,
        content,
        "```"
      ].join("\n"));
    } catch {
      entries.push(`${label} path (failed to read): ${relativePath}`);
    }
  }

  return entries.length ? [`${label} context:`, ...entries].join("\n\n") : "";
}

async function buildReferencedFilesBlock(prompt) {
  return buildFileContextBlock("Referenced", extractReferencedPaths(prompt));
}

async function buildAttachedFilesBlock(attachedFiles) {
  return buildFileContextBlock("Attached", attachedFiles);
}

async function ensureParentDirectory(uri) {
  const parent = path.dirname(uri.fsPath);
  await vscode.workspace.fs.createDirectory(vscode.Uri.file(parent));
}

async function openDocument(uri) {
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: true });
}

async function fileExists(uri) {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

class NovaSidebarProvider {
  constructor(context, promptService, outputChannel) {
    this.context = context;
    this.promptService = promptService;
    this.outputChannel = outputChannel;
    this.view = undefined;
    this.messages = context.workspaceState.get(CHAT_STATE_KEY, []);
    this.history = context.workspaceState.get(HISTORY_STATE_KEY, this.messages.map((item) => ({ role: item.role, content: item.content })));
    this.attachedFiles = context.workspaceState.get(ATTACHED_FILES_STATE_KEY, []);
    this.isBusy = false;
    this.streamingPreview = "";
  }

  resolveWebviewView(webviewView) {
    this.view = webviewView;
    const { webview } = webviewView;
    webview.options = {
      enableScripts: true
    };
    webview.html = this.getHtml(webview);

    webview.onDidReceiveMessage(async (message) => {
      switch (message.type) {
        case "ready":
          await this.postState();
          break;
        case "sendPrompt":
          await this.handlePrompt(message);
          break;
        case "clearChat":
          await this.clearChat();
          break;
        case "insertLastResponse":
          await vscode.commands.executeCommand("codexAssistant.insertLastResponse");
          break;
        case "insertLastCodeBlock":
          await vscode.commands.executeCommand("codexAssistant.insertLastCodeBlock");
          break;
        case "applyLastCodeBlock":
          await vscode.commands.executeCommand("codexAssistant.applyLastCodeBlock");
          break;
        case "runLastShellBlock":
          await vscode.commands.executeCommand("codexAssistant.runLastShellBlock");
          break;
        case "runLastShellBlockWithCapture":
          await vscode.commands.executeCommand("codexAssistant.runLastShellBlockWithCapture");
          break;
        case "applyFileEdits":
          await vscode.commands.executeCommand("codexAssistant.applyFileEdits");
          break;
        case "setApiKey":
          await vscode.commands.executeCommand("codexAssistant.setApiKey");
          break;
        case "configureSettings":
          await vscode.commands.executeCommand("codexAssistant.configureSettings");
          break;
        case "attachFiles":
          await this.pickAttachedFiles();
          break;
        case "removeAttachedFile":
          await this.removeAttachedFile(message.path);
          break;
        case "clearAttachedFiles":
          await this.clearAttachedFiles();
          break;
      }
    });
  }

  async handlePrompt(message) {
    if (this.isBusy) {
      return;
    }

    const prompt = String(message.prompt || "").trim();
    if (!prompt) {
      return;
    }

    const includeSelection = Boolean(message.includeSelection);
    const includeWorkspaceContext = Boolean(message.includeWorkspaceContext);
    const content = await this.composePrompt(prompt, includeSelection, includeWorkspaceContext, {
      selectionOverride: message.selectionOverride,
      languageIdOverride: message.languageIdOverride,
      fileUriOverride: message.fileUriOverride
    });

    this.messages.push({ role: "user", content: String(message.displayPrompt || prompt) });
    this.history.push({ role: "user", content });
    this.isBusy = true;
    this.streamingPreview = "";
    await this.persistState();
    await this.postState();

    try {
      for (let step = 0; step < MAX_TOOL_STEPS; step += 1) {
        const assistantMessage = { role: "assistant", content: "" };
        this.messages.push(assistantMessage);
        await this.postState();

        const answer = await this.promptService.sendChatRequest(
          this.history,
          {
            onToken: async (token) => {
              assistantMessage.content += token;
              this.streamingPreview = assistantMessage.content;
              await this.postState();
            },
            onComplete: async (finalText) => {
              assistantMessage.content = finalText;
              this.streamingPreview = "";
              await this.postState();
            }
          }
        );

        const toolRequest = extractToolRequest(answer);
        const visibleText = stripToolBlock(answer);
        this.history.push({ role: "assistant", content: answer });

        if (!toolRequest) {
          assistantMessage.content = visibleText || answer;
          await this.context.workspaceState.update(LAST_RESPONSE_KEY, assistantMessage.content);
          await this.persistState();
          break;
        }

        assistantMessage.content = visibleText || renderToolSummary(toolRequest);
        const toolResult = await executeLocalTool(toolRequest);
        const summary = summarizeToolResult(toolResult);
        this.messages.push({ role: "assistant", content: summary });
        this.history.push({ role: "user", content: formatToolResult(toolResult) });
        await this.context.workspaceState.update(LAST_RESPONSE_KEY, summary);
        await this.persistState();
        await this.postState();

        if (shouldStopAfterTool(toolResult)) {
          break;
        }

        if (step === MAX_TOOL_STEPS - 1) {
          this.messages.push({ role: "assistant", content: "Stopped after reaching the local tool step limit." });
          await this.persistState();
        }
      }
    } catch (error) {
      this.messages.push({
        role: "assistant",
        content: `Request failed.\n\n${error instanceof Error ? error.message : String(error)}`
      });
      await this.persistState();
    } finally {
      this.isBusy = false;
      this.streamingPreview = "";
      await this.postState();
    }
  }

  async composePrompt(prompt, includeSelection, includeWorkspaceContext, overrides = {}) {
    const parts = [prompt];

    const attachedFilesBlock = await buildAttachedFilesBlock(this.attachedFiles);
    if (attachedFilesBlock) {
      parts.push(attachedFilesBlock);
    }

    if (looksLikeFileMutationRequest(prompt)) {
      parts.push("Tooling rule: the user explicitly wants workspace files created or modified. Use write_file, replace_in_file, or apply_patch immediately unless a missing detail makes that impossible.");
    }

    const referencedFilesBlock = await buildReferencedFilesBlock(prompt);
    if (referencedFilesBlock) {
      parts.push(referencedFilesBlock);
    }

    if (includeSelection || overrides.selectionOverride) {
      const selectionBlock = this.buildSelectionBlock(overrides);
      if (selectionBlock) {
        parts.push(selectionBlock);
      }
    }

    if (includeWorkspaceContext) {
      const workspaceContext = await buildWorkspaceContext(prompt, { activeFileHint: overrides.fileUriOverride });
      parts.push("Workspace context:\n" + workspaceContext);
    }

    return parts.join("\n\n");
  }

  buildSelectionBlock(overrides = {}) {
    const explicitSelection = String(overrides.selectionOverride || "").trim();
    const explicitLanguage = String(overrides.languageIdOverride || "text");
    const explicitUri = overrides.fileUriOverride ? vscode.Uri.parse(String(overrides.fileUriOverride)) : null;

    if (explicitSelection) {
      const fileLabel = explicitUri ? vscode.workspace.asRelativePath(explicitUri, false) : "selection";
      return [
        `Current selection from ${fileLabel}:`,
        "```" + explicitLanguage,
        truncateText(explicitSelection, 4000),
        "```"
      ].join("\n");
    }

    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return "";
    }

    const selection = editor.document.getText(editor.selection).trim();
    if (!selection) {
      return "";
    }

    return [
      `Current selection from ${vscode.workspace.asRelativePath(editor.document.uri, false)}:`,
      "```" + editor.document.languageId,
      truncateText(selection, 4000),
      "```"
    ].join("\n");
  }

  async enqueueSelectionPrompt(selection, languageId, uri) {
    if (this.isBusy) {
      vscode.window.showInformationMessage("Nova Agent is already handling another request.");
      return;
    }

    const config = getAgentConfiguration();
    await this.handlePrompt({
      prompt: `Explain, critique, and improve this ${languageId || "code"} snippet.`,
      displayPrompt: `Explain, critique, and improve this ${languageId || "code"} snippet.`,
      includeSelection: false,
      includeWorkspaceContext: Boolean(getAgentSetting("includeWorkspaceContextByDefault", false)),
      selectionOverride: selection,
      languageIdOverride: languageId || "text",
      fileUriOverride: uri ? String(uri) : ""
    });
  }

  async analyzeCommandResult(runnableBlock, result) {
    if (this.isBusy) {
      vscode.window.showInformationMessage("Nova Agent is already handling another request.");
      return;
    }

    const config = getAgentConfiguration();
    const prompt = [
      "The suggested command has been executed. Analyze the result and give the next concrete step.",
      "",
      "Command:",
      "```" + (runnableBlock?.language || "shell"),
      String(result.command || "").trim(),
      "```",
      "",
      `Exit code: ${result.exitCode}`,
      "",
      "stdout:",
      "```text",
      String(result.stdout || "").trim() || "(empty)",
      "```",
      "",
      "stderr:",
      "```text",
      String(result.stderr || "").trim() || "(empty)",
      "```"
    ].join("\n");

    await this.handlePrompt({
      prompt,
      displayPrompt: "Analyze the captured terminal result and tell me the next step.",
      includeSelection: false,
      includeWorkspaceContext: Boolean(getAgentSetting("includeWorkspaceContextByDefault", false))
    });
  }

  async clearChat() {
    this.messages = [];
    this.history = [];
    this.streamingPreview = "";
    await this.context.workspaceState.update(LAST_RESPONSE_KEY, "");
    await this.persistState();
    await this.postState();
  }

  async pickAttachedFiles() {
    const roots = vscode.workspace.workspaceFolders;
    if (!roots?.length) {
      vscode.window.showWarningMessage("Open a workspace folder before attaching files.");
      return;
    }

    const uris = await vscode.window.showOpenDialog({
      canSelectMany: true,
      canSelectFolders: false,
      canSelectFiles: true,
      defaultUri: roots[0].uri,
      openLabel: "Attach Files"
    });

    if (!uris?.length) {
      return;
    }

    const next = [...this.attachedFiles];
    for (const uri of uris) {
      const relativePath = normalizeAttachedFilePath(uri);
      if (relativePath && !next.includes(relativePath)) {
        next.push(relativePath);
      }
    }

    this.attachedFiles = next.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 6);
    await this.context.workspaceState.update(ATTACHED_FILES_STATE_KEY, this.attachedFiles);
    await this.postState();

    if (this.attachedFiles.length) {
      vscode.window.showInformationMessage(`Attached: ${this.attachedFiles.join(", ")}`);
    }
  }

  async removeAttachedFile(targetPath) {
    this.attachedFiles = this.attachedFiles.filter((item) => item !== String(targetPath || ""));
    await this.context.workspaceState.update(ATTACHED_FILES_STATE_KEY, this.attachedFiles);
    await this.postState();
  }

  async clearAttachedFiles() {
    this.attachedFiles = [];
    await this.context.workspaceState.update(ATTACHED_FILES_STATE_KEY, this.attachedFiles);
    await this.postState();
  }

  async notifySecretsChanged() {
    await this.postState();
  }

  async persistState() {
    await this.context.workspaceState.update(CHAT_STATE_KEY, this.messages.slice(-40));
    await this.context.workspaceState.update(HISTORY_STATE_KEY, this.history.slice(-80));
  }

  async postState() {
    if (!this.view) {
      return;
    }

    const hasApiKey = Boolean(await getStoredApiKey(this.context));
    const config = getAgentConfiguration();
    const lastResponse = this.context.workspaceState.get(LAST_RESPONSE_KEY, "");

    this.view.webview.postMessage({
      type: "state",
      payload: {
        hasApiKey,
        isBusy: this.isBusy,
        messages: this.messages,
        streamingPreview: this.streamingPreview,
        hasLastCodeBlock: Boolean(extractLastCodeBlock(lastResponse)),
        hasLastShellBlock: Boolean(extractLastRunnableBlock(lastResponse)),
        hasFileEdits: extractFileEdits(lastResponse).length > 0,
        attachedFiles: this.attachedFiles,
        includeSelectionByDefault: Boolean(getAgentSetting("includeSelectionByDefault", false)),
        includeWorkspaceContextByDefault: Boolean(getAgentSetting("includeWorkspaceContextByDefault", false)),
        model: String(getAgentSetting("model", "gpt-4.1-mini"))
      }
    });
  }

  getHtml(webview) {
    const nonce = crypto.randomBytes(16).toString("base64");

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Nova Agent</title>
  <style>
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      background: linear-gradient(180deg, color-mix(in srgb, var(--vscode-sideBar-background) 88%, var(--vscode-editor-background)), var(--vscode-sideBar-background));
      display: flex;
      flex-direction: column;
      min-height: 100vh;
    }
    .toolbar {
      display: flex;
      gap: 8px;
      padding: 12px;
      border-bottom: 1px solid var(--vscode-panel-border);
      background: color-mix(in srgb, var(--vscode-sideBar-background) 82%, var(--vscode-editor-background));
      position: sticky;
      top: 0;
      z-index: 2;
      flex-wrap: wrap;
    }
    button {
      border: 1px solid var(--vscode-button-border, transparent);
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      padding: 6px 10px;
      border-radius: 8px;
      cursor: pointer;
    }
    button.secondary {
      background: transparent;
      color: var(--vscode-foreground);
      border-color: var(--vscode-panel-border);
    }
    button:disabled { opacity: 0.6; cursor: default; }
    .meta {
      padding: 10px 12px 0;
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
    }
    .messages {
      flex: 1;
      padding: 12px;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .empty {
      padding: 14px;
      border: 1px dashed var(--vscode-panel-border);
      border-radius: 12px;
      color: var(--vscode-descriptionForeground);
      line-height: 1.5;
      background: color-mix(in srgb, var(--vscode-editorWidget-background) 70%, transparent);
    }
    .bubble {
      padding: 10px 12px;
      border-radius: 12px;
      line-height: 1.5;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .bubble.user {
      background: color-mix(in srgb, var(--vscode-textLink-foreground) 16%, transparent);
      border: 1px solid color-mix(in srgb, var(--vscode-textLink-foreground) 30%, transparent);
    }
    .bubble.assistant {
      background: color-mix(in srgb, var(--vscode-editorWidget-background) 80%, transparent);
      border: 1px solid var(--vscode-panel-border);
    }
    .attachments {
      padding: 0 12px;
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    .attachment {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 8px;
      border-radius: 999px;
      border: 1px solid var(--vscode-panel-border);
      background: color-mix(in srgb, var(--vscode-editorWidget-background) 72%, transparent);
      font-size: 12px;
    }
    .attachment button {
      padding: 0 4px;
      border: none;
      background: transparent;
      color: var(--vscode-descriptionForeground);
    }
    .attachmentActions {
      padding: 0 12px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
    }
    .attachmentActions button {
      padding: 2px 6px;
    }
    .composer {
      border-top: 1px solid var(--vscode-panel-border);
      padding: 12px;
      display: grid;
      gap: 10px;
      background: color-mix(in srgb, var(--vscode-sideBar-background) 90%, var(--vscode-editor-background));
    }
    textarea {
      width: 100%;
      min-height: 132px;
      resize: vertical;
      padding: 10px 12px;
      border-radius: 8px;
      border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      font-family: var(--vscode-font-family);
    }
    .row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 10px;
      font-size: 12px;
      flex-wrap: wrap;
    }
    .toggles {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
    }
    .status { color: var(--vscode-descriptionForeground); }
    label { display: flex; align-items: center; gap: 6px; }
  </style>
</head>
<body>
  <div class="toolbar">
    <button id="apiKeyBtn" class="secondary">API Key</button>
    <button id="settingsBtn" class="secondary">Settings</button>
    <button id="attachBtn" class="secondary">Attach Files</button>
    <button id="insertBtn" class="secondary">Insert Reply</button>
    <button id="insertCodeBtn" class="secondary">Insert Code</button>
    <button id="applyCodeBtn" class="secondary">Apply Code</button>
    <button id="applyFilesBtn" class="secondary">Apply Files</button>
    <button id="runShellBtn" class="secondary">Run Shell</button>
    <button id="runAnalyzeBtn" class="secondary">Run+Analyze</button>
    <button id="clearBtn" class="secondary">Clear</button>
  </div>
  <div class="meta" id="meta"></div>
  <div class="messages" id="messages"></div>
  <div class="attachments" id="attachments"></div>
  <div class="attachmentActions" id="attachmentActions" hidden>
    <span>Attached files will be included as context.</span>
    <button id="clearAttachmentsBtn" class="secondary">Clear Files</button>
  </div>
  <div class="composer">
    <textarea id="prompt" placeholder="Ask Nova Agent to debug, refactor, explain, or propose code changes..."></textarea>
    <div class="row">
      <div class="toggles">
        <label><input id="includeSelection" type="checkbox" /> Include selection</label>
        <label><input id="includeWorkspace" type="checkbox" /> Include workspace</label>
      </div>
      <span class="status" id="status"></span>
    </div>
    <button id="sendBtn">Send</button>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const promptEl = document.getElementById("prompt");
    const messagesEl = document.getElementById("messages");
    const statusEl = document.getElementById("status");
    const metaEl = document.getElementById("meta");
    const attachmentsEl = document.getElementById("attachments");
    const attachmentActionsEl = document.getElementById("attachmentActions");
    const clearAttachmentsBtn = document.getElementById("clearAttachmentsBtn");
    const includeSelectionEl = document.getElementById("includeSelection");
    const includeWorkspaceEl = document.getElementById("includeWorkspace");
    const sendBtn = document.getElementById("sendBtn");
    const clearBtn = document.getElementById("clearBtn");
    const insertBtn = document.getElementById("insertBtn");
    const insertCodeBtn = document.getElementById("insertCodeBtn");
    const applyCodeBtn = document.getElementById("applyCodeBtn");
    const applyFilesBtn = document.getElementById("applyFilesBtn");
    const runShellBtn = document.getElementById("runShellBtn");
    const runAnalyzeBtn = document.getElementById("runAnalyzeBtn");
    const apiKeyBtn = document.getElementById("apiKeyBtn");
    const settingsBtn = document.getElementById("settingsBtn");
    const attachBtn = document.getElementById("attachBtn");
    let initialized = false;

    function escapeHtml(text) {
      return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }

    function render(state) {
      if (!initialized) {
        includeSelectionEl.checked = state.includeSelectionByDefault;
        includeWorkspaceEl.checked = state.includeWorkspaceContextByDefault;
        initialized = true;
      }

      sendBtn.disabled = state.isBusy || !state.hasApiKey;
      insertBtn.disabled = !state.messages.some((item) => item.role === "assistant");
      insertCodeBtn.disabled = !state.hasLastCodeBlock;
      applyCodeBtn.disabled = !state.hasLastCodeBlock;
      applyFilesBtn.disabled = !state.hasFileEdits;
      runShellBtn.disabled = !state.hasLastShellBlock;
      runAnalyzeBtn.disabled = !state.hasLastShellBlock || state.isBusy;
      statusEl.textContent = state.isBusy ? "Streaming response..." : state.hasApiKey ? "Ready" : "API key required";
      metaEl.textContent = "Model: " + state.model + (state.hasApiKey ? "" : " | Configure an API key to start");

      const attachedFiles = (Array.isArray(state.attachedFiles) ? state.attachedFiles : []).map((file) => String(file || "").trim()).filter(Boolean);
      attachmentActionsEl.hidden = attachedFiles.length === 0;
      attachmentsEl.innerHTML = attachedFiles.map((file) => (
        '<span class="attachment">' + escapeHtml(file) + '<button data-remove-file="' + escapeHtml(file) + '">x</button></span>'
      )).join("");
      attachmentsEl.querySelectorAll("button[data-remove-file]").forEach((button) => {
        button.addEventListener("click", () => {
          vscode.postMessage({ type: "removeAttachedFile", path: button.getAttribute("data-remove-file") || "" });
        });
      });

      if (!state.messages.length) {
        messagesEl.innerHTML = '<div class="empty">This sidebar can chat, stream model output, inspect the local repo with read/search/list tools, attach specific files as context, write files, apply patches, run shell snippets, and feed captured terminal output back into the next turn.</div>';
        return;
      }

      messagesEl.innerHTML = state.messages.map((message) => '<div class="bubble ' + message.role + '">' + escapeHtml(message.content) + '</div>').join("");
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    window.addEventListener("message", (event) => {
      const message = event.data;
      if (message.type === "state") {
        render(message.payload);
      }
    });

    sendBtn.addEventListener("click", () => {
      vscode.postMessage({
        type: "sendPrompt",
        prompt: promptEl.value,
        includeSelection: includeSelectionEl.checked,
        includeWorkspaceContext: includeWorkspaceEl.checked
      });
      promptEl.value = "";
    });

    promptEl.addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
        sendBtn.click();
      }
    });

    clearBtn.addEventListener("click", () => vscode.postMessage({ type: "clearChat" }));
    insertBtn.addEventListener("click", () => vscode.postMessage({ type: "insertLastResponse" }));
    insertCodeBtn.addEventListener("click", () => vscode.postMessage({ type: "insertLastCodeBlock" }));
    applyCodeBtn.addEventListener("click", () => vscode.postMessage({ type: "applyLastCodeBlock" }));
    applyFilesBtn.addEventListener("click", () => vscode.postMessage({ type: "applyFileEdits" }));
    runShellBtn.addEventListener("click", () => vscode.postMessage({ type: "runLastShellBlock" }));
    runAnalyzeBtn.addEventListener("click", () => vscode.postMessage({ type: "runLastShellBlockWithCapture" }));
    apiKeyBtn.addEventListener("click", () => vscode.postMessage({ type: "setApiKey" }));
    settingsBtn.addEventListener("click", () => vscode.postMessage({ type: "configureSettings" }));
    attachBtn.addEventListener("click", () => vscode.postMessage({ type: "attachFiles" }));
    clearAttachmentsBtn.addEventListener("click", () => vscode.postMessage({ type: "clearAttachedFiles" }));
    vscode.postMessage({ type: "ready" });
  </script>
</body>
</html>`;
  }
}

function deactivate() {}

module.exports = {
  activate,
  deactivate
};









































