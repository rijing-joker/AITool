// Streaming provider health probe, mirroring the semantics of
// EasyCLIProxyAPI's Rust `provider_health_probe` command: POST a tiny
// generate request to the upstream and measure the time to the first
// streamed text token, so the dashboard can flag dead providers/models.

const MAX_STREAM_BYTES = 256 * 1024;
const MAX_PROBE_CONCURRENCY = 4;
const SUPPORTED_PROTOCOLS = new Set(["openai-chat", "openai-responses", "claude", "gemini"]);

let activeProbes = 0;
const waiters = [];

async function acquireSlot() {
  if (activeProbes < MAX_PROBE_CONCURRENCY) {
    activeProbes += 1;
    return;
  }
  await new Promise((resolve) => waiters.push(resolve));
  activeProbes += 1;
}

function releaseSlot() {
  activeProbes = Math.max(0, activeProbes - 1);
  const next = waiters.shift();
  if (next) next();
}

function hasText(value) {
  if (typeof value === "string") return value.trim() !== "";
  if (Array.isArray(value)) return value.some((item) => hasText(item));
  if (value && typeof value === "object") {
    return ["text", "content"].some((key) => hasText(value[key]));
  }
  return false;
}

function jsonHasText(protocol, value) {
  if (!value || typeof value !== "object") return false;
  switch (protocol) {
    case "openai-chat":
      return (value.choices ?? []).some((choice) =>
        hasText(choice?.delta?.content)
        || hasText(choice?.delta?.reasoning_content)
        || hasText(choice?.delta?.reasoning)
        || hasText(choice?.delta?.thinking)
        || hasText(choice?.message?.content),
      );
    case "openai-responses": {
      const deltaTypes = new Set([
        "response.output_text.delta",
        "response.reasoning_text.delta",
        "response.reasoning_summary_text.delta",
      ]);
      if (deltaTypes.has(value.type) && hasText(value.delta)) return true;
      return (value.output ?? []).some((item) =>
        (item?.content ?? []).some((part) => hasText(part?.text)),
      );
    }
    case "claude":
      return hasText(value?.delta?.text)
        || hasText(value?.delta?.thinking)
        || (value?.content ?? []).some((part) => hasText(part?.text));
    case "gemini":
      return (value.candidates ?? []).some((candidate) =>
        (candidate?.content?.parts ?? []).some((part) => hasText(part?.text)),
      );
    default:
      return false;
  }
}

function streamLines(text) {
  return text.split(/\r?\n/);
}

function sseJsonEvents(text) {
  const events = [];
  for (const rawLine of streamLines(text)) {
    const line = rawLine.trim();
    const data = line.startsWith("data:") ? line.slice(5).trim() : line;
    if (!data || data === "[DONE]") continue;
    try {
      events.push(JSON.parse(data));
    } catch {}
  }
  return events;
}

function streamHasText(protocol, buffer) {
  return sseJsonEvents(buffer.toString("utf8")).some((value) => jsonHasText(protocol, value));
}

function geminiTerminalSuccess(value) {
  const exhausted = (value.candidates ?? []).some(
    (candidate) => candidate?.finishReason === "MAX_TOKENS",
  );
  const thoughts = value?.usageMetadata?.thoughtsTokenCount ?? 0;
  const total = value?.usageMetadata?.totalTokenCount ?? 0;
  return exhausted && thoughts > 0 && total >= thoughts;
}

function streamHasTerminalSuccess(protocol, buffer) {
  if (protocol !== "gemini") return false;
  return sseJsonEvents(buffer.toString("utf8")).some(geminiTerminalSuccess);
}

function isStreamingContentType(contentType) {
  const lowered = String(contentType || "").toLowerCase();
  return lowered.includes("text/event-stream")
    || lowered.includes("application/x-ndjson")
    || lowered.includes("application/json-seq");
}

// request: { url, header, data, protocol, timeoutMs } (EasyCLIProxyAPI shape).
// `model`/`source`/`authIndex` are accepted for shape parity; they only feed
// the Rust side's local usage log, which AiTool does not keep.
async function probe(request) {
  const url = String(request?.url || "").trim();
  let parsed;
  try {
    parsed = new URL(url);
  } catch (error) {
    throw new Error(`Invalid health check URL: ${error?.message || error}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Health checks support only HTTP or HTTPS URLs");
  }
  const protocol = String(request?.protocol || "");
  if (!SUPPORTED_PROTOCOLS.has(protocol)) {
    throw new Error("Unsupported health check protocol");
  }
  const data = String(request?.data || "");
  if (Buffer.byteLength(data, "utf8") > 64 * 1024) {
    throw new Error("Health check request body is too large");
  }
  const timeoutMs = Math.min(120_000, Math.max(1_000, Number(request?.timeoutMs) || 15_000));

  await acquireSlot();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = process.hrtime.bigint();
  try {
    let response;
    try {
      response = await fetch(parsed, {
        method: "POST",
        headers: { ...(request?.header || {}) },
        body: data,
        signal: controller.signal,
      });
    } catch (error) {
      throw new Error(`Health check request failed: ${error?.cause?.code || error?.message || error}`);
    }
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).trim();
      throw new Error(detail
        ? `Upstream returned HTTP ${response.status}: ${detail}`
        : `Upstream returned HTTP ${response.status}`);
    }
    const contentType = response.headers.get("content-type") || "";
    if (!isStreamingContentType(contentType)) {
      throw new Error("Upstream did not return a streaming response; time to first token cannot be measured");
    }
    const reader = response.body.getReader();
    const received = [];
    let receivedBytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      receivedBytes += value.byteLength;
      if (receivedBytes > MAX_STREAM_BYTES) {
        throw new Error("Health check did not receive the model's first token within the limit");
      }
      received.push(Buffer.from(value));
      const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      const elapsed = Math.max(1, Math.round(elapsedMs));
      const chunkText = Buffer.concat(received);
      if (streamHasText(protocol, chunkText)) {
        return { firstTokenLatencyMs: elapsed, responseLatencyMs: elapsed };
      }
      if (streamHasTerminalSuccess(protocol, chunkText)) {
        return { responseLatencyMs: elapsed };
      }
    }
    throw new Error("Health check did not receive the model's first token");
  } finally {
    clearTimeout(timer);
    releaseSlot();
  }
}

module.exports = { probe };
