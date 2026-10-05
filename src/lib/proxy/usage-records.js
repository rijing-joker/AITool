const fs = require("node:fs/promises");
const path = require("node:path");
const { setImmediate: yieldToIO } = require("node:timers/promises");
const { normalizeRecord } = require("./usage-record");

const RECORD_FILE = /^records-\d{4}-\d{2}-\d{2}\.jsonl$/;

function signature(stat) {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}

async function boundary(handle, offset) {
  const buffer = Buffer.alloc(Math.min(64, offset));
  const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset - buffer.length);
  return buffer.subarray(0, bytesRead).toString("hex");
}

function parseRecord(line) {
  try {
    // Rows written before normalization are raw core payloads (snake_case
    // tokens, unmasked api_key); normalize every row as it is parsed so the
    // cache and every reader see canonical, secret-free rows.
    return normalizeRecord(JSON.parse(line));
  } catch {
    return null;
  }
}

async function readFile(filePath, stat, previous) {
  const handle = await fs.open(filePath, "r");
  try {
    // App writers append or replace files atomically. Check the old boundary
    // too, so a truncate/rewrite followed by growth does not reuse stale rows.
    const append = previous && stat.dev === previous.dev && stat.ino === previous.ino &&
      stat.size > previous.size &&
      await boundary(handle, Math.min(64, previous.offset)) === previous.head &&
      await boundary(handle, previous.offset) === previous.boundary;
    const rows = append ? previous.rows.slice() : [];
    let offset = append ? previous.offset : 0;
    let pending = Buffer.alloc(0);
    let parsedLines = 0;
    if (Number(stat.size) > offset) {
      const stream = handle.createReadStream({ start: offset, end: Number(stat.size) - 1, autoClose: false });
      for await (const chunk of stream) {
        const buffer = pending.length ? Buffer.concat([pending, chunk]) : chunk;
        let start = 0;
        let end;
        while ((end = buffer.indexOf(10, start)) !== -1) {
          const record = parseRecord(buffer.toString("utf8", start, end));
          if (record) rows.push(record);
          offset += end - start + 1;
          start = end + 1;
          // JSON parsing stays on the main thread, but large backfills must
          // allow other dashboard/API requests to make progress.
          if (++parsedLines % 1024 === 0) await yieldToIO();
        }
        pending = Buffer.from(buffer.subarray(start));
      }
    }
    return {
      signature: signature(stat), dev: stat.dev, ino: stat.ino, size: stat.size,
      offset, boundary: await boundary(handle, offset), rows,
      head: await boundary(handle, Math.min(64, offset)),
      // A valid final JSON value without a newline is visible, but is read
      // again on append. Never permanently consume a partially written line.
      tail: pending.length ? parseRecord(pending.toString("utf8")) : null,
    };
  } finally {
    await handle.close();
  }
}

function createUsageRecordStore({ maxFiles = 14, maxCachedBytes = 64 * 1024 * 1024, maxCachedRecords = 100_000, idleTtlMs = 120_000 } = {}) {
  let cache = null;
  let pending = null;
  let idleTimer = null;

  function retain(next) {
    cache = next;
    clearTimeout(idleTimer);
    idleTimer = next ? setTimeout(() => { cache = null; idleTimer = null; }, idleTtlMs) : null;
    idleTimer?.unref?.();
  }

  async function load(usageDir) {
    let names;
    try {
      names = (await fs.readdir(usageDir)).filter((name) => RECORD_FILE.test(name)).sort().reverse().slice(0, maxFiles);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      retain(null);
      return [];
    }
    const files = (await Promise.all(names.map(async (name) => {
      try {
        return { name, stat: await fs.stat(path.join(usageDir, name), { bigint: true }) };
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        return null;
      }
    }))).filter(Boolean);
    const key = files.map(({ name, stat }) => `${name}:${signature(stat)}`).join("|");
    const previous = cache?.usageDir === usageDir ? cache : null;
    if (previous?.key === key) {
      retain(previous);
      return previous.rows;
    }

    const entries = new Map();
    const rows = [];
    for (const { name, stat } of files) {
      const old = previous?.entries.get(name);
      let entry;
      try {
        entry = old?.signature === signature(stat) ? old : await readFile(path.join(usageDir, name), stat, old);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        continue; // Rotated/deleted between listing and opening; retry next read.
      }
      entries.set(name, entry);
      for (const record of entry.rows) rows.push(record);
      if (entry.tail) rows.push(entry.tail);
    }
    rows.sort((a, b) => String(b.timestamp || "").localeCompare(String(a.timestamp || "")));
    const bytes = files.reduce((total, { stat }) => total + Number(stat.size), 0);
    // Bound retained history. Oversized datasets still return complete results,
    // but their parsed records are released after the current requests finish.
    retain(bytes <= maxCachedBytes && rows.length <= maxCachedRecords
      ? { usageDir, key, entries, rows } : null);
    return rows;
  }

  return {
    async readRecords(usageDir) {
      // Share simultaneous list/stats/overview reads, including the cold scan.
      // Serialize a different directory too (useful after a runtime path change).
      while (pending && pending.usageDir !== usageDir) await pending.promise.catch(() => {});
      if (!pending) {
        const request = { usageDir, promise: null };
        request.promise = load(usageDir).finally(() => { if (pending === request) pending = null; });
        pending = request;
      }
      return pending.promise;
    },
  };
}

module.exports = { createUsageRecordStore };
