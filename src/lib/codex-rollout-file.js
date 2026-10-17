"use strict";

// A compressed rollout is an immutable snapshot of the same logical JSONL.
// Never write decoded conversation text to disk or expose a compressed byte
// offset as a plaintext cursor. Decoders enforce the existing Harness limits.
const fs = require("node:fs/promises");
const path = require("node:path");
const { Readable } = require("node:stream");
const { decodeDshZstd } = require("./zstd");
const MAX_COMPRESSED_BYTES = 64 * 1024 * 1024;
const MAX_TEXT_BYTES = 128 * 1024 * 1024;

const isCompressed = (file) => typeof file === "string" && file.endsWith(".jsonl.zst");
const isRollout = (file) => typeof file === "string" && (file.endsWith(".jsonl") || isCompressed(file));
const logicalPath = (file) => isCompressed(file) ? file.slice(0, -4) : file;
const siblingPath = (file) => isCompressed(file) ? logicalPath(file) : isRollout(file) ? `${file}.zst` : null;
const signature = (stat) => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
function rolloutIds(file) {
  const match = path.basename(String(file || "")).match(new RegExp(`(${UUID})(?:_(${UUID}))?\\.jsonl(?:\\.zst)?$`, "i"));
  return match ? { thread: match[1].toLowerCase(), rollout: (match[2] || match[1]).toLowerCase(), paginated: !!match[2] } : null;
}

function dedupeSiblings(files, pathOf = (file) => file) {
  const plain = new Set(files.filter((file) => !isCompressed(pathOf(file))).map(pathOf));
  return files.filter((file) => !isCompressed(pathOf(file)) || !plain.has(logicalPath(pathOf(file))));
}

async function readSnapshot(file, { expectedStat, maxOutputBytes = MAX_TEXT_BYTES } = {}) {
  const handle = await fs.open(file, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("Not a Codex rollout file");
    if (expectedStat && signature(expectedStat) !== signature(stat)) throw new Error("Codex rollout changed before reading");
    if (isCompressed(file) && stat.size > MAX_COMPRESSED_BYTES) throw new Error("Compressed Codex rollout exceeds read limit");
    const bytes = await handle.readFile();
    const data = isCompressed(file) ? await decodeDshZstd(bytes, { maxOutputBytes }) : bytes;
    const current = await fs.stat(file);
    if (signature(stat) !== signature(await handle.stat()) || signature(stat) !== signature(current)) {
      throw new Error("Codex rollout changed while reading");
    }
    return { data, stat };
  } finally {
    await handle.close();
  }
}

async function readText(file) {
  return (await readSnapshot(file)).data.toString("utf8");
}

function bufferStream(data, start = 0, end = data.length) {
  return Readable.from((function* chunks() {
    for (let offset = start; offset < end; offset += 64 * 1024) yield data.subarray(offset, Math.min(end, offset + 64 * 1024));
  })());
}

module.exports = { isCompressed, isRollout, logicalPath, siblingPath, signature, rolloutIds, dedupeSiblings, readSnapshot, readText, bufferStream };
