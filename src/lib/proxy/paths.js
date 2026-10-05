const os = require("node:os");
const path = require("node:path");

// AiTool proxy layer — on-disk layout under ~/.aitool/proxy:
//   bin/cli-proxy-api      CLIProxyAPI core binary (downloaded or user-supplied)
//   config.yaml            bootstrap core config (server/management/oauth/usage)
//   auths/                 OAuth + file-backed provider credentials (core auth-dir)
//   logs/core.log          core stdout/stderr when daemonized
//   usage/records-*.jsonl  per-request usage events bridged from the core
//   usage/buckets.json     cumulative half-hour buckets already merged into the tracker queue
//   usage/models-dev-pricing.json  models.dev pricing snapshot for cost estimates
const proxyRoot = path.join(os.homedir(), ".aitool", "proxy");

module.exports = {
  proxyRoot,
  binDir: path.join(proxyRoot, "bin"),
  binPath: path.join(proxyRoot, "bin", process.platform === "win32" ? "cli-proxy-api.exe" : "cli-proxy-api"),
  configPath: path.join(proxyRoot, "config.yaml"),
  authDir: path.join(proxyRoot, "auths"),
  logsDir: path.join(proxyRoot, "logs"),
  coreLogPath: path.join(proxyRoot, "logs", "core.log"),
  usageDir: path.join(proxyRoot, "usage"),
  bucketsStatePath: path.join(proxyRoot, "usage", "buckets.json"),
  pricingPath: path.join(proxyRoot, "usage", "models-dev-pricing.json"),
  pidPath: path.join(proxyRoot, "core.pid"),
  settingsPath: path.join(proxyRoot, "settings.json"),
  remarksPath: path.join(proxyRoot, "api-access-remarks.json"),
  apiKeyRemarksPath: path.join(proxyRoot, "api-key-remarks.json"),
  coreVersionPath: path.join(proxyRoot, "core-version.txt"),
};
