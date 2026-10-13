// Adapted from TokenTracker 1da2bd6d / 056b27e0. AiTool compacts upload
// batches in memory: the proxy bridge appends outside sync.lock, so replacing
// the shared queue file could lose concurrent requests.

const CHUNK_BYTES = 64 * 1024;
const { TOKEN_COLUMNS } = require("./account-usage-dedup");

function sessionSnapshotMs(row) {
  const verifiedMs = Date.parse(row?.snapshot_verified_at);
  if (typeof row?.source !== "string" || row.source.trim().toLowerCase() !== "trae-cn" ||
      typeof row.session_id !== "string" || !row.session_id.trim() || row.session_id.trim().length > 256 ||
      typeof row.model !== "string" || !row.model.trim() || row.model.trim().length > 200 ||
      !Number.isFinite(Date.parse(row.bucket_start)) || !Number.isFinite(verifiedMs) ||
      TOKEN_COLUMNS.some((column) => !Number.isSafeInteger(Number(row[column])) || Number(row[column]) < 0) ||
      Number(row.total_tokens) !== Number(row.input_tokens) + Number(row.output_tokens) + Number(row.cached_input_tokens) + Number(row.cache_creation_input_tokens)) return null;
  return verifiedMs;
}

// Keep raw bytes, including CRLF and incomplete tails. Upload offsets are
// byte positions, not JavaScript string lengths.
async function* iterateQueueLines(handle, start, end) {
  let position = start;
  let lineStart = start;
  let carry = Buffer.alloc(0);
  while (position < end) {
    const chunk = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, end - position));
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
    if (!bytesRead) throw new Error("Queue changed while reading");
    position += bytesRead;
    const data = carry.length ? Buffer.concat([carry, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead);
    let consumed = 0;
    let newline;
    while ((newline = data.indexOf(10, consumed)) !== -1) {
      const bytes = data.subarray(consumed, newline + 1);
      yield { bytes, start: lineStart, complete: true };
      lineStart += bytes.length;
      consumed = newline + 1;
    }
    carry = Buffer.from(data.subarray(consumed));
  }
  if (carry.length) yield { bytes: carry, start: lineStart, complete: false };
}

module.exports = { iterateQueueLines, sessionSnapshotMs };
