"use strict";

const vscode = require("vscode");

function parseUnifiedDiff(diffText) {
  const text = String(diffText || "").replace(/\r\n/g, "\n");
  const lines = text.split("\n");
  const patches = [];
  let i = 0;

  while (i < lines.length) {
    if (!lines[i].startsWith("--- ")) {
      i += 1;
      continue;
    }

    const oldFile = normalizeDiffPath(lines[i].slice(4).trim());
    i += 1;
    if (i >= lines.length || !lines[i].startsWith("+++ ")) {
      throw new Error("Malformed diff: missing +++ line.");
    }

    const newFile = normalizeDiffPath(lines[i].slice(4).trim());
    i += 1;
    const hunks = [];

    while (i < lines.length && !lines[i].startsWith("--- ")) {
      if (!lines[i].startsWith("@@ ")) {
        i += 1;
        continue;
      }

      const header = lines[i];
      const match = header.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (!match) {
        throw new Error(`Malformed hunk header: ${header}`);
      }

      const hunk = {
        oldStart: Number(match[1]),
        oldCount: Number(match[2] || 1),
        newStart: Number(match[3]),
        newCount: Number(match[4] || 1),
        lines: []
      };
      i += 1;

      while (i < lines.length && !lines[i].startsWith("@@ ") && !lines[i].startsWith("--- ")) {
        const line = lines[i];
        if (line.startsWith("\\ No newline at end of file")) {
          i += 1;
          continue;
        }
        if (!/^[ +\-]/.test(line)) {
          break;
        }
        hunk.lines.push({ type: line[0], text: line.slice(1) });
        i += 1;
      }

      hunks.push(hunk);
    }

    patches.push({ oldFile, newFile, hunks });
  }

  if (!patches.length) {
    throw new Error("No unified diff file sections were found.");
  }

  return patches;
}

function normalizeDiffPath(rawPath) {
  const value = String(rawPath || "").trim();
  if (!value || value === "/dev/null") {
    return "/dev/null";
  }

  return value.replace(/^([ab])\//, "").replace(/\\/g, "/");
}

async function applyUnifiedDiff(diffText, resolveEditUri) {
  const patches = parseUnifiedDiff(diffText);
  const summary = [];

  for (const patch of patches) {
    const targetPath = patch.newFile !== "/dev/null" ? patch.newFile : patch.oldFile;
    const uri = targetPath !== "/dev/null" ? resolveEditUri(targetPath) : null;

    if (patch.newFile === "/dev/null") {
      const deleteUri = resolveEditUri(patch.oldFile);
      if (!deleteUri) {
        throw new Error(`Invalid delete path: ${patch.oldFile}`);
      }
      await vscode.workspace.fs.delete(deleteUri, { useTrash: false });
      summary.push({ type: "delete", path: patch.oldFile });
      continue;
    }

    if (!uri) {
      throw new Error(`Invalid patch path: ${targetPath}`);
    }

    const exists = await fileExists(uri);
    let source = "";
    if (exists) {
      const bytes = await vscode.workspace.fs.readFile(uri);
      source = Buffer.from(bytes).toString("utf8").replace(/\r\n/g, "\n");
    }

    const next = applyPatchToText(source, patch, exists);
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(next));
    summary.push({ type: exists ? "update" : "create", path: targetPath, hunks: patch.hunks.length });
  }

  return summary;
}

function applyPatchToText(sourceText, patch, exists) {
  const sourceLines = sourceText === "" ? [] : sourceText.split("\n");
  const output = [];
  let cursor = 0;

  for (const hunk of patch.hunks) {
    const startIndex = Math.max(hunk.oldStart - 1, 0);
    while (cursor < startIndex && cursor < sourceLines.length) {
      output.push(sourceLines[cursor]);
      cursor += 1;
    }

    for (const line of hunk.lines) {
      if (line.type === " ") {
        if (sourceLines[cursor] !== line.text) {
          throw new Error(`Patch context mismatch in ${patch.newFile !== "/dev/null" ? patch.newFile : patch.oldFile}. Expected '${line.text}'.`);
        }
        output.push(line.text);
        cursor += 1;
      } else if (line.type === "-") {
        if (sourceLines[cursor] !== line.text) {
          throw new Error(`Patch removal mismatch in ${patch.oldFile}. Expected '${line.text}'.`);
        }
        cursor += 1;
      } else if (line.type === "+") {
        output.push(line.text);
      }
    }
  }

  while (cursor < sourceLines.length) {
    output.push(sourceLines[cursor]);
    cursor += 1;
  }

  if (!exists && patch.oldFile !== "/dev/null" && sourceLines.length === 0 && patch.hunks.length === 0) {
    throw new Error(`Cannot patch missing file: ${patch.oldFile}`);
  }

  return output.join("\n");
}

async function fileExists(uri) {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  parseUnifiedDiff,
  applyUnifiedDiff
};
