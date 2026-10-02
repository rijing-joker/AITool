const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");
const { execFileSync } = require("node:child_process");
const { test } = require("node:test");

const paths = require("../src/lib/proxy/paths");
const core = require("../scripts/fetch-core.cjs");

// The download pipeline (resolve → stream → extract → install) exercised with
// a stubbed fetch, against a throwaway paths.* — the real ~/.aitool/proxy
// layout must never be touched by tests.

function makeHome() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aitool-core-dl-"));
  paths.proxyRoot = root;
  paths.binDir = path.join(root, "bin");
  paths.binPath = path.join(paths.binDir, process.platform === "win32" ? "cli-proxy-api.exe" : "cli-proxy-api");
  paths.coreVersionPath = path.join(root, "core-version.txt");
  return root;
}

// A real tar.gz fixture (extract shells out to tar) containing the core
// binary under the release's top-level directory, matching the asset name
// fetch-core computes for this platform.
function makeArchive(root, version) {
  const asset = core.platformAsset(version);
  const stage = path.join(root, "stage", `CLIProxyAPI_${version}`);
  fs.mkdirSync(stage, { recursive: true });
  const binaryName = process.platform === "win32" ? "cli-proxy-api.exe" : "cli-proxy-api";
  fs.writeFileSync(path.join(stage, binaryName), `#!/bin/sh\necho "CLIProxyAPI Version: ${version}"\n`);
  const archive = path.join(root, asset.name);
  execFileSync("tar", ["-czf", archive, "-C", path.dirname(stage), path.basename(stage)]);
  return { archive, asset };
}

function jsonResponse(body) {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => body,
    body: Readable.toWeb(Readable.from([Buffer.from(JSON.stringify(body))])),
  };
}

function binaryResponse(buffer) {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ "content-length": String(buffer.length) }),
    body: Readable.toWeb(Readable.from([buffer])),
  };
}

function chunkedResponse(buffer) {
  // Many small chunks so an abort can land between them.
  const chunks = [];
  for (let offset = 0; offset < buffer.length; offset += 8) {
    chunks.push(buffer.subarray(offset, Math.min(offset + 8, buffer.length)));
  }
  const slow = async function* () {
    for (const chunk of chunks) {
      await new Promise((resolve) => setTimeout(resolve, 2));
      yield chunk;
    }
  };
  return {
    ok: true,
    status: 200,
    headers: new Headers({ "content-length": String(buffer.length) }),
    body: Readable.toWeb(Readable.from(slow())),
  };
}

test("resolveRelease prefers the GitCode mirror's latest release", async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(String(url));
    return jsonResponse({ tag_name: "v8.0.9" });
  };
  const release = await core.resolveRelease({ fetchImpl });
  assert.equal(release.version, "8.0.9");
  assert.equal(release.source, "gitcode");
  assert.match(urls[0], /api\.gitcode\.com\/api\/v5\/repos\/lzt404\/CLIProxyAPI\/releases\/latest/);
});

test("resolveRelease falls back to the repo pin when the mirror is unreachable", async () => {
  const fetchImpl = async () => ({ ok: false, status: 500, headers: new Headers(), body: null });
  const release = await core.resolveRelease({ fetchImpl });
  assert.equal(release.version, core.pinnedVersion());
  assert.equal(release.source, "pinned");
});

test("resolveRelease rethrows aborts instead of falling back", async () => {
  const controller = new AbortController();
  controller.abort();
  const fetchImpl = async (url, { signal } = {}) => {
    const error = new Error("aborted");
    error.name = "AbortError";
    if (signal?.aborted) throw error;
    throw error;
  };
  await assert.rejects(core.resolveRelease({ signal: controller.signal, fetchImpl }), (error) => error.name === "AbortError");
});

test("downloadAndInstall streams from GitCode, installs the binary and records the version", async () => {
  const root = makeHome();
  try {
    const { archive, asset } = makeArchive(root, "8.0.9");
    const archiveBytes = fs.readFileSync(archive);
    const seen = [];
    const fetchImpl = async (url) => {
      seen.push(String(url));
      if (String(url).includes("releases/latest")) return jsonResponse({ tag_name: "v8.0.9" });
      if (String(url).includes("attach_files")) return binaryResponse(archiveBytes);
      throw new Error(`unexpected fetch: ${url}`);
    };
    const events = [];
    const result = await core.downloadAndInstall({ version: "8.0.9", source: "gitcode" }, {
      fetchImpl,
      onProgress: (event) => events.push(event),
    });
    assert.equal(result.skipped, false);
    assert.equal(result.version, "8.0.9");
    assert.equal(result.source, "GitCode");
    assert.ok(fs.existsSync(paths.binPath), "binary installed at paths.binPath");
    assert.equal(fs.readFileSync(paths.coreVersionPath, "utf8"), "v8.0.9\n");
    const downloading = events.filter((e) => e.phase === "downloading");
    assert.ok(downloading.some((e) => e.total === archiveBytes.length && e.downloaded === archiveBytes.length));
    assert.ok(events.some((e) => e.phase === "extracting"));
    // Download candidates are ordered GitCode-first and GitHub is never hit.
    assert.deepEqual(seen.filter((u) => !u.includes("releases/latest")).map((u) => (u.includes("gitcode") ? "gitcode" : "github")), ["gitcode"]);
    assert.ok(!fs.existsSync(path.join(os.tmpdir(), asset.name)), "temp archive cleaned up");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("fetchCore reuses the installed binary when it already matches the latest release", async () => {
  const root = makeHome();
  try {
    fs.mkdirSync(paths.binDir, { recursive: true });
    fs.writeFileSync(paths.binPath, "#!/bin/sh\nexit 0\n");
    fs.writeFileSync(paths.coreVersionPath, "v8.0.9\n");
    let downloads = 0;
    const fetchImpl = async (url) => {
      if (String(url).includes("releases/latest")) return jsonResponse({ tag_name: "v8.0.9" });
      downloads += 1;
      throw new Error(`should not download: ${url}`);
    };
    const result = await core.fetchCore({ fetchImpl });
    assert.equal(result.skipped, true);
    assert.equal(result.version, "8.0.9");
    assert.equal(downloads, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an abort mid-download stops the stream and removes the partial archive", async () => {
  const root = makeHome();
  try {
    const { archive } = makeArchive(root, "8.0.9");
    const controller = new AbortController();
    const fetchImpl = async (url) => {
      if (String(url).includes("releases/latest")) return jsonResponse({ tag_name: "v8.0.9" });
      return chunkedResponse(fs.readFileSync(archive));
    };
    const promise = core.downloadAndInstall({ version: "8.0.9", source: "gitcode" }, {
      fetchImpl,
      signal: controller.signal,
      onProgress: (event) => {
        if (event.phase === "downloading" && event.downloaded > 0) controller.abort();
      },
    });
    await assert.rejects(promise, (error) => error.name === "AbortError");
    // The partial archive (streamed into the real os.tmpdir) is cleaned up.
    const archiveDest = path.join(os.tmpdir(), core.platformAsset("8.0.9").name);
    assert.ok(!fs.existsSync(archiveDest), "partial archive removed on cancel");
    assert.ok(!fs.existsSync(paths.binPath), "no binary installed on cancel");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
