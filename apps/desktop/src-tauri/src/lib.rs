pub mod autostart;
pub mod commands;
pub mod keychain;
pub mod state;
pub mod tray;

#[cfg(test)]
mod test_util;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Logging is owned by the caller (agent lib doc) — init once, before the builder.
    ponter_agent::logging::init();

    // `Manager` is needed for `.state::<TrayState>()` in the close-to-tray handler.
    use tauri::Manager;

    tauri::Builder::default()
        .manage(state::AppState::new())
        .manage(tray::TrayState::new())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            commands::login::login,
            commands::wizard::probe_server,
            #[cfg(not(target_env = "musl"))]
            commands::wizard::probe_capture,
            commands::wizard::save_wizard_settings,
            commands::devices::register_device,
            commands::devices::list_devices,
            commands::devices::delete_device,
            commands::updater::check_update,
            commands::updater::apply_update,
            autostart::set_autostart,
            autostart::is_autostart_enabled,
        ])
        .setup(|app| {
            // The tray must not be able to prevent the window from opening.
            // On failure we log and continue — an app without a tray still opens.
            if let Err(e) = tray::init(app.handle()) {
                eprintln!("failed to initialize the tray icon — continuing without tray: {e}");
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // Close-to-tray: hide only when a tray exists to restore from.
            // Without a tray, letting the default close proceed is the only sane choice.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let tray_active = window.state::<tray::TrayState>().tray_active();
                if tray::should_hide_on_close(tray_active) {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
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
