//! The application object. Owns the message channel, the tokio runtime, and the
//! screen router state. `logic` drains the channel and dispatches commands;
//! `ui` renders the current screen. (eframe 0.36 calls `logic` before each
//! `ui`, and also while the window is hidden when a repaint was requested — so
//! background `Msg`s are still folded in with the window hidden.)

use eframe::egui;

/// Which top-level screen is showing. The router in `ui::mod` picks it from
/// `CoreState` each frame; this field only carries the manual overrides
/// (`editing_server`, wizard step).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Screen {
    ServerSetup,
    Login,
    Wizard,
    Devices,
    Settings,
}

/// A user intent emitted by a screen or the tray. The app turns each into
/// background work on the tokio runtime.
#[derive(Debug)]
pub enum Command {
    Login {
        username: String,
        password: String,
    },
    Logout,
    ProbeServer {
        url: String,
    },
    SaveServer {
        url: String,
    },
    ProbeCapture,
    RegisterDevice {
        capabilities: Vec<String>,
    },
    DeleteDevice {
        id: String,
    },
    RefreshDevices,
    CheckUpdate,
    ApplyUpdate,
    SetAutostart {
        enabled: bool,
    },
    ToggleAllowInput {
        enabled: bool,
    },
    SetTheme {
        theme: String,
    },
    /// Start the hosted agent runtime (§5.4). Idempotent: a second start while
    /// one runs is a no-op.
    StartAgent,
    /// Stop the hosted agent runtime (§5.4). A no-op when nothing runs.
    StopAgent,
    /// Stop the agent (if any) and exit the process.
    Quit,
}

/// A tray menu action, injected by the tray thread (Task 17) as
/// `Msg::Tray(..)` so the app can turn it into the matching `Command`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrayRequest {
    StartAgent,
    StopAgent,
    OpenWindow,
    ToggleAutostart,
    Quit,
}

/// A result reported back from a background task (or the tray) to the app.
///
/// Variants referencing types from `core::{wizard, auth, devices, updater}`
/// are added as those modules are ported in subsequent tasks (spec §4, plan Task 1 Interfaces).
#[derive(Debug)]
pub enum Msg {
    ConfigSaved(Result<(), String>),
    LoginFailed(String),
    WizardAdvanced,
    WizardCompleted,
    AutostartToggled(bool),
    FleetChanged,
    DeviceDeleted(Result<String, String>),
    UpdateApplied(Result<(), String>),
    AgentStarted(Result<(), String>),
    AgentStopped(Result<(), String>),
    /// A tray menu action (Task 17).
    Tray(TrayRequest),
}

/// The shell's root object.
pub struct App {
    pub state: std::sync::Arc<crate::core::state::CoreState>,
    /// Background task -> app channel.
    pub(crate) tx: tokio::sync::mpsc::Sender<Msg>,
    rx: tokio::sync::mpsc::Receiver<Msg>,
    /// The single multi-thread runtime all async work is spawned onto.
    pub(crate) rt: tokio::runtime::Runtime,
    /// Current screen (overridden by the router each frame).
    pub screen: Screen,
    /// Manual override: return to Server Setup from Settings.
    pub editing_server: bool,
}

impl App {
    pub fn new(_cc: &eframe::CreationContext<'_>) -> Self {
        let config_path = crate::core::state::config_dir().map(|d| d.join("config.json"));
        let state = std::sync::Arc::new(crate::core::state::CoreState::with_config(config_path));
        let screen = if !state.has_server_url() {
            Screen::ServerSetup
        } else {
            Screen::Login
        };

        let (tx, rx) = tokio::sync::mpsc::channel(64);
        let rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("building the tokio runtime");
        Self {
            state,
            tx,
            rx,
            rt,
            screen,
            editing_server: false,
        }
    }

    /// Fold one background message into the app state.
    pub(crate) fn handle_msg(&mut self, msg: Msg) {
        // Populated by later tasks (auth, devices, updater, ...). Task 1 only
        // needs the drain to exist and compile.
        let _ = msg;
    }
}

impl eframe::App for App {
    fn logic(&mut self, _ctx: &egui::Context, _frame: &mut eframe::Frame) {
        while let Ok(msg) = self.rx.try_recv() {
            self.handle_msg(msg);
        }
    }

    fn ui(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
        // The router picks the screen from CoreState each frame (Task 16 adds the
        // `showing_settings` override in front of this).
        self.screen = crate::ui::route(&self.state, self.editing_server);
        crate::theme::apply(ui.ctx(), self.state.theme.lock().unwrap().as_deref());
        crate::ui::render(self, ui);
    }
}
