const fs = require("node:fs");
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

  try {
    const stat = await fsPromises.stat(filePath);
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

    res.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": selectedStat.size,
      "Cache-Control": isHtml ? "no-cache" : "public, max-age=31536000, immutable",
      ...(negotiable ? { "Vary": "Accept-Encoding" } : {}),
      ...(encoding ? { "Content-Encoding": encoding } : {}),
    });

    if (req.method === "HEAD") {
      res.end();
      return true;
    }
    const stream = fs.createReadStream(selectedPath);
    stream.on("error", (error) => res.destroy(error));
    res.on("close", () => stream.destroy());
    stream.pipe(res);
    return true;
  } catch (_e) {
    return false;
  }
}

module.exports = { serveStaticFile };
