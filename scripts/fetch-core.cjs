#!/usr/bin/env node
/* eslint-disable no-console */

// Downloads the CLIProxyAPI core release binary into ~/.aitool/proxy/bin.
// Mirrors EasyCLIProxyAPI's version-management page: the target version is
// resolved from the GitCode China mirror's latest release, then GitHub's
// latest (API, atom-feed fallback — the mirror only carries the newest
// release but can lag), and finally the repo pin in core-version.txt when
// both are unreachable (downloads then come from GitHub). Archives are
// verified before install: exact byte count against content-length and
// sha256 against the release's asset digest when one is published. The
// binary itself is fetched at runtime so the proxy engine stays an external,
// independently-updatable process. An already-present matching-or-newer
// binary is reused rather than re-downloaded (never a silent downgrade);
// AITOOL_CORE_FORCE=1 re-fetches.
//
// Usable two ways:
//   - CLI:  `node scripts/fetch-core.cjs` (progress printed to stdout)
//   - lib:  require() → resolveRelease / downloadAndInstall / fetchCore /
//           checkUpdate, used by src/lib/proxy/api.js + core-install.js.

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");
const { createWriteStream } = require("node:fs");
const { pipeline } = require("node:stream/promises");
const crypto = require("node:crypto");
const paths = require("../src/lib/proxy/paths");

const REPO_ROOT = path.resolve(__dirname, "..");
const VERSION_FILE = path.join(REPO_ROOT, "core-version.txt");
const RELEASE_PREFIX = "https://github.com/router-for-me/CLIProxyAPI/releases/download";
const GITHUB_REPO = "router-for-me/CLIProxyAPI";
const GITHUB_API_LATEST = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
const GITHUB_ATOM_LATEST = `https://github.com/${GITHUB_REPO}/releases.atom`;
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
// GitHub's latest release is next (the mirror can lag behind); the repo-pinned
// version is the offline fallback. Mirrors core_runtime.rs fetch_release:
// first responsive source wins, failures are not fatal while one source works.
async function resolveRelease({ signal, fetchImpl = fetch } = {}) {
  const pin = pinnedVersion();
  const stable = (value) => /^\d+\.\d+\.\d+$/.test(value || "") && value.split(".").every((part) => Number.isSafeInteger(Number(part)));
  const atLeastPin = (version) => {
    if (!stable(version)) return false;
    if (!stable(pin)) return true;
    const left = version.split(".").map(Number), right = pin.split(".").map(Number);
    for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] > right[i];
    return true;
  };
  if (GITCODE_CORE_REPO) {
    try {
      const response = await fetchImpl(`${GITCODE_API_PREFIX}/${GITCODE_CORE_REPO}/releases/latest`, {
        headers: { "user-agent": "aitool-fetch-core", accept: "application/json" },
        signal,
      });
      if (response.ok) {
        const body = await response.json().catch(() => null);
        const version = String(body?.tag_name || "").trim().replace(/^v/, "");
        if (atLeastPin(version)) return { version, source: "gitcode", digests: {} };
      }
    } catch (error) {
      if (isAbort(error)) throw error;
      // fall through to GitHub
    }
  }
  const github = await fetchGithubLatest({ signal, fetchImpl, acceptVersion: atLeastPin });
  if (github) return github;
  if (stable(pin)) return { version: pin, source: "pinned", digests: {} };
  throw new Error("unable to resolve a core version — GitCode mirror and GitHub are unreachable and no core-version.txt pin");
}

function parseDigest(value) {
  const hash = String(value || "").trim().replace(/^sha256:/i, "").toLowerCase();
  return /^[0-9a-f]{64}$/.test(hash) ? hash : null;
}

// Release notes pair each archive with its "sha256:<hex>" digest; the same
// hashes the original scrapes from the release page HTML.
function parseDigestsFromBody(body) {
  const digests = {};
  for (const line of String(body || "").split(/\r?\n/)) {
    const hash = parseDigest(line.match(/sha256:\s*([0-9a-fA-F]{64})/)?.[1]);
    if (!hash) continue;
    const name = line.match(/([A-Za-z0-9._-]+\.(?:tar\.gz|zip))/)?.[1];
    if (name) digests[name] = hash;
  }
  return digests;
}

// GitHub's latest release: REST API first (tag + per-asset sha256 digests),
// then the atom feed (tag only — used when the API is unreachable, mirroring
// core_runtime.rs's atom → release-page fallback).
async function fetchGithubLatest({ signal, fetchImpl = fetch, acceptVersion }) {
  const headers = { "user-agent": "aitool-fetch-core" };
  try {
    const response = await fetchImpl(GITHUB_API_LATEST, { headers, signal });
    if (response.ok) {
      const body = await response.json().catch(() => null);
      const version = String(body?.tag_name || "").trim().replace(/^v/, "");
      if (acceptVersion(version)) {
        const digests = {};
        for (const asset of Array.isArray(body?.assets) ? body.assets : []) {
          const digest = parseDigest(asset?.digest);
          if (asset?.name && digest) digests[asset.name] = digest;
        }
        if (!Object.keys(digests).length) Object.assign(digests, parseDigestsFromBody(body?.body));
        return { version, source: "github", digests };
      }
    }
  } catch (error) {
    if (isAbort(error)) throw error;
  }
  try {
    const response = await fetchImpl(GITHUB_ATOM_LATEST, { headers, signal });
    if (response.ok) {
      const text = await response.text();
      // Atom entries are newest-first; the first tag link is the latest release.
      const tag = text.match(/releases\/tag\/v?([0-9][^"<\s]*)/)?.[1];
      if (tag && acceptVersion(tag.trim())) return { version: tag.trim(), source: "github", digests: {} };
    }
  } catch (error) {
    if (isAbort(error)) throw error;
  }
  return null;
}

// easy parity (coreUpdate.tsx): full semver ordering with prerelease rules.
// Returns -1/0/1, or null when either side is unparseable (e.g. a local
// `dev-local+<sha>` build) so callers decide instead of guessing.
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function parseSemanticVersion(version) {
  const match = SEMVER_PATTERN.exec(String(version ?? "").trim().replace(/^v/i, ""));
  if (!match) return null;
  return { core: [match[1], match[2], match[3]], prerelease: match[4] ? match[4].split(".") : null };
}

function compareNumericIdentifier(left, right) {
  if (left.length !== right.length) return left.length > right.length ? 1 : -1;
  if (left === right) return 0;
  return left > right ? 1 : -1;
}

function compareCoreVersions(left, right) {
  const a = parseSemanticVersion(left);
  const b = parseSemanticVersion(right);
  if (!a || !b) return null;
  for (let index = 0; index < a.core.length; index += 1) {
    const difference = compareNumericIdentifier(a.core[index], b.core[index]);
    if (difference !== 0) return difference;
  }
  if (a.prerelease === null) return b.prerelease === null ? 0 : 1;
  if (b.prerelease === null) return -1;
  const count = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < count; index += 1) {
    const leftIdentifier = a.prerelease[index];
    const rightIdentifier = b.prerelease[index];
    if (leftIdentifier === undefined) return -1;
    if (rightIdentifier === undefined) return 1;
    if (leftIdentifier === rightIdentifier) continue;
    const leftIsNumeric = /^\d+$/.test(leftIdentifier);
    const rightIsNumeric = /^\d+$/.test(rightIdentifier);
    if (leftIsNumeric && rightIsNumeric) return compareNumericIdentifier(leftIdentifier, rightIdentifier);
    if (leftIsNumeric) return -1;
    if (rightIsNumeric) return 1;
    return leftIdentifier > rightIdentifier ? 1 : -1;
  }
  return 0;
}

function coreUpdateAvailable(installed, latest) {
  return compareCoreVersions(latest, installed) === 1;
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    fs.createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")))
      .on("error", reject);
  });
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
  let downloaded = 0;
  // pipeline observes write/open errors for the entire stream lifetime and
  // closes the file on cancellation, including while waiting for body data.
  await pipeline(
    body,
    async function* trackProgress(source) {
      for await (const chunk of source) {
        downloaded += chunk.length;
        onProgress?.({ downloaded });
        yield chunk;
      }
    },
    createWriteStream(destination, { mode: 0o600 }),
    { signal },
  );
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
    const downloaded = await streamToFile(response.body, destination, {
      signal,
      onProgress: ({ downloaded }) => onProgress?.({ downloaded, total }),
    });
    // easy parity (validate_download_metadata): a truncated archive must be
    // caught here, not after extraction "succeeds".
    if (total !== null && downloaded !== total) {
      throw new Error(`download size verification failed: got ${downloaded} bytes, expected ${total}`);
    }
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

function backupInstallation() {
  fs.mkdirSync(paths.binDir, { recursive: true });
  const directory = fs.mkdtempSync(path.join(paths.binDir, ".previous-"));
  const originals = [paths.binPath, paths.coreVersionPath].map((target, index) => {
    const backup = path.join(directory, String(index));
    const exists = fs.existsSync(target);
    if (exists) fs.copyFileSync(target, backup);
    return { target, backup, exists };
  });
  return {
    restore() {
      for (const { target, backup, exists } of originals) {
        if (exists) {
          const staged = `${target}.restore-${crypto.randomUUID()}`;
          fs.copyFileSync(backup, staged);
          fs.renameSync(staged, target);
        } else fs.rmSync(target, { force: true });
      }
    },
    cleanup() { fs.rmSync(directory, { recursive: true, force: true }); },
  };
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
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitool-core-"));
  const archivePath = path.join(tempDir, asset.name);
  const stagedBinary = path.join(paths.binDir, `.cli-proxy-api-${crypto.randomUUID()}.tmp`);
  try {
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

    signal?.throwIfAborted();
    // easy parity (validate_download_metadata): sha256 against the release's
    // asset digest when the resolved source published one (GitHub API/notes;
    // the GitCode mirror publishes none, matching the original's optional
    // digest semantics).
    const expectedDigest = release.digests?.[asset.name];
    if (expectedDigest) {
      const actual = await sha256File(archivePath);
      if (actual !== expectedDigest.toLowerCase()) {
        throw new Error(`core archive sha256 verification failed for ${asset.name}`);
      }
    }
    emit({ phase: "extracting", source: downloadedFrom });
    const extractDir = path.join(tempDir, "extracted");
    extract(archivePath, extractDir);
    const binary = findBinary(extractDir);
    if (!binary) throw new Error("core binary not found inside release archive");
    // A failed copy (for example disk full) must leave the installed binary
    // intact so the orchestration can restart the previous version.
    fs.copyFileSync(binary, stagedBinary);
    fs.chmodSync(stagedBinary, 0o755);
    const previous = backupInstallation();
    try {
      signal?.throwIfAborted();
      fs.renameSync(stagedBinary, paths.binPath);
      fs.writeFileSync(paths.coreVersionPath, `v${version}\n`);
    } catch (error) {
      previous.restore();
      throw error;
    } finally { previous.cleanup(); }
    return { skipped: false, version, path: paths.binPath, source: downloadedFrom };
  } finally {
    fs.rmSync(stagedBinary, { force: true });
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

// Full one-shot flow (CLI / spawn path): resolve → reuse-if-current → download.
async function fetchCore({ force = false, onProgress = null, signal, fetchImpl = fetch } = {}) {
  onProgress?.({ phase: "checking" });
  const release = await resolveRelease({ signal, fetchImpl });
  if (!force && fs.existsSync(paths.binPath)) {
    // Never downgrade silently: skip when the installed version is the same
    // or newer than the release. An unparseable installed version (a local
    // build, a missing version file) still installs, matching the original's
    // install-on-request semantics.
    const comparison = compareCoreVersions(release.version, installedVersion());
    if (comparison !== null && comparison <= 0) {
      return { skipped: true, version: release.version, path: paths.binPath, source: "already-installed" };
    }
  }
  return downloadAndInstall(release, { onProgress, signal, fetchImpl });
}

// Update check for the settings page: latest resolvable release vs installed.
async function checkUpdate({ signal, fetchImpl = fetch } = {}) {
  const release = await resolveRelease({ signal, fetchImpl });
  const installed = installedVersion();
  return {
    installed,
    latest: release.version,
    source: release.source,
    hasUpdate: coreUpdateAvailable(installed, release.version),
  };
}

const PHASE_LOG = {
  checking: "Resolving latest core release (GitCode mirror, then GitHub)...",
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
  fetchGithubLatest,
  downloadCandidates,
  downloadAndInstall,
  fetchCore,
  checkUpdate,
  compareCoreVersions,
  coreUpdateAvailable,
  isAbort,
  backupInstallation,
};
