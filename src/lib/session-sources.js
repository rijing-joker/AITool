"use strict";
// Additional read-only formats ported from cc-switch 0a41250dc03a (MIT).
// Every path, including database/WAL and companion files, is revalidated by
// the caller's root clamp. No exported reference grants access by itself.
const fs = require("node:fs/promises");
const sync = require("node:fs");
const path = require("node:path");
const { readSqliteJsonRowsAsync } = require("./sqlite-reader");
const { statusOf } = require("./session-tool-results");
const APPS = ["agy", "hermes", "pi", "grokbuild", "opencode", "mcode", "kimi"];
const fileMetadata = new Map();
const parse = value => { try { return typeof value === "string" ? JSON.parse(value) : value; } catch { return null; } };
const ts = (value, unit = "ms") => {
  if (value == null) return null;
  const n = Number(value);
  if (Number.isFinite(n)) return unit === "seconds" ? n * 1000 : n;
  const date = Date.parse(value);
  return Number.isFinite(date) ? date : null;
};
function text(value) {
  if (typeof value === "string") return value.startsWith("\0json:") ? text(parse(value.slice(6))) : value;
  if (Array.isArray(value)) return value.filter(part => part && !part.thought && !["tool", "thinking", "reasoning", "toolCall", "tool_use"].includes(part.type)).map(part => text(part?.text ?? part?.content ?? part)).join("\n");
  return value?.text || "";
}
function roots(app, home, env = {}) {
  if (app === "agy") {
    const result = [path.join(home, ".gemini", "antigravity-cli"), path.join(home, ".gemini", "antigravity")];
    const profiles = path.join(home, ".aitool", "provider-switch", "agy");
    try { for (const row of sync.readdirSync(profiles, { withFileTypes: true })) if (row.isDirectory()) result.push(path.join(profiles, row.name, "antigravity-cli")); } catch {}
    return result;
  }
  if (app === "hermes") return [env.HERMES_HOME || path.join(home, ".hermes")];
  if (app === "mcode") return [env.MINIMAX_DATA_DIR || env.MAVIS_DATA_DIR || path.join(home, ".minimax")];
  if (app === "opencode") return [path.join(env.XDG_DATA_HOME || path.join(home, ".local", "share"), "opencode")];
  if (app === "grokbuild") return [path.join(home, ".grok", "sessions"), path.join(home, ".grok", "archived_sessions")];
  if (app === "kimi") return [path.join(env.KIMI_CODE_HOME?.trim() || path.join(home, ".kimi-code"), "sessions")];
  if (app === "pi") {
    const agent = env.PI_CODING_AGENT_DIR || path.join(home, ".pi", "agent");
    let configured = env.PI_CODING_AGENT_SESSION_DIR;
    try { const settings = JSON.parse(sync.readFileSync(path.join(agent, "settings.json"), "utf8")); configured ||= settings.sessionDir; } catch (error) { if (error.code !== "ENOENT") return []; }
    if (configured) {
      if (configured.startsWith("~/")) return [path.join(home, configured.slice(2))];
      return path.isAbsolute(configured) ? [configured] : [];
    }
    return [path.join(agent, "sessions")];
  }
  return [];
}
async function walk(root, accept, validate) {
  const out = [], stack = [root];
  while (stack.length) {
    const directory = stack.pop();
    let entries;
    try { await validate(directory); entries = await fs.readdir(directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) stack.push(file);
      else if (entry.isFile() && accept(file)) {
        // Keep the configured path for later root checks, including relocated
        // roots. Validation still checks the real target before any read.
        try { await validate(file); out.push(file); } catch {}
      }
    }
  }
  return out.sort();
}
async function jsonl(file) {
  const stat = await fs.stat(file);
  if (stat.size > 128 * 1024 * 1024) throw new Error("Session exceeds the transcript size limit");
  // Append-only logs may end with an incomplete write. Retry it next revision.
  const raw = await fs.readFile(file, "utf8");
  return raw.split("\n").filter(Boolean).map(parse).filter(Boolean);
}
function meta(app, id, sourcePath, rows, extra = {}) {
  const messages = rows?.messages || [];
  const first = messages.find(row => row.role === "user" && row.content.trim());
  const times = messages.map(row => row.ts).filter(Number.isFinite);
  return { appId: app, sessionId: String(id), sourcePath, title: first?.content.slice(0, 80) || null,
    summary: first?.content.slice(0, 160) || null, projectDir: null, createdAt: times.length ? times.reduce((a,b) => Math.min(a,b)) : null,
    lastActiveAt: times.length ? times.reduce((a,b) => Math.max(a,b)) : null, resumeCommand: null, ...extra };
}
const reference = (file, id) => `sqlite:${file}#${encodeURIComponent(id)}`;
function splitReference(source) {
  if (!source.startsWith("sqlite:")) return { file: source, id: null };
  const pos = source.lastIndexOf("#");
  if (pos < 7) throw new Error("Invalid database session reference");
  const id = decodeURIComponent(source.slice(pos + 1));
  if (!id || id.length > 512 || /[\0\r\n]/.test(id)) throw new Error("Invalid session ID");
  return { file: source.slice(7, pos), id };
}
function database(app, root) {
  return path.join(root, app === "hermes" ? "state.db" : app === "opencode" ? "opencode.db" : "v2/sqlite/runtime-state.sqlite");
}
async function validateSource(app, source, home, env, validate) {
  const { file, id } = splitReference(source);
  if (!path.isAbsolute(file)) throw new Error("Session path must be absolute");
  await validate(file);
  if (id !== null) {
    if (!["hermes", "opencode", "mcode"].includes(app) || file !== database(app, roots(app, home, env)[0])) throw new Error("Unregistered session database");
    return;
  }
  const valid = app === "agy" ? roots(app,home,env).some(root => /^brain\/[\w-]+\/\.system_generated\/logs\/transcript_full\.jsonl$/.test(path.relative(root,file).split(path.sep).join("/")))
    : app === "grokbuild" ? path.basename(file) === "chat_history.jsonl"
    : app === "opencode" ? file.includes(`${path.sep}storage${path.sep}session${path.sep}`) && file.endsWith(".json")
    : app === "kimi" ? file.endsWith(`${path.sep}agents${path.sep}main${path.sep}wire.jsonl`)
    : app === "hermes" ? file.includes(`${path.sep}sessions${path.sep}`) && file.endsWith(".jsonl") : app === "pi" && file.endsWith(".jsonl");
  if (!valid) throw new Error("Not a registered session transcript");
}
const literal = id => `'${id.replaceAll("'", "''")}'`;
function isAgyTranscript(file) {
  return file.replaceAll("\\", "/").endsWith("/.system_generated/logs/transcript_full.jsonl");
}
async function query(file, sql, validate) {
  await validate(file);
  for (const suffix of ["-wal", "-shm"]) {
    try { await fs.lstat(file + suffix); await validate(file + suffix); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return readSqliteJsonRowsAsync(file, sql, { readOnly: true, throwOnReadFailure: true, maxBuffer: 128 * 1024 * 1024 });
}
async function list(app, home, env, validate) {
  const dirs = roots(app, home, env);
  const result = [];
  if (["hermes", "opencode", "mcode"].includes(app)) {
    const file = database(app, dirs[0]);
    try {
      const table = app === "hermes" ? "sessions" : app === "mcode" ? "local_runtime_sessions" : "session";
      const tables = await query(file, "SELECT name FROM sqlite_master WHERE type='table'", validate);
      const names = new Set(tables.map(row => row.name));
      const chosen = app === "opencode" && names.has("session_v2") ? "session_v2" : table;
      const rows = await query(file, `SELECT * FROM ${chosen} LIMIT 5000`, validate);
      if (app === "opencode" && chosen === "session_v2" && names.has("session") && names.has("kv")) {
        const marker = await query(file, "SELECT max(coalesce(time_created,0),coalesce(time_updated,0)) AS ts FROM kv WHERE key='migration.v1-v2' LIMIT 1", validate);
        if (Number.isFinite(marker[0]?.ts)) rows.push(...await query(file, `SELECT * FROM session WHERE time_updated>${Number(marker[0].ts)} AND id NOT IN (SELECT id FROM session_v2) LIMIT 5000`, validate));
      }
      for (const row of rows) {
        const id = row.id || row.session_id;
        if (!id || (app === "mcode" && (row.visibility === "hidden" || row.archived || row.parent_session_id || ["peek", "channel", "cron"].includes(row.session_kind)))) continue;
        result.push(meta(app, id, reference(file, id), null, { title: row.title || null, projectDir: row.cwd || row.directory || row.workspace_dir || null,
          createdAt: ts(row.started_at ?? row.created_at ?? row.created_at_ms ?? row.time_created, app === "hermes" ? "seconds" : "ms"),
          lastActiveAt: ts(row.last_activity_at ?? row.ended_at ?? row.updated_at ?? row.updated_at_ms ?? row.time_updated, app === "hermes" ? "seconds" : "ms") }));
      }
    } catch (error) { if (error.code !== "ENOENT") { /* Missing/legacy schema still permits file sources. */ } }
  }
  for (const dir of dirs) {
    const summaries = new Map();
    const resume = id => {
      if (!/^[\w-]+$/.test(id)) return null;
      const profile = app === "agy" && dir.includes(`${path.sep}provider-switch${path.sep}agy${path.sep}`) ? path.dirname(dir) : null;
      const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
      if (app === "kimi") return /^[\w-]+$/.test(id) ? `env KIMI_CODE_HOME=${quote(path.dirname(dir))} kimi --session ${id}` : null;
      return app === "agy" ? `agy${profile ? ` --gemini_dir=${quote(profile)}` : ""} --conversation=${id}` : app === "grokbuild" ? `grok --resume ${id}` : null;
    };
    if (app === "agy") {
      try {
        for (const row of await query(path.join(dir, "conversation_summaries.db"), "SELECT * FROM conversation_summaries LIMIT 5000", validate)) {
          if (!/^[\w-]+$/.test(row.conversation_id)) continue;
          let projectDir = null;
          try { const uri = parse(row.workspace_uris)?.[0]; if (uri) projectDir = require("node:url").fileURLToPath(uri); } catch {}
          summaries.set(row.conversation_id, meta(app, row.conversation_id, null, null, { title: row.title || null, summary: row.preview?.slice(0,160) || null, projectDir, lastActiveAt: ts(row.last_modified_time), resumeCommand: resume(row.conversation_id) }));
        }
      } catch { /* Binary index is optional. */ }
    }
    const files = await walk(dir, file => app === "agy" ? isAgyTranscript(file)
      : app === "grokbuild" ? path.basename(file) === "chat_history.jsonl"
      : app === "opencode" ? file.includes(`${path.sep}storage${path.sep}session${path.sep}`) && file.endsWith(".json")
      : app === "hermes" ? file.includes(`${path.sep}sessions${path.sep}`) && file.endsWith(".jsonl")
      : app === "kimi" ? file.endsWith(`${path.sep}agents${path.sep}main${path.sep}wire.jsonl`)
      : app === "pi" ? file.endsWith(".jsonl") : false, validate);
    for (const file of files) {
      try {
        const inputs = app === "kimi" ? [file, await kimiStatePath(file, validate)] : [file];
        const stamps = await Promise.all(inputs.map(async input => {
          const stat = await fs.stat(input);
          return [input,stat.dev,stat.ino,stat.size,stat.mtimeMs,stat.ctimeMs];
        }));
        const stamp = JSON.stringify(stamps);
        const key = `${app}:${file}`;
        let cached = fileMetadata.get(key);
        if (!cached || cached.stamp !== stamp || app === "opencode") {
          const read = await readFile(app, file, validate);
          cached = { stamp, read: { id: read.id, cwd: read.cwd, title: read.title, messages: read.messages.filter(row => row.role === "user").slice(0,1).map(row => ({ ...row, content: row.content.slice(0,160) })) },
            times: read.messages.map(row => row.ts).filter(Number.isFinite) };
          if (fileMetadata.size >= 4096) fileMetadata.delete(fileMetadata.keys().next().value);
          fileMetadata.set(key, cached);
        }
        const read = cached.read;
        let id = read.id || path.basename(file, path.extname(file));
        if (app === "agy") id = path.basename(path.dirname(path.dirname(path.dirname(file))));
        if (app === "grokbuild") id = path.basename(path.dirname(file));
        if (app === "kimi") id = path.basename(path.dirname(path.dirname(path.dirname(file))));
        if (result.some(row => row.sessionId === id)) continue;
        const summary = summaries.get(id); summaries.delete(id);
        result.push(summary ? { ...summary, sourcePath: file } : meta(app, id, file, read, { projectDir: read.cwd || null, ...(read.title ? {title:read.title} : {}),
          createdAt: cached.times.length ? cached.times.reduce((a,b) => Math.min(a,b)) : null,
          lastActiveAt: cached.times.length ? cached.times.reduce((a,b) => Math.max(a,b)) : null,
          resumeCommand: resume(id) }));
      } catch { /* Corrupt/unreadable sessions are not fabricated. */ }
    }
    for (const summary of summaries.values()) if (!result.some(row => row.sessionId === summary.sessionId)) result.push(summary);
  }
  return result;
}
function fold(app, values) {
  const messages = [];
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, reasoningTokens: 0,
    totalTokens: 0, inputInclusive: false, model: null, perModel: [] };
  if (app === "agy" || app === "pi" || app === "opencode") usage.executorType = "fresh-input-output-includes-reasoning";
  const models = new Map();
  let selectedModel = null;
  for (const value of values) {
    const row = value.message || value;
    const role = app === "agy" ? value.type === "USER_INPUT" ? "user" : value.type === "PLANNER_RESPONSE" || value.source === "MODEL" ? "assistant" : "system" : row.role === "toolResult" ? "tool" : row.role || row.type;
    if (!["user", "assistant", "tool", "system"].includes(role)) continue;
    let content = text(row.content ?? row.msg_content ?? row.text);
    if (app === "agy" && role === "user") content = content.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/)?.[1]?.trim() || content;
    // Antigravity's fallback steps are execution events, not injected context.
    // Preserve unfamiliar records even when they have no text field.
    if (app === "agy" && !content.trim()) content = JSON.stringify(value, null, 2);
    const message = { role, content, ...(role === "system" && app !== "agy" ? {injected:true} : {}), ts: ts(value.created_at_ms ?? value.created_at ?? value.timestamp ?? value.ts ?? row.timestamp ?? row.time_created ?? row.time?.created, app === "hermes" ? "seconds" : "ms") };
    const parts = row.parts || (Array.isArray(row.content) ? row.content : []);
    const thoughts = parts.filter(part => ["thinking", "reasoning"].includes(part?.type) || part?.thought).map(part => part.text || part.thinking || "");
    if (thoughts.length) message.thinking = thoughts.join("\n");
    else if (typeof row.reasoning === "string" && row.reasoning) message.thinking = row.reasoning;
    const calls = parse(row.tool_calls) || [];
    if (Array.isArray(calls) && calls.length) message.toolCalls = calls.map(call => ({ id: call.id || null, name: call.function?.name || call.name || "unknown", arguments: call.function?.arguments || call.arguments || null }));
    if (role === "tool") {
      const isError = row.is_error === true || row.isError === true;
      // Hermes and Grok do not record a reliable completion flag. Output
      // alone cannot establish success, even when it looks like an error.
      const status = isError ? "failed" : statusOf(row.status)
        || (["grokbuild", "hermes"].includes(app) ? undefined : "success");
      message.toolResults = [{ callId: row.tool_call_id || row.call_id || row.toolCallId || null,
        output: content, isError, ...(status ? {status} : {}) }];
    }
    for (const part of parts) if (["toolCall", "tool_use"].includes(part?.type)) {
      message.toolCalls ||= []; message.toolCalls.push({ id: part.id || null, name: part.name || "unknown", input: JSON.stringify(part.arguments || part.input || {}) });
    }
    for (const part of parts) if (part?.type === "tool") {
      const state = part.state || {};
      message.toolCalls ||= []; message.toolCalls.push({ id: part.callID || part.id || null, name: part.name || part.tool || "unknown", input: JSON.stringify(state.input || part.arguments || part.input || {}) });
      if (state.output != null || state.error) { message.toolResults ||= []; message.toolResults.push({ callId: part.callID || part.id || null, output: text(state.output) || String(state.error || ""), isError: state.status === "error", status: state.status === "error" ? "failed" : state.status === "completed" ? "success" : state.status }); }
    }
    const tokens = row.usage || row.tokens || (app === "agy" ? row : null);
    if (app === "agy" && value.type === "USER_INPUT") {
      const change = String(value.content || "").match(/Model Selection[^\n]*? to ([^\n`<]+)/);
      if (change) selectedModel = change[1].split(". ")[0].replace(/\.+$/, "").trim() || null;
    }
    let model = typeof row.model === "string" ? row.model : row.model?.id || row.modelID || (app === "agy" ? selectedModel : null);
    if (app === "agy" && model?.includes(" ")) model = model.toLowerCase().replace(/ \(/g,"-").replace(/[()]/g,"").trim().split(/\s+/).join("-");
    if (model) message.model = model;
    if (role === "assistant" && tokens && (app !== "agy" || value.status === "DONE")) {
      const n = value => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
      const entry = { inputTokens: n(tokens.input_tokens ?? tokens.input ?? tokens.inputTokens), outputTokens: n(tokens.output_tokens ?? tokens.output ?? tokens.outputTokens),
        cacheReadTokens: n(tokens.cache_read_tokens ?? tokens.cacheRead ?? tokens.cache?.read ?? tokens.cache_read_input_tokens),
        cacheCreationTokens: n(tokens.cache_write_tokens ?? tokens.cacheWrite ?? tokens.cache?.write ?? tokens.cache_creation_input_tokens),
        reasoningTokens: n(tokens.reasoning_tokens ?? tokens.reasoning), cacheCreation1hTokens: 0 };
      for (const key of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheCreationTokens", "reasoningTokens"]) usage[key] += entry[key];
      usage.totalTokens += entry.inputTokens + entry.outputTokens + (usage.inputInclusive ? 0 : entry.cacheReadTokens + entry.cacheCreationTokens);
      const priced = models.get(model || "unknown") || { model: model || "unknown", ...Object.fromEntries(Object.keys(entry).map(key => [key, 0])) };
      for (const key of Object.keys(entry)) priced[key] += entry[key];
      models.set(priced.model, priced); message.usage = entry;
    }
    if (message.content || message.thinking || message.toolCalls?.length || message.toolResults?.length) messages.push(message);
  }
  usage.perModel = [...models.values()]; usage.model = usage.perModel[0]?.model || null;
  return { messages, usage: usage.totalTokens > 0 ? usage : null };
}
async function readFile(app, file, validate) {
  await validate(file);
  if (app === "opencode" && file.endsWith(".json")) {
    const summary = parse(await fs.readFile(file, "utf8"));
    if (!summary?.id || !/^[\w-]+$/.test(summary.id)) throw new Error("Invalid OpenCode session");
    // Derive storage from its registered root, never from a JSON path field.
    const storage = file.slice(0, file.lastIndexOf(`${path.sep}session${path.sep}`));
    const rows = [];
    for (const messageFile of await walk(path.join(storage, "message", summary.id), p => p.endsWith(".json"), validate)) {
      const row = parse(await fs.readFile(messageFile, "utf8"));
      if (!row?.id || !/^[\w-]+$/.test(row.id)) continue;
      row.parts = [];
      for (const part of await walk(path.join(storage, "part", row.id), p => p.endsWith(".json"), validate)) row.parts.push(parse(await fs.readFile(part, "utf8")));
      row.content = row.parts; rows.push(row);
    }
    rows.sort((a, b) => (a.time?.created || 0) - (b.time?.created || 0));
    return { ...fold(app, rows), id: summary.id, cwd: summary.directory };
  }
  if (app === "kimi") return kimiWireSession(file, validate);
  let rows = await jsonl(file);
  let summary = null;
  if (app === "grokbuild") { try { const metadata = path.join(path.dirname(file), "summary.json"); await validate(metadata); summary = parse(await fs.readFile(metadata,"utf8")); } catch {} }
  const header = rows.find(row => row.type === "session") || {};
  if (app === "agy") { const latest = new Map(); for (const row of rows) if (Number.isInteger(row.step_index)) latest.set(row.step_index, row); rows = [...latest].sort((a, b) => a[0] - b[0]).map(([, row]) => row); }
  if (app === "pi") {
    if (header.version === 0) throw new Error("Unsupported Pi session version");
    if ((header.version || 1) < 2) { let previous = null; rows = rows.map((row, index) => { if (row.type === "session") return row; const next = { ...row, id: `legacy-${index}`, parentId: previous }; previous = next.id; return next; }); }
    const nodes = new Map(rows.filter(row => row.id && row.type !== "session").map(row => [row.id, row]));
    const active = new Set(); let leaf = rows.filter(row => nodes.has(row.id)).at(-1);
    while (leaf && !active.has(leaf.id)) { active.add(leaf.id); leaf = nodes.get(leaf.parentId); }
    rows = [...nodes.values()].filter(row => active.has(row.id) && row.type === "message");
  }
  return { ...fold(app, rows), id: summary?.info?.id || header.id, cwd: summary?.info?.cwd || header.cwd, title: summary?.generated_title || summary?.session_summary };
}
async function read(app, source, validate) {
  const { file, id } = splitReference(source);
  if (id === null) return readFile(app, file, validate);
  const tables = new Set((await query(file, "SELECT name FROM sqlite_master WHERE type='table'", validate)).map(row => row.name));
  const quoted = literal(id);
  let rows;
  if (app === "hermes") rows = await query(file, `SELECT * FROM messages WHERE session_id=${quoted} ORDER BY id`, validate);
  else if (app === "mcode") {
    const visible = await query(file, `SELECT 1 FROM local_runtime_sessions WHERE session_id=${quoted} AND visibility <> 'hidden' AND archived=0 AND parent_session_id IS NULL AND session_kind NOT IN ('peek','channel','cron')`, validate);
    if (!visible.length) throw new Error("MiniMax session is unavailable");
    const migrated = tables.has("local_runtime_message_row_migrations") && (await query(file, `SELECT 1 FROM local_runtime_message_row_migrations WHERE session_id=${quoted}`, validate)).length;
    if (migrated) rows = (await query(file, `SELECT * FROM local_runtime_message_rows WHERE session_id=${quoted} ORDER BY id`, validate)).map(row => ({ ...parse(row.data_json), role: row.role, created_at_ms: row.created_at_ms }));
    else rows = (await query(file, `SELECT display_messages_json FROM local_runtime_messages WHERE session_id=${quoted}`, validate)).flatMap(row => parse(row.display_messages_json) || []);
  } else if (app === "opencode") {
    const v2 = tables.has("session_v2") && (await query(file, `SELECT 1 FROM session_v2 WHERE id=${quoted}`, validate)).length;
    if (v2) rows = (await query(file, `SELECT * FROM session_message WHERE session_id=${quoted} ORDER BY seq,rowid`, validate)).map(row => { const data = parse(row.data) || {}; return { ...data, content: ["user", "system"].includes(row.type) && typeof data.text === "string" ? data.text : data.content ?? data.text, role: row.type, time_created: row.time_created }; });
    else {
      const parts = await query(file, `SELECT * FROM part WHERE session_id=${quoted} ORDER BY time_created,id`, validate);
      rows = (await query(file, `SELECT * FROM message WHERE session_id=${quoted} ORDER BY time_created,id`, validate)).map(row => ({ ...parse(row.data), time_created: row.time_created, content: parts.filter(part => part.message_id === row.id).map(part => parse(part.data)).filter(Boolean) }));
    }
  } else throw new Error("Unsupported database session source");
  if (app === "hermes") {
    const kept = new Map();
    for (const row of rows) {
      let display = row.display_metadata; for (let i = 0; i < 2 && typeof display === "string"; i++) display = parse(display);
      if (display?.model_only) continue;
      const key = JSON.stringify([row.role,row.content,row.timestamp,row.tool_call_id,row.tool_calls,row.tool_name]);
      const previous = kept.get(key);
      if (!previous || (Number(row.active || 0) > Number(previous.active || 0)) || (row.active === previous.active && row.id > previous.id)) kept.set(key, row);
    }
    rows = [...kept.values()];
  }
  return fold(app, app === "mcode" ? rows.filter(row => ["user", "assistant"].includes(row.role)) : rows);
}
async function dependencies(app, source, validate) {
  const { file, id } = splitReference(source);
  const files = [await validate(file)];
  if (app === "kimi") files.push(await kimiStatePath(file, validate));
  if (id !== null) for (const suffix of ["-wal", "-shm"]) { try { await fs.lstat(file + suffix); files.push(await validate(file + suffix)); } catch (error) { if (error.code !== "ENOENT") throw error; } }
  if (app === "opencode" && id === null) {
    const storage = file.slice(0, file.lastIndexOf(`${path.sep}session${path.sep}`));
    const summary = parse(await fs.readFile(file, "utf8"));
    if (!summary?.id || !/^[\w-]+$/.test(summary.id)) throw new Error("Invalid OpenCode session");
    const messages = await walk(path.join(storage, "message", summary.id), p => p.endsWith(".json"), validate);
    files.push(...messages);
    for (const messageFile of messages) {
      const message = parse(await fs.readFile(messageFile, "utf8"));
      if (message?.id && /^[\w-]+$/.test(message.id)) files.push(...await walk(path.join(storage, "part", message.id), p => p.endsWith(".json"), validate));
    }
  }
  return files.sort();
}
// ---------------------------------------------------------------------------
// Kimi Code sessions (cc-switch kimi_session.rs / session_manager kimi.rs):
// sessions/<workDirKey>/<id>/state.json holds the metadata; the committed
// main-agent history lives in agents/main/wire.jsonl. Branch switches
// (agent.switched) hide abandoned turns; the committed human projection
// (agent.message.appended) wins over the legacy context.append_message
// stream; usage joins its request by messageId with the real model resolved
// from the loop's llm.request (the human projection names "agent-loop").
// ---------------------------------------------------------------------------
function kimiActiveRecords(records) {
  const segments = new Map();
  let branch = "main", start = 0, base = null;
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record?.type !== "agent.switched") continue;
    segments.set(branch, { start, end: index, base });
    const next = typeof record.branch === "string" ? record.branch : null;
    const nextBase = record.base && typeof record.base.branch === "string" && Number.isInteger(record.base.line) ? [record.base.branch, record.base.line] : null;
    if (!next || !nextBase) throw new Error("Invalid Kimi branch record");
    branch = next; base = nextBase; start = index + 1;
  }
  segments.set(branch, { start, end: records.length, base });
  const chain = [];
  let limit = records.length;
  const visited = new Set();
  for (;;) {
    if (visited.has(branch)) throw new Error("Kimi branch chain contains a cycle");
    visited.add(branch);
    const segment = segments.get(branch);
    if (!segment) throw new Error("Unknown Kimi branch");
    chain.push([segment.start, Math.min(segment.end, limit)]);
    if (!segment.base) break;
    [branch, limit] = segment.base;
  }
  const active = [];
  for (const [from, to] of chain.reverse()) for (let index = from; index < to; index += 1) active.push(index);
  return active;
}

// Join completed steps to committed messages by messageId, carrying the real
// model and the tool-free request latency (llm.request kind "loop" only,
// matched by turnStep; retries replace the failed attempt).
function kimiRequestIndex(records, active) {
  const messages = new Map();
  let step = null;
  const modelName = value => typeof value === "string" && value.trim() && !["agent-loop", "unknown"].includes(value) ? value : null;
  const timeMs = value => {
    const time = Number(value);
    if (!Number.isFinite(time) || time <= 0) return null;
    return time < 1e12 ? time * 1000 : time;
  };
  for (const index of active) {
    const record = records[index];
    if (record?.agentId && record.agentId !== "main") continue;
    if (record?.type === "agent.switched" || record?.type === "agent.turn.started") { step = null; continue; }
    if (record?.type === "llm.request") {
      if (record.kind && record.kind !== "loop") continue;
      if (!step) continue;
      if (step.turnStep && typeof record.turnStep === "string" && step.turnStep !== record.turnStep) continue;
      step.model = modelName(record.model);
      step.requestMs = timeMs(record.time);
      step.responseMs = null;
      continue;
    }
    if (record?.type !== "context.append_loop_event") continue;
    const event = record.event && typeof record.event === "object" ? record.event : null;
    if (!event) continue;
    if (event.type === "step.begin") {
      step = { uuid: typeof event.uuid === "string" ? event.uuid : null, turnStep: typeof event.turnId === "string" && Number.isInteger(event.step) ? `${event.turnId}.${event.step}` : null, model: null, requestMs: null, responseMs: null };
      continue;
    }
    if (event.type === "content.part" || event.type === "tool.call") {
      if (!step || event.stepUuid !== step.uuid) continue;
      if (event.type === "tool.call") continue;
      const time = timeMs(record.time);
      if (time !== null) step.responseMs = Math.max(step.responseMs ?? 0, time);
      continue;
    }
    if (event.type === "step.end") {
      if (step && event.uuid !== step.uuid) continue;
      const current = step || { model: null, requestMs: null, responseMs: null };
      step = null;
      const id = typeof event.messageId === "string" && event.messageId ? event.messageId : null;
      if (!id) continue;
      const latency = current.requestMs !== null && current.responseMs !== null && current.responseMs >= current.requestMs ? current.responseMs - current.requestMs : null;
      messages.set(id, { model: current.model, latencyMs: latency });
    }
  }
  return { lookup(meta) {
    const id = typeof meta?.messageId === "string" ? meta.messageId : null;
    return id ? messages.get(id) || null : null;
  } };
}

// Resolve the same companion for parsing and both caches. Rechecking on
// every read catches edits, deletion and a newly created preferred state.
async function kimiStatePath(file, validate) {
  const sessionDir = path.dirname(path.dirname(path.dirname(file)));
  const statePaths = [path.join(sessionDir, "state.json"), path.join(sessionDir, "session-meta", "state.json")];
  for (const statePath of statePaths) {
    try {
      const resolved = await validate(statePath);
      await fs.stat(statePath);
      return resolved || statePath;
    } catch (error) { if (error.code !== "ENOENT" && !/Not a registered/.test(String(error?.message))) throw error; }
  }
  throw new Error("Kimi session state is missing");
}

async function kimiWireSession(file, validate) {
  const sessionDir = path.dirname(path.dirname(path.dirname(file)));
  const statePath = await kimiStatePath(file, validate);
  const state = parse(await fs.readFile(statePath, "utf8"));
  if (!state) throw new Error("Kimi session state is missing");
  if (state.archived === true || state.custom?.session_kind === "child") throw new Error("Kimi session is archived or a child session");
  const records = (await jsonl(file)).filter(row => row && typeof row === "object");
  const active = kimiActiveRecords(records);
  const requests = kimiRequestIndex(records, active);
  const hasHuman = active.some(index => ["agent.message.appended", "human.agent.message.appended"].includes(records[index].type));
  const rows = [];
  for (const index of active) {
    const record = records[index];
    const kind = record.type;
    let raw = null;
    if (hasHuman && (kind === "agent.message.appended" || kind === "human.agent.message.appended")) raw = record.message?.message ?? null;
    else if (!hasHuman && kind === "context.append_message") raw = record.message ?? null;
    if (!raw || typeof raw !== "object") continue;
    if (!["user", "assistant", "tool", "system"].includes(raw.role)) continue;
    const meta = record.message && typeof record.message === "object" && record.message.meta && typeof record.message.meta === "object" ? record.message.meta : {};
    const injected = raw.role === "system" || ["injection", "system_trigger", "retry", "compaction_summary"].includes(meta.origin?.kind ?? raw.origin?.kind ?? "");
    const parts = Array.isArray(raw.content) ? raw.content : [];
    const mapped = parts.map(part => part?.type === "think" ? { type: "thinking", thinking: part.think ?? "" } : part);
    const row = {
      role: raw.role,
      content: mapped.length ? mapped : typeof raw.content === "string" ? raw.content : "",
      ts: ts(record.time, "seconds"),
      injected,
    };
    if (raw.role === "tool") {
      row.tool_call_id = typeof raw.toolCallId === "string" ? raw.toolCallId : null;
    }
    const calls = Array.isArray(raw.toolCalls) ? raw.toolCalls : [];
    if (calls.length) {
      row.tool_calls = calls.map(call => ({ id: call.id ?? null, name: call.name ?? "unknown", arguments: call.arguments ?? {} }));
    }
    if (raw.role === "assistant" && meta.usage && typeof meta.usage === "object") {
      const usage = meta.usage;
      const request = requests.lookup(meta);
      const declared = typeof meta.model?.model === "string" ? meta.model.model : null;
      const resolved = !["agent-loop", "unknown"].includes(declared || "") ? declared : request?.model ?? null;
      if (resolved) row.model = resolved;
      row.usage = {
        input_tokens: usage.inputOther ?? 0,
        output_tokens: usage.output ?? 0,
        cache_read_tokens: usage.inputCacheRead ?? 0,
        cache_write_tokens: usage.inputCacheCreation ?? 0,
      };
    }
    rows.push(row);
  }
  const folded = fold("kimi", rows);
  return {
    ...folded,
    id: path.basename(sessionDir),
    cwd: state.cwd ?? state.workDir ?? state.custom?.cwd ?? null,
    title: typeof state.title === "string" ? state.title : null,
    summary: typeof state.lastPrompt === "string" ? state.lastPrompt.slice(0, 160) : null,
  };
}

module.exports = { APPS, roots, list, read, dependencies, splitReference, fold, validateSource, isAgyTranscript };
