# Contributing to AiTool

Thanks for considering a contribution! AiTool is a local-first AI toolbox merging an AI gateway (EasyCLIProxyAPI / CLIProxyAPI parity), provider config management (cc-switch port), and the vendored TokenTracker analytics. The process is intentionally lightweight.

## Setup

```bash
git clone https://github.com/rijing-joker/AITool.git
cd AITool
# Node 24 recommended; current dependencies require at least 22.19
npm ci
npm ci --prefix dashboard

# Build the dashboard once so the CLI can serve it
npm run dashboard:build

# Optional — only needed for AI-proxy work: fetch the pinned cli-proxy-api core
node bin/tracker.js proxy install
```

## Run the CLI locally

```bash
node bin/tracker.js serve         # Dashboard at http://localhost:7680 (proxy core starts with it)
node bin/tracker.js sync          # Parse logs; request one-time upload if signed in
node bin/tracker.js status        # Check hook status
node bin/tracker.js doctor        # Health check
node bin/tracker.js proxy status  # AI proxy core + usage bridge
```

## Tests

```bash
npm test                                    # Full suite (node --test test/*.test.js)
node --test test/rollout-parser.test.js     # A single test file
npm --prefix dashboard test -- --testTimeout=15000 # Dashboard Vitest suite
npm run validate:copy
npm run validate:locale
npm run validate:ui-hardcode
npm run validate:guardrails
npm run validate:bot-frames
npm --prefix dashboard run typecheck
npm run dashboard:build
```

`npm run ci:local` remains an inherited convenience script: it includes version-parity checks and does not run the dashboard Vitest suite. In this fork, `validate:versions` is not a gate; do not change versions to satisfy it. Native checks and the current CI triggers are in `.github/workflows/ci.yml` (main/PR-to-main, not every `dev` commit).

If you're touching the dashboard UI:

```bash
npm run dashboard:dev             # Vite :5173 with hybrid local/mock analytics endpoints
npm run validate:copy             # copy.csv registry completeness — user-facing strings live there, never hardcoded
```

For proxy, provider switching and transcript work, use the built dashboard with `node bin/tracker.js serve`; Vite does not start those backends. Restart Vite after changing backend modules used by its middleware.

## Pull Request Checklist

- [ ] Tests pass (`npm test`, plus `npm --prefix dashboard test` for dashboard changes)
- [ ] User-facing strings added to `dashboard/src/content/copy.csv` (validators fail on hardcoding)
- [ ] Swift changes: run `(cd TokenTrackerBar && xcodegen generate && ruby scripts/patch-pbxproj-icon.rb)` after editing `TokenTrackerBar/project.yml`
- [ ] Conventional commit style in English: `feat:`, `fix:`, `refactor:`, `docs:`, `chore:`, `ci:`, `test:`
- [ ] PR description explains *why*, not just *what*

## Where things live

[CLAUDE.md](CLAUDE.md)'s "What's where" table is the map. The most common contributions:

- **New AI tool integration** (analytics): add a `parse*Incremental` parser in `src/lib/rollout.js`, wire it into `src/commands/sync.js`, update onboarding/status, add a hook only where needed, and add a parser test with a real (anonymized) log fixture. Follow the token normalization in CLAUDE.md — `input_tokens` is non-cached input only; verify the provider's semantics before shipping (e.g. Codex's `input` includes cached tokens).
- **Proxy REST endpoint**: `src/lib/proxy/api.js` (mounted under `/api/proxy/*`).
- **Provider switching / MCP / prompts / quota**: `src/lib/provider-switch/` — presets project "floor" key fields into live config files as minimal patches; keep projections line-preserving and never touch user-owned content.
- **Dashboard page**: lazy-imported from `dashboard/src/App.jsx` (exception: `NativeAuthCallbackPage` must stay eager-imported — see CLAUDE.md).

## Code Style

- **CLI (`src/`)**: CommonJS, no transpilation; use Node 24 to develop/test (current dependencies require ≥22.19). Match the existing style.
- **Dashboard (`dashboard/`)**: TypeScript strict, React 18, ESM, Tailwind. Match the existing style.
- **macOS (`TokenTrackerBar/`)**: Swift 5.9, SwiftUI + AppKit. Match the existing style.
- No linter wars. Be reasonable.

## Privacy Rules (non-negotiable)

Analytics parsers must keep prompts, responses and project file contents out of usage queues and upload payloads. Local project/session metadata can include paths and repository names, but those sidecar queues are never uploaded.

The CLI Sessions reader may read existing transcripts into bounded memory and export them explicitly. Provider switching stores user-authored prompts and credentials locally. Proxy inference and enabled search/vision/classification forward selected content to the configured provider. Do not copy any of that content into analytics, telemetry or proxy usage records; see [docs/PRIVACY.md](docs/PRIVACY.md).

Automatic cloud sync is opt-in and fail-closed: any new automatic upload path must gate behind the same `canUpload()` check (`src/lib/cloud-sync-prefs.js` / `dashboard/src/lib/cloud-sync-prefs.ts`).

## Fork workflow

This is `rijing-joker/AITool`, a personal fork. Work lands as ordinary commits on `dev`; do not bump versions, publish npm packages, dispatch release workflows or modify upstream distribution channels. Inherited packaging scripts remain useful for local builds, but do not imply a release. [CLAUDE.md → Fork — no releases here](CLAUDE.md#fork--no-releases-here) is the source of truth.

See [docs/README.md](docs/README.md) for current module guides and dated implementation/review records.
