pub mod commands;
pub mod keychain;
pub mod state;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(state::AppState::new())
        .invoke_handler(tauri::generate_handler![
            commands::login::login,
            commands::wizard::probe_server,
            commands::wizard::probe_capture,
            commands::wizard::save_wizard_settings,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod contract_tests {
    use ponter_agent::{AgentRuntime, RuntimeStatus};

    #[test]
    fn ponter_agent_runtime_api_is_wired() {
        // Compile-time contract: the desktop backend consumes this API in later tasks.
        let _start = AgentRuntime::start;
        assert_eq!(RuntimeStatus::Stopped, RuntimeStatus::Stopped);
    }
}
