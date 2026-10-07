// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
fn spike_start() -> String {
    // Placeholder for AgentRuntime::start(); proves the backend can host
    // the runtime call in-process.
    "runtime start requested".to_string()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![greet, spike_start])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
