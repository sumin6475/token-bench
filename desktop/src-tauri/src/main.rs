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

use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::Mutex;
use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

/// Holds the collector child process so it can be killed on exit.
struct Sidecar(Mutex<Option<Child>>);

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
    let url: tauri::Url = "http://localhost:4318/dashboard".parse().unwrap();
    if let Err(e) = WebviewWindowBuilder::new(app, "dashboard", WebviewUrl::External(url))
        .title("TokenBench Dashboard")
        .inner_size(1080.0, 780.0)
        .min_inner_size(760.0, 560.0)
        .build()
    {
        eprintln!("tokenbench: could not open dashboard window: {e}");
    }
}

#[tauri::command]
fn open_dashboard_cmd(app: AppHandle) {
    open_dashboard(&app);
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .manage(Sidecar(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![open_dashboard_cmd])
        .setup(|app| {
            // --- native menu: real-Mac-app affordances + the dashboard entry
            let dash_item = MenuItemBuilder::with_id("open_dashboard", "Open Dashboard")
                .accelerator("CmdOrCtrl+D")
                .build(app)?;
            let app_sub = SubmenuBuilder::new(app, "TokenBench")
                .about(None)
                .separator()
                .hide()
                .hide_others()
                .separator()
                .quit()
                .build()?;
            let view_sub = SubmenuBuilder::new(app, "View").item(&dash_item).build()?;
            let win_sub = SubmenuBuilder::new(app, "Window")
                .minimize()
                .close_window()
                .build()?;
            let menu = MenuBuilder::new(app)
                .items(&[&app_sub, &view_sub, &win_sub])
                .build()?;
            app.set_menu(menu)?;
            app.on_menu_event(|app, ev| {
                if ev.id() == "open_dashboard" {
                    open_dashboard(app);
                }
            });

            // --- collector sidecar (one process: OTel :4318 + proxy :8787)
            let data_dir = app.path().app_data_dir().expect("resolve app data dir");
            std::fs::create_dir_all(&data_dir).ok();
            let db = data_dir.join("tokenbench.db");

            let node = find_node();
            let collector = find_collector(app.handle());

            match Command::new(&node)
                .arg(&collector)
                .arg("--db")
                .arg(&db)
                .arg("--tokens")
                .arg("--proxy")
                .spawn()
            {
                Ok(child) => {
                    println!(
                        "tokenbench: collector started ({} {}) db={}",
                        node.display(),
                        collector.display(),
                        db.display()
                    );
                    *app.state::<Sidecar>().0.lock().unwrap() = Some(child);
                }
                // A missing collector must not crash the app — the widget will
                // just show "collector not reachable" until it comes up.
                Err(e) => eprintln!(
                    "tokenbench: could not start collector via {}: {e}",
                    node.display()
                ),
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building the TokenBench application")
        .run(|app_handle, event| {
            // P0-10: on quit, kill the sidecar so :4318/:8787 are released.
            if let RunEvent::ExitRequested { .. } = event {
                if let Some(mut child) = app_handle.state::<Sidecar>().0.lock().unwrap().take() {
                    let _ = child.kill();
                    println!("tokenbench: collector stopped");
                }
            }
        });
}
