// Line-based TOML editor for ~/.codex/config.toml, ported from cc-switch's
// projection logic. AiTool itself also writes this file (the `notify` hook
// line managed by src/lib/codex-config.js), so the projection must patch
// only the keys it owns and preserve comments, formatting and unrelated
// tables exactly — a parse/serialize round-trip would destroy them.

function isTableHeader(line) {
  return /^\s*\[/.test(line);
}

// Returns "dotted.name" for `[model_providers.custom]`-style headers
// (array-of-table headers `[[...]]` return null — never ours).
function tableHeaderName(line) {
  const m = line.match(/^\s*\[\s*([^\]]*?)\s*\]\s*(#.*)?$/);
  if (!m) return null;
  const inner = m[1];
  if (inner.startsWith("[")) return null;
  return inner
    .split(".")
    .map((part) => part.trim().replace(/^["']|["']$/g, ""))
    .join(".");
}

function stripComment(rhs) {
  // Naive but sufficient for the scalar values the projection owns: a `#`
  // inside a quoted string does not start a comment.
  let inString = null;
  for (let i = 0; i < rhs.length; i++) {
    const ch = rhs[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === inString) inString = null;
    } else if (ch === '"' || ch === "'") {
      inString = ch;
    } else if (ch === "#") {
      return rhs.slice(0, i).trim();
    }
  }
  return rhs.trim();
}

function parseTomlScalar(rhs) {
  const value = stripComment(rhs);
  if (/^"(.*)"$/s.test(value) || /^'(.*)'$/s.test(value)) {
    return value.slice(1, -1);
  }
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value;
}

function formatTomlString(value) {
  // Escape as a basic string; keep it ASCII-safe for control characters.
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// Scalars, plus inline arrays/tables for the structured values the editor's
// three-way save can write back ([mcp_servers] args/env and friends). The
// switch projections only ever pass scalars; the richer shapes exist so a
// user-edited global table survives a write without a full-file rewrite.
function formatTomlValue(value, depth = 0) {
  if (typeof value === "string") return formatTomlString(value);
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (depth > 6) throw new Error("TOML value is nested too deeply to write");
  if (Array.isArray(value)) {
    return `[${value.map((item) => formatTomlValue(item, depth + 1)).join(", ")}]`;
  }
  if (value !== null && typeof value === "object") {
    const body = Object.entries(value)
      .map(([key, item]) => {
        const left = /^[A-Za-z0-9_-]+$/.test(key) ? key : formatTomlString(key);
        return `${left} = ${formatTomlValue(item, depth + 1)}`;
      })
      .join(", ");
    return `{ ${body} }`;
  }
  throw new Error(`Unsupported TOML value type: ${value === null ? "null" : typeof value}`);
}

function lineKey(line) {
  const m = line.match(/^\s*([A-Za-z0-9_.-]+)\s*=\s*(.*)\s*$/);
  return m ? m[1] : null;
}

// Set `key = value` at top level (before the first table header), replacing
// an existing top-level occurrence or inserting in the leading key block.
function setTopLevelKey(text, key, value) {
  const lines = text.split(/\r?\n/);
  const out = [];
  let replaced = false;
  const newline = `${key} = ${formatTomlValue(value)}`;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isTableHeader(line)) {
      if (!replaced) {
        out.push(newline);
        replaced = true;
      }
      out.push(...lines.slice(i));
      break;
    }
    if (lineKey(line) === key) {
      if (!replaced) {
        out.push(newline);
        replaced = true;
      }
      continue;
    }
    out.push(line);
  }
  if (!replaced) {
    const firstTableIdx = out.findIndex((l) => isTableHeader(l));
    const headerIdx = firstTableIdx === -1 ? out.length : firstTableIdx;
    out.splice(headerIdx, 0, newline);
  }
  return finish(out, text);
}

// Remove a top-level key if present.
function removeTopLevelKey(text, key) {
  const lines = text.split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isTableHeader(line)) {
      out.push(...lines.slice(i));
      break;
    }
    if (lineKey(line) === key) continue;
    out.push(line);
  }
  return finish(out, text);
}

// Read the current top-level scalar value of `key`, or undefined.
function getTopLevelValue(text, key) {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isTableHeader(line)) return undefined;
    if (lineKey(line) === key) return parseTomlScalar(line.replace(/^\s*[A-Za-z0-9_.-]+\s*=\s*/, ""));
  }
  return undefined;
}

// Find the header line index of a dotted table, or -1.
function findTableStart(lines, dottedName) {
  for (let i = 0; i < lines.length; i++) {
    if (tableHeaderName(lines[i]) === dottedName) return i;
  }
  return -1;
}

// Find the header line index of a nested table under `dottedName` (e.g. the
// end of the [model_providers.custom] block when a sibling table starts).
function isBlockEnd(lines, i, dottedName) {
  const name = tableHeaderName(lines[i]);
  if (name == null) return false;
  if (name === dottedName) return false;
  // A subtable of the same prefix belongs to the block ([a.b.c] under [a.b]).
  if (name.startsWith(`${dottedName}.`)) return false;
  return true;
}

function tableBlockEnd(lines, startIndex, dottedName) {
  let end = lines.length;
  for (let i = startIndex + 1; i < lines.length; i++) {
    if (isBlockEnd(lines, i, dottedName)) {
      end = i;
      break;
    }
  }
  // Trim trailing blank lines from the block so removal/replacement doesn't
  // leave stacked blank lines behind.
  while (end > startIndex + 1 && lines[end - 1].trim() === "") end--;
  return end;
}

// Replace or insert the `[model_providers.custom]` table with the given
// key/values; `entries` null removes the table.
function setTable(text, dottedName, entries) {
  const lines = text.split(/\r?\n/);
  const start = findTableStart(lines, dottedName);

  if (!entries || Object.keys(entries).length === 0) {
    if (start === -1) return finish(lines, text);
    const end = tableBlockEnd(lines, start, dottedName);
    const out = lines.slice(0, start).concat(lines.slice(end));
    return finish(out, text);
  }

  const header = `[${dottedName}]`;
  const bodyLines = Object.entries(entries).map(([key, value]) => `${key} = ${formatTomlValue(value)}`);

  if (start === -1) {
    const out = lines.slice();
    while (out.length && out[out.length - 1].trim() === "") out.pop();
    if (out.length) out.push("");
    out.push(header);
    out.push(...bodyLines);
    return finish(out, text);
  }

  const end = tableBlockEnd(lines, start, dottedName);
  const out = lines.slice(0, start).concat([header], bodyLines, lines.slice(end));
  return finish(out, text);
}

// Read the key/values of a dotted table (scalar values only).
function getTableEntries(text, dottedName) {
  const lines = text.split(/\r?\n/);
  const start = findTableStart(lines, dottedName);
  if (start === -1) return null;
  const end = tableBlockEnd(lines, start, dottedName);
  const entries = {};
  for (let i = start + 1; i < end; i++) {
    const key = lineKey(lines[i]);
    if (!key) continue;
    entries[key] = parseTomlScalar(lines[i].replace(/^\s*[A-Za-z0-9_.-]+\s*=\s*/, ""));
  }
  return entries;
}

function finish(out, originalText) {
  let text = out.join("\n");
  // Preserve the original trailing-newline convention.
  if (originalText.endsWith("\n")) {
    if (!text.endsWith("\n")) text += "\n";
  } else {
    text = text.replace(/\n+$/, "");
  }
  return text;
}

module.exports = {
  setTopLevelKey,
  removeTopLevelKey,
  getTopLevelValue,
  setTable,
  getTableEntries,
  parseTomlScalar,
  formatTomlValue,
};
