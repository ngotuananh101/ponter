pub mod keychain;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![])
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
