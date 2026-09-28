#!/usr/bin/env node
/* eslint-disable no-console */

// Downloads the pinned CLIProxyAPI core release binary into ~/.aitool/proxy/bin.
// Mirrors EasyCLIProxyAPI's core pinning: AiTool ships `core-version.txt`, the
// binary itself is fetched from the upstream CLIProxyAPI GitHub releases so the
// proxy engine stays an external, independently-updatable process.

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");
const paths = require("../src/lib/proxy/paths");

const REPO_ROOT = path.resolve(__dirname, "..");
const VERSION_FILE = path.join(REPO_ROOT, "core-version.txt");
const RELEASE_PREFIX = "https://github.com/router-for-me/CLIProxyAPI/releases/download";

function platformAsset() {
  const version = fs.readFileSync(VERSION_FILE, "utf8").trim().replace(/^v/, "");
  const osName = process.platform === "win32" ? "windows" : process.platform;
  const archName = process.arch === "arm64" ? "aarch64" : "amd64";
  const extension = process.platform === "win32" ? "zip" : "tar.gz";
  const name = `CLIProxyAPI_${version}_${osName}_${archName}.${extension}`;
  return { version, name, url: `${RELEASE_PREFIX}/v${version}/${name}` };
}

async function download(url, destination) {
  // Global fetch (Node 20+) follows redirects, which GitHub releases need.
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`download failed: HTTP ${response.status} for ${url}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
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
  const { version, name, url } = platformAsset();
  console.log(`Fetching CLIProxyAPI core v${version} (${name})...`);
  fs.mkdirSync(paths.binDir, { recursive: true });

  const archivePath = path.join(os.tmpdir(), name);
  await download(url, archivePath);
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
