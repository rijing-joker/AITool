// Line-based TOML editor for ~/.codex/config.toml, ported from cc-switch's
// projection logic. AiTool itself also writes this file (the `notify` hook
// line managed by src/lib/codex-config.js), so the projection must patch
// only the keys it owns and preserve comments, formatting and unrelated
// tables exactly — a parse/serialize round-trip would destroy them.

function parseDottedPath(text) {
  const parts = [];
  let rest = text.trim();
  while (rest) {
    const match = rest.match(/^("(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+)\s*/);
    if (!match) return null;
    parts.push(parseTomlScalar(match[1]));
    rest = rest.slice(match[0].length);
    if (!rest) return parts;
    if (!rest.startsWith(".")) return null;
    rest = rest.slice(1).trimStart();
    if (!rest) return null;
  }
  return null;
}

// Track TOML value context before classifying a line. Arrays and multiline
// strings may contain text that looks exactly like a table or assignment.
function scanLines(lines) {
  let quote = null;
  let depth = 0;
  return lines.map((line) => {
    const top = quote === null && depth === 0;
    const match = top && line.match(/^\s*(\[\[?)(.*?)\]\]?\s*(?:#.*)?$/);
    const header = match ? { parts: parseDottedPath(match[2]), array: match[1] === "[[" } : null;
    const key = top && !header ? lineKey(line) : null;
    if (!header) for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (quote) {
        if (quote[0] === '"' && ch === "\\") { i++; continue; }
        if (line.startsWith(quote, i)) { i += quote.length - 1; quote = null; }
      } else if (ch === "#") break;
      else if (ch === '"' || ch === "'") {
        quote = line.startsWith(ch.repeat(3), i) ? ch.repeat(3) : ch;
        i += quote.length - 1;
      } else if (ch === "[" || ch === "{") depth++;
      else if (ch === "]" || ch === "}") depth--;
    }
    // `open` reports that the line ended mid-value (an unterminated array or
    // multiline string), so a caller can tell a value's continuation lines
    // apart from the blank/comment lines that merely follow it.
    return { header, key, open: quote !== null || depth > 0 };
  });
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
  if (value.startsWith('"')) {
    try { return JSON.parse(value); } catch { return value.slice(1, -1); }
  }
  if (value.startsWith("'")) return value.slice(1, -1);
  if (value.startsWith("{") && value.endsWith("}")) {
    return Object.fromEntries(splitValues(value.slice(1, -1)).map((entry) => {
      const equal = entry.indexOf("=");
      return [parseTomlScalar(entry.slice(0, equal)), parseTomlScalar(entry.slice(equal + 1))];
    }));
  }
  if (value.startsWith("[") && value.endsWith("]")) return splitValues(value.slice(1, -1)).map(parseTomlScalar);
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value;
}

function splitValues(text) {
  const values = [];
  let start = 0, depth = 0, quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (quote === '"' && ch === "\\") i++;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "[" || ch === "{") depth++;
    else if (ch === "]" || ch === "}") depth--;
    else if (ch === "," && depth === 0) { values.push(text.slice(start, i).trim()); start = i + 1; }
  }
  if (text.slice(start).trim()) values.push(text.slice(start).trim());
  return values;
}

function formatTomlString(value) {
  return JSON.stringify(String(value));
}

function formatTomlKey(key) {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : formatTomlString(key);
}

// Scalars, plus inline arrays/tables for the structured values the editor's
// three-way save can write back ([mcp_servers] args/env and friends). The
// switch projections only ever pass scalars; the richer shapes exist so a
// user-edited global table survives a write without a full-file rewrite.
function formatTomlValue(value, depth = 0) {
  if (typeof value === "string") return formatTomlString(value);
  if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return String(value);
  if (depth > 6) throw new Error("TOML value is nested too deeply to write");
  if (Array.isArray(value)) {
    return `[${value.map((item) => formatTomlValue(item, depth + 1)).join(", ")}]`;
  }
  if (value !== null && typeof value === "object") {
    const body = Object.entries(value)
      .map(([key, item]) => {
        return `${formatTomlKey(key)} = ${formatTomlValue(item, depth + 1)}`;
      })
      .join(", ");
    return `{ ${body} }`;
  }
  throw new Error(`Unsupported TOML value type: ${value === null ? "null" : typeof value}`);
}

// Split `key = value` into its parts. Bare keys keep their literal text (a
// numeric-looking key is still the string "123"); quoted keys are unquoted so
// `"fetch" = …` and `fetch = …` compare equal.
const KEY_ASSIGN_REGEX = /^\s*("(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_.-]+)\s*=\s*([\s\S]*)$/;

function splitKeyValue(line) {
  const m = line.match(KEY_ASSIGN_REGEX);
  if (!m) return null;
  const token = m[1];
  const key = token.startsWith('"') || token.startsWith("'") ? String(parseTomlScalar(token)) : token;
  return { key, rhs: m[2] };
}

function lineKey(line) {
  const parts = splitKeyValue(line);
  return parts ? parts.key : null;
}

// Set `key = value` at top level (before the first table header), replacing
// an existing top-level occurrence or inserting in the leading key block.
function setTopLevelKey(text, key, value) {
  const lines = text.split(/\r?\n/);
  const context = scanLines(lines);
  const out = [];
  let replaced = false;
  const newline = `${key} = ${formatTomlValue(value)}`;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (context[i].header) {
      if (!replaced) {
        out.push(newline);
        replaced = true;
      }
      out.push(...lines.slice(i));
      break;
    }
    if (context[i].key === key) {
      if (!replaced) {
        out.push(newline);
        replaced = true;
      }
      continue;
    }
    out.push(line);
  }
  if (!replaced) {
    out.push(newline);
  }
  return finish(out, text);
}

// Remove a top-level key if present.
function removeTopLevelKey(text, key) {
  const lines = text.split(/\r?\n/);
  const context = scanLines(lines);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (context[i].header) {
      out.push(...lines.slice(i));
      break;
    }
    if (context[i].key === key) continue;
    out.push(line);
  }
  return finish(out, text);
}

// Read the current top-level scalar value of `key`, or undefined.
function getTopLevelValue(text, key) {
  const lines = text.split(/\r?\n/);
  const context = scanLines(lines);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (context[i].header) return undefined;
    if (context[i].key === key) return parseTomlScalar(splitKeyValue(line).rhs);
  }
  return undefined;
}

// Find the header line index of a dotted table, or -1.
function findTableStart(lines, dottedName, context = scanLines(lines)) {
  for (let i = 0; i < lines.length; i++) {
    if (!context[i].header?.array && JSON.stringify(context[i].header?.parts) === JSON.stringify(dottedName.split("."))) return i;
  }
  return -1;
}

// Find the header line index of a nested table under `dottedName` (e.g. the
// end of the [model_providers.custom] block when a sibling table starts).
function tableBlockEnd(lines, startIndex, dottedName, context = scanLines(lines)) {
  let end = lines.length;
  for (let i = startIndex + 1; i < lines.length; i++) {
    const header = context[i].header;
    const owned = header?.parts && dottedName.split(".").every((part, index) => header.parts[index] === part);
    if (header && (header.array || !owned)) {
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
  const context = scanLines(lines);
  const start = findTableStart(lines, dottedName, context);

  if (!entries || Object.keys(entries).length === 0) {
    if (start === -1) return finish(lines, text);
    const end = tableBlockEnd(lines, start, dottedName, context);
    const out = lines.slice(0, start).concat(lines.slice(end));
    return finish(out, text);
  }

  const header = `[${dottedName}]`;
  const bodyLines = Object.entries(entries).map(([key, value]) => `${formatTomlKey(key)} = ${formatTomlValue(value)}`);

  if (start === -1) {
    const out = lines.slice();
    while (out.length && out[out.length - 1].trim() === "") out.pop();
    if (out.length) out.push("");
    out.push(header);
    out.push(...bodyLines);
    return finish(out, text);
  }

  const end = tableBlockEnd(lines, start, dottedName, context);
  const out = lines.slice(0, start).concat([header], bodyLines, lines.slice(end));
  return finish(out, text);
}

// End index (exclusive) of the assignment starting at `start`, following the
// value across the continuation lines of a wrapped array/multiline string.
function assignmentEnd(context, start) {
  let end = start + 1;
  while (end < context.length && context[end - 1].open) end++;
  return end;
}

// Remove `key = value` from inside the [table] block — the inline form of a
// child table (`fetch = { command = … }` under [mcp_servers]). setTable can
// only replace a `[table.key]` header block, so a caller that is about to
// write one must drop the inline form first or TOML ends up with the same
// table defined twice. Returns the text unchanged when the key is absent.
function removeTableKey(text, dottedName, key) {
  const lines = text.split(/\r?\n/);
  const context = scanLines(lines);
  const start = findTableStart(lines, dottedName, context);
  if (start === -1) return text;
  const end = tableBlockEnd(lines, start, dottedName, context);
  for (let i = start + 1; i < end; i++) {
    if (context[i].header) break;
    if (context[i].key !== key) continue;
    const stop = Math.min(assignmentEnd(context, i), end);
    return finish(lines.slice(0, i).concat(lines.slice(stop)), text);
  }
  return text;
}

// Read the key/values of a dotted table (scalar values only).
function getTableEntries(text, dottedName) {
  const lines = text.split(/\r?\n/);
  const context = scanLines(lines);
  const start = findTableStart(lines, dottedName, context);
  if (start === -1) return null;
  const end = tableBlockEnd(lines, start, dottedName, context);
  const entries = {};
  for (let i = start + 1; i < end; i++) {
    if (context[i].header) break;
    const key = context[i].key;
    if (!key) continue;
    entries[key] = parseTomlScalar(splitKeyValue(lines[i]).rhs);
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
  removeTableKey,
  parseTomlScalar,
  formatTomlValue,
};
