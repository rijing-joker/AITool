const { cacheCreation1h } = require("./cache-tokens");
const codexFiles = require("./codex-rollout-file");
const { normalizeShellOutput, geminiToolResult } = require("./session-tool-results");
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
const { createHash } = require("node:crypto");
const { TranscriptCache, previewTranscript, contentPage } = require("./session-transcript-cache");
const sessionSources = require("./session-sources");
const {
  codexSessionIdFromPath,
} = require("./rollout");

const TITLE_MAX_CHARS = 80;
const SUMMARY_MAX_CHARS = 160;
const HEAD_LINES = 10;
const TAIL_LINES = 30;
const SMALL_FILE_BYTES = 16_384;
const metadataCache = new Map();
const titleIndexCache = new Map();
const transcriptCache = new TranscriptCache();
const codexLineageCache = new Map();

async function codexTranscriptFiles(resolved, realPath, roots) {
  const candidates = [];
  for (const root of roots) await collectJsonlFiles(root, candidates, { compressed: true });
  const inventory = codexFiles.dedupeSiblings(candidates);
  const thread = codexFiles.rolloutIds(resolved)?.thread || codexFiles.rolloutIds(realPath)?.thread;
  const pages = [];
  for (const file of thread ? inventory.filter(file => codexFiles.rolloutIds(file)?.thread === thread) : [realPath]) {
    try { pages.push(await resolveSessionPath(file, roots)); } catch { /* root clamp every page */ }
  }
  if (!pages.length) pages.push(await resolveSessionPath(realPath, roots));
  pages.sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
  const parents = new Set();
  for (const file of pages) {
    const stamp = codexFiles.signature(await fsp.stat(file));
    let lineage = codexLineageCache.get(file);
    if (lineage?.stamp !== stamp) {
      const ids = new Set();
      for (const line of (await codexFiles.readText(file)).split("\n")) {
        const row = parseJsonLine(line);
        if (row?.type === "session_meta") {
          const metadata = require("./codex-fork-replay").forkReplayMetadata(row.payload);
          for (const id of Object.values(metadata || {})) if (id) ids.add(id);
        }
      }
      lineage = { stamp, ids: [...ids] };
      codexLineageCache.set(file, lineage);
      if (codexLineageCache.size > 256) codexLineageCache.delete(codexLineageCache.keys().next().value);
    }
    for (const id of lineage.ids) parents.add(id);
  }
  const dependencies = new Set(pages);
  for (const file of inventory) {
    const ids = codexFiles.rolloutIds(file);
    if (!ids || (!parents.has(ids.thread) && !parents.has(ids.rollout))) continue;
    try { dependencies.add(await resolveSessionPath(file, roots)); } catch { /* root clamp every parent */ }
  }
  return { pages: [...new Set(pages)], dependencies: [...dependencies].sort() };
}

async function transcriptRevision(app, files) {
  const stats = await Promise.all(files.map(async file => {
    const stat = await fsp.stat(file);
    return [file, stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs];
  }));
  return createHash("sha256").update(JSON.stringify([app, stats])).digest("hex");
}

async function cachedMetadata(filePath, app) {
  const stat = await fsp.stat(filePath).catch(() => null);
  if (!stat) return null;
  const signature = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  const cached = metadataCache.get(filePath);
  if (cached?.signature === signature) return cached.value ? { ...cached.value } : null;
  const value = app === "claude" ? await claudeParseSession(filePath) : await codexParseSession(filePath);
  metadataCache.delete(filePath);
  metadataCache.set(filePath, { signature, value });
  if (metadataCache.size > 512) metadataCache.delete(metadataCache.keys().next().value);
  return value ? { ...value } : null;
}

async function codexNativeTitles(home) {
  const root = path.join(home, ".codex");
  const sourcePath = path.join(root, "session_index.jsonl");
  let realPath;
  try { realPath = await resolveSessionPath(sourcePath, [root]); } catch { return new Map(); }
  const stat = await fsp.stat(realPath).catch(() => null);
  if (!stat) return new Map();
  const signature = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  const cached = titleIndexCache.get(realPath);
  if (cached?.signature === signature) return cached.titles;
  const titles = new Map();
  const raw = await fsp.readFile(realPath, "utf8").catch(() => "");
  for (const line of raw.split("\n")) {
    const row = parseJsonLine(line);
    if (typeof row?.id === "string" && typeof row.thread_name === "string" && row.thread_name.trim()) titles.set(row.id, row.thread_name.trim());
  }
  titleIndexCache.set(realPath, { signature, titles });
  if (titleIndexCache.size > 8) titleIndexCache.delete(titleIndexCache.keys().next().value);
  return titles;
}

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

// Inline raster images are bounded independently and across the transcript.
const IMAGE_MAX_BASE64_CHARS = 2 * 1024 * 1024;
const IMAGES_TOTAL_MAX_BASE64_CHARS = 8 * 1024 * 1024;
const IMAGE_MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

function extractImageFromItem(item, budget) {
  if (item == null || typeof item !== "object" || item.type !== "image") return null;
  const source = item.source;
  if (source == null || typeof source !== "object" || source.type !== "base64") return null;
  const mediaType = source.media_type;
  const data = typeof source.data === "string" ? source.data : "";
  if (!IMAGE_MEDIA_TYPES.has(mediaType) || !data || data.length % 4 !== 0) return null;
  // Avoid decoding a large attachment just to validate its transport encoding.
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  const encoded = data.slice(0, data.length - padding);
  if (/[^A-Za-z0-9+/]/.test(encoded)) return null;
  const entry = { mediaType, byteLength: data.length / 4 * 3 - padding };
  if (data.length > IMAGE_MAX_BASE64_CHARS || data.length > budget.remaining) {
    entry.oversized = true;
    return entry;
  }
  budget.remaining -= data.length;
  entry.dataUrl = `data:${mediaType};base64,${data}`;
  return entry;
}

function thinkingText(text) {
  const trimmed = String(text ?? "").trim();
  if (trimmed === "") return null;
  return trimmed;
}

// Claude Code keeps session metadata (custom-title, relocated, …) within the
// last 64 KiB of the transcript instead of appending it after every turn, so
// a `/cd` record can sit tens of kilobytes before EOF — beyond the tail-line
// window used for titles (cc-switch ea8bc2c). Returns the last relocated
// target, or null when the transcript never moved.
const RELOCATED_TAIL_BYTES = 64 * 1024;

async function lastRelocatedCwd(filePath) {
  let file;
  try {
    file = await fsp.open(filePath, "r");
    const { size } = await file.stat();
    const start = Math.max(0, size - RELOCATED_TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
    const lines = buffer.subarray(0, bytesRead).toString("utf8").split("\n");
    // Seeking into the middle of a line leaves a partial first line.
    if (start > 0 && lines.length) lines.shift();
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (!lines[i].includes("\"relocated\"")) continue;
      const value = parseJsonLine(lines[i]);
      if (value?.type !== "relocated") continue;
      const cwd = typeof value.relocatedCwd === "string" ? value.relocatedCwd.trim() : "";
      if (cwd !== "") return cwd;
    }
    return null;
  } catch {
    return null;
  } finally {
    if (file) await file.close().catch(() => {});
  }
}

async function readHeadTailLines(filePath, headN = HEAD_LINES, tailN = TAIL_LINES) {
  const file = await fsp.open(filePath, "r");
  try {
    const { size } = await file.stat();
    const read = async (start, length) => {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await file.read(buffer, 0, length, start);
      return buffer.subarray(0, bytesRead);
    };
    const nonempty = text => text.split("\n").filter(line => line !== "");
    if (size <= SMALL_FILE_BYTES) {
      const lines = nonempty((await read(0, size)).toString("utf8"));
      if (lines.length <= headN + tailN) return { head: lines, tail: lines };
      return { head: lines.slice(0, headN), tail: lines.slice(-tailN) };
    }
    // Read complete lines from either end. Long individual JSON records can
    // span chunks; decode only after joining so UTF-8 is never split mid-codepoint.
    const chunk = 64 * 1024;
    let end = 0, headBuffer = Buffer.alloc(0), head = [];
    while (end < size) {
      const buffer = await read(end, Math.min(chunk, size - end));
      if (!buffer.length) break;
      end += buffer.length;
      headBuffer = Buffer.concat([headBuffer, buffer]);
      const text = headBuffer.toString("utf8");
      head = nonempty(end < size ? text.slice(0, text.lastIndexOf("\n") + 1) : text);
      if (head.length >= headN) break;
    }
    let start = size, tailBuffer = Buffer.alloc(0), tail = [];
    while (start > 0) {
      const next = Math.max(0, start - chunk);
      tailBuffer = Buffer.concat([await read(next, start - next), tailBuffer]);
      start = next;
      const text = tailBuffer.toString("utf8");
      tail = nonempty(start > 0 ? text.slice(text.indexOf("\n") + 1) : text);
      if (tail.length >= tailN) break;
    }
    return { head: head.slice(0, headN), tail: tail.slice(-tailN) };
  } finally { await file.close(); }
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
    entry = { model: key, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, cacheCreation1hTokens: 0 };
    perModel.set(key, entry);
  }
  entry.inputTokens += row.inputTokens;
  entry.outputTokens += row.outputTokens;
  entry.reasoningTokens += row.reasoningTokens;
  entry.cacheReadTokens += row.cacheReadTokens;
  entry.cacheCreationTokens += row.cacheCreationTokens;
  entry.cacheCreation1hTokens = (entry.cacheCreation1hTokens || 0) + (row.cacheCreation1hTokens || 0);
}

async function collectJsonlFiles(root, files = [], { compressed = false } = {}) {
  let entries;
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return files;
  }
  const plainNames = compressed
    ? new Set(entries.filter((e) => e.isFile() && e.name.endsWith(".jsonl")).map((e) => e.name))
    : null;
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      await collectJsonlFiles(fullPath, files, { compressed });
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(fullPath);
    } else if (
      compressed &&
      entry.isFile() &&
      codexFiles.isCompressed(entry.name) &&
      // When Codex compression briefly leaves both forms in place, the plain
      // file is the source of truth (cc-switch 8641cd1).
      !plainNames.has(codexFiles.logicalPath(entry.name))
    ) {
      files.push(fullPath);
    }
  }
  return files;
}

// cc-switch 8641cd1 lists compressed sessions by decompressing only the head
// ("so scanning tens of GB stays fast"): the zstd transform stream stops once
// the head budget is collected, instead of materializing the whole file per
// listed row. Runtimes without the stream API (Node < 24) fall back to the
// capped full decompress.
const COMPRESSED_HEAD_BUDGET_BYTES = 1024 * 1024;

async function readCompressedRolloutHeadText(filePath) {
  const zlib = require("node:zlib");
  if (typeof zlib.createZstdDecompress !== "function") {
    return { text: await codexFiles.readText(filePath), truncated: false };
  }
  return await new Promise((resolve, reject) => {
    const source = fs.createReadStream(filePath);
    const zstd = zlib.createZstdDecompress();
    const chunks = [];
    let total = 0;
    let settled = false;
    const finish = (error, truncated = false) => {
      if (settled) return;
      settled = true;
      source.destroy();
      zstd.destroy();
      if (error) reject(error);
      else resolve({ text: Buffer.concat(chunks, total).toString("utf8"), truncated });
    };
    source.on("error", finish);
    zstd.on("error", finish);
    zstd.on("end", () => finish());
    zstd.on("data", (chunk) => {
      chunks.push(chunk);
      total += chunk.length;
      if (total >= COMPRESSED_HEAD_BUDGET_BYTES) finish(null, true);
    });
    source.pipe(zstd);
  });
}

async function readCompressedRolloutHeadLines(filePath, headN) {
  const { text, truncated } = await readCompressedRolloutHeadText(filePath);
  let lines = text.split("\n").filter((line) => line !== "");
  // The budget cut can land mid-line; drop the partial tail line so callers
  // only ever see complete JSONL rows.
  if (truncated) lines = lines.slice(0, -1);
  return lines.slice(0, headN);
}

// Codex compresses 7-day-old rollouts to rollout-*.jsonl.zst (cc-switch
// 8641cd1 adaptation); decompress transparently so transcript readers stay
// byte-identical for both forms.

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

  // `/cd` moved the session: the last relocated record wins over the cwd the
  // transcript started with. Ordinary records' `cwd` is the Bash tool's
  // tracked working directory and drifts into subdirectories as commands run,
  // which must not move the session (cc-switch ea8bc2c).
  const relocatedCwd = await lastRelocatedCwd(filePath);
  if (relocatedCwd !== null) projectDir = relocatedCwd;

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
  const raw = await codexFiles.readText(filePath);
  const messages = [];
  const imageBudget = { remaining: IMAGES_TOTAL_MAX_BASE64_CHARS };
  // Claude can rewrite the same assistant message (streaming retries); keep
  // the row with the larger output_tokens per message id, like cc-switch does.
  const usageById = new Map();
  const callsById = new Map();
  const usage = emptyUsage(false);
  for (const line of raw.split("\n")) {
    if (line === "") continue;
    const value = parseJsonLine(line);
    if (!value || value.isMeta === true || value.isSidechain === true) continue;
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
        toolResults = results.map((item) => {
          const call = callsById.get(item.tool_use_id);
          const text = extractText(item.content);
          const ts = parseTimestampToMs(value.timestamp);
          const shell = call?.name === "Bash" ? normalizeShellOutput(text) : null;
          return {
            toolUseId: typeof item.tool_use_id === "string" ? item.tool_use_id : null,
            content: text,
            ...(typeof item.is_error === "boolean" ? { isError: item.is_error } : {}),
            ...(results.length === 1 && value.toolUseResult?.structuredPatch?.length ? { structuredPatch: value.toolUseResult.structuredPatch } : {}),
            ...(results.length === 1 && value.toolUseResult?.interrupted === true ? { status: "interrupted" } : {}),
            ...(shell?.exitCode != null ? { exitCode: shell.exitCode } : {}),
            ...(call?.name === "Bash" && ts != null && call.ts != null && ts >= call.ts ? { durationMs: ts - call.ts } : {}),
          };
        });
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
        for (const call of toolCalls) {
          if (call.id) callsById.set(call.id, { name: call.name, ts: parseTimestampToMs(value.timestamp) });
        }
      }
    }
    const thinking = role === "assistant" && Array.isArray(message.content)
      ? thinkingText(message.content
          .filter((item) => item?.type === "thinking" && typeof item.thinking === "string")
          .map((item) => item.thinking)
          .join("\n"))
      : null;
    // Transcript images (pasted screenshots): any content position, user or
    // assistant. The extractText path ignores them.
    let images = null;
    if (Array.isArray(message.content)) {
      for (const item of message.content) {
        const image = extractImageFromItem(item, imageBudget);
        if (image) (images ??= []).push(image);
      }
    }
    const content = extractText(role === "user" && toolResults
      ? message.content.filter(item => item?.type !== "tool_result") : message.content);
    if (content.trim() !== "" || thinking || toolCalls || toolResults || images) {
      const row = { role, content, ts: parseTimestampToMs(value.timestamp) };
      if (thinking) {
        row.thinking = thinking;
      }
      if (toolCalls) row.toolCalls = toolCalls;
      if (toolResults) row.toolResults = toolResults;
      if (images) row.images = images;
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
          ...(cacheCreation1h(message.usage) ? { cacheCreation1hTokens: cacheCreation1h(message.usage) } : {}),
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
    usage.cacheCreation1hTokens = (usage.cacheCreation1hTokens || 0) + (row.cacheCreation1hTokens || 0);
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
        ...(rowUsage.cacheCreation1hTokens ? { cacheCreation1hTokens: rowUsage.cacheCreation1hTokens } : {}),
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

function codexIsInjectedContext(text) {
  return /^(?:# AGENTS\.md instructions|<environment_context>|<user_instructions>|<turn_aborted>)/.test(String(text || "").trimStart());
}

function codexQuestionText(content) {
  const items = Array.isArray(content) ? content : [content];
  return items.map(item => codexExtractPromptFromIdeContext(extractText(typeof item === "string" ? item : [item])))
    .filter(text => text.trim() && !codexIsInjectedContext(text)).join("\n");
}

async function codexParseSession(filePath) {
  if (codexFiles.isCompressed(filePath)) return codexParseCompressedSession(filePath);
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
      const text = codexQuestionText(value.payload.content);
      if (text !== "" && !codexIsInjectedContext(text)) {
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

// Compressed rollouts list from the decompressed head only (cc-switch
// 8641cd1): the file's mtime — which Codex preserves through compression —
// stands in for last-active, and there is no last-reply preview. A head
// decompression failure must not vanish the session: fall back to the
// filename's rollout UUID and the mtime.
async function codexParseCompressedSession(filePath) {
  let head = [];
  try {
    head = await readCompressedRolloutHeadLines(filePath, HEAD_LINES);
  } catch {
    head = [];
  }

  let sessionId = null;
  let projectDir = null;
  let createdAt = null;
  let firstUserMessage = null;

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
      const text = codexQuestionText(value.payload.content);
      if (text !== "" && !codexIsInjectedContext(text)) {
        firstUserMessage = text;
      }
    }
  }

  if (!sessionId) sessionId = codexFiles.rolloutIds(filePath)?.thread || codexSessionIdFromPath(filePath);
  if (!sessionId) return null;

  const stat = await fsp.stat(filePath).catch(() => null);
  const title = (firstUserMessage ? truncateSummary(firstUserMessage, TITLE_MAX_CHARS) : null)
    ?? (projectDir ? path.basename(projectDir) : null);

  return {
    appId: "codex",
    sessionId,
    title,
    summary: null,
    projectDir,
    createdAt,
    lastActiveAt: stat ? Math.round(stat.mtimeMs) : null,
    sourcePath: filePath,
    resumeCommand: `codex resume ${sessionId}`,
  };
}

// Rejected patches often have no exit code. Missing output is not success.
function applyPatchStatus(output) {
  // Native Codex results may be JSON-encoded { output, metadata } envelopes.
  // Decode only for status detection; the transcript keeps the original text.
  const rawText = extractText(output);
  const result = typeof output === "string" || Array.isArray(output) ? parseJsonLine(rawText) : output;
  const text = extractText(result?.output ?? rawText).trim();
  const exit = text.match(/(?:^|\n)(?:Exit code:|Process exited with code)\s*(-?\d+)/i);
  const exitCode = Number.isInteger(result?.metadata?.exit_code)
    ? result.metadata.exit_code : exit ? Number(exit[1]) : null;
  if (/^(?:apply_patch verification failed|patch rejected|error:|failed to)/im.test(text)
      || (exitCode !== null && exitCode !== 0)) return "failed";
  if (exitCode === 0 || /^Success\.?(?:\s|$)/im.test(text)) return "success";
  return "pending";
}

function parseApplyPatch(argumentsText) {
  const parsed = typeof argumentsText === "string" ? parseJsonLine(argumentsText) : argumentsText;
  const text = typeof parsed === "string" ? parsed
    : typeof parsed?.patch === "string" ? parsed.patch
      : typeof parsed?.input === "string" ? parsed.input : String(argumentsText ?? "");
  const begin = text.indexOf("*** Begin Patch");
  if (begin === -1) return null;
  const end = text.indexOf("*** End Patch", begin);
  const body = text.slice(begin, end === -1 ? undefined : end + "*** End Patch".length);
  const files = [];
  let additions = 0;
  let deletions = 0;
  let kind = null;
  for (const line of body.split("\n")) {
    if (line.startsWith("*** Add File: ")) {
      kind = "add";
      files.push({ kind, path: line.slice("*** Add File: ".length).trim() });
    } else if (line.startsWith("*** Update File: ")) {
      kind = "update";
      files.push({ kind, path: line.slice("*** Update File: ".length).trim() });
    } else if (line.startsWith("*** Delete File: ")) {
      kind = "delete";
      files.push({ kind, path: line.slice("*** Delete File: ".length).trim() });
    } else if (line.startsWith("*** Move to: ") && files.length > 0) {
      files[files.length - 1].moveTo = line.slice("*** Move to: ".length).trim();
    } else if (line.startsWith("***")) {
      kind = null;
    } else if (kind === "add" || kind === "update") {
      if (line.startsWith("+")) additions += 1;
      else if (kind === "update" && line.startsWith("-")) deletions += 1;
    }
  }
  return { body, files, additions, deletions, status: "pending", error: false };
}

async function codexReadMessages(filePaths, { resolveForkReplay } = {}) {
  const paths = Array.isArray(filePaths) ? filePaths : [filePaths];
  const raw = (await Promise.all(paths.map((file) => codexFiles.readText(file)))).join("\n");
  const messages = [];
  // Ordinary tool results must not scan the transcript for a patch they lack.
  const patchesByCallId = new Map();
  // Attribute cumulative increments to the model active for each event.
  // Fold both relay cache-write conventions into the queue contract before
  // returning usage. The explicit flag keeps pricing from subtracting cache
  // a second time, independent of the model-id heuristic.
  const usage = emptyUsage(false);
  let usageSeen = false;
  let usageDeferred = false;
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
      if (role === "user") {
        const items = Array.isArray(payload.content) ? payload.content : [payload.content];
        const injected = items.map(item => extractText(typeof item === "string" ? item : [item])).filter(codexIsInjectedContext);
        if (injected.length) messages.push({ role, content: injected.join("\n"), injected: true, ts: parseTimestampToMs(value.timestamp) });
        content = codexQuestionText(payload.content);
      }
    } else if (payload.type === "function_call" || payload.type === "custom_tool_call") {
      role = "assistant";
      const args = payload.type === "custom_tool_call" ? payload.input : payload.arguments;
      toolCalls = [{
        callId: typeof payload.call_id === "string" ? payload.call_id : null,
        name: typeof payload.name === "string" && payload.name ? payload.name : "unknown",
        ...(payload.type === "custom_tool_call"
          ? { input: typeof args === "string" ? args : null }
          : { arguments: typeof args === "string" ? args : null }),
      }];
      const patch = payload.name === "apply_patch" ? parseApplyPatch(args) : null;
      if (patch) {
        toolCalls[0].patch = patch;
        if (typeof payload.call_id === "string") patchesByCallId.set(payload.call_id, patch);
      }
      content = "";
    } else if (payload.type === "function_call_output" || payload.type === "custom_tool_call_output") {
      role = "tool";
      content = typeof payload.output === "object" && payload.output !== null && !Array.isArray(payload.output)
        ? JSON.stringify(payload.output) : extractText(payload.output);
      toolResults = [{
        callId: typeof payload.call_id === "string" ? payload.call_id : null,
        ...normalizeShellOutput(content),
      }];
      const patch = patchesByCallId.get(payload.call_id);
      if (patch) {
        patch.status = applyPatchStatus(payload.output);
        patch.error = patch.status === "failed";
      }
    } else if (payload.type === "reasoning") {
      // Reasoning summaries render as their own collapsed thinking row.
      const summary = Array.isArray(payload.summary)
        ? payload.summary.filter((item) => typeof item?.text === "string").map((item) => item.text).join("\n")
        : "";
      const thinking = thinkingText(summary);
      if (!thinking) continue;
      messages.push({ role: "assistant", content: "", thinking, ts: parseTimestampToMs(value.timestamp) });
      continue;
    } else {
      continue;
    }
    if (content.trim() === "" && !toolCalls && !toolResults) continue;
    const row = { role, content, ts: parseTimestampToMs(value.timestamp) };
    if (role === "assistant" && usage.model) row.model = usage.model;
    if (toolCalls) row.toolCalls = toolCalls;
    if (toolResults) row.toolResults = toolResults;
    messages.push(row);
  }
  // Use the same accounting pass as analytics, including compaction records,
  // merged pages and parent replay. Presentation keeps its original messages.
  if (!usageDeferred) {
    const { parseCodexRolloutFile } = require("./codex-rollout-parser");
    try {
      await parseCodexRolloutFile(paths, {
        collectBreakdowns: false, resolveForkReplay, allowUndatedUsage: true,
        onUsage(event) {
          if (!event.delta) return;
          const delta = event.delta;
          const row = { inputTokens: delta.input_tokens, outputTokens: delta.output_tokens,
            reasoningTokens: delta.reasoning_output_tokens, cacheReadTokens: delta.cached_input_tokens,
            cacheCreationTokens: delta.cache_creation_input_tokens };
          trackModelUsage(usage, event.model, row);
          for (const [key, count] of Object.entries(row)) usage[key] += count;
          usage.totalTokens += delta.total_tokens;
          usageSeen = true;
        },
      });
    } catch (error) {
      if (error.code !== "CODEX_FORK_DEFERRED") throw error;
      usageDeferred = true;
    }
  }
  if (!usageSeen || usageDeferred) return { messages, usage: null, usageDeferred };
  return { messages, usage: finalizeUsage(usage), usageDeferred };
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
  const raw = await codexFiles.readText(filePath);
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
      ? thinkingText(msg.content
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
    let toolResults = null;
    if (Array.isArray(msg.toolCalls)) {
      const calls = msg.toolCalls.filter((call) => call && typeof call.name === "string");
      if (calls.length > 0) {
        toolCalls = calls.map((call, index) => {
          const id = call.id || `${msg.id || messages.length}-tool-${index}`;
          const result = geminiToolResult(call, id);
          if (result) (toolResults ??= []).push(result);
          return { name: call.name, args: call.args ?? null,
            ...(call.id || result ? { id } : {}) };
        });
      }
    }
    if (content.trim() === "" && !thinking && !toolCalls) continue;
    const row = { role: type === "gemini" ? "assistant" : "user", content, ts: parseTimestampToMs(msg.timestamp) };
    if (thinking) {
      row.thinking = thinking;
    }
    if (toolCalls) row.toolCalls = toolCalls;
    if (toolResults) row.toolResults = toolResults;
    if (typeof msg.model === "string" && msg.model) row.model = msg.model;
    if (rowUsage) row.usage = rowUsage;
    messages.push(row);
  }
  usage.totalTokens = usage.inputTokens + usage.outputTokens + usage.reasoningTokens;
  return { messages, usage: finalizeUsage(usage) };
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

const SESSION_APPS = ["claude", "codex", "gemini", ...sessionSources.APPS];

function rootsForApp(app, home, env = process.env) {
  if (app === "claude") return claudeRoots(home);
  if (app === "codex") return codexRoots(home);
  if (app === "gemini") return geminiRoots(home);
  if (sessionSources.APPS.includes(app)) return sessionSources.roots(app, home, env);
  throw new Error(`Unsupported app: ${app}`);
}

async function listSessions({ app, home, env = process.env } = {}) {
  if (!SESSION_APPS.includes(app)) throw new Error(`Unsupported app: ${app}`);
  const resolvedHome = resolveHome({ home, env });
  if (!resolvedHome) return [];

  if (sessionSources.APPS.includes(app)) {
    const roots = rootsForApp(app, resolvedHome, env);
    return sortByRecency(await sessionSources.list(app, resolvedHome, env,
      file => resolveSessionPath(path.resolve(file), roots, { directory: true })));
  }

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
    await collectJsonlFiles(root, files, { compressed: app === "codex" });
  }
  const sessions = [];
  for (const filePath of codexFiles.dedupeSiblings(files)) {
    try { await resolveSessionPath(filePath, rootsForApp(app, resolvedHome)); } catch { continue; }
    const meta = await cachedMetadata(filePath, app);
    if (meta) sessions.push(meta);
  }
  if (app !== "codex") return sortByRecency(sessions);
  const grouped = new Map();
  for (const row of sessions.sort((a, b) => path.basename(a.sourcePath).localeCompare(path.basename(b.sourcePath)))) {
    const id = codexFiles.rolloutIds(row.sourcePath)?.thread || row.sessionId;
    const previous = grouped.get(id);
    if (!previous) grouped.set(id, { ...row, sessionId: id, resumeCommand: `codex resume ${id}` });
    else {
      previous.lastActiveAt = Math.max(previous.lastActiveAt || 0, row.lastActiveAt || 0);
      if (row.summary) previous.summary = row.summary;
      if (!previous.title) previous.title = row.title;
    }
  }
  const titles = await codexNativeTitles(resolvedHome);
  for (const row of grouped.values()) {
    if (titles.has(row.sessionId)) row.title = titles.get(row.sessionId);
  }
  return sortByRecency([...grouped.values()]);
}

function sortByRecency(sessions) {
  return sessions.sort((a, b) => (b.lastActiveAt ?? b.createdAt ?? 0) - (a.lastActiveAt ?? a.createdAt ?? 0));
}

function pathIsInsideRoot(sourcePath, root) {
  const relative = path.relative(root, sourcePath);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

async function resolveSessionPath(sourcePath, roots, { directory = false } = {}) {
  // Require both the client path and its actual target to belong to the same
  // app root. Resolve the root too so a user-relocated session directory works.
  const matchingRoots = roots.filter((root) => pathIsInsideRoot(sourcePath, root) || (directory && sourcePath === path.resolve(root)));
  if (matchingRoots.length) {
    const realPath = await fsp.realpath(sourcePath);
    for (const root of matchingRoots) {
      const realRoot = await fsp.realpath(root);
      if (pathIsInsideRoot(realPath, realRoot) || (directory && realPath === realRoot && (await fsp.stat(realPath)).isDirectory())) return realPath;
    }
  }
  throw new Error("Session path is outside this app's session roots");
}

async function readSession({ app, sourcePath, home, env = process.env, preview = false } = {}) {
  if (!SESSION_APPS.includes(app)) throw new Error(`Unsupported app: ${app}`);
  const resolvedHome = resolveHome({ home, env });
  if (!resolvedHome || !isNonEmptyString(sourcePath)) {
    throw new Error("Session path is required");
  }
  if (sessionSources.APPS.includes(app)) {
    const roots = rootsForApp(app, resolvedHome, env);
    const validate = file => resolveSessionPath(path.resolve(file), roots, { directory: true });
    await sessionSources.validateSource(app, sourcePath, resolvedHome, env, validate);
    const dependencies = await sessionSources.dependencies(app, sourcePath, validate);
    const revision = await transcriptRevision(app, dependencies);
    const key = `${app}:${sourcePath}`;
    let transcript = transcriptCache.get(key, revision);
    if (!transcript) {
      transcript = await sessionSources.read(app, sourcePath, validate);
      const after = await sessionSources.dependencies(app, sourcePath, validate);
      if (await transcriptRevision(app, after) !== revision) throw new Error("Session changed during reading; reload the session");
      transcriptCache.set(key, revision, transcript);
    }
    const session = { sourcePath, revision, messages: transcript.messages, usage: transcript.usage };
    return preview ? previewTranscript(session) : session;
  }
  const resolved = path.resolve(sourcePath);
  let realPath;
  try { realPath = await resolveSessionPath(resolved, rootsForApp(app, resolvedHome)); }
  catch (error) {
    if (app !== "codex" || error.code !== "ENOENT") throw error;
    for (const sibling of codexFiles.siblingPaths(resolved)) {
      try {
        realPath = await resolveSessionPath(sibling, rootsForApp(app, resolvedHome));
        break;
      } catch (siblingError) {
        if (siblingError.code !== "ENOENT") throw siblingError;
      }
    }
    if (!realPath) throw error;
  }
  if (app === "gemini" && path.extname(realPath) !== ".json" && path.extname(realPath) !== ".jsonl") {
    throw new Error("Not a gemini session file");
  }
  if (app !== "gemini" && !(app === "codex" ? codexFiles.isRollout(realPath) : path.extname(realPath) === ".jsonl")) {
    throw new Error("Not a session transcript file");
  }
  if (app === "claude" && (isClaudeAgentSession(path.basename(resolved)) || isClaudeAgentSession(path.basename(realPath)))) {
    throw new Error("Not a claude session file");
  }
  let codexPages = [realPath];
  let dependencies = [realPath];
  let resolveForkReplay;
  if (app === "codex") {
    const related = await codexTranscriptFiles(resolved, realPath, rootsForApp(app, resolvedHome));
    codexPages = related.pages;
    dependencies = related.dependencies;
    resolveForkReplay = require("./codex-fork-replay").createForkReplayResolver(dependencies);
  }
  const revision = await transcriptRevision(app, dependencies);
  const key = `${app}:${realPath}`;
  let transcript = transcriptCache.get(key, revision);
  if (!transcript) {
    transcript = app === "claude"
      ? await claudeReadMessages(realPath)
      : app === "codex"
        ? await codexReadMessages(codexPages, { resolveForkReplay })
        : await geminiReadMessages(realPath);
    // Don't commit a snapshot of a log that changed during parsing, or usage
    // whose fork parent is not yet available. A later request must retry.
    const after = app === "codex" ? (await codexTranscriptFiles(resolved, realPath, rootsForApp(app, resolvedHome))).dependencies : dependencies;
    if (await transcriptRevision(app, after) !== revision) {
      throw new Error("Session changed during reading; reload the session");
    }
    if (!transcript.usageDeferred) {
      transcriptCache.set(key, revision, transcript);
    }
  }
  const session = { sourcePath: resolved, revision, messages: transcript.messages, usage: transcript.usage };
  return preview ? previewTranscript(session) : session;
}

async function readSessionContent(options) {
  // Never trust a reference as authorization. Revalidate roots and current
  // physical pages (including symlinks) before accessing the memory cache.
  const session = await readSession({ ...options, preview: false });
  return contentPage(session, options);
}

function listSessionApps({ home, env = process.env } = {}) {
  const resolvedHome = resolveHome({ home, env });
  return SESSION_APPS.map((app) => ({
    id: app,
    available: resolvedHome ? rootsForApp(app, resolvedHome, env).some((root) => {
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
  readSessionContent,
  // exposed for tests
  extractText,
  parseTimestampToMs,
  truncateSummary,
};
