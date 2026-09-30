const os = require("node:os");
const path = require("node:path");

// Provider-switch layer (ported from cc-switch's config-management module) —
// on-disk layout under ~/.aitool/provider-switch:
//   providers.json          SSOT store of per-app provider presets + current pointer
//   codex-auth-stash.json   official Codex (ChatGPT) login stashed while a
//                           third-party provider is active (0600)
//   backups/<app>/…         pre-first-write + pre-switch copies of live files
//
// Live target files stay where the owning CLI tools expect them (~/.claude,
// ~/.codex, ~/.gemini) and are resolved lazily so tests can point HOME at a
// temp directory.
function home() {
  return os.homedir();
}

function providerSwitchRoot() {
  return path.join(home(), ".aitool", "provider-switch");
}

function storePath() {
  return path.join(providerSwitchRoot(), "providers.json");
}

function codexAuthStashPath() {
  return path.join(providerSwitchRoot(), "codex-auth-stash.json");
}

// Codex model catalog sidecar (~/.codex): config.toml's model_catalog_json
// points at this file to populate Codex's /model menu.
function codexModelCatalogPath() {
  return path.join(home(), ".codex", "aitool-model-catalog.json");
}

function backupsDir(app) {
  return path.join(providerSwitchRoot(), "backups", app);
}

// Live target file registry per supported app. `private` files hold API keys
// or OAuth tokens and are written 0600; `format` drives the live editor and
// the projection writers.
function targetFiles(app) {
  switch (app) {
    case "claude":
      return [
        {
          id: "settings",
          labelKey: "pswitch.live.file.settings",
          path: path.join(home(), ".claude", "settings.json"),
          format: "json",
          private: true,
        },
      ];
    case "codex":
      return [
        {
          id: "config",
          labelKey: "pswitch.live.file.config",
          path: path.join(home(), ".codex", "config.toml"),
          format: "toml",
          private: true,
        },
        {
          id: "auth",
          labelKey: "pswitch.live.file.auth",
          path: path.join(home(), ".codex", "auth.json"),
          format: "json",
          private: true,
        },
      ];
    case "gemini":
      return [
        {
          id: "env",
          labelKey: "pswitch.live.file.env",
          path: path.join(home(), ".gemini", ".env"),
          format: "env",
          private: true,
        },
      ];
    default:
      return [];
  }
}

function targetFile(app, fileId) {
  return targetFiles(app).find((file) => file.id === fileId) || null;
}

module.exports = {
  providerSwitchRoot,
  storePath,
  codexAuthStashPath,
  codexModelCatalogPath,
  backupsDir,
  targetFiles,
  targetFile,
};
