# AiTool Desktop

Tauri 2 shell that wraps the AiTool local dashboard in a native window with a
system-tray icon — the EasyCLIProxyAPI-style desktop experience on top of the
TokenTracker dashboard.

## What it does

- Launch: picks a free loopback port (7680+), spawns `node bin/tracker.js serve
  --port <p> --no-open` from the AiTool repo root, waits for the server's
  health endpoint, then opens a native window on the dashboard. The proxy core
  and usage bridge start with the server (settings.autoStart, default on).
- Tray menu: **Open AiTool**, **Start proxy**, **Stop proxy**, **Quit AiTool**.
  Left-clicking the tray icon opens the window.
- Closing the window hides it to the tray (server + proxy keep running);
  **Quit** stops the Node server child and exits.

## Requirements

- Node.js 20+ on the machine (the shell spawns it; probed at
  `/opt/homebrew/bin/node`, `/usr/local/bin/node`, `/usr/bin/node`,
  `~/.volta/bin/node`, `~/.bun/bin/bun`, then `$PATH`).
- Rust toolchain (cargo) to build.
- The server resolves the AiTool repo at compile time
  (`CARGO_MANIFEST_DIR/../..`); override with `AITOOL_ROOT` and the Node binary
  with `AITOOL_NODE`.

## Build & run

```bash
npm install
npx tauri build     # bundle: src-tauri/target/release/bundle/macos/AiTool.app (+ dmg)
# or, for development:
npx tauri dev
```
