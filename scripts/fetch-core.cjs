#!/usr/bin/env node
/* eslint-disable no-console */

// Downloads the pinned CLIProxyAPI core release binary into ~/.aitool/proxy/bin.
// Mirrors EasyCLIProxyAPI's core pinning: AiTool ships `core-version.txt`, the
// binary itself is fetched at runtime so the proxy engine stays an external,
// independently-updatable process. Sources are tried in order — the GitCode
// China mirror first (fast, proxy-free), then upstream GitHub as fallback — and
// an already-present pinned binary is reused rather than re-downloaded.

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");
const paths = require("../src/lib/proxy/paths");

const REPO_ROOT = path.resolve(__dirname, "..");
const VERSION_FILE = path.join(REPO_ROOT, "core-version.txt");
const RELEASE_PREFIX = "https://github.com/router-for-me/CLIProxyAPI/releases/download";
// GitCode mirror of the core (the same one EasyCLIProxyAPI ships): reachable
// from mainland China without a proxy and carrying the identical release
// assets. Override with AITOOL_CORE_GITCODE_REPO; set it empty to disable.
const GITCODE_CORE_REPO = process.env.AITOOL_CORE_GITCODE_REPO === undefined
  ? "lzt404/CLIProxyAPI"
  : process.env.AITOOL_CORE_GITCODE_REPO.trim();

function platformAsset() {
  const version = fs.readFileSync(VERSION_FILE, "utf8").trim().replace(/^v/, "");
  const osName = process.platform === "win32" ? "windows" : process.platform;
  const archName = process.arch === "arm64" ? "aarch64" : "amd64";
  const extension = process.platform === "win32" ? "zip" : "tar.gz";
  const name = `CLIProxyAPI_${version}_${osName}_${archName}.${extension}`;
  return { version, name };
}

// Ordered download candidates. GitCode is tried first (fast + proxy-free in CN);
// GitHub is the canonical fallback. Override the order with AITOOL_CORE_DOWNLOAD
// (comma-separated "gitcode"/"github").
function downloadCandidates({ version, name }) {
  const tag = `v${version}`;
  const sources = {
    github: { label: "GitHub", url: `${RELEASE_PREFIX}/${tag}/${name}` },
  };
  if (GITCODE_CORE_REPO) {
    sources.gitcode = {
      label: "GitCode",
      url: `https://api.gitcode.com/api/v5/repos/${GITCODE_CORE_REPO}/releases/${tag}/attach_files/${name}/download`,
    };
  }
  const order = (process.env.AITOOL_CORE_DOWNLOAD || "gitcode,github")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const list = [];
  for (const key of order) if (sources[key] && !list.includes(sources[key])) list.push(sources[key]);
  if (!list.length) list.push(sources.github);
  return list;
}

function installedVersion() {
  try {
    return fs.readFileSync(paths.coreVersionPath, "utf8").trim().replace(/^v/, "");
  } catch {
    return null;
  }
}

async function download(url, destination) {
  // Global fetch (Node 20+) follows redirects, which GitHub releases and the
  // GitCode signed-CDN handoff both need.
  const response = await fetch(url, { headers: { "user-agent": "aitool-fetch-core" } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length === 0) throw new Error("empty response body");
  fs.writeFileSync(destination, buffer);
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

async function main() {
  const { version, name } = platformAsset();

  // The core binary lives at a single canonical path; if it is already the
  // pinned version, reuse it instead of re-downloading. Makes the script
  // idempotent — safe to run on every serve/build. AITOOL_CORE_FORCE=1 re-fetches.
  const force = /^(1|true|yes|on)$/i.test(String(process.env.AITOOL_CORE_FORCE || "").trim());
  if (!force && fs.existsSync(paths.binPath) && installedVersion() === version) {
    console.log(`CLIProxyAPI core v${version} already at ${paths.binPath} — reusing.`);
    return;
  }

  fs.mkdirSync(paths.binDir, { recursive: true });
  const archivePath = path.join(os.tmpdir(), name);
  const failures = [];
  let fetched = false;
  for (const { label, url } of downloadCandidates({ version, name })) {
    try {
      console.log(`Fetching CLIProxyAPI core v${version} (${name}) from ${label}...`);
      await download(url, archivePath);
      fetched = true;
      break;
    } catch (error) {
      failures.push(`${label}: ${error?.message || error}`);
    }
  }
  if (!fetched) throw new Error(`all core download sources failed — ${failures.join("; ")}`);

  const extractDir = path.join(os.tmpdir(), `aitool-core-${version}`);
  fs.rmSync(extractDir, { recursive: true, force: true });
  extract(archivePath, extractDir);

  const binary = findBinary(extractDir);
  if (!binary) throw new Error("core binary not found inside release archive");
  fs.copyFileSync(binary, paths.binPath);
  fs.chmodSync(paths.binPath, 0o755);
  fs.writeFileSync(paths.coreVersionPath, `v${version}\n`);
  console.log(`Installed ${paths.binPath}`);
}

main().catch((error) => {
  console.error(error?.message || error);
  console.error("Alternatively build from source and set AITOOL_CORE_BIN=/path/to/cli-proxy-api, then run `aitool proxy install`.");
  process.exit(1);
});
