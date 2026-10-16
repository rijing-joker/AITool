const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { Readable } = require("node:stream");
const { execFileSync } = require("node:child_process");
const { test } = require("node:test");

const paths = require("../src/lib/proxy/paths");
const core = require("../scripts/fetch-core.cjs");

test("staging a release preserves the live binary and marker until commit", async () => {
  const root = makeHome();
  let staged;
  try {
    const { archive } = makeArchive(root, "8.0.9");
    fs.mkdirSync(paths.binDir, { recursive: true });
    fs.writeFileSync(paths.binPath, "previous core");
    fs.writeFileSync(paths.coreVersionPath, "v8.0.8\n");
    staged = await core.stageCoreRelease({ version: "8.0.9", source: "gitcode" }, {
      fetchImpl: async () => binaryResponse(fs.readFileSync(archive)),
    });
    assert.equal(fs.readFileSync(paths.binPath, "utf8"), "previous core");
    assert.equal(fs.readFileSync(paths.coreVersionPath, "utf8"), "v8.0.8\n");
    assert.notEqual(staged.binaryPath, paths.binPath);
    assert.ok(fs.existsSync(staged.binaryPath));
    core.installStagedCore(staged);
    assert.match(fs.readFileSync(paths.binPath, "utf8"), /8\.0\.9/);
    assert.equal(fs.readFileSync(paths.coreVersionPath, "utf8"), "v8.0.9\n");
  } finally {
    staged?.cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("failed rollback preserves its original backup across another update attempt", (t) => {
  const root = makeHome();
  try {
    fs.mkdirSync(paths.binDir, { recursive: true });
    fs.writeFileSync(paths.binPath, "original working core");
    fs.writeFileSync(paths.coreVersionPath, "v8.0.8\n");
    const original = core.backupInstallation();
    fs.writeFileSync(paths.binPath, "broken replacement");
    fs.writeFileSync(paths.coreVersionPath, "v8.0.9\n");
    const rename = fs.renameSync;
    const mock = t.mock.method(fs, "renameSync", (...args) => {
      if (args[1] === paths.binPath) throw new Error("file is locked");
      return rename(...args);
    });
    assert.throws(() => original.restore(), /previous installation retained/);
    original.cleanup();
    assert.equal(fs.readFileSync(path.join(original.directory, "0"), "utf8"), "original working core");
    const retry = core.backupInstallation();
    assert.notEqual(retry.directory, original.directory);
    retry.cleanup();
    assert.equal(fs.readFileSync(path.join(original.directory, "0"), "utf8"), "original working core");
    mock.mock.restore();
    original.restore();
    original.cleanup();
    assert.equal(fs.readFileSync(paths.binPath, "utf8"), "original working core");
    assert.equal(fs.existsSync(original.directory), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

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

function textResponse(body) {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    text: async () => body,
  };
}

const githubApi = (body) => jsonResponse(body);
const atomFeed = (tag) => textResponse(`<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/" xml:lang="en-US">
  <entry>
    <id>tag:github.com,2008:Repository/1/v${tag}</id>
    <link rel="self" href="https://github.com/router-for-me/CLIProxyAPI/releases/tag/v${tag}"/>
  </entry>
</feed>`);

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
    return jsonResponse({ tag_name: "v8.0.29" });
  };
  const release = await core.resolveRelease({ fetchImpl });
  assert.equal(release.version, "8.0.29");
  assert.equal(release.source, "gitcode");
  assert.match(urls[0], /api\.gitcode\.com\/api\/v5\/repos\/lzt404\/CLIProxyAPI\/releases\/latest/);
});

test("resolveRelease falls back to the repo pin when the mirror is unreachable", async () => {
  const fetchImpl = async () => ({ ok: false, status: 500, headers: new Headers(), body: null });
  const release = await core.resolveRelease({ fetchImpl });
  assert.equal(release.version, core.pinnedVersion());
  assert.equal(release.source, "pinned");
});

test("resolveRelease rejects stale, prerelease and malformed mirror tags", async () => {
  for (const tag_name of ["v8.0.18", "v8.0.29-rc.1", "../8.0.99", "latest", "v8.0", ""]) {
    const release = await core.resolveRelease({ fetchImpl: async () => jsonResponse({ tag_name }) });
    assert.deepEqual(release, { version: core.pinnedVersion(), source: "pinned", digests: {} });
  }
  assert.deepEqual(await core.resolveRelease({ fetchImpl: async () => jsonResponse({ tag_name: "v8.1.0" }) }), { version: "8.1.0", source: "gitcode", digests: {} });
});

test("resolveRelease falls back to GitHub's latest when the mirror lags or is down", async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes("api.gitcode.com")) return { ok: false, status: 502, headers: new Headers(), body: null };
    if (String(url).includes("api.github.com")) return githubApi({ tag_name: "v8.0.30" });
    throw new Error(`unexpected fetch: ${url}`);
  };
  const release = await core.resolveRelease({ fetchImpl });
  assert.equal(release.version, "8.0.30");
  assert.equal(release.source, "github");
});

test("resolveRelease uses the GitHub atom feed when the API is unreachable", async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes("api.gitcode.com") || String(url).includes("api.github.com")) {
      return { ok: false, status: 503, headers: new Headers(), body: null };
    }
    if (String(url).endsWith("releases.atom")) return atomFeed("8.0.29");
    throw new Error(`unexpected fetch: ${url}`);
  };
  const release = await core.resolveRelease({ fetchImpl });
  assert.equal(release.version, "8.0.29");
  assert.equal(release.source, "github");
});

test("resolveRelease validates GitHub API and atom tags against the stable pin", async () => {
  for (const tag of ["8.0.18", "8.0.99-rc.1", "../8.0.99", "latest", "8.0", ""]) {
    const release = await core.resolveRelease({ fetchImpl: async (url) => {
      if (String(url).includes("api.gitcode.com")) return jsonResponse({ tag_name: "v8.0.18" });
      if (String(url).includes("api.github.com")) return githubApi({ tag_name: tag });
      return atomFeed(tag);
    } });
    assert.equal(release.version, core.pinnedVersion());
    assert.equal(release.source, "pinned");
  }
  const release = await core.resolveRelease({ fetchImpl: async (url) => {
    if (String(url).endsWith("releases.atom")) return atomFeed("8.0.29");
    return jsonResponse({ tag_name: "v8.0.18" });
  } });
  assert.equal(release.version, "8.0.29");
  assert.equal(release.source, "github");
});

test("resolveRelease carries GitHub asset digests for download verification", async () => {
  const digest = "a".repeat(64);
  const fetchImpl = async (url) => {
    if (String(url).includes("api.gitcode.com")) return { ok: false, status: 502, headers: new Headers(), body: null };
    return githubApi({
      tag_name: "v8.0.30",
      assets: [{ name: core.platformAsset("8.0.30").name, digest: `sha256:${digest}` }],
    });
  };
  const release = await core.resolveRelease({ fetchImpl });
  assert.equal(release.digests[core.platformAsset("8.0.30").name], digest);
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
    fs.writeFileSync(paths.coreVersionPath, "v8.0.29\n");
    let downloads = 0;
    const fetchImpl = async (url) => {
      if (String(url).includes("releases/latest")) return jsonResponse({ tag_name: "v8.0.29" });
      downloads += 1;
      throw new Error(`should not download: ${url}`);
    };
    const result = await core.fetchCore({ fetchImpl });
    assert.equal(result.skipped, true);
    assert.equal(result.version, "8.0.29");
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

test("download write errors reject cleanly and preserve the installed core", async (t) => {
  const root = makeHome();
  try {
    fs.mkdirSync(paths.binDir, { recursive: true });
    fs.writeFileSync(paths.binPath, "previous core");
    const open = t.mock.method(fs, "open", (...args) => {
      process.nextTick(() => args.at(-1)(Object.assign(new Error("disk full"), { code: "ENOSPC" })));
    });
    await assert.rejects(core.downloadAndInstall({ version: "8.0.9", source: "gitcode" }, {
      fetchImpl: async () => binaryResponse(Buffer.from("archive")),
    }), /all core download sources failed.*disk full/);
    open.mock.restore();
    assert.equal(fs.readFileSync(paths.binPath, "utf8"), "previous core");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a partial install copy leaves the previous core and version intact", async (t) => {
  const root = makeHome();
  try {
    const { archive } = makeArchive(root, "8.0.9");
    const bytes = fs.readFileSync(archive);
    fs.mkdirSync(paths.binDir, { recursive: true });
    fs.writeFileSync(paths.binPath, "previous core");
    fs.writeFileSync(paths.coreVersionPath, "v8.0.8\n");
    t.mock.method(fs, "copyFileSync", (_source, destination) => {
      fs.writeFileSync(destination, "partial");
      throw new Error("disk full copying binary");
    });
    await assert.rejects(core.downloadAndInstall({ version: "8.0.9", source: "gitcode" }, {
      fetchImpl: async () => binaryResponse(bytes),
    }), /disk full copying binary/);
    assert.equal(fs.readFileSync(paths.binPath, "utf8"), "previous core");
    assert.equal(fs.readFileSync(paths.coreVersionPath, "utf8"), "v8.0.8\n");
    assert.deepEqual(fs.readdirSync(paths.binDir), [path.basename(paths.binPath)]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a tampered archive fails sha256 verification and installs nothing", async () => {
  const root = makeHome();
  try {
    const { archive, asset } = makeArchive(root, "8.0.9");
    const servedBytes = Buffer.from(fs.readFileSync(archive));
    servedBytes[servedBytes.length - 1] ^= 0xff; // flip the last byte
    const fetchImpl = async (url) => {
      if (String(url).includes("api.gitcode.com")) return { ok: false, status: 502, headers: new Headers(), body: null };
      if (String(url).includes("api.github.com")) {
        return githubApi({
          tag_name: "v8.0.9",
          assets: [{ name: asset.name, digest: `sha256:${crypto.createHash("sha256").update(fs.readFileSync(archive)).digest("hex")}` }],
        });
      }
      return binaryResponse(servedBytes);
    };
    await assert.rejects(core.downloadAndInstall({ version: "8.0.9", source: "github", digests: { [asset.name]: crypto.createHash("sha256").update(fs.readFileSync(archive)).digest("hex") } }, { fetchImpl }),
      /sha256 verification failed/);
    assert.ok(!fs.existsSync(paths.binPath), "no binary installed from a tampered archive");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a truncated download fails the content-length check", async () => {
  const root = makeHome();
  try {
    const { archive } = makeArchive(root, "8.0.9");
    const bytes = fs.readFileSync(archive);
    const shortResponse = {
      ok: true,
      status: 200,
      headers: new Headers({ "content-length": String(bytes.length + 100) }),
      body: Readable.toWeb(Readable.from([bytes])),
    };
    await assert.rejects(core.downloadAndInstall({ version: "8.0.9", source: "gitcode", digests: {} }, {
      fetchImpl: async () => shortResponse,
    }), /download size verification failed/);
    assert.ok(!fs.existsSync(paths.binPath), "no binary installed from a truncated archive");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("compareCoreVersions orders semantically and refuses unparseable builds", () => {
  assert.equal(core.compareCoreVersions("8.0.10", "8.0.9"), 1);
  assert.equal(core.compareCoreVersions("8.0.9", "8.0.9"), 0);
  assert.equal(core.compareCoreVersions("8.0.9", "8.10.0"), -1);
  assert.equal(core.compareCoreVersions("8.0.9-rc.2", "8.0.9-rc.10"), -1);
  assert.equal(core.compareCoreVersions("8.0.9-rc.1", "8.0.9"), -1);
  assert.equal(core.compareCoreVersions("v8.0.9", "8.0.9"), 0);
  // Local builds (dev-local+sha) are not comparable — callers decide.
  assert.equal(core.compareCoreVersions("8.0.9", "dev-local+abc1234"), null);
  assert.equal(core.coreUpdateAvailable("8.0.9", "8.0.10"), true);
  assert.equal(core.coreUpdateAvailable("8.0.10", "8.0.9"), false);
  assert.equal(core.coreUpdateAvailable(null, "8.0.10"), false);
});

test("fetchCore never downgrades a newer installed version", async () => {
  const root = makeHome();
  try {
    fs.mkdirSync(paths.binDir, { recursive: true });
    fs.writeFileSync(paths.binPath, "#!/bin/sh\nexit 0\n");
    fs.writeFileSync(paths.coreVersionPath, "v9.0.0\n");
    let downloads = 0;
    const fetchImpl = async (url) => {
      if (String(url).includes("releases/latest")) return jsonResponse({ tag_name: `v${core.pinnedVersion()}` });
      downloads += 1;
      throw new Error(`should not download: ${url}`);
    };
    const result = await core.fetchCore({ fetchImpl });
    assert.equal(result.skipped, true);
    assert.equal(downloads, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("checkUpdate reports installed, latest and hasUpdate", async () => {
  const root = makeHome();
  try {
    fs.mkdirSync(paths.binDir, { recursive: true });
    fs.writeFileSync(paths.coreVersionPath, "v8.0.9\n");
    const fetchImpl = async (url) => {
      if (String(url).includes("api.gitcode.com")) return { ok: false, status: 502, headers: new Headers(), body: null };
      if (String(url).includes("api.github.com")) return githubApi({ tag_name: "v8.0.30" });
      throw new Error(`unexpected fetch: ${url}`);
    };
    assert.deepEqual(await core.checkUpdate({ fetchImpl }), {
      installed: "8.0.9", latest: "8.0.30", source: "github", hasUpdate: true,
    });
    fs.writeFileSync(paths.coreVersionPath, "v8.0.30\n");
    assert.equal((await core.checkUpdate({ fetchImpl })).hasUpdate, false);
    fs.writeFileSync(paths.coreVersionPath, "dev-local+abc1234\n");
    assert.equal((await core.checkUpdate({ fetchImpl })).hasUpdate, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("overlapping downloads use independent temporary files and clean them up", async (t) => {
  const root = makeHome();
  try {
    const { archive } = makeArchive(root, "8.0.9");
    const bytes = fs.readFileSync(archive);
    const dirs = [];
    const mkdtemp = fs.mkdtempSync;
    t.mock.method(fs, "mkdtempSync", (...args) => {
      const dir = mkdtemp(...args);
      dirs.push(dir);
      return dir;
    });
    const fetchImpl = async () => chunkedResponse(bytes);
    await Promise.all([
      core.downloadAndInstall({ version: "8.0.9", source: "gitcode" }, { fetchImpl }),
      core.downloadAndInstall({ version: "8.0.9", source: "gitcode" }, { fetchImpl }),
    ]);
    assert.equal(new Set(dirs).size, dirs.length);
    assert.equal(dirs.filter((dir) => path.basename(dir).startsWith("aitool-core-")).length, 2);
    assert.ok(dirs.every((dir) => !fs.existsSync(dir)));
    assert.match(fs.readFileSync(paths.binPath, "utf8"), /8\.0\.9/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
