const fsPromises = require("node:fs/promises");
const path = require("node:path");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".xml": "application/xml",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

const COMPRESSIBLE = new Set([".html", ".js", ".mjs", ".css", ".json", ".svg", ".txt", ".xml", ".webmanifest"]);

function encodingPreferences(header) {
  const weights = new Map();
  for (const part of String(header || "").toLowerCase().split(",")) {
    const [name, ...parameters] = part.trim().split(";");
    if (!name) continue;
    const quality = parameters.map((v) => v.trim()).find((v) => v.startsWith("q="));
    const value = quality ? Number(quality.slice(2)) : 1;
    weights.set(name.trim(), Number.isFinite(value) && value >= 0 && value <= 1 ? value : 0);
  }
  const quality = (name) => weights.get(name) ?? weights.get("*") ?? 0;
  return {
    encodings: ["br", "gzip"].filter((name) => quality(name) > 0 && quality(name) >= (weights.get("identity") ?? 0))
      .sort((a, b) => quality(b) - quality(a)),
    identityAllowed: (weights.get("identity") ?? (weights.get("*") === 0 ? 0 : 1)) > 0,
  };
}

/**
 * Serve a static file from baseDir. Returns true if served, false otherwise.
 * For SPA: caller should fall back to index.html when this returns false.
 */
async function serveStaticFile(baseDir, pathname, res, req = {}) {
  const safePath = path.normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(baseDir, safePath);

  // prevent directory traversal
  if (!filePath.startsWith(baseDir)) return false;

  // Bind the stat and the read to one checked descriptor (cc-switch-free
  // upstream d9c0226f): a stat-then-open race could swap the file for
  // something outside baseDir after the traversal check passed.
  let handle;
  try {
    handle = await fsPromises.open(filePath, "r");
    const stat = await handle.stat();
    if (!stat.isFile()) return false;

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || "application/octet-stream";
    const isHtml = ext === ".html";
    const negotiable = COMPRESSIBLE.has(ext);
    const preferences = encodingPreferences(req.headers?.["accept-encoding"]);
    let selectedPath = filePath;
    let selectedStat = stat;
    let encoding = null;
    if (negotiable) {
      for (const candidate of preferences.encodings) {
        const variant = `${filePath}.${candidate === "br" ? "br" : "gz"}`;
        try {
          const variantStat = await fsPromises.stat(variant);
          if (variantStat.isFile() && variantStat.mtimeMs >= stat.mtimeMs) {
            selectedPath = variant;
            selectedStat = variantStat;
            encoding = candidate;
            break;
          }
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      }
    }
    if (!encoding && !preferences.identityAllowed) {
      res.writeHead(406, { "Vary": "Accept-Encoding", "Content-Length": 0 });
      res.end();
      return true;
    }

    // The selected path may be a sibling pre-compressed variant, re-opened
    // under the same checked-descriptor rule — BEFORE the headers are
    // committed, so an open failure (variant deleted between stat and open)
    // still falls back to the caller's 404/SPA path instead of leaving a
    // half-committed response. The size is re-statted from the opened
    // descriptor: the pre-open variant stat raced any atomic rewrite (old
    // Content-Length + new body → keep-alive hangs / truncated tails).
    // Whichever descriptor the stream does not consume is closed here: with
    // a variant, the base descriptor's job (the checked stat) is done, so it
    // must be closed explicitly — nulling it without closing leaked one fd
    // per compressible-asset request.
    let streamHandle;
    if (encoding) {
      streamHandle = await fsPromises.open(selectedPath, "r");
      selectedStat = await streamHandle.stat();
      await handle.close();
      handle = null;
    } else {
      streamHandle = handle;
      handle = null; // The stream owns and closes this descriptor.
    }

    res.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": selectedStat.size,
      "Cache-Control": isHtml ? "no-cache" : "public, max-age=31536000, immutable",
      ...(negotiable ? { "Vary": "Accept-Encoding" } : {}),
      ...(encoding ? { "Content-Encoding": encoding } : {}),
    });

    if (req.method === "HEAD") {
      // The descriptor was opened but will not be streamed — close it here.
      await streamHandle.close();
      res.end();
      return true;
    }
    const stream = streamHandle.createReadStream();
    stream.on("error", (error) => res.destroy(error));
    res.on("close", () => stream.destroy());
    stream.pipe(res);
    return true;
  } catch (_e) {
    if (res.headersSent) {
      // Nothing may fall back to the SPA path once the response is committed;
      // tear the socket down instead of leaving the request hanging.
      res.destroy();
      return true;
    }
    return false;
  } finally {
    if (handle) await handle.close();
  }
}

module.exports = { serveStaticFile };
