# Agent Instructions

Use [CLAUDE.md](./CLAUDE.md) as the single source of truth for this repository's project guidance, architecture notes, release workflow, and conventions.

If any project-specific instructions appear to conflict across files, follow `CLAUDE.md` and update this file only to keep that pointer intact.

## What this repo is

**AiTool** — one local-first app merging three products (a rebrand from TokenTracker is in progress; legacy names remain everywhere on purpose, don't mass-rename):

- **AI Proxy** — a Node re-implementation of EasyCLIProxyAPI's management layer that drives the external Go binary `cli-proxy-api` (pinned in `core-version.txt`, fetched by `scripts/fetch-core.cjs`, `AITOOL_CORE_BIN` to override). Exposes `/v1/chat/completions`, `/v1/messages`, `/v1beta/models` on `127.0.0.1:8318` (loopback-only; port configurable in `config.yaml`). Per-request usage lands in `~/.aitool/proxy/usage/*.jsonl`.
- **Token Tracker analytics** — the vendored TokenTracker CLI + dashboard tracking 43 AI coding tools, unchanged.
- **Provider config management** — a Node port of cc-switch's config-file module: per-app provider presets in `~/.aitool/provider-switch/providers.json`, one-click switch projects each provider's key fields into the AI CLIs' live config files (`~/.claude/settings.json`, `~/.codex/config.toml` + `auth.json`, `~/.gemini/.env`) with pre-write backups; the add/edit dialog shows the full post-switch projection of each config file (cc-switch's editor view via `editor.js`) and saves floor keys to the provider row while writing other user edits straight into the live files with three-way conflict handling; dashboard page `/provider-switch`.

Data flow: AI CLI hooks → `src/lib/rollout.js` parsers (`parse*Incremental`) → `~/.tokentracker/queue.jsonl` (UTC half-hour buckets, append-only) → local API (`src/lib/local-api.js`: `/functions/*` analytics + `/api/proxy/*` proxy + `/api/provider-switch/*` config switching) → dashboard. Proxied requests enter the same buckets with `source: "cliproxy"` via `src/lib/proxy/usage-bridge.js`.

## Layout

| Path | What |
|---|---|
| `bin/tracker.js` → `src/cli.js` | CLI (`aitool`), CommonJS, Node ≥20 |
| `src/lib/proxy/` | proxy paths / config / core manager / management client / usage bridge / REST handlers; `src/commands/proxy.js` is the `aitool proxy …` command |
| `src/lib/provider-switch/` | cc-switch port: key-field "floor" tables + minimal-patch projections (claude / codex / gemini), line-preserving TOML/.env editors, editor view + three-way save split (`editor.js`), backups, presets; mounted under `/api/provider-switch/*`; page `dashboard/src/pages/ProviderSwitchPage.jsx` |
| `dashboard/` | React 18 + Vite 7 + TS strict + Tailwind; the AI Proxy page is `dashboard/src/pages/ProxyPage.jsx` (tab logic mirrors EasyCLIProxyAPI) |
| `desktop/` | Tauri 2 shell: native window + tray around the dashboard; spawns `node bin/tracker.js serve` on a free loopback port (`AITOOL_ROOT` / `AITOOL_NODE` overrides) |
| `TokenTrackerBar/`, `TokenTrackerWin/`, `TokenTrackerLinux/` | macOS (Swift menu bar, XcodeGen) / Windows (.NET 8 + WebView2) / Linux (Tauri 2) apps; each bundles a gitignored `EmbeddedServer/` built by its own bundle script |
| On disk | `~/.tokentracker/` analytics; `~/.aitool/proxy/` — `bin/`, `config.yaml`, `auths/`, `usage/`, `logs/`; plaintext management key in `~/.aitool/proxy/settings.json`; `~/.aitool/provider-switch/` — provider presets, backups, codex-auth stash |

## Commands

```bash
npm test                            # node --test test/*.test.js
node --test test/<name>.test.js     # single file
npm run ci:local                    # tests + validators + dashboard build
npm run dashboard:dev               # Vite dev server :5173 (mock API, skips CLI backend)
node bin/tracker.js serve --no-sync # real dashboard :7680 (proxy core starts with it)
npm run validate:copy|locale|ui-hardcode|guardrails|versions|bot-frames
docker compose up -d --build        # container: dashboard :7680 + proxy :8318, published on host loopback
cd desktop && npx tauri dev         # desktop shell; npx tauri build → AiTool.app (+ dmg)
```

## Load-bearing rules

- CommonJS in `src/`, ESM + strict TS in `dashboard/` — never mix. Env prefixes: `TOKENTRACKER_` (legacy CLI settings, still valid) and `AITOOL_` (proxy/desktop); `VITE_` for dashboard.
- User-facing dashboard text comes from `dashboard/src/content/copy.csv` — never hardcode; validators fail on it.
- **Cost is computed from `input + output + cached_input + cache_creation (+ reasoning where applicable)` via `computeRowCost` in `src/lib/pricing/index.js` — never `total_tokens`** (a provider that only fills `total_tokens` renders $0). Verify each provider's `input_tokens` semantics (e.g. Codex's `input` includes cached tokens).
- Model pricing edits go in `src/lib/pricing/curated-overrides.json` **and** the canonical edge block in `dashboard/edge-patches/tokentracker-leaderboard-refresh.ts`, copied verbatim into the other 4 edge files — `test/edge-pricing-parity.test.js` fails on drift.
- `dashboard/src/App.jsx` lazy-loads pages **except `NativeAuthCallbackPage`, which must stay eager-imported** (OAuth `insforge_code` is captured at module-load; lazy-loading breaks sign-in).
- Privacy: token counts only — never prompts, messages, or conversation bodies.
- Releases: any `src/`/`dashboard/` change ships npm + macOS + Windows + Linux (every desktop app bundles the CLI + dashboard). Bump only `package.json`, then `npm run sync-versions`; never push the local `vX.Y.Z` tag. Full workflow in CLAUDE.md.

## Read before touching

- `CLAUDE.md` — source of truth: command map, parser/token-normalization rules, release workflow, hard-won gotchas.
- `README.md` — the AiTool merge architecture (proxy ↔ analytics bridge diagram).
- `PRODUCT.md` / `DESIGN.md` — product principles and the dashboard design language.
- `docs/` — provider limits (opencode-go, devin), privacy, ops runbooks.

<!-- INSFORGE:START -->
## InsForge backend

This project uses [InsForge](https://insforge.dev): an all-in-one, open-source Postgres-based backend (BaaS) that gives this app a database, authentication, file storage, edge functions, realtime, an AI model gateway, and payments through one platform.

- **Project:** **tokentracker** (API base `https://srctyff5.us-east.insforge.app`)
- **Skills:** these InsForge skills are installed for supported coding agents. Reach for them before implementing any InsForge feature instead of guessing the API:
  - `insforge`: app code with the `@insforge/sdk` client (database CRUD, auth, storage, edge functions, realtime, AI, email, and Stripe payments).
  - `insforge-cli`: backend and infrastructure via the `insforge` CLI (projects, SQL, migrations, RLS policies, storage buckets, functions, secrets, payment setup, schedules, deploys).
  - `insforge-debug`: diagnosing failures (SDK/HTTP errors, RLS denials, auth and OAuth issues) and running security or performance audits.
  - `insforge-integrations`: wiring external auth providers (Clerk, Auth0, WorkOS, Better Auth, etc.) for JWT-based RLS, or the OKX x402 payment facilitator.
  - `find-skills`: discovering additional skills on demand.
- **Credentials:** app code reads keys from `.env.local`; the CLI reads `.insforge/project.json`. Never hardcode or commit keys.

Key patterns:

- Database inserts take an array: `insert([{ ... }])`.
- Reference users with `auth.users(id)`; use `auth.uid()` in RLS policies.
- For storage uploads, persist both the returned `url` and `key`.
<!-- INSFORGE:END -->
