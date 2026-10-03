<div align="center">

# AiTool

**English** · [简体中文](./README.zh-CN.md)

### One toolbox for your AI coding workflow — a multi-provider AI gateway plus a token usage dashboard, in one local app.

AiTool merges three open-source projects into a single local-first product:

- **AI Proxy** (from [EasyCLIProxyAPI](https://github.com/router-for-me/EasyCLIProxyAPI) / [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI), MIT) — run a local gateway that exposes your provider accounts through OpenAI / Anthropic / Gemini compatible endpoints, with per-request usage records.
- **Token usage analytics** (from [TokenTracker](https://github.com/xiufengsun/TokenTracker), MIT) — the local-first dashboard that tracks token usage and cost across 43 AI coding tools.
- **Provider config management** (from [cc-switch](https://github.com/farion1231/cc-switch), MIT) — manage per-tool provider presets and one-click switch the live config files of Claude Code / Codex CLI / Gemini CLI, without hand-editing JSON / TOML.

The UI is TokenTracker's design language throughout — one dashboard for both worlds: proxied requests flow into the same trends, model breakdown, and cost views as your native CLI tools.

</div>

---

## How the merge works

```
┌────────────────────────────── AiTool dashboard (localhost:7680) ─────────────────────────────┐
│  Sidebar                                                                                     │
│  ├── AI Proxy        ← NEW: proxy lifecycle, providers, keys, per-request records, config    │
│  ├── Provider Configs ← NEW: one-click AI-CLI config-file switching (cc-switch port)         │
│  └── Tokens / Sessions / Limits / …  ← TokenTracker analytics (43 CLI tools), unchanged      │
└──────────────┬──────────────────────────────────────────────────────────┬────────────────────┘
               │ /api/proxy/*                                             │ /functions/* (local API)
               ▼                                                          ▼
   Node proxy layer (src/lib/proxy)                       TokenTracker data plane (~/.tokentracker)
   ├── core manager   — spawns cli-proxy-api              ├── queue.jsonl  ← half-hour usage buckets
   ├── management API client (Bearer key)                 ├── cost engine  (70+ model pricing)
   └── usage bridge — RESP SUBSCRIBE usage ───────────────►└── fused in: proxy usage = source "cliproxy"
        └── per-request records → ~/.aitool/proxy/usage/*.jsonl
```

The core binary stays an external, independently updatable process (pinned in `core-version.txt`, same pattern as EasyCLIProxyAPI). The bridge folds every successful proxied request into TokenTracker's half-hour buckets, so **proxy usage shows up in the standard dashboard automatically** — trends, model breakdown, cost, heatmap — alongside Claude Code, Codex, Gemini, and the other 40 tracked tools.

## Quick start

Requirements: Node.js 20+. The proxy core additionally needs macOS / Linux / Windows (a Go-built binary is fetched automatically).

> Full run guide — dashboard dev mode, proxy setup, desktop shell, troubleshooting: [docs/running.md](./docs/running.md)

### Desktop app (recommended)

```bash
cd desktop && npm install && npx tauri build
open src-tauri/target/release/bundle/macos/AiTool.app   # macOS; also bundles a .dmg
```

Native window + system tray (Open / Start proxy / Stop proxy / Quit). The shell
picks a free loopback port, launches the Node server, and opens the dashboard
once the proxy is healthy; closing the window hides to tray, Quit stops the
server and the proxy core. See [desktop/README.md](./desktop/README.md).

### Terminal

```bash
npm install                # root CLI + deps
npm --prefix dashboard install
npm run dashboard:build

node bin/tracker.js proxy install    # fetch the pinned CLIProxyAPI core (or: AITOOL_CORE_BIN=/path/to/cli-proxy-api node bin/tracker.js proxy install)
node bin/tracker.js serve            # dashboard at http://localhost:7680 — proxy starts with it
```

Or drive the proxy from the CLI:

```bash
aitool proxy status     # core + bridge status
aitool proxy start      # start core + usage bridge
aitool proxy stop
aitool proxy config     # show paths and endpoint
```

### Docker

```bash
docker compose up -d --build
# dashboard: http://127.0.0.1:7680 — AI proxy: http://127.0.0.1:8318
```

One container runs the dashboard + local API and the AI proxy core (the pinned CLIProxyAPI binary is pre-fetched for the image platform at build time). Data persists in named volumes mapping `~/.tokentracker` and `~/.aitool`. Ports publish on the host **loopback only** — the local API is login-free and trusts loopback origins, so never publish it to a public interface without an authenticating reverse proxy. Inside the container everything binds `0.0.0.0` via `AITOOL_BIND_HOST`; on a bare host the default stays `127.0.0.1`.

## Provider config management (from cc-switch)

A Node port of [cc-switch](https://github.com/farion1231/cc-switch)'s config-file module. Keep named provider presets per tool and switch between them from the dashboard's **Provider Configs** page (sidebar → AI Proxy group) — no more hand-editing JSON / TOML / env files.

| | |
| --- | --- |
| **Tools covered** | Claude Code (`~/.claude/settings.json`) · Codex CLI (`~/.codex/config.toml` + `auth.json`) · Gemini CLI (`~/.gemini/.env`) |
| **Switch model** | Minimal-patch projection (cc-switch's "floor" key fields): only the provider's key fields — endpoint, credentials, model names — are written; user-owned content (hooks, permissions, comments) is never touched, and the previous provider's residue is removed only when you haven't changed it |
| **Editor** | The add/edit dialog shows the full config file as it would look after switching to this provider (cc-switch's editor view); on save, key fields go back to the provider row while other edits are written into the live files with three-way conflict detection (keep mine / keep theirs) |
| **Codex credentials** | The relay key is written to `experimental_bearer_token` under `[model_providers.custom]` in `config.toml` — Codex CLI 0.149+ no longer reads relay keys from `auth.json`, which holds only the official ChatGPT login (the add/edit dialog's Codex editors are split accordingly: `auth.json` JSON + `config.toml` TOML) |
| **MCP servers** | The page's MCP tab keeps one list of MCP servers (cc-switch's unified `mcp_servers` module) with per-app toggles that project each spec into the app's native MCP config — Claude (`~/.claude.json`), Codex (`[mcp_servers.*]` in `config.toml`), Gemini (`settings.json`), Grok Build, OpenCode, Hermes, MiniMax Code (`~/.minimax/mcp.json`) — and can import what the tools already configured |
| **Safety** | Atomic writes (`0600` for credential files), first-write backup per file restorable from the dashboard, and config-file editors built into the add/edit dialog; Codex's official ChatGPT login is stashed when switching to a third-party relay and restored on switch-back |
| **Storage** | `~/.aitool/provider-switch/` — `providers.json` (presets + current pointer), `mcp-servers.json` (shared MCP server list), `codex-auth-stash.json`, `backups/` |

## AI Proxy capabilities (from EasyCLIProxyAPI)

Managed through the dashboard's **AI Proxy** page (tabs) or the core's management API:

| Feature | Where |
| --- | TokenTracker-style page tab |
| Core lifecycle (start / stop / health / version) | Overview |
| Client access keys (`access.api-keys`) | Access Keys |
| Compatible endpoints — `/v1/chat/completions`, `/v1/messages`, `/v1beta/models` | Access Keys |
| Provider auth files (upload / list / delete / refresh) | Providers |
| Per-request usage records (model, provider, tokens, latency, failures) | Requests |
| `config.yaml` editor via the core's management API | Settings |
| Auto-start with the dashboard | Settings |

On-disk layout: `~/.aitool/proxy/` — `bin/` (core), `config.yaml`, `auths/` (provider credentials), `usage/` (per-request records + bucket state), `logs/core.log`.

The usage bridge ignores RESP control notifications such as `support_refresh`.
On startup, AiTool repairs historical notifications saved by older versions:
it backs up affected files under `usage/control-notification-backup-*`, removes
the notifications, and appends corrected cumulative totals to the tracker queue.
Real zero-token requests are retained. To run the repair manually, first stop
any AiTool dashboard/desktop/container using these data directories, then run
`node bin/tracker.js proxy repair-usage` before restarting it. Repeating the
repair is safe; it does not contact an AI provider.

Default endpoint: `http://127.0.0.1:8318` (loopback-only; port configurable in config.yaml). The plaintext management key lives in `~/.aitool/proxy/settings.json` — the core hashes its own copy on first load.

## Token usage analytics (from TokenTracker)

| | |
| --- | --- |
| **AI tools supported** | **43** |
| **Dashboard** | localhost:7680 — trends, model breakdown, cost, heatmap |
| **Proxy usage source** | `cliproxy` — folded into the same views automatically |

Everything in the vendored TokenTracker CLI keeps working: hook installation for 43 AI coding tools (Claude Code, Codex, Gemini, Cursor, Droid, Cline, Command Code, TRAE, …), local JSONL parsing, the cost engine, sessions, limits, achievements, skills panel, desktop pet, widgets — with the same dashboard at `localhost:7680`. Proxy usage appears as a `cliproxy` source in the same views.

```bash
aitool            # open the dashboard
aitool sync       # manual sync of local tool logs
aitool status     # hook attachment status
aitool doctor     # health check
```

Advanced per-tool overrides (vendored from TokenTracker): `TOKENTRACKER_LMSTUDIO_HOME` (LM Studio data dir), `TOKENTRACKER_UNSLOTH_DB` (Unsloth Studio DB path), `TOKENTRACKER_DEVIN_DB` (Devin CLI DB path), `TOKENTRACKER_ACODE_HOME` (AStudio directory), `TOKENTRACKER_TRAE_HOME` / `TOKENTRACKER_TRAE_DB` / `TOKENTRACKER_TRAE_SQLCIPHER_KEY` (TRAE international local usage — see [docs/trae.md](./docs/trae.md)).

## Project layout

```
bin/tracker.js           CLI entry (aitool)
src/cli.js               command dispatch (serve/sync/status/…/proxy)
src/lib/local-api.js     local API: /functions/* (usage) + /api/proxy/* (new)
src/lib/proxy/           NEW — paths / config / manager / management client / usage bridge / REST handlers
src/commands/proxy.js    NEW — `aitool proxy …` command
dashboard/               TokenTracker dashboard (Vite + React + Tailwind, oai design system)
  └── src/pages/ProxyPage.jsx   NEW — AI Proxy page (7 tabs)
src/lib/provider-switch/ NEW — cc-switch port: provider presets → live config files (floors, projections, backups)
src/commands/…           src/lib/local-api.js also mounts /api/provider-switch/*
dashboard/…/ProviderSwitchPage.jsx  NEW — /provider-switch page (Provider Configs)
scripts/fetch-core.cjs   NEW — downloads the pinned CLIProxyAPI release binary
core-version.txt         NEW — pinned core version
Dockerfile / docker-compose.yml   NEW — container run (compose publishes loopback ports)
```

## Third-party projects

- [TokenTracker](https://github.com/xiufengsun/TokenTracker) (MIT) — vendored as the base: CLI, dashboard, design system.
- [EasyCLIProxyAPI](https://github.com/router-for-me/EasyCLIProxyAPI) (MIT) — reference for the GUI-over-core architecture and feature set; AiTool re-implements the management layer in Node.
- [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) (MIT) — the proxy engine, downloaded at runtime as an external binary (not vendored).
- [cc-switch](https://github.com/farion1231/cc-switch) (MIT) — reference for the provider-preset / config-file-switching module; AiTool re-implements it in Node (dashboard Provider Configs page).

## License

MIT — see [LICENSE](./LICENSE) (from TokenTracker).
