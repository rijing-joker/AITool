// CLI session history (cc-switch session_manager port, minimal reader):
// scan each AI CLI's on-disk session logs and read them back as a plain
// transcript of {role, content, ts} rows. Providers and layouts mirror
// cc-switch's providers/*.rs: claude (~/.claude/projects/**/*.jsonl), codex
// (~/.codex/sessions + archived_sessions), gemini (~/.gemini/tmp/*/chats).
//
// This is a reader, not the full upstream module: no deletes, no custom
// titles/index DBs, no structured reader UI — those can layer on later.
//
// HOME resolution follows the commandcode-limits convention: explicit `home`
// or env HOME only, never os.homedir(), so tests stay isolated.
//
// `readSession` takes a sourcePath from the client, so every path is clamped
// to the app's own roots before being touched (no arbitrary file reads).

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const TITLE_MAX_CHARS = 80;
const SUMMARY_MAX_CHARS = 160;
const HEAD_LINES = 10;
const TAIL_LINES = 30;
const SMALL_FILE_BYTES = 16_384;

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function resolveHome({ home, env = process.env } = {}) {
  if (isNonEmptyString(home)) return home.trim();
  const envHome = env && typeof env === "object" ? env.HOME : null;
  if (isNonEmptyString(envHome)) return envHome.trim();
  return null;
}

// ---------------------------------------------------------------------------
// Shared value parsing (cc-switch providers/utils.rs)
// ---------------------------------------------------------------------------

function parseTimestampToMs(value) {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    return value > 1_000_000_000_000 ? Math.trunc(value) : Math.trunc(value * 1000);
  }
  if (typeof value === "string") {
    if (/^\d+(?:\.\d+)?$/.test(value.trim())) return parseTimestampToMs(Number(value));
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

function truncateSummary(text, max = SUMMARY_MAX_CHARS) {
  const trimmed = String(text ?? "").trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}...`;
}

// Flatten Anthropic-style content (string | item array | {text}) to text.
// tool_use / toolCall items render as "[Tool: Name]"; tool_result items keep
// their nested text.
function extractText(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map(extractTextFromItem)
      .filter((text) => text && text.trim() !== "")
      .join("\n");
  }
  if (typeof content === "object") return String(content.text ?? "");
  return "";
}

function extractTextFromItem(item) {
  if (item == null || typeof item !== "object") {
    return typeof item === "string" ? item : "";
  }
  const type = item.type ?? "";
  if (type === "tool_use" || type === "toolCall") {
    return `[Tool: ${typeof item.name === "string" && item.name ? item.name : "unknown"}]`;
  }
  if (type === "tool_result") return extractText(item.content);
  if (typeof item.text === "string") return item.text;
  return "";
}

async function readHeadTailLines(filePath, headN = HEAD_LINES, tailN = TAIL_LINES) {
  const raw = await fsp.readFile(filePath, "utf8");
  const lines = raw.split("\n").filter((line) => line !== "");
  if (lines.length <= headN + tailN) return { head: lines, tail: lines };
  return {
    head: lines.slice(0, headN),
    tail: lines.slice(lines.length - tailN),
  };
}

function parseJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

async function collectJsonlFiles(root, files = []) {
  let entries;
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      await collectJsonlFiles(fullPath, files);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(fullPath);
    }
  }
  return files;
}

// ---------------------------------------------------------------------------
// Provider: claude — ~/.claude/projects/**/*.jsonl
// ---------------------------------------------------------------------------

function claudeRoots(home) {
  return [path.join(home, ".claude", "projects")];
}

function isClaudeAgentSession(fileName) {
  return fileName.startsWith("agent-") || fileName === "journal.jsonl";
}

function claudeSessionIdFromPath(filePath) {
  return path.basename(filePath).replace(/\.jsonl$/, "") || null;
}

async function claudeParseSession(filePath) {
  if (isClaudeAgentSession(path.basename(filePath))) return null;
  let headTail;
  try {
    headTail = await readHeadTailLines(filePath);
  } catch {
    return null;
  }
  const { head, tail } = headTail;

  let sessionId = null;
  let projectDir = null;
  let createdAt = null;
  let firstUserMessage = null;
  let lastActiveAt = null;
  let customTitle = null;
  let summary = null;

  for (const line of head) {
    const value = parseJsonLine(line);
    if (!value) continue;
    if (sessionId === null && typeof value.sessionId === "string") sessionId = value.sessionId;
    if (projectDir === null && typeof value.cwd === "string") projectDir = value.cwd;
    if (createdAt === null) createdAt = parseTimestampToMs(value.timestamp);
    if (firstUserMessage === null) {
      const isUser = value.type === "user" || value?.message?.role === "user";
      if (isUser && value.message) {
        const text = extractText(value.message.content).trim();
        if (text !== "" && !text.includes("<local-command-caveat>") && !text.startsWith("<command-name>")) {
          firstUserMessage = text;
        }
      }
    }
  }

  for (let i = tail.length - 1; i >= 0; i -= 1) {
    const value = parseJsonLine(tail[i]);
    if (!value) continue;
    if (lastActiveAt === null) lastActiveAt = parseTimestampToMs(value.timestamp);
    if (customTitle === null && value.type === "custom-title" && typeof value.customTitle === "string" && value.customTitle.trim() !== "") {
      customTitle = value.customTitle.trim();
    }
    if (summary === null && value?.isMeta !== true && value.message) {
      const text = extractText(value.message.content);
      if (text.trim() !== "") summary = text;
    }
  }

  const resolvedId = sessionId ?? claudeSessionIdFromPath(filePath);
  if (!resolvedId) return null;
  const title = customTitle
    ?? (firstUserMessage ? truncateSummary(firstUserMessage, TITLE_MAX_CHARS) : null)
    ?? (projectDir ? path.basename(projectDir) : null);

  return {
    appId: "claude",
    sessionId: resolvedId,
    title,
    summary: summary ? truncateSummary(summary) : null,
    projectDir,
    createdAt,
    lastActiveAt,
    sourcePath: filePath,
    resumeCommand: `claude --resume ${resolvedId}`,
  };
}

async function claudeReadMessages(filePath) {
  const raw = await fsp.readFile(filePath, "utf8");
  const messages = [];
  for (const line of raw.split("\n")) {
    if (line === "") continue;
    const value = parseJsonLine(line);
    if (!value || value.isMeta === true) continue;
    const message = value.message;
    if (!message) continue;
    let role = typeof message.role === "string" ? message.role : "unknown";
    // Claude wraps tool_result inside user messages; reclassify as "tool".
    if (role === "user" && Array.isArray(message.content)) {
      const allToolResults = message.content.length > 0 && message.content.every((item) => item?.type === "tool_result");
      if (allToolResults) role = "tool";
    }
    const content = extractText(message.content);
    if (content.trim() === "") continue;
    messages.push({ role, content, ts: parseTimestampToMs(value.timestamp) });
  }
  return messages;
}

// ---------------------------------------------------------------------------
// Provider: codex — ~/.codex/sessions/**/*.jsonl (+ archived_sessions)
// ---------------------------------------------------------------------------

function codexRoots(home) {
  return [
    path.join(home, ".codex", "sessions"),
    path.join(home, ".codex", "archived_sessions"),
  ];
}

function codexExtractPromptFromIdeContext(text) {
  // IDE-launched sessions carry the user's prompt inside a
  // <user_instructions>/<user_prompt> wrapper; fall back to the raw text.
  const match = text.match(/<user_prompt>([\s\S]*?)<\/user_prompt>/);
  return match ? match[1].trim() : text.trim();
}

async function codexParseSession(filePath) {
  let headTail;
  try {
    headTail = await readHeadTailLines(filePath);
  } catch {
    return null;
  }
  const { head, tail } = headTail;

  let sessionId = null;
  let projectDir = null;
  let createdAt = null;
  let firstUserMessage = null;
  let lastActiveAt = null;
  let summary = null;

  for (const line of head) {
    const value = parseJsonLine(line);
    if (!value) continue;
    if (createdAt === null) createdAt = parseTimestampToMs(value.timestamp);
    if (value.type === "session_meta") {
      const payload = value.payload ?? {};
      if (sessionId === null && typeof payload.id === "string") sessionId = payload.id;
      if (projectDir === null && typeof payload.cwd === "string") projectDir = payload.cwd;
    }
    if (firstUserMessage === null && value.type === "response_item" && value.payload?.type === "message" && value.payload?.role === "user") {
      const text = codexExtractPromptFromIdeContext(extractText(value.payload.content));
      if (text !== "" && !text.includes("<user_instructions>") && !text.startsWith("<environment_context>")) {
        firstUserMessage = text;
      }
    }
  }

  for (let i = tail.length - 1; i >= 0; i -= 1) {
    const value = parseJsonLine(tail[i]);
    if (!value) continue;
    if (lastActiveAt === null) lastActiveAt = parseTimestampToMs(value.timestamp);
    if (summary === null && value.type === "response_item" && value.payload?.type === "message" && value.payload?.role === "assistant") {
      const text = extractText(value.payload.content);
      if (text.trim() !== "") summary = text;
    }
  }

  if (!sessionId) return null;
  const title = (firstUserMessage ? truncateSummary(firstUserMessage, TITLE_MAX_CHARS) : null)
    ?? (projectDir ? path.basename(projectDir) : null);

  return {
    appId: "codex",
    sessionId,
    title,
    summary: summary ? truncateSummary(summary) : null,
    projectDir,
    createdAt,
    lastActiveAt,
    sourcePath: filePath,
    resumeCommand: `codex resume ${sessionId}`,
  };
}

async function codexReadMessages(filePath) {
  const raw = await fsp.readFile(filePath, "utf8");
  const messages = [];
  for (const line of raw.split("\n")) {
    if (line === "") continue;
    const value = parseJsonLine(line);
    if (!value || value.type !== "response_item") continue;
    const payload = value.payload;
    if (!payload) continue;
    let role;
    let content;
    if (payload.type === "message") {
      role = typeof payload.role === "string" ? payload.role : "unknown";
      content = extractText(payload.content);
    } else if (payload.type === "function_call") {
      role = "assistant";
      content = `[Tool: ${typeof payload.name === "string" && payload.name ? payload.name : "unknown"}]`;
    } else if (payload.type === "function_call_output") {
      role = "tool";
      content = typeof payload.output === "string" ? payload.output : "";
    } else {
      continue;
    }
    if (content.trim() === "") continue;
    messages.push({ role, content, ts: parseTimestampToMs(value.timestamp) });
  }
  return messages;
}

// ---------------------------------------------------------------------------
// Provider: gemini — ~/.gemini/tmp/<project>/chats/session-*.json
// ---------------------------------------------------------------------------

function geminiRoots(home) {
  return [path.join(home, ".gemini", "tmp")];
}

async function geminiSessionFiles(home) {
  const files = [];
  const tmpDir = path.join(home, ".gemini", "tmp");
  let projectDirs;
  try {
    projectDirs = await fsp.readdir(tmpDir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of projectDirs) {
    if (!entry.isDirectory()) continue;
    const projectPath = path.join(tmpDir, entry.name);
    const chatsDir = path.join(projectPath, "chats");
    let chatFiles;
    try {
      chatFiles = await fsp.readdir(chatsDir, { withFileTypes: true });
    } catch {
      continue;
    }
    let projectRoot = null;
    try {
      projectRoot = (await fsp.readFile(path.join(projectPath, ".project_root"), "utf8")).trim() || null;
    } catch {
      projectRoot = null;
    }
    for (const chat of chatFiles) {
      if (chat.isFile() && chat.name.endsWith(".json")) {
        files.push({ filePath: path.join(chatsDir, chat.name), projectRoot });
      }
    }
  }
  return files;
}

async function geminiParseSession(filePath, projectRoot) {
  let value;
  try {
    value = JSON.parse(await fsp.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
  if (value == null || typeof value !== "object" || typeof value.sessionId !== "string") return null;

  const createdAt = parseTimestampToMs(value.startTime);
  const lastActive = parseTimestampToMs(value.lastUpdated) ?? createdAt;
  const msgs = Array.isArray(value.messages) ? value.messages : [];
  const firstUser = msgs.find((msg) => msg?.type === "user" && typeof msg.content === "string" && msg.content.trim() !== "");

  return {
    appId: "gemini",
    sessionId: value.sessionId,
    title: firstUser ? truncateSummary(firstUser.content, TITLE_MAX_CHARS) : null,
    summary: firstUser ? truncateSummary(firstUser.content) : null,
    projectDir: projectRoot ?? null,
    createdAt,
    lastActiveAt: lastActive,
    sourcePath: filePath,
    resumeCommand: `gemini --resume ${value.sessionId}`,
  };
}

async function geminiReadMessages(filePath) {
  let value;
  try {
    value = JSON.parse(await fsp.readFile(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Failed to parse session JSON: ${error?.message || error}`);
  }
  const msgs = Array.isArray(value?.messages) ? value.messages : [];
  const messages = [];
  for (const msg of msgs) {
    const type = msg?.type;
    if (type !== "user" && type !== "gemini") continue;
    let content = typeof msg.content === "string"
      ? msg.content
      : Array.isArray(msg.content)
        ? msg.content.filter((item) => item && typeof item.text === "string").map((item) => item.text).join("\n")
        : "";
    if (Array.isArray(msg.toolCalls)) {
      for (const call of msg.toolCalls) {
        if (typeof call?.name === "string") {
          content = `${content}${content ? "\n" : ""}[Tool: ${call.name}]`;
        }
      }
    }
    if (content.trim() === "") continue;
    messages.push({ role: type === "gemini" ? "assistant" : "user", content, ts: parseTimestampToMs(msg.timestamp) });
  }
  return messages;
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

const SESSION_APPS = ["claude", "codex", "gemini"];

function rootsForApp(app, home) {
  if (app === "claude") return claudeRoots(home);
  if (app === "codex") return codexRoots(home);
  if (app === "gemini") return geminiRoots(home);
  throw new Error(`Unsupported app: ${app}`);
}

async function listSessions({ app, home, env = process.env } = {}) {
  if (!SESSION_APPS.includes(app)) throw new Error(`Unsupported app: ${app}`);
  const resolvedHome = resolveHome({ home, env });
  if (!resolvedHome) return [];

  if (app === "gemini") {
    const sessions = [];
    for (const { filePath, projectRoot } of await geminiSessionFiles(resolvedHome)) {
      const meta = await geminiParseSession(filePath, projectRoot);
      if (meta) sessions.push(meta);
    }
    return sortByRecency(sessions);
  }

  const files = [];
  for (const root of rootsForApp(app, resolvedHome)) {
    await collectJsonlFiles(root, files);
  }
  const sessions = [];
  for (const filePath of files) {
    const meta = app === "claude" ? await claudeParseSession(filePath) : await codexParseSession(filePath);
    if (meta) sessions.push(meta);
  }
  return sortByRecency(sessions);
}

function sortByRecency(sessions) {
  return sessions.sort((a, b) => (b.lastActiveAt ?? b.createdAt ?? 0) - (a.lastActiveAt ?? a.createdAt ?? 0));
}

function pathIsInsideRoot(sourcePath, root) {
  const relative = path.relative(root, sourcePath);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

async function readSession({ app, sourcePath, home, env = process.env } = {}) {
  if (!SESSION_APPS.includes(app)) throw new Error(`Unsupported app: ${app}`);
  const resolvedHome = resolveHome({ home, env });
  if (!resolvedHome || !isNonEmptyString(sourcePath)) {
    throw new Error("Session path is required");
  }
  const resolved = path.resolve(sourcePath);
  const inside = rootsForApp(app, resolvedHome).some((root) => pathIsInsideRoot(resolved, root));
  if (!inside) {
    throw new Error("Session path is outside this app's session roots");
  }
  if (app === "gemini" && path.extname(resolved) !== ".json") {
    throw new Error("Not a gemini session file");
  }
  if (app !== "gemini" && path.extname(resolved) !== ".jsonl") {
    throw new Error("Not a session transcript file");
  }
  if (app === "claude" && isClaudeAgentSession(path.basename(resolved))) {
    throw new Error("Not a claude session file");
  }
  const messages = app === "claude"
    ? await claudeReadMessages(resolved)
    : app === "codex"
      ? await codexReadMessages(resolved)
      : await geminiReadMessages(resolved);
  return { sourcePath: resolved, messages };
}

function listSessionApps({ home, env = process.env } = {}) {
  const resolvedHome = resolveHome({ home, env });
  return SESSION_APPS.map((app) => ({
    id: app,
    available: resolvedHome ? rootsForApp(app, resolvedHome).some((root) => {
      try {
        return fs.statSync(root).isDirectory();
      } catch {
        return false;
      }
    }) : false,
  }));
}

module.exports = {
  SESSION_APPS,
  listSessionApps,
  listSessions,
  readSession,
  // exposed for tests
  extractText,
  parseTimestampToMs,
  truncateSummary,
};
