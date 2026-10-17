// Adapted from azrinaldi/opencode-free-bridge, MIT, f3e1c5a (see LICENSE).
// Pure protocol helpers only: no listeners, network defaults, installers or disk history.
const crypto = require("node:crypto");
const MAX_BODY_BYTES = 10 * 1024 * 1024;
const CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const SESSION_PREFIX_MASK = (1n << 48n) - 1n;
const MAX_COUNTER_PER_MS = 16;
let lastTimestamp = 0;
let counter = 0;
const RAND_POOL_SIZE = 14 * 256;
const randPool = Buffer.allocUnsafe(RAND_POOL_SIZE);
let randPoolOffset = RAND_POOL_SIZE;

function nextRandomBase62_14() {
  if (randPoolOffset + 14 > RAND_POOL_SIZE) {
    crypto.randomFillSync(randPool);
    randPoolOffset = 0;
  }
  let out = "";
  for (let i = 0; i < 14; i++) {
    out += CHARS[randPool[randPoolOffset + i] % 62];
  }
  randPoolOffset += 14;
  return out;
}

function createId(descending, timestamp = Date.now()) {
  if (timestamp !== lastTimestamp) {
    lastTimestamp = timestamp;
    counter = 0;
  }
  counter++;
  const extraMs = Math.floor((counter - 1) / MAX_COUNTER_PER_MS);
  const effectiveCounter = ((counter - 1) % MAX_COUNTER_PER_MS) + 1;
  const current = BigInt(timestamp + extraMs) * 0x1000n + BigInt(effectiveCounter);
  const value = (descending ? ~current : current) & SESSION_PREFIX_MASK;
  return value.toString(16).padStart(12, "0") + nextRandomBase62_14();
}


// --- OpenCode v2 Tool Fingerprint Layering ---
// Upstream /inference/v1 validates that `tools` contains OpenCode's exact `read`
// and `shell` tool definitions (verbatim description and parameter schema).
// Stub descriptions or `tool_choice: "none"` trigger 403 FreeTierError.
const FINGERPRINT_TOOL_NAMES = ["read", "shell"];

const FINGERPRINT_TOOL_DEFINITIONS = {
  read: {
    description:
      "Read the contents of a file or directory. Supports text files, images, and PDFs. Images and PDFs are presented directly to the model. Each text line is prefixed by its 1-based line number as <line>: <content>. The prefix is for reference and is not part of the file content. Directory entries are returned one per line. Use offset and limit to read large files or directories in sections. Prefer one larger read over many small slices, and use grep to find specific content in large files.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File or directory to read" },
        offset: {
          type: "integer",
          minimum: 0,
          description: "The line or directory entry to start reading from (1-based)",
        },
        limit: {
          type: "integer",
          minimum: 0,
          description:
            "The maximum number of lines or directory entries to read (defaults to and capped at 2000)",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  shell: {
    description:
      "Execute a shell command and return its output. Commands run on Linux using bash. Quote file paths containing spaces or special characters. Prefer dedicated tools over shell commands when possible. When output is large, the full result is saved to a file and a truncated preview is returned. Rely on automatic truncation unless filtering the output is more useful. Commands accept an optional timeout, background commands have no timeout by default. Background commands return immediately, and you will be notified when they complete.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command string to execute" },
        workdir: {
          type: "string",
          description:
            "Working directory to execute the command in. Defaults to the current working directory. When possible, avoid changing directories in the command and set the working directory here instead.",
        },
        timeout: {
          type: "integer",
          minimum: 0,
          description:
            "Timeout in milliseconds. Set to 0 to disable the timeout. Defaults to 120000 for foreground commands. Background commands have no timeout by default.",
        },
        background: {
          type: "boolean",
          description:
            "Run the command in the background and return immediately (useful for dev servers and long-running builds). You do not need to use '&' at the end of the command when using this parameter. You will be notified when it completes. DO NOT poll for completion.",
        },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
};

function getToolName(tool) {
  if (!tool || typeof tool !== "object") return "";
  if (typeof tool.name === "string") return tool.name.trim();
  if (tool.function && typeof tool.function.name === "string") return tool.function.name.trim();
  return "";
}

function stableStringify(val) {
  if (!val || typeof val !== "object") return JSON.stringify(val);
  if (Array.isArray(val)) return "[" + val.map(stableStringify).join(",") + "]";
  const keys = Object.keys(val).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(val[k])).join(",") + "}";
}

const FINGERPRINT_PARAM_STRINGS = {
  read: stableStringify(FINGERPRINT_TOOL_DEFINITIONS.read.parameters),
  shell: stableStringify(FINGERPRINT_TOOL_DEFINITIONS.shell.parameters),
};

const CANONICAL_TOOLS_CHAT = Object.freeze(
  FINGERPRINT_TOOL_NAMES.map((name) =>
    Object.freeze({
      type: "function",
      function: Object.freeze({
        name,
        description: FINGERPRINT_TOOL_DEFINITIONS[name].description,
        parameters: FINGERPRINT_TOOL_DEFINITIONS[name].parameters,
      }),
    })
  )
);

const CANONICAL_TOOLS_RESPONSES = Object.freeze(
  FINGERPRINT_TOOL_NAMES.map((name) =>
    Object.freeze({
      type: "function",
      name,
      description: FINGERPRINT_TOOL_DEFINITIONS[name].description,
      parameters: FINGERPRINT_TOOL_DEFINITIONS[name].parameters,
      strict: false,
    })
  )
);

const EMPTY_MAP = Object.freeze(new Map());

function isExactFingerprintDef(tool, key) {
  const want = FINGERPRINT_TOOL_DEFINITIONS[key];
  if (!want || !tool || typeof tool !== "object") return false;
  const def = tool.function && typeof tool.function === "object" ? tool.function : tool;
  return (
    def.description === want.description &&
    stableStringify(def.parameters) === FINGERPRINT_PARAM_STRINGS[key]
  );
}

function buildPlaceholderNote(appendedNames) {
  if (!Array.isArray(appendedNames) || appendedNames.length === 0) return "";
  const list = appendedNames.map((n) => `\`${n}\``).join(" or ");
  return appendedNames.length > 1
    ? `Do not call the ${list} tools; they are placeholders that do nothing. Use the other tools you have been given instead.`
    : `Do not call the ${list} tool; it is a placeholder that does nothing. Use the other tools you have been given instead.`;
}

const DEFAULT_PLACEHOLDER_NOTE = buildPlaceholderNote(FINGERPRINT_TOOL_NAMES);

function prepareToolsWithFingerprint(clientTools = [], flat = false) {
  if (!Array.isArray(clientTools) || clientTools.length === 0) {
    return {
      tools: flat ? CANONICAL_TOOLS_RESPONSES : CANONICAL_TOOLS_CHAT,
      appended: FINGERPRINT_TOOL_NAMES,
      placeholderNote: DEFAULT_PLACEHOLDER_NOTE,
      aliasToOriginal: EMPTY_MAP,
      originalToAlias: EMPTY_MAP,
    };
  }
  const aliasToOriginal = new Map();
  const originalToAlias = new Map();
  const normalized = [];
  const takenNames = new Set(clientTools.map(getToolName).filter(Boolean));
  const presentExactFingerprints = new Set();

  for (const t of clientTools) {
    const name = getToolName(t);
    if (!name) continue;
    const def = t.function && typeof t.function === "object" ? t.function : t;
    const description = def.description || "";
    const parameters = def.parameters || { type: "object", properties: {} };

    if (FINGERPRINT_TOOL_NAMES.includes(name)) {
      if (presentExactFingerprints.has(name)) continue;
      if (isExactFingerprintDef(t, name)) {
        presentExactFingerprints.add(name);
        normalized.push(
          flat
            ? { type: "function", name, description, parameters, strict: false }
            : { type: "function", function: { name, description, parameters } }
        );
        continue;
      }
      // Client defined its own `read` or `shell` tool with a custom schema:
      // alias it so we can still inject OpenCode's exact fingerprint tool.
      if (originalToAlias.has(name)) continue;
      let alias = `${name}_client`;
      for (let i = 2; takenNames.has(alias); i++) {
        alias = `${name}_client${i}`;
      }
      takenNames.add(alias);
      aliasToOriginal.set(alias, name);
      originalToAlias.set(name, alias);
      normalized.push(
        flat
          ? { type: "function", name: alias, description, parameters }
          : { type: "function", function: { name: alias, description, parameters } }
      );
      continue;
    }

    normalized.push(
      flat
        ? { type: "function", name, description, parameters }
        : { type: "function", function: { name, description, parameters } }
    );
  }

  const appended = [];
  for (let i = 0; i < FINGERPRINT_TOOL_NAMES.length; i++) {
    const name = FINGERPRINT_TOOL_NAMES[i];
    if (presentExactFingerprints.has(name)) continue;
    normalized.push(flat ? CANONICAL_TOOLS_RESPONSES[i] : CANONICAL_TOOLS_CHAT[i]);
    appended.push(name);
  }

  return {
    tools: normalized,
    appended,
    placeholderNote:
      appended.length === FINGERPRINT_TOOL_NAMES.length
        ? DEFAULT_PLACEHOLDER_NOTE
        : buildPlaceholderNote(appended),
    aliasToOriginal,
    originalToAlias,
  };
}

function prepareResponsesTools(clientTools = []) {
  return prepareToolsWithFingerprint(clientTools, true).tools;
}

function prepareChatTools(clientTools = []) {
  return prepareToolsWithFingerprint(clientTools, false).tools;
}

function restoreClientToolName(name, aliasToOriginal) {
  if (!name || !aliasToOriginal || aliasToOriginal.size === 0) return name;
  return aliasToOriginal.get(name) || name;
}

function extractContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (typeof p === "string") return p;
        if (p?.type === "text" && typeof p.text === "string") return p.text;
        if (p?.text) return String(p.text);
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return content ? JSON.stringify(content) : "";
}

// First-N-chars text without ever serializing the whole value: strings are
// sliced directly, arrays join only text parts up to the limit, objects fall
// back to a bounded stringify. Used for the headerless session signature so
// a multi-MB system prompt is never JSON.stringified just for a hash.
function shortText(content, limit = 1000) {
  if (typeof content === "string") return content.slice(0, limit);
  if (Array.isArray(content)) {
    let out = "";
    for (const p of content) {
      if (out.length >= limit) break;
      if (typeof p === "string") out += p;
      else if (p?.type === "text" && typeof p.text === "string") out += p.text;
      else if (p?.text) out += String(p.text);
    }
    return out.slice(0, limit);
  }
  if (!content) return "";
  try {
    return JSON.stringify(content).slice(0, limit);
  } catch {
    return String(content).slice(0, limit);
  }
}

function messageSignatureSample(content, limit = 1000) {
  if (typeof content === "string") {
    const len = content.length;
    if (len <= limit) return `${len}:${content}`;
    const half = Math.floor(limit / 2);
    return `${len}:${content.slice(0, half)}..${content.slice(len - half)}`;
  }
  if (Array.isArray(content)) {
    const head = shortText(content, Math.floor(limit / 2));
    const last = content[content.length - 1];
    const tail = shortText(last ? [last] : [], Math.floor(limit / 2));
    return `${content.length}:${head}..${tail}`;
  }
  return shortText(content, limit);
}

function transformResponsesContent(content, role = "user") {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const hasNonText = content.some(
      (p) =>
        p &&
        typeof p === "object" &&
        (p.type === "image_url" || p.type === "input_image" || p.type === "input_file")
    );
    if (!hasNonText) return extractContent(content);
    const textType = role === "assistant" ? "output_text" : "input_text";
    const parts = [];
    for (const p of content) {
      if (typeof p === "string") {
        parts.push({ type: textType, text: p });
      } else if (p && typeof p === "object") {
        if (p.type === "text" || p.type === "input_text" || p.type === "output_text") {
          parts.push({ type: textType, text: String(p.text ?? "") });
        } else if (p.type === "image_url") {
          const imageUrl = typeof p.image_url === "string" ? p.image_url : p.image_url?.url;
          if (imageUrl) parts.push({ type: "input_image", image_url: imageUrl });
        } else if (p.type === "input_image" || p.type === "input_file") {
          parts.push(p);
        } else if (p.text) {
          parts.push({ type: textType, text: String(p.text) });
        }
      }
    }
    return parts;
  }
  return extractContent(content);
}

// Convert OpenAI messages to OpenCode input format (for Responses API)
function transformToResponsesInput(messages = [], originalToAlias = null) {
  const input = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m) continue;
    if (m.role === "system" || m.role === "developer") {
      continue;
    }
    if (m.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: m.tool_call_id || "call_unknown",
        output: typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? ""),
      });
      continue;
    }
    if (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      if (m.content) {
        input.push({
          role: "assistant",
          content: transformResponsesContent(m.content, "assistant"),
        });
      }
      for (const tc of m.tool_calls) {
        const fn = tc.function || {};
        const rawName = fn.name || "unknown";
        const mappedName =
          originalToAlias && originalToAlias.has(rawName) ? originalToAlias.get(rawName) : rawName;
        input.push({
          type: "function_call",
          call_id: tc.id || `call_${crypto.randomBytes(8).toString("hex")}`,
          name: mappedName,
          arguments: typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments || {}),
        });
      }
      continue;
    }
    const role = m.role || "user";
    input.push({ role, content: transformResponsesContent(m.content, role) });
  }
  return input;
}

function extractSystemInstructions(messages = [], explicitInstructions = "", placeholderNote = "") {
  const parts = [];
  if (typeof explicitInstructions === "string" && explicitInstructions.trim()) {
    parts.push(explicitInstructions.trim());
  }
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m || (m.role !== "system" && m.role !== "developer")) continue;
    const text = extractContent(m.content).trim();
    if (text) parts.push(text);
  }
  if (placeholderNote) {
    parts.push(placeholderNote);
  }
  return parts.join("\n\n");
}

function transformChatMessages(messages = [], originalToAlias = null, placeholderNote = "") {
  const out = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m) continue;
    if (
      originalToAlias &&
      originalToAlias.size > 0 &&
      m.role === "assistant" &&
      Array.isArray(m.tool_calls)
    ) {
      out.push({
        ...m,
        tool_calls: m.tool_calls.map((tc) => {
          const fnName = tc?.function?.name;
          if (fnName && originalToAlias.has(fnName)) {
            return { ...tc, function: { ...tc.function, name: originalToAlias.get(fnName) } };
          }
          return tc;
        }),
      });
    } else {
      out.push(m);
    }
  }

  if (placeholderNote) {
    const first = out[0];
    if (first?.role === "system" || first?.role === "developer") {
      if (typeof first.content === "string") {
        out[0] = { ...first, content: `${first.content}\n\n${placeholderNote}` };
      } else if (Array.isArray(first.content)) {
        out[0] = { ...first, content: [...first.content, { type: "text", text: `\n\n${placeholderNote}` }] };
      } else {
        out.unshift({ role: "system", content: placeholderNote });
      }
    } else {
      out.unshift({ role: "system", content: placeholderNote });
    }
  }
  return out;
}


// Persistent session cache — preserves upstream prompt/KV cache across turns (LRU)
const sessionCache = new Map();
const MAX_SESSIONS = 500;
const SESSION_TTL_MS = 3 * 3600 * 1000;

function getPersistentSessionId(req, body) {
  const headers = req?.headers || {};
  const rawHeaderKey =
    headers["x-opencode-session"] ||
    headers["x-opencode-session-id"] ||
    headers["x-session-id"] ||
    headers["session-id"] ||
    headers["x-conversation-id"] ||
    headers["x-9r-session-id"];
  const headerKey = Array.isArray(rawHeaderKey)
    ? String(rawHeaderKey[0] || "").slice(0, 256)
    : rawHeaderKey
      ? String(rawHeaderKey).slice(0, 256)
      : "";
  // Fast path (common case): a session header is present, so no message
  // hashing is needed at all. The conv-signature hash below only runs for
  // headerless clients, and slices BEFORE stringify so a huge system prompt
  // never gets serialized just to take its first 1000 chars.
  let lookupKey = headerKey ? "hdr:" + headerKey : null;
  if (!lookupKey) {
    const msgs = body && Array.isArray(body.messages) ? body.messages : [];
    if (msgs.length > 0) {
      const sig =
        messageSignatureSample(msgs[0]?.content, 1000) +
        "::" +
        messageSignatureSample(msgs[1]?.content, 1000);
      if (sig !== "::") {
        lookupKey =
          "conv:" + crypto.createHash("sha256").update(sig).digest("hex").slice(0, 20);
      }
    }
  }
  const now = Date.now();
  if (lookupKey && sessionCache.has(lookupKey)) {
    const entry = sessionCache.get(lookupKey);
    if (now - entry.lastSeen < SESSION_TTL_MS) {
      // Re-insert to update Map insertion order for O(1) LRU eviction
      sessionCache.delete(lookupKey);
      entry.lastSeen = now;
      sessionCache.set(lookupKey, entry);
      return entry.sessionId;
    }
    sessionCache.delete(lookupKey);
  }
  const newSessionId = "ses_" + createId(true);
  if (lookupKey) {
    if (sessionCache.size >= MAX_SESSIONS) {
      for (const [k, v] of sessionCache) {
        if (now - v.lastSeen >= SESSION_TTL_MS) sessionCache.delete(k);
      }
      if (sessionCache.size >= MAX_SESSIONS) {
        const lruKey = sessionCache.keys().next().value;
        if (lruKey !== undefined) sessionCache.delete(lruKey);
      }
    }
    sessionCache.set(lookupKey, { sessionId: newSessionId, lastSeen: now });
  }
  return newSessionId;
}

function readRequestBody(req, maxBytes = MAX_BODY_BYTES, signal) {
  if (signal?.aborted) return Promise.reject(signal.reason);
  // Early reject: if the client declares a huge body, refuse without reading
  // a single byte instead of buffering up to the limit first.
  const declared = parseInt(req?.headers?.["content-length"] || "", 10);
  if (Number.isFinite(declared) && declared > maxBytes) {
    const err = new Error(`Request body exceeds limit of ${maxBytes} bytes`);
    err.statusCode = 413;
    err.code = "payload_too_large";
    return Promise.reject(err);
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    let done = false;
    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
      req.off("aborted", onAborted);
      if (typeof req.off === "function") {
        req.off("error", onError);
        req.off("data", onData);
        req.off("end", onEnd);
      } else if (typeof req.removeListener === "function") {
        req.removeListener("error", onError);
        req.removeListener("data", onData);
        req.removeListener("end", onEnd);
      }
    };

    const onError = (err) => {
      if (done) return;
      done = true;
      cleanup();
      reject(err);
    };
    const onAbort = () => onError(signal.reason);
    const onAborted = () => onError(new Error("Client disconnected"));

    const onData = (chunk) => {
      if (done) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buf.length;
      if (totalBytes > maxBytes) {
        done = true;
        chunks.length = 0;
        cleanup();
        if (typeof req.pause === "function") req.pause();
        const err = new Error(`Request body exceeds limit of ${maxBytes} bytes`);
        err.statusCode = 413;
        err.code = "payload_too_large";
        reject(err);
        return;
      }
      chunks.push(buf);
    };

    const onEnd = () => {
      if (done) return;
      done = true;
      cleanup();
      resolve(Buffer.concat(chunks).toString("utf8"));
    };

    req.on("error", onError);
    req.on("aborted", onAborted);
    signal?.addEventListener("abort", onAbort, { once: true });
    req.on("data", onData);
    req.on("end", onEnd);
  });
}


module.exports = { prepareToolsWithFingerprint, transformToResponsesInput, transformChatMessages, extractSystemInstructions, getPersistentSessionId, readRequestBody };
