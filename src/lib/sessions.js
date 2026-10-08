// CLI session history (cc-switch session_manager port, minimal reader):
// scan each AI CLI's on-disk session logs and read them back as a plain
// transcript of {role, content, ts} rows. Providers and layouts mirror
// cc-switch's providers/*.rs: claude (~/.claude/projects/**/*.jsonl), codex
// (~/.codex/sessions + archived_sessions), gemini (~/.gemini/tmp/*/chats).
//
// Messages carry light structure on top of the plain transcript: assistant
// rows may include `toolCalls` [{id/name/input} shapes], tool rows carry
// `toolResults`, and assistant rows carry per-message `usage` + `model` where
// the source files attribute tokens per message (claude/gemini).
//
// Resolve explicit `home`, then HOME / Windows USERPROFILE. An injected
// environment never falls through to the real user's home, keeping tests isolated.
//
// `readSession` takes a sourcePath from the client, so every path is clamped
// to the app's own roots before being touched (no arbitrary file reads).

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { createUsageDeltaState, consumeUsageDelta } = require("./codex-token-usage");

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
  for (const key of ["HOME", "USERPROFILE"]) {
    const envHome = env && typeof env === "object" ? env[key] : null;
    if (isNonEmptyString(envHome)) return envHome.trim();
  }
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

// Thinking rows render as a collapsed block in the reader; cap the captured
// text so a runaway reasoning stream cannot bloat the API response.
const THINKING_MAX_CHARS = 32 * 1024;

function capThinking(text) {
  const trimmed = String(text ?? "").trim();
  if (trimmed === "") return null;
  return trimmed.length > THINKING_MAX_CHARS ? `${trimmed.slice(0, THINKING_MAX_CHARS)}\n…` : trimmed;
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

// Session usage totals (cc-switch services/session_usage*.rs, minimal): token
// sums read back from the same transcript files, used for the reader header.
// `inputInclusive` mirrors the upstream semantics split: Claude reports fresh
// input tokens with independent cache fields, while Codex/OpenAI and Gemini
// report input already including cache reads.
function emptyUsage(inputInclusive) {
  return {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: 0,
    durationMs: null,
    inputInclusive,
    model: null,
  };
}

function trackSpan(usage, ts) {
  if (ts == null) return;
  if (usage.firstTs == null || ts < usage.firstTs) usage.firstTs = ts;
  if (usage.lastTs == null || ts > usage.lastTs) usage.lastTs = ts;
}

function finalizeUsage(usage) {
  if (usage.firstTs != null && usage.lastTs != null && usage.lastTs > usage.firstTs) {
    usage.durationMs = usage.lastTs - usage.firstTs;
  }
  delete usage.firstTs;
  delete usage.lastTs;
  // Per-model token sums so the reader header can price a mixed-model
  // session at each model's own rate (cc-switch prices per imported row).
  const perModel = usage.perModel instanceof Map ? usage.perModel : new Map();
  usage.perModel = Array.from(perModel.values()).sort((a, b) =>
    (b.inputTokens + b.outputTokens + b.reasoningTokens + b.cacheReadTokens + b.cacheCreationTokens)
    - (a.inputTokens + a.outputTokens + a.reasoningTokens + a.cacheReadTokens + a.cacheCreationTokens));
  const dominant = usage.perModel[0];
  usage.model = dominant && dominant.model !== "unknown" ? dominant.model : (usage.model ?? null);
  return usage;
}

/** Accumulate one token row into the per-model breakdown. */
function trackModelUsage(usage, model, row) {
  const perModel = usage.perModel instanceof Map ? usage.perModel : new Map();
  usage.perModel = perModel;
  const key = model || "unknown";
  let entry = perModel.get(key);
  if (!entry) {
    entry = { model: key, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
    perModel.set(key, entry);
  }
  entry.inputTokens += row.inputTokens;
  entry.outputTokens += row.outputTokens;
  entry.reasoningTokens += row.reasoningTokens;
  entry.cacheReadTokens += row.cacheReadTokens;
  entry.cacheCreationTokens += row.cacheCreationTokens;
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
  // Claude can rewrite the same assistant message (streaming retries); keep
  // the row with the larger output_tokens per message id, like cc-switch does.
  const usageById = new Map();
  const usage = emptyUsage(false);
  for (const line of raw.split("\n")) {
    if (line === "") continue;
    const value = parseJsonLine(line);
    if (!value || value.isMeta === true) continue;
    trackSpan(usage, parseTimestampToMs(value.timestamp));
    const message = value.message;
    if (!message) continue;
    let role = typeof message.role === "string" ? message.role : "unknown";
    let toolCalls = null;
    let toolResults = null;
    // Claude wraps tool_result inside user messages; reclassify as "tool".
    if (role === "user" && Array.isArray(message.content)) {
      const results = message.content.filter((item) => item?.type === "tool_result");
      if (message.content.length > 0 && results.length === message.content.length) role = "tool";
      if (results.length > 0) {
        toolResults = results.map((item) => ({
          toolUseId: typeof item.tool_use_id === "string" ? item.tool_use_id : null,
          content: extractText(item.content),
        }));
      }
    }
    if (role === "assistant" && Array.isArray(message.content)) {
      const calls = message.content.filter((item) => item?.type === "tool_use");
      if (calls.length > 0) {
        toolCalls = calls.map((item) => ({
          id: typeof item.id === "string" ? item.id : null,
          name: typeof item.name === "string" ? item.name : "unknown",
          input: item.input ?? null,
        }));
      }
    }
    const thinking = role === "assistant" && Array.isArray(message.content)
      ? capThinking(message.content
          .filter((item) => item?.type === "thinking" && typeof item.thinking === "string")
          .map((item) => item.thinking)
          .join("\n"))
      : null;
    const content = extractText(message.content);
    if (content.trim() !== "" || thinking || toolCalls || toolResults) {
      const row = { role, content, ts: parseTimestampToMs(value.timestamp) };
      if (thinking) row.thinking = thinking;
      if (toolCalls) row.toolCalls = toolCalls;
      if (toolResults) row.toolResults = toolResults;
      // Attach the winning usage row to its message after retries resolve.
      if (role === "assistant" && typeof message.id === "string" && message.id) row._msgId = message.id;
      if (role === "assistant" && typeof message.model === "string" && message.model) row.model = message.model;
      messages.push(row);
    }

    if (role === "assistant" && message.usage && typeof message.usage === "object") {
      // cc-switch imports only id-carrying assistant usage rows; synthetic or
      // error rows without a message id are skipped rather than summed.
      const id = typeof message.id === "string" && message.id ? message.id : null;
      if (id) {
        const row = {
          inputTokens: Number(message.usage.input_tokens) || 0,
          outputTokens: Number(message.usage.output_tokens) || 0,
          cacheReadTokens: Number(message.usage.cache_read_input_tokens) || 0,
          cacheCreationTokens: Number(message.usage.cache_creation_input_tokens) || 0,
          reasoningTokens: 0,
          model: typeof message.model === "string" && message.model ? message.model : null,
          stopReason: typeof message.stop_reason === "string" && message.stop_reason ? message.stop_reason : null,
        };
        const existing = usageById.get(id);
        // Same retry-write rule as upstream: a row with a stop_reason always
        // beats one without; among equal presence the larger output wins.
        if (!existing
          || (row.stopReason && !existing.stopReason)
          || (!row.stopReason === !existing.stopReason && row.outputTokens > existing.outputTokens)) {
          usageById.set(id, row);
        }
      }
    }
  }
  for (const row of usageById.values()) {
    usage.inputTokens += row.inputTokens;
    usage.outputTokens += row.outputTokens;
    usage.cacheReadTokens += row.cacheReadTokens;
    usage.cacheCreationTokens += row.cacheCreationTokens;
    trackModelUsage(usage, row.model, row);
  }
  usage.totalTokens = usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheCreationTokens;
  for (const row of messages) {
    if (!row._msgId) continue;
    const rowUsage = usageById.get(row._msgId);
    delete row._msgId;
    if (rowUsage) {
      row.usage = {
        inputTokens: rowUsage.inputTokens,
        outputTokens: rowUsage.outputTokens,
        cacheReadTokens: rowUsage.cacheReadTokens,
        cacheCreationTokens: rowUsage.cacheCreationTokens,
      };
    }
  }
  return { messages, usage: finalizeUsage(usage) };
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
  // Attribute cumulative increments to the model active for each event.
  // Input includes cache reads; reasoning is already included in output.
  const usage = emptyUsage(true);
  const usageState = createUsageDeltaState();
  const snapshot = (value) => value && typeof value === "object" && !Array.isArray(value) ? {
    ...value,
    cached_input_tokens: value.cached_input_tokens ?? value.cache_read_input_tokens,
    total_tokens: value.total_tokens ?? ((Number(value.input_tokens) || 0) + (Number(value.output_tokens) || 0)),
  } : null;
  let usageSeen = false;
  for (const line of raw.split("\n")) {
    if (line === "") continue;
    const value = parseJsonLine(line);
    if (!value) continue;
    trackSpan(usage, parseTimestampToMs(value.timestamp));
    if (value.type === "turn_context" && typeof value.payload?.model === "string" && value.payload.model) {
      usage.model = value.payload.model;
    }
    if (value.type === "event_msg" && value.payload?.type === "token_count") {
      const info = value.payload.info;
      // Sessions can switch models mid-flight; the model rides turn_context
      // and the token_count info block — the last one seen wins.
      if (typeof info?.model === "string" && info.model) usage.model = info.model;
      else if (typeof info?.model_name === "string" && info.model_name) usage.model = info.model_name;
      const delta = consumeUsageDelta(usageState, snapshot(info?.last_token_usage), snapshot(info?.total_token_usage));
      if (delta) {
        const row = {
          inputTokens: delta.input_tokens,
          outputTokens: delta.output_tokens,
          reasoningTokens: delta.reasoning_output_tokens,
          cacheReadTokens: delta.cached_input_tokens,
          cacheCreationTokens: 0,
        };
        trackModelUsage(usage, usage.model, row);
        for (const [key, count] of Object.entries(row)) usage[key] += count;
        usage.totalTokens += delta.total_tokens;
        usageSeen = true;
      }
    }
    if (value.type !== "response_item") continue;
    const payload = value.payload;
    if (!payload) continue;
    let role;
    let content;
    let toolCalls = null;
    let toolResults = null;
    if (payload.type === "message") {
      role = typeof payload.role === "string" ? payload.role : "unknown";
      content = extractText(payload.content);
    } else if (payload.type === "function_call" || payload.type === "custom_tool_call") {
      role = "assistant";
      toolCalls = [{
        callId: typeof payload.call_id === "string" ? payload.call_id : null,
        name: typeof payload.name === "string" && payload.name ? payload.name : "unknown",
        ...(payload.type === "custom_tool_call"
          ? { input: typeof payload.input === "string" ? payload.input : null }
          : { arguments: typeof payload.arguments === "string" ? payload.arguments : null }),
      }];
      content = "";
    } else if (payload.type === "function_call_output" || payload.type === "custom_tool_call_output") {
      role = "tool";
      toolResults = [{
        callId: typeof payload.call_id === "string" ? payload.call_id : null,
        output: typeof payload.output === "string" ? payload.output : "",
      }];
      content = typeof payload.output === "string" ? payload.output : "";
    } else if (payload.type === "reasoning") {
      // Reasoning summaries render as their own collapsed thinking row.
      const summary = Array.isArray(payload.summary)
        ? payload.summary.filter((item) => typeof item?.text === "string").map((item) => item.text).join("\n")
        : "";
      const thinking = capThinking(summary);
      if (!thinking) continue;
      messages.push({ role: "assistant", content: "", thinking, ts: parseTimestampToMs(value.timestamp) });
      continue;
    } else {
      continue;
    }
    if (content.trim() === "" && !toolCalls && !toolResults) continue;
    const row = { role, content, ts: parseTimestampToMs(value.timestamp) };
    if (toolCalls) row.toolCalls = toolCalls;
    if (toolResults) row.toolResults = toolResults;
    messages.push(row);
  }
  if (!usageSeen) return { messages, usage: null };
  return { messages, usage: finalizeUsage(usage) };
}

// ---------------------------------------------------------------------------
// Provider: gemini — ~/.gemini/tmp/<project>/chats/session-*.json
// ---------------------------------------------------------------------------

function geminiRoots(home) {
  return [path.join(home, ".gemini", "tmp")];
}

// Newer Gemini CLI writes chats as a JSONL replay log (cc-switch cddb3b6):
// metadata checkpoint lines carry a sessionId, message lines carry an id and
// are upserted in place by that id, {"$set":{...}} merges metadata (messages
// replaced wholesale), {"$rewindTo":id} truncates. Resume migrates old .json
// chats to .jsonl and leaves the stale .json behind, so .json is only listed
// when no same-basename .jsonl exists.
function geminiIsInjectedContext(text) {
  const trimmed = String(text || "").trimStart();
  return trimmed.startsWith("<session_context>")
    || trimmed.startsWith("<hook_context>")
    || trimmed.startsWith("<environment_context>")
    || trimmed.startsWith("<user_instructions>")
    || trimmed.startsWith("/");
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
      const realChatsDir = await resolveSessionPath(chatsDir, geminiRoots(home));
      chatFiles = await fsp.readdir(realChatsDir, { withFileTypes: true });
    } catch {
      continue;
    }
    let projectRoot = null;
    try {
      const marker = await resolveSessionPath(path.join(projectPath, ".project_root"), geminiRoots(home));
      projectRoot = (await fsp.readFile(marker, "utf8")).trim() || null;
    } catch {
      projectRoot = null;
    }
    const jsonlStems = new Set();
    for (const chat of chatFiles) {
      if (chat.isFile() && chat.name.endsWith(".jsonl")) jsonlStems.add(chat.name.slice(0, -".jsonl".length));
    }
    for (const chat of chatFiles) {
      if (!chat.isFile()) continue;
      if (chat.name.endsWith(".jsonl")) {
        files.push({ filePath: path.join(chatsDir, chat.name), projectRoot });
      } else if (chat.name.endsWith(".json") && !jsonlStems.has(chat.name.slice(0, -".json".length))) {
        files.push({ filePath: path.join(chatsDir, chat.name), projectRoot });
      }
    }
  }
  return files;
}

// Replays a Gemini CLI JSONL chat log into {metadata, messages}.
function geminiParseJsonlDocument(raw) {
  let metadata = null;
  const messages = [];
  const indexById = new Map();
  const pushMessage = (msg) => {
    if (!msg || typeof msg !== "object") return;
    if (typeof msg.id !== "string" && typeof msg.id !== "number") return;
    const key = String(msg.id);
    const existingIdx = indexById.get(key);
    if (existingIdx !== undefined) messages[existingIdx] = msg;
    else {
      indexById.set(key, messages.length);
      messages.push(msg);
    }
  };
  const replaceMessages = (list) => {
    messages.length = 0;
    indexById.clear();
    for (const msg of Array.isArray(list) ? list : []) pushMessage(msg);
  };
  for (const line of String(raw ?? "").split("\n")) {
    if (line === "") continue;
    const value = parseJsonLine(line);
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    // Message lines (they carry an id) are checked first so a format variant
    // that also repeats sessionId on message rows still upserts as a message.
    if (value.id != null && value.$set === undefined && value.$rewindTo === undefined) {
      pushMessage(value);
      continue;
    }
    if (typeof value.sessionId === "string") {
      metadata = { ...(metadata || {}), ...value };
      if (Array.isArray(value.messages)) replaceMessages(value.messages);
      continue;
    }
    if (value.$set && typeof value.$set === "object") {
      const { messages: patched, ...rest } = value.$set;
      metadata = { ...(metadata || {}), ...rest };
      if (Array.isArray(patched)) replaceMessages(patched);
      continue;
    }
    if (value.$rewindTo !== undefined) {
      const idx = indexById.get(String(value.$rewindTo));
      if (idx !== undefined) {
        for (const dropped of messages.slice(idx + 1)) indexById.delete(String(dropped.id));
        messages.length = idx + 1;
      }
      continue;
    }
    pushMessage(value);
  }
  return { metadata, messages };
}

async function geminiLoadDocument(filePath) {
  const raw = await fsp.readFile(filePath, "utf8");
  if (filePath.endsWith(".jsonl")) {
    const { metadata, messages } = geminiParseJsonlDocument(raw);
    if (!metadata || typeof metadata.sessionId !== "string") return null;
    return { metadata, messages };
  }
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (value == null || typeof value !== "object" || typeof value.sessionId !== "string") return null;
  return { metadata: value, messages: Array.isArray(value.messages) ? value.messages : [] };
}

function geminiFirstUserTitle(msgs) {
  for (const msg of msgs) {
    if (msg?.type !== "user") continue;
    const content = typeof msg.content === "string" ? msg.content : "";
    if (content.trim() === "" || geminiIsInjectedContext(content)) continue;
    return content;
  }
  return null;
}

async function geminiParseSession(filePath, projectRoot) {
  let doc;
  try {
    doc = await geminiLoadDocument(filePath);
  } catch {
    return null;
  }
  if (!doc) return null;
  const { metadata, messages } = doc;
  const createdAt = parseTimestampToMs(metadata.startTime);
  const lastActive = parseTimestampToMs(metadata.lastUpdated) ?? createdAt;
  const firstUser = geminiFirstUserTitle(messages);

  return {
    appId: "gemini",
    sessionId: metadata.sessionId,
    title: firstUser ? truncateSummary(firstUser, TITLE_MAX_CHARS) : null,
    summary: firstUser ? truncateSummary(firstUser) : null,
    projectDir: projectRoot ?? null,
    createdAt,
    lastActiveAt: lastActive,
    sourcePath: filePath,
    resumeCommand: `gemini --resume ${metadata.sessionId}`,
  };
}

async function geminiReadMessages(filePath) {
  let doc;
  try {
    doc = await geminiLoadDocument(filePath);
  } catch (error) {
    throw new Error(`Failed to parse session JSON: ${error?.message || error}`);
  }
  if (!doc) throw new Error("Failed to parse session JSON: missing sessionId");
  const { metadata, messages: msgs } = doc;
  const messages = [];
  // Per-message `tokens` fields ({input, output, thoughts, cached}); input is
  // inclusive of cached tokens (Gemini semantics).
  const usage = emptyUsage(true);
  const startTs = parseTimestampToMs(metadata?.startTime);
  const endTs = parseTimestampToMs(metadata?.lastUpdated) ?? startTs;
  trackSpan(usage, startTs);
  trackSpan(usage, endTs);
  for (const msg of msgs) {
    const type = msg?.type;
    if (type !== "user" && type !== "gemini") continue;
    if (typeof msg.model === "string" && msg.model) usage.model = msg.model;
    const tokens = msg.tokens && typeof msg.tokens === "object" ? msg.tokens : null;
    let rowUsage = null;
    if (tokens) {
      const row = {
        inputTokens: Number(tokens.input) || 0,
        outputTokens: Number(tokens.output) || 0,
        reasoningTokens: Number(tokens.thoughts) || 0,
        cacheReadTokens: Number(tokens.cached) || 0,
        cacheCreationTokens: 0,
      };
      usage.inputTokens += row.inputTokens;
      usage.outputTokens += row.outputTokens;
      usage.reasoningTokens += row.reasoningTokens;
      usage.cacheReadTokens += row.cacheReadTokens;
      trackModelUsage(usage, msg.model, row);
      rowUsage = {
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        reasoningTokens: row.reasoningTokens,
        cacheReadTokens: row.cacheReadTokens,
      };
    }
    const thinking = Array.isArray(msg.content)
      ? capThinking(msg.content
          .filter((item) => item?.thought === true && typeof item.text === "string")
          .map((item) => item.text)
          .join("\n"))
      : null;
    const content = typeof msg.content === "string"
      ? msg.content
      : Array.isArray(msg.content)
        ? msg.content.filter((item) => item && item.thought !== true && typeof item.text === "string").map((item) => item.text).join("\n")
        : "";
    let toolCalls = null;
    if (Array.isArray(msg.toolCalls)) {
      const calls = msg.toolCalls.filter((call) => call && typeof call.name === "string");
      if (calls.length > 0) {
        toolCalls = calls.map((call) => ({
          name: call.name,
          args: call.args ?? null,
        }));
      }
    }
    if (content.trim() === "" && !thinking && !toolCalls) continue;
    const row = { role: type === "gemini" ? "assistant" : "user", content, ts: parseTimestampToMs(msg.timestamp) };
    if (thinking) row.thinking = thinking;
    if (toolCalls) row.toolCalls = toolCalls;
    if (rowUsage) row.usage = rowUsage;
    messages.push(row);
  }
  usage.totalTokens = usage.inputTokens + usage.outputTokens + usage.reasoningTokens;
  return { messages, usage: finalizeUsage(usage) };
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

async function resolveSessionPath(sourcePath, roots) {
  // Require both the client path and its actual target to belong to the same
  // app root. Resolve the root too so a user-relocated session directory works.
  const matchingRoots = roots.filter((root) => pathIsInsideRoot(sourcePath, root));
  if (matchingRoots.length) {
    const realPath = await fsp.realpath(sourcePath);
    for (const root of matchingRoots) {
      const realRoot = await fsp.realpath(root);
      if (pathIsInsideRoot(realPath, realRoot)) return realPath;
    }
  }
  throw new Error("Session path is outside this app's session roots");
}

async function readSession({ app, sourcePath, home, env = process.env } = {}) {
  if (!SESSION_APPS.includes(app)) throw new Error(`Unsupported app: ${app}`);
  const resolvedHome = resolveHome({ home, env });
  if (!resolvedHome || !isNonEmptyString(sourcePath)) {
    throw new Error("Session path is required");
  }
  const resolved = path.resolve(sourcePath);
  const realPath = await resolveSessionPath(resolved, rootsForApp(app, resolvedHome));
  if (app === "gemini" && path.extname(realPath) !== ".json" && path.extname(realPath) !== ".jsonl") {
    throw new Error("Not a gemini session file");
  }
  if (app !== "gemini" && path.extname(realPath) !== ".jsonl") {
    throw new Error("Not a session transcript file");
  }
  if (app === "claude" && (isClaudeAgentSession(path.basename(resolved)) || isClaudeAgentSession(path.basename(realPath)))) {
    throw new Error("Not a claude session file");
  }
  const transcript = app === "claude"
    ? await claudeReadMessages(realPath)
    : app === "codex"
      ? await codexReadMessages(realPath)
      : await geminiReadMessages(realPath);
  return { sourcePath: resolved, messages: transcript.messages, usage: transcript.usage };
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
