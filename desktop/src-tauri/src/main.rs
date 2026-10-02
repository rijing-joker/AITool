// AiTool desktop shell (Tauri 2).
//
// Wraps the AiTool local dashboard (Node server + web UI) in a native window
// and adds a tray icon with proxy controls — the EasyCLIProxyAPI experience
// (launch an app, get a window, control the proxy from the tray) on top of
// the TokenTracker dashboard.
//
// Boot sequence: pick a free loopback port → spawn `node bin/tracker.js
// serve --port <p> --no-open` from the AiTool repo → poll the proxy status
// endpoint until the server is up → open a window on the server URL. Closing
// the window hides to tray; Quit (tray menu) stops the Node child and exits.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::net::TcpListener;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent};

const PREFERRED_PORTS: [u16; 8] = [7680, 7681, 7682, 7683, 7684, 7685, 7686, 7687];
const HEALTH_TIMEOUT: Duration = Duration::from_secs(60);

struct ServerState {
    child: Mutex<Option<Child>>,
    port: Mutex<u16>,
}

fn repo_root() -> PathBuf {
    if let Ok(root) = std::env::var("AITOOL_ROOT") {
        return PathBuf::from(root);
    }
    // desktop/src-tauri → repo root (two levels up), resolved at compile time
    // so a bundled .app still finds the checkout it was built from.
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..").canonicalize().expect(
        "AiTool repo root not found — build from within the repository or set AITOOL_ROOT",
    )
}

fn resolve_node() -> String {
    if let Ok(node) = std::env::var("AITOOL_NODE") {
        return node;
    }
    // Finder-launched apps get a minimal PATH; probe the common install
    // locations before falling back to $PATH lookup by the OS.
    let home = std::env::var("HOME").unwrap_or_default();
    for candidate in [
        "/opt/homebrew/bin/node",
        "/usr/local/bin/node",
        "/usr/bin/node",
        &format!("{home}/.volta/bin/node"),
        &format!("{home}/.bun/bin/bun"),
    ] {
        if std::path::Path::new(candidate).exists() {
            return candidate.to_string();
        }
    }
    "node".to_string()
}

fn pick_free_port() -> Option<u16> {
    for port in PREFERRED_PORTS {
        if TcpListener::bind(("127.0.0.1", port)).is_ok() {
            return Some(port);
        }
    }
    None
}

fn spawn_server(root: &PathBuf, port: u16) -> Result<Child, String> {
    let node = resolve_node();
    // bun works too (bin/tracker.js is plain CommonJS); resolve_node may pick it.
    let is_bun = node.ends_with("bun");
    let mut cmd = Command::new(&node);
    if is_bun {
        cmd.arg("run");
    }
    cmd.arg("bin/tracker.js")
        .arg("serve")
        .arg("--port")
        .arg(port.to_string())
        .arg("--no-open")
        .current_dir(root)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .env("AITOOL_DESKTOP", "1");
    cmd.spawn().map_err(|e| format!("failed to spawn {node}: {e}"))
}

fn http_ok(url: &str) -> bool {
    ureq::get(url)
        .timeout(Duration::from_secs(2))
        .call()
        .map(|r| r.status() < 500)
        .unwrap_or(false)
}

fn wait_for_server(port: u16) -> bool {
    let status_url = format!("http://127.0.0.1:{port}/api/proxy/status");
    let deadline = std::time::Instant::now() + HEALTH_TIMEOUT;
    while std::time::Instant::now() < deadline {
        if http_ok(&status_url) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    false
}

// --- Tray proxy controls ---------------------------------------------------

fn local_auth_token(port: u16) -> Option<String> {
    let body: serde_json::Value = ureq::get(&format!("http://127.0.0.1:{port}/api/local-auth"))
        .timeout(Duration::from_secs(3))
        .call()
        .ok()?
        .into_json()
        .ok()?;
    body.get("token")?.as_str().map(|s| s.to_string())
}

fn proxy_command(port: u16, action: &str) -> Result<(), String> {
    let token = local_auth_token(port).ok_or("no local auth token")?;
    let origin = format!("http://127.0.0.1:{port}");
    let response = ureq::post(&format!("{origin}/api/proxy/{action}"))
        .set("x-tokentracker-local-auth", &token)
        .set("Origin", &origin)
        .timeout(Duration::from_secs(30))
        .call();
    match response {
        Ok(r) if r.status() == 200 => Ok(()),
        Ok(r) => Err(format!("proxy {action} → HTTP {}", r.status())),
        Err(e) => Err(format!("proxy {action} failed: {e}")),
    }
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn build_main_window(app: &AppHandle, port: u16) -> tauri::Result<()> {
    let url: tauri::Url = format!("http://127.0.0.1:{port}/").parse().unwrap();
    WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
        .title("AiTool")
        .inner_size(1280.0, 840.0)
        .min_inner_size(980.0, 640.0)
        .build()?;
    Ok(())
}

fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open AiTool", true, None::<&str>)?;
    let start = MenuItem::with_id(app, "proxy_start", "Start proxy", true, None::<&str>)?;
    let stop = MenuItem::with_id(app, "proxy_stop", "Stop proxy", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit AiTool", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &start, &stop, &quit])?;

    let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/icon.png"))?.to_owned();

    TrayIconBuilder::with_id("aitool-tray")
        .icon(icon)
        .tooltip("AiTool")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show_main_window(app),
            "proxy_start" | "proxy_stop" => {
                let app = app.clone();
                let action = event.id().as_ref().trim_start_matches("proxy_").to_string();
                let port = app.state::<ServerState>().port.lock().map(|p| *p).unwrap_or(7680);
                std::thread::spawn(move || {
                    if let Err(error) = proxy_command(port, &action) {
                        eprintln!("[AiTool] {error}");
                    }
                });
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

fn main() {
    let root = repo_root();
    let port = pick_free_port().expect("no free loopback port in 7680-7687");
    let child = spawn_server(&root, port).expect("failed to start the AiTool server");

    let app = tauri::Builder::default()
        .manage(ServerState {
            child: Mutex::new(Some(child)),
            port: Mutex::new(port),
        })
        .on_window_event(|window, event| {
            // Closing the window hides to tray (proxy keeps running); real
            // exit is the tray menu's Quit.
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .setup(move |app| {
            setup_tray(app.handle())?;

            // Boot the server health wait off the main thread; open the
            // dashboard window once /api/proxy/status answers (which also
            // proves the proxy auto-start ran). Window creation is dispatched
            // onto the main thread — creating a WebviewWindow directly from a
            // worker thread races the app setup and yields a shell window
            // with no attached webview.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                if !wait_for_server(port) {
                    eprintln!(
                        "[AiTool] local server did not become healthy on port {port}; see the server log"
                    );
                    return;
                }
                let handle_for_window = handle.clone();
                let result = handle.run_on_main_thread(move || {
                    if let Err(error) = build_main_window(&handle_for_window, port) {
                        eprintln!("[AiTool] failed to open dashboard window: {error}");
                    }
                });
                if let Err(error) = result {
                    eprintln!("[AiTool] main-thread dispatch failed: {error}");
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    // `App::run` drives the event loop until exit; `RunEvent::Exit` fires on
    // app.exit(0) (tray Quit) and stops the Node child we spawned.
    app.run(|app, event| match event {
        // Kill the Node child on both exit paths — Quit Apple Event goes
        // through ExitRequested; the final Exit fires right before teardown.
        RunEvent::ExitRequested { .. } | RunEvent::Exit => {
            if let Ok(mut guard) = app.state::<ServerState>().child.lock() {
                if let Some(mut child) = guard.take() {
                    let port = app.state::<ServerState>().port.lock().map(|p| *p).unwrap_or(7680);
                    if let Err(error) = proxy_command(port, "stop") {
                        eprintln!("[AiTool] {error}");
                    }
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
        }
        _ => {}
    });
}
