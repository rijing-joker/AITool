# Running AiTool

How to get every surface of AiTool running locally: the dashboard GUI, the AI proxy behind it, and the desktop apps. For architecture see the [README](../README.md); for fork workflow and agent conventions see [CLAUDE.md](../CLAUDE.md).

## Prerequisites

- **Node.js 24 recommended** for development and tests; use **22.19+** for current dependencies. `package.json` still declares ≥20, but `undici@8` requires ≥22.19 and the tests import TypeScript through native type stripping.
- **Rust toolchain (cargo)** — only if you build a Tauri desktop app yourself
- The AI proxy core additionally needs macOS / Linux / Windows; its Go binary is fetched automatically (no toolchain needed)
- **Docker** — only for the container run (section 5)

## 1. Terminal: dashboard GUI at `localhost:7680`

```bash
npm install                    # root CLI + deps
npm --prefix dashboard install
npm run dashboard:build        # build the dashboard into dashboard/dist/

node bin/tracker.js serve      # opens http://localhost:7680 in your browser
```

`serve` starts the local HTTP API, serves the built dashboard, and (unless disabled in the proxy settings) starts the AI proxy core and its usage bridge with it. If port 7680 is taken, pass `--port 7681`; `--no-open` skips opening the browser. Other useful commands:

```bash
node bin/tracker.js sync       # parse logs; one-time upload request if account/device credentials exist
node bin/tracker.js status     # which AI CLI hooks are attached
node bin/tracker.js doctor     # health check
```

Analytics state lives in `~/.tokentracker/tracker/`; the main queue is `queue.jsonl` (UTC half-hour buckets). Proxy state lives in `~/.aitool/proxy/`, and provider/config/MCP/skills/prompt/profile state in `~/.aitool/provider-switch/`. Automatic cloud upload defaults off; a manual `sync` requests a one-time upload without changing that preference.

`serve --no-sync` skips the initial sync; it still starts the proxy when auto-start is enabled. `serve` can repair/install local hook integration. Docker sets `AITOOL_PASSIVE_HOOKS=1` to avoid writing container hook paths into shared host configs.

### Dashboard frontend development (hot reload)

```bash
npm run dashboard:dev          # Vite :5173, hybrid local/mock analytics middleware
```

Vite serves selected analytics, projects, sessions, pet and skills endpoints from the checkout, supplies local/mock results for other `/functions/*` endpoints and forwards unhandled `/functions/*` routes to a CLI on :7680. It does not bootstrap `/api/proxy/*`, `/api/provider-switch/*` or `/api/cli-sessions/*`. Use the built dashboard with `serve` for those features. Backend modules outside Vite’s module graph need a Vite restart after edits; frontend hot reload alone does not reload them.

## 2. AI proxy (optional)

The proxy drives the external [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) Go binary; AiTool does not link or vendor it into the CLI/native app. The Docker image separately downloads it at image build time. The current pin is **v8.0.37** (`core-version.txt`); this pin does not automatically replace an already installed core.

```bash
node bin/tracker.js proxy install   # fetch the pinned core (core-version.txt) into ~/.aitool/proxy/bin
node bin/tracker.js proxy status    # core + usage-bridge status
node bin/tracker.js proxy start     # start core + usage bridge (serve does this automatically)
node bin/tracker.js proxy config    # show paths and endpoint
```

- Compatible endpoints (`/v1/chat/completions`, `/v1/messages`, `/v1beta/models`) listen on `http://127.0.0.1:8318`, loopback-only. Port 8318 (not the core's conventional 8317) so a standalone CLIProxyAPI / EasyCLIProxyAPI install can coexist.
- Overrides: `AITOOL_CORE_BIN=/path/to/cli-proxy-api` to use a binary you already have, or `node bin/tracker.js proxy install --local <CLIProxyAPI checkout>` to build your fork.
- Core logs: `~/.aitool/proxy/logs/core.log`. Per-request usage records: `~/.aitool/proxy/usage/`.

## 3. Desktop app (Tauri 2 shell, `desktop/`)

A native window + system tray around the dashboard.

```bash
cd desktop
npm install
npx tauri dev      # development build
npx tauri build    # release: desktop/src-tauri/target/release/bundle/macos/AiTool.app (+ dmg)
```

Behavior: the shell picks a free loopback port, spawns `node bin/tracker.js serve --port <p> --no-open` from the repo root, polls `GET /api/proxy/status` until the local server responds, then opens the window. Closing the window hides to tray (server + proxy keep running); **Quit** stops the server and the proxy core. Tray menu: Open AiTool / Start proxy / Stop proxy / Quit.

The configured bundle targets are macOS `app`/`dmg`; unlike the TokenTracker platform apps, this shell does not bundle Node, CLI or `dashboard/dist`. Build the dashboard before launching. Its port search is limited to 7680–7687. Server readiness does not require the proxy core to be healthy.

The shell needs to find a Node binary — it probes `/opt/homebrew/bin/node`, `/usr/local/bin/node`, `/usr/bin/node`, `~/.volta/bin/node`, `~/.bun/bin/bun`, then `$PATH`. Set `AITOOL_NODE` to override, and use the runtime `AITOOL_ROOT` override if the checkout moved from its compile-time location.

Note: `desktop/` is built manually and is not part of the GitHub release workflows.

## 4. Platform apps (bundled menu bar / tray clients)

Each platform app packages its own gitignored `EmbeddedServer/` (Node + CLI + dashboard). These retain their TokenTracker names during the rebrand.

- **macOS** (`TokenTrackerBar/`, Swift/AppKit + WidgetKit): requires Xcode + XcodeGen. Build the dashboard, run `bash TokenTrackerBar/scripts/bundle-node.sh --arch arm64` (or `x64`), then `(cd TokenTrackerBar && xcodegen generate && ruby scripts/patch-pbxproj-icon.rb)`. Open the generated Xcode project for a local build; `project.yml` is the project definition. The server uses :7680.
- **Windows** (`TokenTrackerWin/`, .NET 8 + WebView2): [build/dev/bundling guide](../TokenTrackerWin/README.md). Prefers :17680 and falls back to a free loopback port; the fixed port matters for OAuth.
- **Linux** (`TokenTrackerLinux/`, Tauri 2 + WebKitGTK): [platform guide](../TokenTrackerLinux/README.md). `npm run linux:build` builds dashboard assets, stages Node/CLI and packages AppImage/`.deb`/`.rpm`; requires Linux Tauri dependencies. Also prefers :17680 with a free-port fallback.

Inherited CI/packaging workflows remain in the tree. This personal fork does not dispatch releases or publish packages; see [CLAUDE.md → Fork — no releases here](../CLAUDE.md#fork--no-releases-here).

## 5. Docker

```bash
docker compose up -d --build
# dashboard: http://127.0.0.1:7680 — AI proxy: http://127.0.0.1:8318
```

Or without compose:

```bash
docker build -t aitool:local .
docker run -d --name aitool -p 127.0.0.1:7680:7680 -p 127.0.0.1:8318:8318 aitool:local
```

- One container = dashboard + local API + AI proxy core. The pinned CLIProxyAPI binary is pre-fetched for the image platform at build time and staged at `/opt/aitool/cli-proxy-api` (outside the data dirs, so a mounted volume cannot shadow it); the proxy layer copies it into `~/.aitool/proxy/bin` on first start.
- Data: named volumes `aitool-tracker` → `/root/.tokentracker` (analytics) and `aitool-proxy` → `/root/.aitool` (proxy config/usage + provider-switch presets/backups).
- Named volumes start empty and know nothing about AI-CLI data on the host, so on a machine with native usage history the dashboard reads zeros, and provider switch cannot reach the host CLIs' live config files it is supposed to rewrite. To run the container as a full native equivalent, copy `docker-compose.override.yml.example` to `docker-compose.override.yml` (binds `~/.tokentracker`, `~/.zcode`, `~/.claude`, `~/.codex`, `~/.gemini`, `~/.aitool` and runs the service as uid 1000 so files it writes stay owned by the host account) and `docker compose up -d` again; the override file is machine-local and gitignored, the example is what travels with the repo. This exposes the mounted sources for analytics, the read-only CLI Sessions page and Claude/Codex/Gemini configuration projection. The other supported tools require their own config/session-root mounts. Check the example’s uid and bind paths against your machine; it is not a complete mount inventory for all ten tools.
- Ports publish on the host **loopback only**. The local API is login-free and trusts loopback origins — never publish it to a public interface without an authenticating reverse proxy.
- Inside the container everything binds `0.0.0.0` via `AITOOL_BIND_HOST` (a container-bound `127.0.0.1` is unreachable through `-p`). On a bare host the default stays `127.0.0.1`; the proxy's `config.yaml` `server.host` reconciles to the override on start, including volumes carried over from a loopback-only machine.

For optional OpenCode free models, desktop client connections, Magpie/WorkBuddy adapters and search/vision/routing, see the [documentation index](README.md). These integrations require explicit configuration; opening a status page does not perform discovery, login, MCP checks or quota refresh.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `serve` says port 7680 is in use | Pass `--port 7681`. On Windows the DoSvc service holds 7680; under WSL the server auto-uses a different port for this reason. |
| Docker: published port unreachable | `AITOOL_BIND_HOST=0.0.0.0` must be set in the container (the compose file does this) — a `127.0.0.1` bind inside the container is never reachable through `-p`. |
| `proxy status` → "not installed" | Run `node bin/tracker.js proxy install` (or set `AITOOL_CORE_BIN`). |
| Proxy won't start, port conflict | A standalone CLIProxyAPI/EasyCLIProxyAPI may be holding 8317 — that's fine, AiTool uses 8318; if 8318 is also taken, change `port` in `~/.aitool/proxy/config.yaml`. |
| Dashboard shows no proxy data | Check `proxy status` → usage bridge should be `streaming`; core log at `~/.aitool/proxy/logs/core.log`. |
| Docker: usage dashboard is all zeros while the service is healthy | Stock compose uses named volumes — the container can't see native tracker state or AI-CLI data. Copy `docker-compose.override.yml.example` → `docker-compose.override.yml` and `docker compose up -d` (see section 5). |
| Desktop app can't find Node | It probes common Homebrew/Volta/bun paths then `$PATH`; set `AITOOL_NODE`. |
| Long CLI-session fields show previews | Expand to load the full field. If logs change during reading, reload the session; search and Markdown export load the full current revision. |
| Auth/OAuth issues in the dashboard | Use `node bin/tracker.js doctor`; the OAuth callback page (`NativeAuthCallbackPage`) must stay eagerly imported — see CLAUDE.md. |
