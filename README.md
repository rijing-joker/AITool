<div align="center">

# AiTool

**English** · [简体中文](./README.zh-CN.md)

### One toolbox for your AI coding workflow — a multi-provider AI gateway plus a token usage dashboard, in one local app.

AiTool merges two open-source projects into a single local-first product:

- **AI Proxy** (from [EasyCLIProxyAPI](https://github.com/router-for-me/EasyCLIProxyAPI) / [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI), MIT) — run a local gateway that exposes your provider accounts through OpenAI / Anthropic / Gemini compatible endpoints, with per-request usage records.
- **Token usage analytics** (from [TokenTracker](https://github.com/xiufengsun/TokenTracker), MIT) — the local-first dashboard that tracks token usage and cost across 41 AI coding tools.

The UI is TokenTracker's design language throughout — one dashboard for both worlds: proxied requests flow into the same trends, model breakdown, and cost views as your native CLI tools.

</div>

---

## How the merge works

```
┌────────────────────────────── AiTool dashboard (localhost:7680) ─────────────────────────────┐
│  Sidebar                                                                                     │
│  ├── AI Proxy        ← NEW: proxy lifecycle, providers, keys, per-request records, config    │
│  └── Tokens / Sessions / Limits / …  ← TokenTracker analytics (41 CLI tools), unchanged      │
└──────────────┬──────────────────────────────────────────────────────────┬────────────────────┘
               │ /api/proxy/*                                             │ /functions/* (local API)
               ▼                                                          ▼
   Node proxy layer (src/lib/proxy)                       TokenTracker data plane (~/.tokentracker)
   ├── core manager   — spawns cli-proxy-api              ├── queue.jsonl  ← half-hour usage buckets
   ├── management API client (Bearer key)                 ├── cost engine  (70+ model pricing)
   └── usage bridge — RESP SUBSCRIBE usage ───────────────►└── fused in: proxy usage = source "cliproxy"
        └── per-request records → ~/.aitool/proxy/usage/*.jsonl
```

The core binary stays an external, independently updatable process (pinned in `core-version.txt`, same pattern as EasyCLIProxyAPI). The bridge folds every successful proxied request into TokenTracker's half-hour buckets, so **proxy usage shows up in the standard dashboard automatically** — trends, model breakdown, cost, heatmap — alongside Claude Code, Codex, Gemini, and the other 38 tracked tools.

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

Default endpoint: `http://127.0.0.1:8318` (loopback-only; port configurable in config.yaml). The plaintext management key lives in `~/.aitool/proxy/settings.json` — the core hashes its own copy on first load.

## Token usage analytics (from TokenTracker)

| | |
| --- | --- |
| **AI tools supported** | **41** |
| **Dashboard** | localhost:7680 — trends, model breakdown, cost, heatmap |
| **Proxy usage source** | `cliproxy` — folded into the same views automatically |

Everything in the vendored TokenTracker CLI keeps working: hook installation for 41 AI coding tools (Claude Code, Codex, Gemini, Cursor, Droid, …), local JSONL parsing, the cost engine, sessions, limits, achievements, skills panel, desktop pet, widgets — with the same dashboard at `localhost:7680`. Proxy usage appears as a `cliproxy` source in the same views.

```bash
aitool            # open the dashboard
aitool sync       # manual sync of local tool logs
aitool status     # hook attachment status
aitool doctor     # health check
```

Advanced per-tool overrides (vendored from TokenTracker): `TOKENTRACKER_LMSTUDIO_HOME` (LM Studio data dir), `TOKENTRACKER_UNSLOTH_DB` (Unsloth Studio DB path), `TOKENTRACKER_DEVIN_DB` (Devin CLI DB path), `TOKENTRACKER_ACODE_HOME` (AStudio directory).

## Project layout

```
bin/tracker.js           CLI entry (aitool)
src/cli.js               command dispatch (serve/sync/status/…/proxy)
src/lib/local-api.js     local API: /functions/* (usage) + /api/proxy/* (new)
src/lib/proxy/           NEW — paths / config / manager / management client / usage bridge / REST handlers
src/commands/proxy.js    NEW — `aitool proxy …` command
dashboard/               TokenTracker dashboard (Vite + React + Tailwind, oai design system)
  └── src/pages/ProxyPage.jsx   NEW — AI Proxy page (5 tabs)
scripts/fetch-core.cjs   NEW — downloads the pinned CLIProxyAPI release binary
core-version.txt         NEW — pinned core version
```

## Third-party projects

- [TokenTracker](https://github.com/xiufengsun/TokenTracker) (MIT) — vendored as the base: CLI, dashboard, design system.
- [EasyCLIProxyAPI](https://github.com/router-for-me/EasyCLIProxyAPI) (MIT) — reference for the GUI-over-core architecture and feature set; AiTool re-implements the management layer in Node.
- [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) (MIT) — the proxy engine, downloaded at runtime as an external binary (not vendored).

## License

MIT — see [LICENSE](./LICENSE) (from TokenTracker).
