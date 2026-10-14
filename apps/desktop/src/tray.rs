//! Tray icon + agent lifecycle (ADR-81, Task 17).

use crate::app::{Msg, TrayRequest};
use ponter_agent::{RuntimeHandle, RuntimeStatus};
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc::Sender;

pub const ID_STATUS: &str = "status";
pub const ID_START: &str = "start";
pub const ID_STOP: &str = "stop";
pub const ID_OPEN: &str = "open";
pub const ID_AUTOSTART: &str = "autostart";
pub const ID_QUIT: &str = "quit";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrayAction {
    Start,
    Stop,
    OpenWindow,
    ToggleAutostart,
    Quit,
}

pub fn tray_label(status: &RuntimeStatus) -> &'static str {
    match status {
        RuntimeStatus::Connected => "Connected",
        RuntimeStatus::Disconnected => "Disconnected",
        RuntimeStatus::Stopped => "Stopped",
    }
}

pub fn status_text(status: &RuntimeStatus) -> String {
    format!("Status: {}", tray_label(status))
}

pub fn status_key(status: &RuntimeStatus) -> &'static str {
    match status {
        RuntimeStatus::Connected => "connected",
        RuntimeStatus::Disconnected => "disconnected",
        RuntimeStatus::Stopped => "stopped",
    }
}

pub fn action_for_menu_id(id: &str) -> Option<TrayAction> {
    match id {
        ID_START => Some(TrayAction::Start),
        ID_STOP => Some(TrayAction::Stop),
        ID_OPEN => Some(TrayAction::OpenWindow),
        ID_AUTOSTART => Some(TrayAction::ToggleAutostart),
        ID_QUIT => Some(TrayAction::Quit),
        _ => None,
    }
}

pub fn derive_ws_url(server_url: &str) -> Result<String, String> {
    let trimmed = server_url.trim_end_matches('/');
    let ws = if trimmed.starts_with("http://") {
        trimmed.replacen("http://", "ws://", 1)
    } else if trimmed.starts_with("https://") {
        trimmed.replacen("https://", "wss://", 1)
    } else if trimmed.starts_with("ws://") || trimmed.starts_with("wss://") {
        trimmed.to_string()
    } else {
        return Err(format!(
            "server URL must use http://, https://, ws://, or wss:// (got: {})",
            trimmed
        ));
    };
    Ok(format!("{ws}/api/ws/agent"))
}

pub fn should_hide_on_close(tray_active: bool) -> bool {
    tray_active
}

pub type RuntimeSlot = Arc<Mutex<Option<RuntimeHandle>>>;

pub fn current_status_text(runtime: &Mutex<Option<RuntimeHandle>>) -> String {
    let guard = match runtime.lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    };
    match &*guard {
        Some(handle) => status_text(&handle.status()),
        None => status_text(&RuntimeStatus::Stopped),
    }
}

pub fn spawn(tx: Sender<Msg>, runtime: RuntimeSlot) {
    #[cfg(target_os = "linux")]
    spawn_linux(tx, runtime);
    #[cfg(target_os = "windows")]
    spawn_windows(tx, runtime);
    #[cfg(not(any(target_os = "linux", target_os = "windows")))]
    {
        let _ = (tx, runtime);
    }
}

#[cfg(any(target_os = "linux", target_os = "windows"))]
const TRAY_ICON_PNG: &[u8] = include_bytes!("../icons/32x32.png");

fn msg_for_menu_id(id: &str) -> Option<Msg> {
    match action_for_menu_id(id)? {
        TrayAction::Start => Some(Msg::Tray(TrayRequest::StartAgent)),
        TrayAction::Stop => Some(Msg::Tray(TrayRequest::StopAgent)),
        TrayAction::OpenWindow => Some(Msg::Tray(TrayRequest::OpenWindow)),
        TrayAction::ToggleAutostart => Some(Msg::Tray(TrayRequest::ToggleAutostart)),
        TrayAction::Quit => Some(Msg::Tray(TrayRequest::Quit)),
    }
}

#[cfg(target_os = "linux")]
fn spawn_linux(tx: Sender<Msg>, runtime: RuntimeSlot) {
    use ksni::blocking::TrayMethods;
    struct PonterTray {
        tx: Sender<Msg>,
        runtime: RuntimeSlot,
    }
    impl ksni::Tray for PonterTray {
        fn id(&self) -> String {
            "ponter-desktop".into()
        }
        fn title(&self) -> String {
            "Ponter Desktop".into()
        }
        fn icon_name(&self) -> String {
            "ponter-desktop".into()
        }
        fn icon_pixmap(&self) -> Vec<ksni::Icon> {
            eframe::icon_data::from_png_bytes(TRAY_ICON_PNG)
                .map(|img| {
                    vec![ksni::Icon {
                        width: img.width as i32,
                        height: img.height as i32,
                        data: img.rgba,
                    }]
                })
                .unwrap_or_default()
        }
        fn menu(&self) -> Vec<ksni::MenuItem<Self>> {
            use ksni::menu::StandardItem;
            let send = |id: &'static str| {
                let tx = self.tx.clone();
                move |_t: &mut PonterTray| {
                    if let Some(msg) = msg_for_menu_id(id) {
                        let _ = tx.try_send(msg);
                    }
                }
            };
            vec![
                StandardItem {
                    label: current_status_text(&self.runtime),
                    enabled: false,
                    ..Default::default()
                }
                .into(),
                StandardItem {
                    label: "Start agent".into(),
                    activate: Box::new(send(ID_START)),
                    ..Default::default()
                }
                .into(),
                StandardItem {
                    label: "Stop agent".into(),
                    activate: Box::new(send(ID_STOP)),
                    ..Default::default()
                }
                .into(),
                StandardItem {
                    label: "Open window".into(),
                    activate: Box::new(send(ID_OPEN)),
                    ..Default::default()
                }
                .into(),
                StandardItem {
                    label: "Quit".into(),
                    activate: Box::new(send(ID_QUIT)),
                    ..Default::default()
                }
                .into(),
            ]
        }
    }
    let tray = PonterTray { tx, runtime };
    std::thread::spawn(move || {
        let _ = tray.spawn();
    });
}

#[cfg(target_os = "windows")]
fn spawn_windows(tx: Sender<Msg>, runtime: RuntimeSlot) {
    use tray_icon::menu::{Menu, MenuItem, PredefinedMenuItem};
    use tray_icon::TrayIconBuilder;

    std::thread::spawn(move || {
        let menu = Menu::new();
        let status = MenuItem::new(current_status_text(&runtime), false, None);
        let start = MenuItem::with_id(ID_START, "Start agent", true, None);
        let stop = MenuItem::with_id(ID_STOP, "Stop agent", true, None);
        let open = MenuItem::with_id(ID_OPEN, "Open window", true, None);
        let quit = MenuItem::with_id(ID_QUIT, "Quit", true, None);
        menu.append_items(&[
            &status,
            &start,
            &stop,
            &open,
            &PredefinedMenuItem::separator(),
            &quit,
        ])
        .expect("building the tray menu");

        let icon = eframe::icon_data::from_png_bytes(TRAY_ICON_PNG)
            .map(|img| tray_icon::Icon::from_rgba(img.rgba, img.width, img.height))
            .expect("decoding the embedded tray icon")
            .expect("building the tray icon");

        let _tray = TrayIconBuilder::new()
            .with_tooltip("Ponter Desktop")
            .with_icon(icon)
            .with_menu(Box::new(menu))
            .build()
            .expect("building the tray icon");
        let rx = tray_icon::menu::MenuEvent::receiver();
        loop {
            match rx.recv() {
                Ok(event) => {
                    if let Some(msg) = msg_for_menu_id(event.id.as_ref()) {
                        let _ = tx.try_send(msg);
                    }
                }
                Err(_) => break,
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_runtime_status_to_tray_label() {
        assert_eq!(tray_label(&RuntimeStatus::Connected), "Connected");
        assert_eq!(tray_label(&RuntimeStatus::Disconnected), "Disconnected");
        assert_eq!(tray_label(&RuntimeStatus::Stopped), "Stopped");
    }

    #[test]
    fn status_key_maps_all_variants() {
        assert_eq!(status_key(&RuntimeStatus::Connected), "connected");
        assert_eq!(status_key(&RuntimeStatus::Disconnected), "disconnected");
        assert_eq!(status_key(&RuntimeStatus::Stopped), "stopped");
    }

    #[test]
    fn status_text_formats_exactly() {
        assert_eq!(status_text(&RuntimeStatus::Connected), "Status: Connected");
        assert_eq!(
            status_text(&RuntimeStatus::Disconnected),
            "Status: Disconnected"
        );
        assert_eq!(status_text(&RuntimeStatus::Stopped), "Status: Stopped");
    }

    #[test]
    fn action_for_menu_id_dispatches_all_ids() {
        assert_eq!(action_for_menu_id("start"), Some(TrayAction::Start));
        assert_eq!(action_for_menu_id("stop"), Some(TrayAction::Stop));
        assert_eq!(action_for_menu_id("open"), Some(TrayAction::OpenWindow));
        assert_eq!(
            action_for_menu_id("autostart"),
            Some(TrayAction::ToggleAutostart)
        );
        assert_eq!(action_for_menu_id("quit"), Some(TrayAction::Quit));
    }

    #[test]
    fn action_for_menu_id_unknown_is_none() {
        assert_eq!(action_for_menu_id("nope"), None);
        assert_eq!(action_for_menu_id(""), None);
    }

    #[test]
    fn derive_ws_url_converts_http() {
        assert_eq!(
            derive_ws_url("http://localhost:8787").unwrap(),
            "ws://localhost:8787/api/ws/agent"
        );
    }

    #[test]
    fn derive_ws_url_converts_https_and_trims_slash() {
        assert_eq!(
            derive_ws_url("https://h:8443/").unwrap(),
            "wss://h:8443/api/ws/agent"
        );
    }

    #[test]
    fn derive_ws_url_passes_through_ws() {
        assert_eq!(derive_ws_url("ws://h").unwrap(), "ws://h/api/ws/agent");
    }

    #[test]
    fn derive_ws_url_rejects_unsupported_scheme() {
        assert!(derive_ws_url("ftp://h").is_err());
    }

    #[test]
    fn derive_ws_url_rejects_missing_scheme() {
        assert!(derive_ws_url("localhost:8787").is_err());
    }

    #[test]
    fn should_hide_on_close_true_when_tray_active() {
        assert!(should_hide_on_close(true));
    }

    #[test]
    fn should_hide_on_close_false_when_no_tray() {
        assert!(!should_hide_on_close(false));
    }
}
