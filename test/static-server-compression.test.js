const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { once } = require("node:events");
const zlib = require("node:zlib");
const { test } = require("node:test");
const { EventEmitter } = require("node:events");
const { serveStaticFile } = require("../src/lib/static-server");

test("precompressed assets negotiate encodings, preserve MIME/cache headers and fall back safely", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aitool-compress-"));
  const source = 'console.log("compression test");\n'.repeat(300);
  await fs.writeFile(path.join(dir, "app.js"), source);
  await fs.writeFile(path.join(dir, "index.html"), "<!doctype html>" + "<p>hello</p>".repeat(200));
  await fs.writeFile(path.join(dir, "small.txt"), "small");
  const { precompressAssets } = await import("../dashboard/scripts/precompress-assets.mjs");
  await precompressAssets(dir);
  assert.equal(await fs.stat(path.join(dir, "small.txt.gz")).then(() => true, () => false), false);
  const server = http.createServer(async (req, res) => {
    if (!await serveStaticFile(dir, req.url, res, req)) { res.writeHead(404); res.end(); }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); await fs.rm(dir, { recursive: true, force: true }); });
  const get = (url, encoding, method = "GET") => new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: server.address().port, path: url, method, headers: encoding ? { "accept-encoding": encoding } : {} }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject); req.end();
  });
  for (const [header, expected] of [["gzip, br", "br"], ["gzip ;q=1, br;q=0.2", "gzip"], ["br;q=0, gzip", "gzip"], ["*;q=0.5, br;q=0", "gzip"]]) {
    const response = await get("/app.js", header);
    assert.equal(response.status, 200);
    assert.equal(response.headers["content-encoding"], expected);
    assert.equal(response.headers["content-type"], "application/javascript; charset=utf-8");
    assert.equal(response.headers.vary, "Accept-Encoding");
    assert.match(response.headers["cache-control"], /immutable/);
    assert.equal(Number(response.headers["content-length"]), response.body.length);
    assert.equal((expected === "br" ? zlib.brotliDecompressSync(response.body) : zlib.gunzipSync(response.body)).toString(), source);
  }
  for (const header of [undefined, "gzip;q=0, br;q=0", "identity;q=1, br;q=0.2"]) {
    const response = await get("/app.js", header);
    assert.equal(response.headers["content-encoding"], undefined);
    assert.equal(response.body.toString(), source);
  }
  const head = await get("/app.js", "br", "HEAD");
  assert.equal(head.body.length, 0);
  assert.equal(head.headers["content-encoding"], "br");
  assert.ok(Number(head.headers["content-length"]) > 0);
  assert.equal((await get("/index.html", "br")).headers["cache-control"], "no-cache");
  assert.equal((await get("/small.txt", "br")).body.toString(), "small");
  assert.equal((await get("/small.txt", "identity;q=0, *;q=0")).status, 406);
  await fs.rm(path.join(dir, "app.js.br"));
  assert.equal((await get("/app.js", "br, gzip")).headers["content-encoding"], "gzip");
  await fs.utimes(path.join(dir, "app.js.gz"), new Date(0), new Date(0));
  assert.equal((await get("/app.js", "gzip")).body.toString(), source, "stale variants are ignored");
  assert.equal((await get("/missing.js", "br")).status, 404);
});

test("serving a precompressed variant closes the checked base descriptor (no fd leak)", async (t) => {
  // Regression guard: when a .br/.gz sibling wins negotiation, the base-file
  // descriptor opened for the checked stat must be closed explicitly — it is
  // not the one the stream owns. Patch fs/promises.open to count close() calls
  // per path (the variant fd's close is driven by the stream internals; the
  // base file has a distinct path, so the two are separable).
  const fsSync = require("node:fs");
  const fsp = require("node:fs/promises");
  const { EventEmitter } = require("node:events");
  const origOpen = fsp.open;
  const closesByPath = new Map();
  fsp.open = async function patchedOpen(file, ...args) {
    const handle = await origOpen.call(fsp, file, ...args);
    const key = String(file);
    const origClose = handle.close.bind(handle);
    handle.close = async function patchedClose(...cargs) {
      closesByPath.set(key, (closesByPath.get(key) || 0) + 1);
      return origClose(...cargs);
    };
    return handle;
  };
  t.after(() => { fsp.open = origOpen; });

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aitool-fdleak-"));
  const source = 'console.log("fd leak test");\n'.repeat(200);
  const basePath = path.join(dir, "app.js");
  await fs.writeFile(basePath, source);
  const { precompressAssets } = await import("../dashboard/scripts/precompress-assets.mjs");
  await precompressAssets(dir);

  const serve = async () => {
    const req = { method: "GET", headers: { "accept-encoding": "gzip" } };
    const res = new EventEmitter();
    res.write = () => true;
    res.end = () => {};
    res.writeHead = () => res;
    res.destroy = () => {};
    const served = await serveStaticFile(dir, "/app.js", res, req);
    assert.equal(served, true);
    // Give the base-handle close (awaited inside serveStaticFile) its tick.
    await new Promise((resolve) => setImmediate(resolve));
    return closesByPath.get(basePath) || 0;
  };

  const first = await serve();
  assert.equal(first, 1, "base descriptor must be closed after the first variant request");
  const second = await serve();
  assert.equal(second, 2, "…and after the second");
  await fs.rm(dir, { recursive: true, force: true });
});

test("a variant open failure falls back before the response is committed", async (t) => {
  // The variant is re-opened BEFORE writeHead, so a stat→open race (variant
  // deleted in between) returns false while headers are still uncommitted and
  // the caller's 404/SPA fallback proceeds — instead of hanging a
  // half-committed response (the catch also destroys the socket if headers
  // ever did go out).
  const fsp = require("node:fs/promises");
  const origOpen = fsp.open;
  fsp.open = async function failingVariantOpen(file, ...args) {
    if (String(file).endsWith(".gz")) throw new Error("variant vanished between stat and open");
    return origOpen.call(fsp, file, ...args);
  };
  t.after(() => { fsp.open = origOpen; });

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aitool-openfail-"));
  await fs.writeFile(path.join(dir, "app.js"), 'console.log("open failure test");\n'.repeat(200));
  const { precompressAssets } = await import("../dashboard/scripts/precompress-assets.mjs");
  await precompressAssets(dir);

  const res = new EventEmitter();
  res.headersSent = false;
  res.write = () => true;
  res.end = () => {};
  res.writeHead = () => { res.headersSent = true; return res; };
  res.destroy = () => {};
  const served = await serveStaticFile(dir, "/app.js", res, { method: "GET", headers: { "accept-encoding": "gzip" } });
  assert.equal(served, false, "the caller must get the fallback signal");
  assert.equal(res.headersSent, false, "no headers may be committed on the failure path");
  await fs.rm(dir, { recursive: true, force: true });
});

test("a variant's Content-Length is re-statted from the opened descriptor", async (t) => {
  // The pre-open variant stat races an atomic rewrite (deploy replaces
  // app.js.gz between stat and open): committing the raced size with the
  // body the opened descriptor serves hangs keep-alive clients / truncates
  // the tail. The size must come from a stat bound to the opened handle.
  const fsp = require("node:fs/promises");
  const origStat = fsp.stat;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aitool-stalestat-"));
  const source = 'console.log("stale stat test");\n'.repeat(200);
  await fs.writeFile(path.join(dir, "app.js"), source);
  const { precompressAssets } = await import("../dashboard/scripts/precompress-assets.mjs");
  await precompressAssets(dir);
  const variantPath = path.join(dir, "app.js.gz");
  const realSize = (await origStat.call(fsp, variantPath)).size;
  fsp.stat = async function staleVariantStat(file, ...args) {
    const stat = await origStat.call(fsp, file, ...args);
    if (String(file) === variantPath) return { ...stat, size: realSize + 999, isFile: () => true };
    return stat;
  };
  t.after(() => { fsp.stat = origStat; });

  const written = [];
  let committedHeaders = null;
  const res = new EventEmitter();
  res.write = (chunk) => { written.push(chunk); return true; };
  res.writeHead = (status, headers) => { committedHeaders = headers; return res; };
  res.destroy = () => {};
  const done = new Promise((resolve) => {
    res.end = (chunk) => { if (chunk) written.push(chunk); resolve(); };
  });
  const served = await serveStaticFile(dir, "/app.js", res, { method: "GET", headers: { "accept-encoding": "gzip" } });
  assert.equal(served, true);
  assert.equal(committedHeaders["Content-Encoding"], "gzip");
  await done;
  assert.equal(committedHeaders["Content-Length"], realSize, "size is bound to the opened descriptor, not the raced stat");
  const body = Buffer.concat(written);
  assert.equal(body.length, realSize);
  await fs.rm(dir, { recursive: true, force: true });
});
