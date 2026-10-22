"use strict";

// Process-local only: transcript bodies never become analytics or disk cache.
class TranscriptCache {
  constructor({ maxEntries = 8, maxBytes = 96 * 1024 * 1024 } = {}) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0 || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw new Error("Transcript cache limits must be positive integers");
    }
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
    this.entries = new Map();
    this.bytes = 0;
  }

  get(key, revision) {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.revision !== revision) {
      this.delete(key);
      return null;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    // Pricing and consumers may annotate their returned copy.
    return structuredClone(entry.value);
  }

  delete(key) {
    this.bytes -= this.entries.get(key)?.bytes || 0;
    this.entries.delete(key);
  }

  set(key, revision, value) {
    this.delete(key);
    const bytes = Buffer.byteLength(JSON.stringify(value));
    if (bytes > this.maxBytes) return;
    while (this.entries.size >= this.maxEntries || this.bytes + bytes > this.maxBytes) {
      this.delete(this.entries.keys().next().value);
    }
    this.entries.set(key, { revision, value: structuredClone(value), bytes });
    this.bytes += bytes;
  }
}

const PREVIEW_THRESHOLD = 4096;
const PREVIEW_CHARS = 1200;
const CONTENT_PAGE_CHARS = 128 * 1024;

function previewTranscript(session) {
  const messages = structuredClone(session.messages);
  const replace = (object, field, id) => {
    if (typeof object?.[field] !== "string" || object[field].length <= PREVIEW_THRESHOLD) return;
    object[`${field}Ref`] = { id, length: object[field].length };
    object[field] = object[field].slice(0, PREVIEW_CHARS);
  };
  messages.forEach((message, index) => {
    for (const field of ["content", "thinking"]) replace(message, field, `${index}:${field}`);
    (message.toolResults || []).forEach((result, resultIndex) => {
      for (const field of ["content", "output"]) replace(result, field, `${index}:result:${resultIndex}:${field}`);
    });
  });
  return { ...session, messages, preview: true };
}

function contentPage(session, { revision, ref, offset = 0, limit = CONTENT_PAGE_CHARS }) {
  if (revision !== session.revision) throw new Error("Session changed; reload before reading more content");
  const match = String(ref || "").match(/^(\d+):(?:(content|thinking)|result:(\d+):(content|output))$/);
  if (!match || !Number.isSafeInteger(Number(offset)) || Number(offset) < 0 ||
      !Number.isSafeInteger(Number(limit)) || Number(limit) <= 0) throw new Error("Invalid session content reference or range");
  const message = session.messages[Number(match[1])];
  const value = match[2] ? message?.[match[2]] : message?.toolResults?.[Number(match[3])]?.[match[4]];
  if (typeof value !== "string" || Number(offset) > value.length) throw new Error("Session content is unavailable");
  const start = Number(offset);
  const end = Math.min(value.length, start + Math.min(Number(limit), CONTENT_PAGE_CHARS));
  return { content: value.slice(start, end), offset: start, nextOffset: end, total: value.length, complete: end === value.length };
}

module.exports = { TranscriptCache, previewTranscript, contentPage };
