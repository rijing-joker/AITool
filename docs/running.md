# Running AiTool

How to get every surface of AiTool running locally: the dashboard GUI, the AI proxy behind it, and the desktop apps. For architecture see the [README](../README.md); for packaging/release internals and agent conventions see [CLAUDE.md](../CLAUDE.md).

## Prerequisites

- **Node.js 20+** (the CLI, dashboard build, and everything the desktop shell spawns)
- **Rust toolchain (cargo)** — only if you build a Tauri desktop app yourself
- The AI proxy core additionally needs macOS / Linux / Windows; its Go binary is fetched automatically (no toolchain needed)

## 1. Terminal: dashboard GUI at `localhost:7680`

```bash
npm install                    # root CLI + deps
npm --prefix dashboard install
npm run dashboard:build        # build the dashboard into dashboard/dist/

node bin/tracker.js serve      # opens http://localhost:7680 in your browser
```

`serve` starts the local HTTP API, serves the built dashboard, and (unless disabled in the proxy settings) starts the AI proxy core and its usage bridge with it. If port 7680 is taken, pass `--port 7681`; `--no-open` skips opening the browser. Other useful commands:

```bash
node bin/tracker.js sync       # manual sync of local AI-tool logs into the analytics store
node bin/tracker.js status     # which AI CLI hooks are attached
node bin/tracker.js doctor     # health check
```

Data lands in `~/.tokentracker/` (analytics) and `~/.aitool/proxy/` (proxy).

### Dashboard frontend development (hot reload)

```bash
npm run dashboard:dev          # Vite dev server on :5173 with a mocked local API
```

This skips the CLI backend entirely — good for UI work. To verify changes to `src/` (local API, proxy, parsers), build the dashboard and use `node bin/tracker.js serve` instead.

## 2. AI proxy (optional)

The proxy drives the external [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) Go binary; AiTool never links or bundles it.

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

Behavior: the shell picks a free loopback port, spawns `node bin/tracker.js serve --port <p> --no-open` from the repo root, polls `GET /api/proxy/status` until healthy, then opens the window. Closing the window hides to tray (server + proxy keep running); **Quit** stops the server and the proxy core. Tray menu: Open AiTool / Start proxy / Stop proxy / Quit.

The shell needs to find a Node binary — it probes `/opt/homebrew/bin/node`, `/usr/local/bin/node`, `/usr/bin/node`, `~/.volta/bin/node`, `~/.bun/bin/bun`, then `$PATH`. Set `AITOOL_NODE` to override, and `AITOOL_ROOT` if the repo isn't at the compile-time location.

Note: `desktop/` is built manually and is not part of the GitHub release workflows.

## 4. Platform apps (menu bar / tray apps shipped by CI)

- **macOS** (`TokenTrackerBar/`, Swift menu bar app): local DMG build steps are in [CLAUDE.md → Local DMG build](../CLAUDE.md). Requires XcodeGen + Xcode.
- **Windows** (`TokenTrackerWin/`, .NET 8 tray app) and **Linux** (`TokenTrackerLinux/`, Tauri 2 → AppImage/`.deb`/`.rpm`): CI is authoritative — see [CLAUDE.md → Release workflow](../CLAUDE.md). Each bundles its own `EmbeddedServer/` (Node + CLI + dashboard), so a repo-local dev loop is the same `serve` command as in section 1.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `serve` says port 7680 is in use | Pass `--port 7681`. On Windows the DoSvc service holds 7680; under WSL the server auto-uses a different port for this reason. |
| `proxy status` → "not installed" | Run `node bin/tracker.js proxy install` (or set `AITOOL_CORE_BIN`). |
| Proxy won't start, port conflict | A standalone CLIProxyAPI/EasyCLIProxyAPI may be holding 8317 — that's fine, AiTool uses 8318; if 8318 is also taken, change `port` in `~/.aitool/proxy/config.yaml`. |
| Dashboard shows no proxy data | Check `proxy status` → usage bridge should be `streaming`; core log at `~/.aitool/proxy/logs/core.log`. |
| Desktop app can't find Node | It probes common Homebrew/Volta/bun paths then `$PATH`; set `AITOOL_NODE`. |
| Auth/OAuth issues in the dashboard | Use `node bin/tracker.js doctor`; the OAuth callback page (`NativeAuthCallbackPage`) must stay eagerly imported — see CLAUDE.md. |
