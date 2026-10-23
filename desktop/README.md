# AiTool Desktop

A Tauri 2 native window and tray around the checkout's local dashboard. This shell is separate from the bundled TokenTracker platform apps; it needs the repository and a local Node installation at runtime.

## What it does

- Probes ports **7680–7687** on `127.0.0.1`, then starts `node bin/tracker.js serve --port <p> --no-open` from the repository.
- Waits for `/api/proxy/status` to respond, then opens the dashboard. This checks server readiness; the proxy core may still be stopped, missing or unhealthy.
- The Node server starts the proxy and usage bridge when `settings.autoStart` is enabled (default on).
- Closing the window hides it to the tray. Open AiTool brings it back; Start proxy / Stop proxy use the authenticated local API; Quit stops the proxy and server.

## Requirements

- Node **22.19+**, with Node 24 recommended for development/tests. The package still declares ≥20, but current dependencies need a newer runtime.
- Rust and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for the target platform.
- A checkout with root dependencies installed and `dashboard/dist/` built.
- The proxy core is fetched separately using `node bin/tracker.js proxy install`; Go is needed only for `proxy install --local`.

## Build and run

From the repository root:

```bash
npm ci
npm ci --prefix dashboard
npm run dashboard:build
npm ci --prefix desktop
npm --prefix desktop run dev
```

For the configured macOS app/DMG targets:

```bash
npm --prefix desktop run build
open desktop/src-tauri/target/release/bundle/macos/AiTool.app
```

`desktop/src-tauri/tauri.conf.json` currently selects `app` and `dmg` bundles. Use [TokenTrackerLinux](../TokenTrackerLinux/README.md) or [TokenTrackerWin](../TokenTrackerWin/README.md) for their platform packaging. No dashboard rebuild or runtime bundle runs automatically from this shell's Tauri build.

`AITOOL_ROOT` is a **runtime** override; otherwise the shell uses the repository path captured at compilation. `AITOOL_NODE` overrides runtime discovery, which probes common Homebrew/system/Volta/bun locations before PATH. Moving the checkout after building therefore requires `AITOOL_ROOT`.

This shell is built locally; the fork does not publish releases. For the full run guide and architecture see [docs/running.md](../docs/running.md) and [docs/architecture.md](../docs/architecture.md).
