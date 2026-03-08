"use strict";

const vscode = require("vscode");
const path = require("path");

const DEFAULT_EXCLUDES = "**/{.git,node_modules,.venv,venv,dist,build,out,.next,coverage,.turbo,.cache,bin,obj,target}/**";
const TEXT_FILE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".jsonl", ".py", ".cs", ".java", ".kt", ".go", ".rs",
  ".cpp", ".c", ".h", ".hpp", ".md", ".txt", ".yml", ".yaml", ".toml", ".xml", ".html", ".css", ".scss",
  ".sql", ".sh", ".ps1", ".bat"
]);

async function buildWorkspaceContext(query, options = {}) {
  const config = vscode.workspace.getConfiguration("codexAssistant");
  const maxFiles = Number(config.get("maxWorkspaceFiles") || 60);
  const maxContextFiles = Number(config.get("maxContextFiles") || 4);
  const maxFileChars = Number(config.get("maxFileContextChars") || 1800);
  const folders = vscode.workspace.workspaceFolders || [];

  if (!folders.length) {
    return "No workspace folder is open.";
  }

  const uris = await vscode.workspace.findFiles("**/*", DEFAULT_EXCLUDES, maxFiles);
  const files = uris
    .map((uri) => ({
      uri,
      path: vscode.workspace.asRelativePath(uri, false)
    }))
    .filter((item) => item.path && isLikelyUsefulFile(item.path));

  const activeEditor = vscode.window.activeTextEditor;
  const activeFile = activeEditor ? vscode.workspace.asRelativePath(activeEditor.document.uri, false) : "None";
  const ranked = rankFiles(files, query, activeFile);
  const picked = ranked.slice(0, Math.max(1, maxContextFiles));
  const snippets = await Promise.all(picked.map((item) => readFileSnippet(item.uri, item.path, maxFileChars)));

  const lines = [
    `Workspace folders: ${folders.map((folder) => folder.name).join(", ")}`,
    `Active file: ${activeFile}`,
    `Relevant files (${picked.length}/${files.length} scanned):`,
    ...picked.map((item) => `- ${item.path}`)
  ];

  const snippetLines = snippets.filter(Boolean).flatMap((snippet) => ["", ...snippet.split("\n")]);
  return [...lines, ...snippetLines].join("\n");
}

function rankFiles(files, query, activeFile) {
  const queryTokens = tokenize(query);
  return files
    .map((file) => ({
      ...file,
      score: scoreFile(file.path, queryTokens, activeFile)
    }))
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
}

function scoreFile(filePath, queryTokens, activeFile) {
  const normalized = filePath.toLowerCase();
  let score = 0;

  if (activeFile && filePath === activeFile) {
    score += 8;
  }

  for (const token of queryTokens) {
    if (normalized.includes(token)) {
      score += token.length > 4 ? 5 : 3;
    }
    const parts = normalized.split(/[\\/_.-]+/);
    if (parts.includes(token)) {
      score += 4;
    }
  }

  if (/readme|package\.json|tsconfig|vite|next|app|index|main|program|extension/.test(normalized)) {
    score += 1;
  }

  return score;
}

function tokenize(text) {
  return [...new Set(String(text || "").toLowerCase().match(/[a-z0-9_.-]{2,}/g) || [])];
}

async function readFileSnippet(uri, relativePath, maxChars) {
  const ext = path.extname(relativePath).toLowerCase();
  if (!TEXT_FILE_EXTENSIONS.has(ext)) {
    return "";
  }

  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    const text = Buffer.from(bytes).toString("utf8");
    const compact = truncateText(text, maxChars);
    return [
      `File: ${relativePath}`,
      "```" + languageFromPath(relativePath),
      compact,
      "```"
    ].join("\n");
  } catch {
    return "";
  }
}

function truncateText(text, maxChars) {
  const value = String(text || "").trim();
  if (value.length <= maxChars) {
    return value;
  }
  return value.slice(0, maxChars) + "\n... [truncated]";
}

function isLikelyUsefulFile(filePath) {
  const normalized = filePath.toLowerCase();
  if (normalized.includes("/.git/") || normalized.includes("/.venv/") || normalized.includes("/node_modules/")) {
    return false;
  }

  const ext = path.extname(normalized);
  return !ext || TEXT_FILE_EXTENSIONS.has(ext);
}

function languageFromPath(filePath) {
  return path.extname(filePath).replace(/^\./, "") || "text";
}

function extractCodeBlocks(text) {
  const matches = [...String(text || "").matchAll(/```([^\n]*)\n([\s\S]*?)```/g)];
  return matches.map((match) => ({
    info: String(match[1] || "").trim(),
    language: String((String(match[1] || "").trim().split(/\s+/)[0]) || "").toLowerCase(),
    content: String(match[2] || "").trim()
  })).filter((item) => item.content);
}

function extractLastCodeBlock(text) {
  const blocks = extractCodeBlocks(text);
  return blocks.length ? blocks[blocks.length - 1].content : "";
}

function extractLastRunnableBlock(text) {
  const shellLanguages = new Set(["sh", "bash", "shell", "zsh", "powershell", "ps1", "cmd", "bat"]);
  const blocks = extractCodeBlocks(text).filter((item) => shellLanguages.has(item.language));
  return blocks.length ? blocks[blocks.length - 1] : null;
}

function extractFileEdits(text) {
  const source = String(text || "");
  const regex = /(?:^|\n)(?:File:\s*([^\n]+)\n)?```([^\n]*)\n([\s\S]*?)```/g;
  const edits = [];
  let match;

  while ((match = regex.exec(source)) !== null) {
    const declaredPath = normalizePathToken(match[1] || "");
    const info = String(match[2] || "").trim();
    const content = String(match[3] || "").trim();
    if (!content) {
      continue;
    }

    const infoPath = parsePathFromInfo(info);
    const filePath = declaredPath || infoPath;
    if (!filePath) {
      continue;
    }

    edits.push({
      path: filePath,
      language: String((info.split(/\s+/)[0]) || "").toLowerCase(),
      content
    });
  }

  return dedupeByPath(edits);
}

function parsePathFromInfo(info) {
  const tokens = String(info || "").split(/\s+/).filter(Boolean);
  for (const token of tokens) {
    const pair = token.match(/^(?:file|path)=(.+)$/i);
    if (pair) {
      return normalizePathToken(pair[1]);
    }
  }

  for (const token of tokens.slice(1)) {
    const normalized = normalizePathToken(token);
    if (normalized && normalized.includes(".")) {
      return normalized;
    }
  }

  return "";
}

function normalizePathToken(value) {
  const raw = String(value || "").trim().replace(/^['"]|['"]$/g, "");
  if (!raw) {
    return "";
  }

  return raw.replace(/\\/g, "/");
}

function dedupeByPath(edits) {
  const map = new Map();
  for (const edit of edits) {
    map.set(edit.path, edit);
  }
  return [...map.values()];
}

function resolveEditUri(relativePath) {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!root) {
    return null;
  }

  const normalized = normalizePathToken(relativePath);
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) {
    return null;
  }

  const rootPath = root.fsPath;
  const fullPath = path.resolve(rootPath, normalized);
  const safeRoot = path.resolve(rootPath) + path.sep;
  const safeTarget = path.resolve(fullPath);

  if (safeTarget !== path.resolve(rootPath) && !safeTarget.startsWith(safeRoot)) {
    return null;
  }

  return vscode.Uri.file(safeTarget);
}

module.exports = {
  buildWorkspaceContext,
  extractCodeBlocks,
  extractLastCodeBlock,
  extractLastRunnableBlock,
  extractFileEdits,
  resolveEditUri,
  truncateText
};
