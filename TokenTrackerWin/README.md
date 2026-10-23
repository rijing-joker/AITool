# TokenTracker for Windows (AiTool tray client)

The Windows native client around AiTool's Node CLI and dashboard. TokenTracker names remain for compatibility. This client bundles `EmbeddedServer/`; it is separate from the checkout-dependent `desktop/` shell.

## Current behavior

- .NET 8 WinForms tray plus a WPF WebView2 composition dashboard window.
- Open Dashboard / Switch provider / Sync / Desktop quota / Show Pet / startup and update controls. Provider switching dispatches `native:providers` into the existing page and preserves drafts; hidden windows report `native:visibility` to pause dashboard refresh.
- Native theme/settings bridge, `tokentracker://` OAuth relay, single-instance handling and upstream update checking/downloading. Update checks repeat every six hours while resident, subject to preferences/in-flight guards.
- The server prefers **127.0.0.1:17680**, falling back to an OS-assigned free port. DoSvc frequently holds 7680. OAuth needs the allow-listed fixed port; email login can still work on the fallback.
- `ServerManager` launches the bundled CLI with `serve --port <P> --no-sync --no-open`; local/native publication follows the cloud-sync preference. Server-owned proxy startup follows its settings.
- On Quit the server is stopped. A Windows Job Object with `KILL_ON_JOB_CLOSE` also cleans up the assigned Node process after a forced tray-app exit.

## Desktop quota and pet

Enable **Desktop quota** in the tray. Its 320 × 144 DIP collapsed view expands to 360 × 340 DIP and supports two provider windows, reset countdowns, theme/language, saved placement and fullscreen hiding. Closing the widget disables it persistently; reopen from the tray. Dashboard closure does not stop the widget's shared 60-second quota polling.

The floating pet has separate character/size/visibility controls. Build dashboard assets with `TOKENTRACKER_BUILD_PET=1` to include **both `pet.html` and `quota.html`**. The quota window uses a solid layered surface with a rounded region; Windows 11 Acrylic is not required for it.

## Requirements and development

Windows 10/11, WebView2 Runtime and .NET 8 SDK. Use Node 24 for checkout development/tests (current dependencies require ≥22.19). Packaged clients use the Node version pinned by `scripts/bundle-node.ps1`.

From the repository root in PowerShell:

```powershell
npm ci
npm ci --prefix dashboard
$env:TOKENTRACKER_BUILD_PET = '1'
npm run dashboard:build
dotnet build TokenTrackerWin/TokenTrackerWin.csproj -c Debug
$env:TOKENTRACKER_NODE = (Get-Command node).Source
$env:TOKENTRACKER_ENTRY = Join-Path $PWD 'bin\tracker.js'
.\TokenTrackerWin\bin\Debug\net8.0-windows10.0.19041.0\TokenTracker.exe
```

The executable resides in the tray without a console. The target framework and output path come from `TokenTrackerWin.csproj`.

## Local bundling and verification

From the repository root:

```powershell
powershell -ExecutionPolicy Bypass -File TokenTrackerWin\scripts\bundle-node.ps1
dotnet publish TokenTrackerWin/TokenTrackerWin.csproj -c Release -r win-x64 --self-contained false
dotnet test TokenTrackerWin.Tests/TokenTrackerWin.Tests.csproj -c Release
```

`bundle-node.ps1` downloads pinned Node and stages CLI + built dashboard into the gitignored `TokenTrackerWin/EmbeddedServer/`. The published package must copy that directory next to `TokenTracker.exe`; `dotnet publish` alone does not declare it as project content. The inherited installer/workflow handles the distribution copy; see `installer/TokenTracker.iss` and `.github/workflows/release-windows.yml`.

Regenerate tray assets with `TokenTrackerWin/scripts/make-icon.ps1` if needed. Tray-icon rendering and native UI are not exact macOS feature parity; current source and tests define the supported behavior.

This fork does not publish packages or dispatch inherited releases. Upstream update links remain upstream links. See [running.md](../docs/running.md), [architecture.md](../docs/architecture.md) and [CLAUDE.md](../CLAUDE.md).
