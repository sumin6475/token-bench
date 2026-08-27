// TokenBench desktop shell.
//
// Owns three things:
//   1. The always-on-top widget window (config in tauri.conf.json).
//   2. The collector sidecar — spawned on launch with --proxy (OTel :4318 +
//      provider proxy :8787 in ONE node process), killed on quit (P0-10).
//      Self-contained resolution: the bundled Node binary (externalBin, lands
//      next to the app executable) runs the bundled collector (resources ->
//      Contents/Resources/sidecar/). Env vars and the repo path are fallbacks
//      for dev, not requirements.
//   3. The dashboard window — a normal resizable window on /dashboard, opened
//      from the widget button, the View menu, or Cmd+D.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::menu::{CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

const COLLECTOR_PROTOCOL_MARKER: &str = "\"widgetProtocol\":2";

/// Holds the collector child process so it can be killed on exit.
struct Sidecar {
    child: Mutex<Option<Child>>,
    stopping: AtomicBool,
    widget_loaded: AtomicBool,
}

#[derive(Debug, Serialize, Deserialize)]
struct Preferences {
    float_on_top: bool,
}

impl Default for Preferences {
    fn default() -> Self {
        Self { float_on_top: true }
    }
}

fn preferences_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|p| p.join("preferences.json"))
}

fn load_preferences(app: &AppHandle) -> Preferences {
    preferences_path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_preferences(app: &AppHandle, preferences: &Preferences) {
    let Some(path) = preferences_path(app) else { return };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(json) = serde_json::to_string_pretty(preferences) {
        let _ = std::fs::write(path, json);
    }
}

/// Bundled Node first (externalBin — sits next to the app executable in both
/// `tauri dev` and the .app bundle), then an explicit override, then PATH.
fn find_node() -> PathBuf {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let n = dir.join("node");
            if n.exists() {
                return n;
            }
        }
    }
    if let Ok(p) = std::env::var("TOKENBENCH_NODE") {
        return PathBuf::from(p);
    }
    PathBuf::from("node")
}

/// Bundled collector first (resources/sidecar/), then an explicit repo
/// override, then the dev-time repo path baked at compile time.
fn find_collector(app: &AppHandle) -> PathBuf {
    if let Ok(rd) = app.path().resource_dir() {
        let c = rd.join("sidecar").join("collector.js");
        if c.exists() {
            return c;
        }
    }
    if let Ok(root) = std::env::var("TOKENBENCH_ROOT") {
        return PathBuf::from(root).join("collector.js");
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("collector.js")
}

fn open_dashboard(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("dashboard") {
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let url: tauri::Url = "http://127.0.0.1:4318/dashboard".parse().unwrap();
    if let Err(e) = WebviewWindowBuilder::new(app, "dashboard", WebviewUrl::External(url))
        .title("TokenBench Dashboard")
        .inner_size(1080.0, 780.0)
        .min_inner_size(760.0, 560.0)
        .build()
    {
        eprintln!("tokenbench: could not open dashboard window: {e}");
    }
}

fn collector_health_response() -> Option<String> {
    let address = SocketAddr::from(([127, 0, 0, 1], 4318));
    let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_millis(350)) else {
        return None;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(350)));
    if stream
        .write_all(b"GET /healthz HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
        .is_err()
    {
        return None;
    }
    let mut response = String::new();
    if stream.read_to_string(&mut response).is_ok()
        && response.starts_with("HTTP/1.1 200")
        && response.contains("\"status\":\"ok\"")
    {
        Some(response)
    } else {
        None
    }
}

fn collector_is_healthy() -> bool {
    collector_health_response()
        .is_some_and(|response| response.contains(COLLECTOR_PROTOCOL_MARKER))
}

/// Stop only a bundled TokenBench collector, never an unrelated service or a
/// collector the user launched manually. This repairs the macOS crash/orphan
/// case where an older app leaves :4318 alive across an update.
fn stop_stale_bundled_collector() -> bool {
    let Ok(listeners) = Command::new("/usr/sbin/lsof")
        .args(["-nP", "-tiTCP:4318", "-sTCP:LISTEN"])
        .output()
    else {
        return false;
    };
    if !listeners.status.success() {
        return false;
    }

    let mut stopped = false;
    for pid in String::from_utf8_lossy(&listeners.stdout).lines() {
        if !pid.chars().all(|c| c.is_ascii_digit()) {
            continue;
        }
        let Ok(details) = Command::new("/bin/ps")
            .args(["-p", pid, "-o", "command="])
            .output()
        else {
            continue;
        };
        let command = String::from_utf8_lossy(&details.stdout);
        let is_bundled_sidecar = command.contains("/TokenBench.app/Contents/MacOS/node")
            && command.contains("/TokenBench.app/Contents/Resources/sidecar/collector.js");
        if is_bundled_sidecar
            && Command::new("/bin/kill")
                .arg(pid)
                .status()
                .is_ok_and(|status| status.success())
        {
            println!("tokenbench: stopped stale bundled collector pid={pid}");
            stopped = true;
        }
    }
    if stopped {
        for _ in 0..20 {
            if collector_health_response().is_none() {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }
    stopped
}

fn check_collector_health() -> String {
    match collector_health_response() {
        Some(response) if response.contains(COLLECTOR_PROTOCOL_MARKER) => "healthy".into(),
        Some(_) => "outdated".into(),
        None => "unreachable".into(),
    }
}

/// The configured webview is created before setup runs, so a cold start can
/// otherwise navigate to :4318 a few milliseconds before Node begins listening
/// and remain on WebKit's blank error page. Keep it hidden, then navigate and
/// reveal it exactly once after the compatible collector is ready.
fn reveal_widget_once(app: &AppHandle) {
    let sidecar = app.state::<Sidecar>();
    if sidecar.widget_loaded.swap(true, Ordering::Relaxed) {
        return;
    }
    let Some(widget) = app.get_webview_window("main") else {
        sidecar.widget_loaded.store(false, Ordering::Relaxed);
        return;
    };
    let url: tauri::Url = "http://127.0.0.1:4318/widget".parse().unwrap();
    if let Err(e) = widget.navigate(url) {
        eprintln!("tokenbench: could not load widget after collector startup: {e}");
        sidecar.widget_loaded.store(false, Ordering::Relaxed);
        return;
    }
    let _ = widget.show();
    let _ = widget.set_focus();
}

fn reveal_widget_when_ready(app: &AppHandle) {
    for _ in 0..80 {
        if collector_is_healthy() {
            reveal_widget_once(app);
            return;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    eprintln!("tokenbench: collector startup timed out; widget remains hidden until watchdog recovery");
}

fn spawn_collector(node: &PathBuf, collector: &PathBuf, db: &PathBuf) -> std::io::Result<Child> {
    Command::new(node)
        .arg(collector)
        .arg("--db")
        .arg(db)
        .arg("--tokens")
        .arg("--proxy")
        .spawn()
}

#[tauri::command]
fn open_dashboard_cmd(app: AppHandle) {
    open_dashboard(&app);
}

#[tauri::command]
fn load_widget_cmd(app: AppHandle) -> bool {
    if !collector_is_healthy() {
        return false;
    }
    let Some(widget) = app.get_webview_window("main") else {
        return false;
    };
    let url: tauri::Url = "http://127.0.0.1:4318/widget".parse().unwrap();
    widget.navigate(url).is_ok()
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .manage(Sidecar {
            child: Mutex::new(None),
            stopping: AtomicBool::new(false),
            widget_loaded: AtomicBool::new(false),
        })
        .invoke_handler(tauri::generate_handler![open_dashboard_cmd, load_widget_cmd])
        .setup(|app| {
            let preferences = load_preferences(app.handle());
            if let Some(widget) = app.get_webview_window("main") {
                widget.set_always_on_top(preferences.float_on_top)?;
            }

            // --- native menu: real-Mac-app affordances + the dashboard entry
            let dash_item = MenuItemBuilder::with_id("open_dashboard", "Open Dashboard")
                .accelerator("CmdOrCtrl+D")
                .build(app)?;
            let health_item = MenuItemBuilder::with_id("check_health", "Check Collector Health")
                .build(app)?;
            let float_item = CheckMenuItemBuilder::with_id("float_on_top", "Float on Top")
                .checked(preferences.float_on_top)
                .build(app)?;
            let app_sub = SubmenuBuilder::new(app, "TokenBench")
                .about(None)
                .separator()
                .item(&health_item)
                .separator()
                .hide()
                .hide_others()
                .separator()
                .quit()
                .build()?;
            let view_sub = SubmenuBuilder::new(app, "View").item(&dash_item).build()?;
            let win_sub = SubmenuBuilder::new(app, "Window")
                .item(&float_item)
                .separator()
                .minimize()
                .close_window()
                .build()?;
            let menu = MenuBuilder::new(app)
                .items(&[&app_sub, &view_sub, &win_sub])
                .build()?;
            app.set_menu(menu)?;
            let float_item_for_event = float_item.clone();
            app.on_menu_event(move |app, ev| {
                if ev.id() == "open_dashboard" {
                    open_dashboard(app);
                } else if ev.id() == "check_health" {
                    let status = check_collector_health();
                    println!("Collector health: {}", status);
                    // In a real app, you'd show a dialog here
                } else if ev.id() == "float_on_top" {
                    let enabled = float_item_for_event.is_checked().unwrap_or(true);
                    if let Some(widget) = app.get_webview_window("main") {
                        if let Err(e) = widget.set_always_on_top(enabled) {
                            eprintln!("tokenbench: could not change Float on Top: {e}");
                            return;
                        }
                    }
                    save_preferences(app, &Preferences { float_on_top: enabled });
                }
            });

            // --- collector sidecar (one process: OTel :4318 + proxy :8787)
            let data_dir = app.path().app_data_dir().expect("resolve app data dir");
            std::fs::create_dir_all(&data_dir).ok();
            let db = data_dir.join("tokenbench.db");

            let node = find_node();
            let collector = find_collector(app.handle());

            if collector_is_healthy() {
                println!("tokenbench: attached to the collector already running on :4318");
            } else {
                if collector_health_response().is_some() {
                    stop_stale_bundled_collector();
                }
                match spawn_collector(&node, &collector, &db) {
                Ok(child) => {
                    println!(
                        "tokenbench: collector started ({} {}) db={}",
                        node.display(),
                        collector.display(),
                        db.display()
                    );
                    *app.state::<Sidecar>().child.lock().unwrap() = Some(child);
                }
                // A missing collector must not crash the app — the widget will
                // just show "collector not reachable" until it comes up.
                Err(e) => eprintln!(
                    "tokenbench: could not start collector via {}: {e}",
                    node.display()
                ),
                }
            }

            reveal_widget_when_ready(app.handle());

            // A crashed sidecar must not leave the widget permanently dead.
            // The watchdog also takes ownership if an external collector that
            // was already on :4318 later disappears.
            let watchdog_app = app.handle().clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(Duration::from_secs(2));
                let sidecar = watchdog_app.state::<Sidecar>();
                if sidecar.stopping.load(Ordering::Relaxed) {
                    break;
                }

                if collector_is_healthy() {
                    reveal_widget_once(&watchdog_app);
                }

                let needs_child = {
                    let mut child = sidecar.child.lock().unwrap();
                    match child.as_mut().and_then(|c| c.try_wait().ok()).flatten() {
                        Some(status) => {
                            eprintln!("tokenbench: collector exited ({status}); scheduling restart");
                            *child = None;
                            true
                        }
                        None => child.is_none(),
                    }
                };
                if needs_child && !collector_is_healthy() {
                    if collector_health_response().is_some() && !stop_stale_bundled_collector() {
                        // An incompatible listener that is not our bundled
                        // sidecar must not be killed or competed with.
                        continue;
                    }
                    match spawn_collector(&node, &collector, &db) {
                        Ok(mut child) => {
                            if sidecar.stopping.load(Ordering::Relaxed) {
                                let _ = child.kill();
                                break;
                            }
                            println!("tokenbench: collector restarted");
                            *sidecar.child.lock().unwrap() = Some(child);
                        }
                        Err(e) => eprintln!("tokenbench: collector restart failed: {e}"),
                    }
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building the TokenBench application")
        .run(|app_handle, event| {
            // P0-10: macOS can reach either ExitRequested or Exit depending on
            // how the app is closed. Handle both; taking the Option makes this
            // idempotent if both events arrive.
            if matches!(event, RunEvent::ExitRequested { .. } | RunEvent::Exit) {
                let sidecar = app_handle.state::<Sidecar>();
                sidecar.stopping.store(true, Ordering::Relaxed);
                let owned_child = sidecar.child.lock().unwrap().take();
                if let Some(mut child) = owned_child {
                    let _ = child.kill();
                    println!("tokenbench: collector stopped");
                }
            }
        });
}
