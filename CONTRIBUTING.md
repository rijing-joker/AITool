# Contributing to AiTool

Thanks for considering a contribution! AiTool is a local-first AI toolbox merging an AI gateway (EasyCLIProxyAPI / CLIProxyAPI parity), provider config management (cc-switch port), and the vendored TokenTracker analytics. The process is intentionally lightweight.

## Setup

```bash
git clone https://github.com/rijing-joker/AITool.git
cd AITool
npm install
npm --prefix dashboard install

# Build the dashboard once so the CLI can serve it
npm run dashboard:build

# Optional — only needed for AI-proxy work: fetch the pinned cli-proxy-api core
node bin/tracker.js proxy install
```

## Run the CLI locally

```bash
node bin/tracker.js serve         # Dashboard at http://localhost:7680 (proxy core starts with it)
node bin/tracker.js sync          # Manual sync
node bin/tracker.js status        # Check hook status
node bin/tracker.js doctor        # Health check
node bin/tracker.js proxy status  # AI proxy core + usage bridge
```

## Tests

```bash
npm test                                    # Full suite (node --test test/*.test.js)
node --test test/rollout-parser.test.js     # A single test file
npm --prefix dashboard test                 # Dashboard vitest suite
npm run ci:local                            # Tests + validators + dashboard build (everything CI runs)
```

If you're touching the dashboard UI:

```bash
npm run dashboard:dev             # Vite dev server with mocked API (skips the CLI backend)
npm run validate:copy             # copy.csv registry completeness — user-facing strings live there, never hardcoded
```

## Pull Request Checklist

- [ ] Tests pass (`npm test`, plus `npm --prefix dashboard test` for dashboard changes)
- [ ] User-facing strings added to `dashboard/src/content/copy.csv` (validators fail on hardcoding)
- [ ] Swift changes: run `xcodegen generate` after editing `TokenTrackerBar/project.yml`
- [ ] Conventional commit style in English: `feat:`, `fix:`, `refactor:`, `docs:`, `chore:`, `ci:`, `test:`
- [ ] PR description explains *why*, not just *what*

## Where things live

[CLAUDE.md](CLAUDE.md)'s "What's where" table is the map. The most common contributions:

- **New AI tool integration** (analytics): add a `parse*Incremental` parser in `src/lib/rollout.js`, a hook installer in `src/commands/init.js`, a status check in `src/commands/status.js`, and a parser test with a real (anonymized) log fixture. Follow the token normalization in CLAUDE.md — `input_tokens` is non-cached input only; verify the provider's semantics before shipping (e.g. Codex's `input` includes cached tokens).
- **Proxy REST endpoint**: `src/lib/proxy/api.js` (mounted under `/api/proxy/*`).
- **Provider switching / MCP / prompts / quota**: `src/lib/provider-switch/` — presets project "floor" key fields into live config files as minimal patches; keep projections line-preserving and never touch user-owned content.
- **Dashboard page**: lazy-imported from `dashboard/src/App.jsx` (exception: `NativeAuthCallbackPage` must stay eager-imported — see CLAUDE.md).

## Code Style

- **CLI (`src/`)**: CommonJS, Node 20+, no transpilation. Match the existing style.
- **Dashboard (`dashboard/`)**: TypeScript strict, React 18, ESM, Tailwind. Match the existing style.
- **macOS (`TokenTrackerBar/`)**: Swift 5.9, SwiftUI + AppKit. Match the existing style.
- No linter wars. Be reasonable.

## Privacy Rules (non-negotiable)

AiTool tracks **only token counts and timestamps**. Never log, store, transmit, or print any prompt content, response content, file paths from user code, or anything that could leak what the user is working on. If your change touches a parser, double-check this.

Cloud sync is opt-in and fail-closed: any new automatic upload path must gate behind the same `canUpload()` check (`src/lib/cloud-sync-prefs.js` / `dashboard/src/lib/cloud-sync-prefs.ts`).

## Releasing (maintainers only)

See the "Release workflow" section in [CLAUDE.md](CLAUDE.md).
