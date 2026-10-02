#!/usr/bin/env node
/* eslint-disable no-console */

// Downloads the CLIProxyAPI core release binary into ~/.aitool/proxy/bin.
// Mirrors EasyCLIProxyAPI's version-management page: the target version is
// resolved from the GitCode China mirror's latest release (the mirror only
// carries the newest release, and the repo pin in core-version.txt is the
// fallback when the mirror API is unreachable — downloads then come from
// GitHub). The binary itself is fetched at runtime so the proxy engine stays
// an external, independently-updatable process. An already-present matching
// binary is reused rather than re-downloaded; AITOOL_CORE_FORCE=1 re-fetches.
//
// Usable two ways:
//   - CLI:  `node scripts/fetch-core.cjs` (progress printed to stdout)
//   - lib:  require() → resolveRelease / downloadAndInstall / fetchCore,
//           used by src/lib/proxy/core-install.js for progress-aware installs.

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");
const { createWriteStream } = require("node:fs");
const { once } = require("node:events");
const paths = require("../src/lib/proxy/paths");

const REPO_ROOT = path.resolve(__dirname, "..");
const VERSION_FILE = path.join(REPO_ROOT, "core-version.txt");
const RELEASE_PREFIX = "https://github.com/router-for-me/CLIProxyAPI/releases/download";
const GITCODE_API_PREFIX = "https://api.gitcode.com/api/v5/repos";
// GitCode mirror of the core (the same one EasyCLIProxyAPI ships): reachable
// from mainland China without a proxy and carrying the latest release assets.
// Override with AITOOL_CORE_GITCODE_REPO; set it empty to disable.
const GITCODE_CORE_REPO = process.env.AITOOL_CORE_GITCODE_REPO === undefined
  ? "lzt404/CLIProxyAPI"
  : process.env.AITOOL_CORE_GITCODE_REPO.trim();

function pinnedVersion() {
  try {
    return fs.readFileSync(VERSION_FILE, "utf8").trim().replace(/^v/, "");
  } catch {
    return null;
  }
}

function installedVersion() {
  try {
    return fs.readFileSync(paths.coreVersionPath, "utf8").trim().replace(/^v/, "");
  } catch {
    return null;
  }
}

function platformAsset(version) {
  const osName = process.platform === "win32" ? "windows" : process.platform;
  const archName = process.arch === "arm64" ? "aarch64" : "amd64";
  const extension = process.platform === "win32" ? "zip" : "tar.gz";
  const name = `CLIProxyAPI_${version}_${osName}_${archName}.${extension}`;
  return { version, name };
}

// Resolve the version to install. The GitCode mirror is queried for its latest
// release first (fast, proxy-free in CN, and the only version it carries);
// the repo-pinned version is the offline fallback (downloaded from GitHub).
async function resolveRelease({ signal, fetchImpl = fetch } = {}) {
  if (GITCODE_CORE_REPO) {
    try {
      const response = await fetchImpl(`${GITCODE_API_PREFIX}/${GITCODE_CORE_REPO}/releases/latest`, {
        headers: { "user-agent": "aitool-fetch-core", accept: "application/json" },
        signal,
      });
      if (response.ok) {
        const body = await response.json().catch(() => null);
        const version = String(body?.tag_name || "").trim().replace(/^v/, "");
        if (version) return { version, source: "gitcode" };
      }
    } catch (error) {
      if (isAbort(error)) throw error;
      // fall through to the pinned version
    }
  }
  const version = pinnedVersion();
  if (version) return { version, source: "pinned" };
  throw new Error("unable to resolve a core version — GitCode mirror unreachable and no core-version.txt pin");
}

function isAbort(error) {
  return error?.name === "AbortError" || error?.code === "ABORT_ERR";
}

// Ordered download candidates for a resolved version. GitCode is tried first
// (fast + proxy-free in CN); GitHub is the canonical fallback. When the
// version came from the pin (GitCode API already unreachable) GitHub goes
// first instead of wasting a request on the mirror. Override the order with
// AITOOL_CORE_DOWNLOAD (comma-separated "gitcode"/"github").
function downloadCandidates({ version }, { prefer = "gitcode" } = {}) {
  const tag = `v${version}`;
  const sources = {
    github: { label: "GitHub", url: `${RELEASE_PREFIX}/${tag}/${platformAsset(version).name}` },
  };
  if (GITCODE_CORE_REPO) {
    sources.gitcode = {
      label: "GitCode",
      url: `${GITCODE_API_PREFIX}/${GITCODE_CORE_REPO}/releases/${tag}/attach_files/${platformAsset(version).name}/download`,
    };
  }
  const order = (process.env.AITOOL_CORE_DOWNLOAD || `${prefer === "github" ? "github,gitcode" : "gitcode,github"}`)
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const list = [];
  for (const key of order) if (sources[key] && !list.includes(sources[key])) list.push(sources[key]);
  if (!list.length) list.push(sources.github);
  return list;
}

// Stream the response body to disk, reporting { downloaded, total } per chunk.
// Global fetch (Node 20+) follows redirects, which GitHub releases and the
// GitCode signed-CDN handoff both need.
async function streamToFile(body, destination, { onProgress, signal } = {}) {
  const file = createWriteStream(destination);
  let downloaded = 0;
  try {
    for await (const chunk of body) {
      if (signal?.aborted) {
        const error = new Error("download canceled");
        error.name = "AbortError";
        throw error;
      }
      downloaded += chunk.length;
      if (!file.write(chunk)) await once(file, "drain");
      onProgress?.({ downloaded });
    }
  } finally {
    await new Promise((resolve) => file.end(resolve));
  }
  if (downloaded === 0) throw new Error("empty response body");
  return downloaded;
}

async function downloadWithProgress(url, destination, { onProgress, signal, fetchImpl = fetch } = {}) {
  const response = await fetchImpl(url, { headers: { "user-agent": "aitool-fetch-core" }, signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const header = Number(response.headers.get("content-length"));
  const total = Number.isFinite(header) && header > 0 ? header : null;
  onProgress?.({ downloaded: 0, total });
  try {
    await streamToFile(response.body, destination, {
      signal,
      onProgress: ({ downloaded }) => onProgress?.({ downloaded, total }),
    });
  } catch (error) {
    fs.rmSync(destination, { force: true });
    throw error;
  }
}

function extract(archive, destination) {
  fs.mkdirSync(destination, { recursive: true });
  if (archive.endsWith(".zip")) {
    execFileSync("powershell", [
      "-NoProfile",
      "-Command",
      `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${destination}' -Force`,
    ]);
  } else {
    execFileSync("tar", ["-xzf", archive, "-C", destination]);
  }
}

function findBinary(dir) {
  const wanted = process.platform === "win32" ? "cli-proxy-api.exe" : "cli-proxy-api";
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name === wanted) return full;
    }
  }
  return null;
}

// Download + install a resolved release. Reports progress events:
//   { phase: "downloading", source, downloaded, total }
//   { phase: "switching", source, message }   (source failed, moving on)
//   { phase: "extracting", source }
async function downloadAndInstall(release, { onProgress = null, signal, fetchImpl = fetch } = {}) {
  const emit = (event) => onProgress?.(event);
  const { version } = release;
  const asset = platformAsset(version);

  fs.mkdirSync(paths.binDir, { recursive: true });
  const archivePath = path.join(os.tmpdir(), asset.name);
  const failures = [];
  let downloadedFrom = null;
  for (const candidate of downloadCandidates(asset, { prefer: release.source === "gitcode" ? "gitcode" : "github" })) {
    try {
      emit({ phase: "downloading", source: candidate.label, downloaded: 0, total: null });
      await downloadWithProgress(candidate.url, archivePath, {
        signal,
        fetchImpl,
        onProgress: ({ downloaded, total }) => emit({ phase: "downloading", source: candidate.label, downloaded, total }),
      });
      downloadedFrom = candidate.label;
      break;
    } catch (error) {
      fs.rmSync(archivePath, { force: true });
      if (isAbort(error)) throw error;
      failures.push(`${candidate.label}: ${error?.message || error}`);
      emit({ phase: "switching", source: candidate.label, message: `${candidate.label} download failed: ${error?.message || error}` });
    }
  }
  if (!downloadedFrom) throw new Error(`all core download sources failed — ${failures.join("; ")}`);

  emit({ phase: "extracting", source: downloadedFrom });
  const extractDir = path.join(os.tmpdir(), `aitool-core-${version}`);
  fs.rmSync(extractDir, { recursive: true, force: true });
  try {
    extract(archivePath, extractDir);
    const binary = findBinary(extractDir);
    if (!binary) throw new Error("core binary not found inside release archive");
    fs.copyFileSync(binary, paths.binPath);
    fs.chmodSync(paths.binPath, 0o755);
    fs.writeFileSync(paths.coreVersionPath, `v${version}\n`);
  } finally {
    fs.rmSync(extractDir, { recursive: true, force: true });
    fs.rmSync(archivePath, { force: true });
  }
  return { skipped: false, version, path: paths.binPath, source: downloadedFrom };
}

// Full one-shot flow (CLI / spawn path): resolve → reuse-if-current → download.
async function fetchCore({ force = false, onProgress = null, signal, fetchImpl = fetch } = {}) {
  onProgress?.({ phase: "checking" });
  const release = await resolveRelease({ signal, fetchImpl });
  if (!force && fs.existsSync(paths.binPath) && installedVersion() === release.version) {
    return { skipped: true, version: release.version, path: paths.binPath, source: "already-installed" };
  }
  return downloadAndInstall(release, { onProgress, signal, fetchImpl });
}

const PHASE_LOG = {
  checking: "Resolving latest core release (GitCode mirror first)...",
  downloading: "Downloading",
  switching: "Source failed, trying the next one",
  extracting: "Extracting",
};

async function main() {
  const force = /^(1|true|yes|on)$/i.test(String(process.env.AITOOL_CORE_FORCE || "").trim());
  const result = await fetchCore({
    force,
    onProgress: (event) => {
      if (event.phase === "downloading") {
        const total = event.total ? `${(event.downloaded / event.total * 100).toFixed(0)}%` : `${event.downloaded} bytes`;
        console.log(`Downloading from ${event.source}: ${total}`);
      } else if (PHASE_LOG[event.phase]) {
        console.log(PHASE_LOG[event.phase]);
      }
    },
  });
  if (result.skipped) {
    console.log(`CLIProxyAPI core v${result.version} already at ${result.path} — reusing.`);
  } else {
    console.log(`Installed CLIProxyAPI core v${result.version} (via ${result.source}) at ${result.path}`);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error?.message || error);
    console.error("Alternatively build from source and set AITOOL_CORE_BIN=/path/to/cli-proxy-api, then run `aitool proxy install`.");
    process.exit(1);
  });
}

module.exports = {
  pinnedVersion,
  installedVersion,
  platformAsset,
  resolveRelease,
  downloadCandidates,
  downloadAndInstall,
  fetchCore,
  isAbort,
};
