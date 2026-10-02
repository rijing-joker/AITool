const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { once } = require("node:events");
const zlib = require("node:zlib");
const { test } = require("node:test");
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
