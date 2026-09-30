// Line-preserving .env editor for ~/.gemini/.env, ported from cc-switch's
// parse_env_file / remove_env_entries_preserving_layout: setting a key
// replaces its line in place (keeping any leading comment lines and blank
// layout around it); removing a key drops just that line. Comments and
// unrelated entries are byte-preserved.

function parseKey(line) {
  const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
  return m ? m[1] : null;
}

function splitValue(line) {
  const m = line.match(/^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.*?)\s*$/);
  return m ? m[1] : "";
}

function unquote(value) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

// Parse into [{ key, value }] entries (comments/blank lines skipped).
function parseEnvFile(text) {
  const entries = [];
  for (const line of text.split(/\r?\n/)) {
    const key = parseKey(line);
    if (!key) continue;
    entries.push({ key, value: unquote(splitValue(line)) });
  }
  return entries;
}

function formatEnvValue(value) {
  const text = String(value);
  if (/[\s#"']/.test(text) || text === "") {
    return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return text;
}

// Set key=value, replacing an existing line in place or appending at the end.
function setEnvValue(text, key, value) {
  const lines = text.split(/\r?\n/);
  const newline = `${key}=${formatEnvValue(value)}`;
  let replaced = false;
  const out = lines.map((line) => {
    if (!replaced && parseKey(line) === key) {
      replaced = true;
      return newline;
    }
    return line;
  });
  if (!replaced) {
    while (out.length && out[out.length - 1].trim() === "") out.pop();
    out.push(newline);
  }
  return finish(out, text);
}

// Remove every line assigning `key`, preserving all other lines.
function removeEnvValue(text, key) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    if (parseKey(line) === key) continue;
    out.push(line);
  }
  return finish(out, text);
}

function getEnvValue(text, key) {
  for (const entry of parseEnvFile(text)) {
    if (entry.key === key) return entry.value;
  }
  return undefined;
}

function finish(out, originalText) {
  let text = out.join("\n");
  if (originalText.endsWith("\n")) {
    if (!text.endsWith("\n")) text += "\n";
  } else {
    text = text.replace(/\n+$/, "");
  }
  return text;
}

module.exports = {
  parseEnvFile,
  setEnvValue,
  removeEnvValue,
  getEnvValue,
  formatEnvValue,
};
