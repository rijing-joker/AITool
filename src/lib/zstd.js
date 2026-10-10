// Bounded multi-frame Zstd reader shared by DeepSeek Harness and Codex.
// Native decoding runs in the libuv pool, never on the HTTP event loop.
const DEFAULT_MAX_OUTPUT_BYTES = 128 * 1024 * 1024;

function inspectDshZstdFrames(data, maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES) {
  const input = Buffer.isBuffer(data) ? data : Buffer.from(data || []);
  const limit = Number.isSafeInteger(maxOutputBytes) && maxOutputBytes >= 0
    ? maxOutputBytes
    : DEFAULT_MAX_OUTPUT_BYTES;
  let offset = 0;
  let totalContentBytes = 0;
  let allContentSizesDeclared = true;
  let frames = 0;
  const frameRanges = [];

  const need = (count, label) => {
    if (offset + count > input.length) throw new Error(`Invalid DeepSeek Harness zstd ${label}`);
  };
  const readUnsignedLE = (count) => {
    need(count, "frame header");
    let value = 0n;
    for (let i = 0; i < count; i++) value |= BigInt(input[offset + i]) << BigInt(i * 8);
    offset += count;
    return value;
  };

  while (offset < input.length) {
    const frameStart = offset;
    need(4, "magic");
    const magic = input.readUInt32LE(offset);
    offset += 4;

    if (magic >= 0x184d2a50 && magic <= 0x184d2a5f) {
      need(4, "skippable frame size");
      const skipBytes = input.readUInt32LE(offset);
      offset += 4;
      need(skipBytes, "skippable frame payload");
      offset += skipBytes;
      continue;
    }
    if (magic !== 0xfd2fb528) throw new Error("Invalid DeepSeek Harness zstd frame magic");

    need(1, "descriptor");
    const descriptor = input[offset++];
    if ((descriptor & 0x08) !== 0) throw new Error("Invalid DeepSeek Harness zstd reserved frame bit");
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 0x20) !== 0;
    const hasChecksum = (descriptor & 0x04) !== 0;
    const dictionaryIdBytes = [0, 1, 2, 4][descriptor & 0x03];
    let windowSize = null;
    if (!singleSegment) {
      need(1, "window descriptor");
      const windowDescriptor = input[offset++];
      const windowBase = 2 ** (10 + (windowDescriptor >>> 3));
      windowSize = windowBase + (windowBase / 8) * (windowDescriptor & 0x07);
    }
    need(dictionaryIdBytes, "dictionary id");
    offset += dictionaryIdBytes;

    const contentSizeBytes = contentSizeFlag === 0
      ? (singleSegment ? 1 : 0)
      : [0, 2, 4, 8][contentSizeFlag];
    let declaredContentBytes = null;
    if (contentSizeBytes > 0) {
      declaredContentBytes = readUnsignedLE(contentSizeBytes);
      if (contentSizeBytes === 2) declaredContentBytes += 256n;
      if (declaredContentBytes > BigInt(limit)) {
        throw new Error(`DeepSeek Harness decompressed session log exceeds ${limit} bytes`);
      }
      if (singleSegment) windowSize = Number(declaredContentBytes);
    } else {
      allContentSizesDeclared = false;
    }

    let lastBlock = false;
    let frameUpperBound = 0;
    while (!lastBlock) {
      need(3, "block header");
      const blockHeader = input[offset] | (input[offset + 1] << 8) | (input[offset + 2] << 16);
      offset += 3;
      lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 0x03;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) throw new Error("Invalid DeepSeek Harness zstd reserved block type");
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      need(payloadBytes, "block payload");
      offset += payloadBytes;
      // A raw block emits blockSize bytes; an RLE block expands to blockSize
      // repeated bytes; a compressed block cannot emit more than the frame's
      // window or Zstandard's 128 KiB maximum block size. This gives frames
      // without FCS a safe allocation bound before native decompression.
      frameUpperBound += blockType === 2
        ? Math.min(Number(windowSize) || 128 * 1024, 128 * 1024)
        : blockSize;
      if (declaredContentBytes == null && frameUpperBound > limit) {
        throw new Error(`DeepSeek Harness decompressed session log exceeds ${limit} bytes`);
      }
    }
    if (hasChecksum) {
      need(4, "checksum");
      offset += 4;
    }
    const boundedFrameBytes = declaredContentBytes == null
      ? frameUpperBound
      : Number(declaredContentBytes);
    totalContentBytes += boundedFrameBytes;
    if (allContentSizesDeclared && totalContentBytes > limit) {
      throw new Error(`DeepSeek Harness decompressed session log exceeds ${limit} bytes`);
    }
    frameRanges.push({ start: frameStart, end: offset, maxContentBytes: boundedFrameBytes });
    frames += 1;
  }

  if (frames === 0) throw new Error("DeepSeek Harness zstd log contains no data frames");
  return {
    frames,
    totalContentBytes: allContentSizesDeclared ? totalContentBytes : null,
    maxTotalContentBytes: totalContentBytes,
    frameRanges,
  };
}

// Decode one already-isolated frame. Prefer Node's built-in zstd (22.15+):
// the desktop bundles install dependencies with --ignore-scripts, so
// @mongodb-js/zstd ships without its native binding there and the require()
// would throw — silently skipping every compressed session (issue #465). The
// MongoDB binding stays as the fallback for Node 20 CLI installs, where npm
// runs install scripts normally.
async function decodeDshZstdFrame(frameBytes) {
  const zlib = require("node:zlib");
  if (typeof zlib.zstdDecompress === "function") {
    return new Promise((resolve, reject) => zlib.zstdDecompress(frameBytes, (error, value) => error ? reject(error) : resolve(value)));
  }
  return Buffer.from(await require("@mongodb-js/zstd").decompress(frameBytes));
}

// Decode one independent Harness append frame at a time; per-frame decoding
// lets us enforce the aggregate plaintext limit when the frame omits its
// content size.
async function decodeDshZstd(
  data,
  { maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES, inspected = null } = {},
) {
  const input = Buffer.isBuffer(data) ? data : Buffer.from(data || []);
  const frameInfo = inspected || inspectDshZstdFrames(input, maxOutputBytes);
  const parts = [];
  let total = 0;
  for (const frame of frameInfo.frameRanges) {
    const decoded = await decodeDshZstdFrame(input.subarray(frame.start, frame.end));
    total += decoded.length;
    if (total > maxOutputBytes) {
      throw new Error(`DeepSeek Harness decompressed session log exceeds ${maxOutputBytes} bytes`);
    }
    parts.push(decoded);
  }
  return Buffer.concat(parts, total);
}

module.exports = { inspectDshZstdFrames, decodeDshZstd };
