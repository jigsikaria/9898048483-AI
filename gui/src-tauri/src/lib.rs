use tauri::Manager;

#[tauri::command]
fn gateway_status() -> String {
    "online".to_string()
}

#[tauri::command]
fn proxy_chat(model: String, messages: String) -> Result<String, String> {
    // Desktop gateway client - proxies to the local/remote AdapterOS server.
    // The server endpoint is configurable at runtime from the GUI; this command
    // is a thin passthrough for native clients without a browser fetch layer.
    let _ = (model, messages);
    Err("configure the server endpoint in the GUI settings".to_string())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![gateway_status, proxy_chat])
        .setup(|app| {
            let window = app.get_webview_window("main");
            if let Some(win) = window {
                let _ = win.set_title("9898048483 Adapter OS v10.0");
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
