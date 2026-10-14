//! The application object. Owns the message channel, the tokio runtime, and the
//! screen router state. `logic` drains the channel and dispatches commands;
//! `ui` renders the current screen. (eframe 0.36 calls `logic` before each
//! `ui`, and also while the window is hidden when a repaint was requested — so
//! background `Msg`s are still folded in with the window hidden.)

use eframe::egui;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

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
#[derive(Debug, Clone)]
pub enum Msg {
    ServerProbed(crate::core::wizard::ProbeResult),
    ConfigSaved(Result<(), String>),
    LoggedIn(crate::core::auth::UserProfile),
    LoginFailed(String),
    CaptureProbed(crate::core::wizard::ProbeResult),
    WizardAdvanced,
    WizardCompleted,
    AutostartToggled(bool),
    DevicesLoaded(Result<Vec<crate::core::devices::DesktopDevice>, String>),
    FleetChanged,
    DeviceRegistered(Result<crate::core::devices::DesktopDevice, String>),
    DeviceDeleted(Result<String, String>),
    UpdateChecked(Result<Option<crate::core::updater::UpdateInfo>, String>),
    UpdateApplied(Result<(), String>),
    AgentStarted(Result<(), String>),
    AgentStopped(Result<(), String>),
    /// A tray menu action (Task 17).
    Tray(TrayRequest),
}

/// The shell's root object.
pub struct App {
    pub state: Arc<crate::core::state::CoreState>,
    /// Background task -> app channel.
    pub(crate) tx: tokio::sync::mpsc::Sender<Msg>,
    rx: tokio::sync::mpsc::Receiver<Msg>,
    /// The single multi-thread runtime all async work is spawned onto.
    pub(crate) rt: tokio::runtime::Runtime,
    /// Current screen (overridden by the router each frame).
    pub screen: Screen,
    pub ctx: egui::Context,
    /// Manual override: return to Server Setup from Settings.
    pub editing_server: bool,
    pub server_url_input: String,
    pub last_probe: Option<Msg>,
    pub login_error: Option<String>,
    pub username_input: String,
    pub password_input: String,
    pub devices: Vec<crate::core::devices::DesktopDevice>,
    pub wizard_step: usize,
    pub capture_probe_ok: bool,
    pub autostart_enabled: bool,
    pub allow_input: bool,
    pub show_window: bool,
    pub showing_settings: bool,
    pub username: String,
    pub register_capabilities: Vec<String>,
    pub pending_delete: Option<String>,
    pub available_update: Option<crate::core::updater::UpdateInfo>,
    pub tray_active: bool,
    pub fleet_started: Arc<AtomicBool>,
    pub fleet_shutdown_tx: tokio::sync::watch::Sender<bool>,
    pub agent: Arc<Mutex<Option<ponter_agent::RuntimeHandle>>>,
}

impl App {
    pub fn new(cc: &eframe::CreationContext<'_>) -> Self {
        let (tx, rx) = tokio::sync::mpsc::channel(64);
        let (fleet_shutdown_tx, fleet_shutdown_rx) = tokio::sync::watch::channel(false);
        let rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("building the tokio runtime");
        let config_path = crate::core::state::config_dir().map(|d| d.join("config.json"));
        let state = Arc::new(crate::core::state::CoreState::with_config(config_path));
        let screen = if !state.has_server_url() {
            Screen::ServerSetup
        } else {
            Screen::Login
        };

        crate::theme::setup_fonts(&cc.egui_ctx);

        let allow_input = *state.allow_input.lock().unwrap();
        let app = Self {
            state,
            tx,
            rx,
            rt,
            screen,
            ctx: cc.egui_ctx.clone(),
            username_input: String::new(),
            password_input: String::new(),
            login_error: None,
            server_url_input: String::new(),
            last_probe: None,
            devices: Vec::new(),
            wizard_step: 0,
            capture_probe_ok: false,
            autostart_enabled: crate::autostart::is_autostart_enabled(),
            allow_input,
            editing_server: false,
            show_window: false,
            showing_settings: false,
            username: String::new(),
            register_capabilities: vec!["terminal".to_string(), "desktop".to_string()],
            pending_delete: None,
            available_update: None,
            tray_active: false,
            fleet_started: Arc::new(AtomicBool::new(false)),
            fleet_shutdown_tx,
            agent: Arc::new(Mutex::new(None)),
        };

        // Start the fleet task exactly once for the app's lifetime (guard (g)).
        if !app.fleet_started.swap(true, Ordering::Relaxed) {
            app.rt.spawn(crate::core::fleet_ws::run(
                app.state.clone(),
                app.tx.clone(),
                fleet_shutdown_rx,
            ));
        }

        app
    }

    /// Dispatch a user intent to the tokio runtime.
    pub fn send(&self, cmd: Command) {
        let tx = self.tx.clone();
        let ctx = self.ctx.clone();
        let state = self.state.clone();
        match cmd {
            Command::Login { username, password } => {
                self.rt.spawn(async move {
                    let client = state.http.clone();
                    let url = state.server_url.lock().unwrap().clone();
                    let res = crate::core::auth::login_impl(
                        &client,
                        &url,
                        username,
                        password,
                        &state.access_token,
                    )
                    .await;
                    let msg = match res {
                        Ok(user) => Msg::LoggedIn(user),
                        Err(e) => Msg::LoginFailed(e),
                    };
                    let _ = tx.send(msg).await;
                    ctx.request_repaint();
                });
            }
            Command::Logout => {
                self.rt.spawn(async move {
                    let _ = crate::core::auth::logout_impl(&state);
                    let _ = tx.send(Msg::DevicesLoaded(Ok(Vec::new()))).await;
                    ctx.request_repaint();
                });
            }
            Command::ProbeServer { url } => {
                self.rt.spawn(async move {
                    let client = state.http.clone();
                    let probe = crate::core::wizard::probe_server_impl(&client, &url)
                        .await
                        .unwrap_or_else(|e| crate::core::wizard::ProbeResult {
                            ok: false,
                            message: e,
                        });
                    let _ = tx.send(Msg::ServerProbed(probe)).await;
                    ctx.request_repaint();
                });
            }
            Command::SaveServer { url } => {
                self.rt.spawn(async move {
                    let res = crate::core::wizard::save_config_impl(
                        &state,
                        Some(url.as_str()),
                        *state.allow_input.lock().unwrap(),
                        state.theme.lock().unwrap().clone().as_deref(),
                    );
                    if res.is_ok() {
                        state.set_has_server_url(true);
                    }
                    let _ = tx.send(Msg::ConfigSaved(res)).await;
                    ctx.request_repaint();
                });
            }
            Command::ProbeCapture => {
                self.rt.spawn(async move {
                    let probe = crate::core::wizard::probe_capture()
                        .await
                        .unwrap_or_else(|e| crate::core::wizard::ProbeResult {
                            ok: false,
                            message: e,
                        });
                    let _ = tx.send(Msg::CaptureProbed(probe)).await;
                    ctx.request_repaint();
                });
            }
            Command::RegisterDevice { capabilities } => {
                self.rt.spawn(async move {
                    let client = state.http.clone();
                    let url = state.server_url.lock().unwrap().clone();
                    let token = state.access_token.lock().unwrap().clone();
                    let res = crate::core::devices::register_device_impl(
                        &client,
                        &url,
                        token,
                        capabilities,
                    )
                    .await;
                    let _ = tx.send(Msg::DeviceRegistered(res)).await;
                    ctx.request_repaint();
                });
            }
            Command::DeleteDevice { id } => {
                self.rt.spawn(async move {
                    let client = state.http.clone();
                    let url = state.server_url.lock().unwrap().clone();
                    let token = state.access_token.lock().unwrap().clone();
                    let res = crate::core::devices::delete_device_impl(&client, &url, token, &id)
                        .await
                        .map(|_| id);
                    let _ = tx.send(Msg::DeviceDeleted(res)).await;
                    ctx.request_repaint();
                });
            }
            Command::RefreshDevices => {
                self.rt.spawn(async move {
                    let client = state.http.clone();
                    let url = state.server_url.lock().unwrap().clone();
                    let token = state.access_token.lock().unwrap().clone();
                    let res = crate::core::devices::list_devices_impl(&client, &url, token).await;
                    let _ = tx.send(Msg::DevicesLoaded(res)).await;
                    ctx.request_repaint();
                });
            }
            Command::CheckUpdate => {
                self.rt.spawn(async move {
                    let client = state.http.clone();
                    let res = crate::core::updater::check(&client, env!("CARGO_PKG_VERSION")).await;
                    let _ = tx.send(Msg::UpdateChecked(res)).await;
                    ctx.request_repaint();
                });
            }
            Command::ApplyUpdate => {
                self.rt.spawn(async move {
                    let client = state.http.clone();
                    let res = match crate::core::updater::check(&client, env!("CARGO_PKG_VERSION"))
                        .await
                    {
                        Ok(Some(info)) => crate::core::updater::apply(&client, &info).await,
                        Ok(None) => Ok(()),
                        Err(e) => Err(e),
                    };
                    let _ = tx.send(Msg::UpdateApplied(res)).await;
                    ctx.request_repaint();
                });
            }
            Command::SetAutostart { enabled } => {
                self.rt.spawn(async move {
                    let res = crate::autostart::set_autostart(enabled);
                    let _ = tx.send(Msg::AutostartToggled(res.is_ok())).await;
                    ctx.request_repaint();
                });
            }
            Command::ToggleAllowInput { enabled } => {
                self.rt.spawn(async move {
                    *state.allow_input.lock().unwrap() = enabled;
                    let url = state.server_url.lock().unwrap().clone();
                    let theme = state.theme.lock().unwrap().clone();
                    let res = crate::core::wizard::save_config_impl(
                        &state,
                        Some(url.as_str()),
                        enabled,
                        theme.as_deref(),
                    );
                    if res.is_ok() {
                        state.set_has_server_url(true);
                    }
                    let _ = tx.send(Msg::ConfigSaved(res)).await;
                    ctx.request_repaint();
                });
            }
            Command::SetTheme { theme } => {
                self.rt.spawn(async move {
                    *state.theme.lock().unwrap() = Some(theme.clone());
                    let url = state.server_url.lock().unwrap().clone();
                    let allow_input = *state.allow_input.lock().unwrap();
                    let res = crate::core::wizard::save_config_impl(
                        &state,
                        Some(url.as_str()),
                        allow_input,
                        Some(theme.as_str()),
                    );
                    if res.is_ok() {
                        state.set_has_server_url(true);
                    }
                    let _ = tx.send(Msg::ConfigSaved(res)).await;
                    ctx.request_repaint();
                });
            }
            Command::StartAgent => {
                if self.agent.lock().unwrap().is_some() {
                    return;
                }
                let agent = self.agent.clone();
                self.rt.spawn(async move {
                    match crate::core::agent_host::start(&state).await {
                        Ok(handle) => {
                            *agent.lock().unwrap() = Some(handle);
                            let _ = tx.send(Msg::AgentStarted(Ok(()))).await;
                        }
                        Err(e) => {
                            let _ = tx.send(Msg::AgentStarted(Err(e))).await;
                        }
                    }
                    ctx.request_repaint();
                });
            }
            Command::StopAgent => {
                let agent = self.agent.clone();
                self.rt.spawn(async move {
                    let handle_opt = agent.lock().unwrap().take();
                    let res = match handle_opt {
                        Some(handle) => crate::core::agent_host::stop(&handle).await,
                        None => Ok(()),
                    };
                    let _ = tx.send(Msg::AgentStopped(res)).await;
                    ctx.request_repaint();
                });
            }
            Command::Quit => {
                let agent = self.agent.clone();
                let shutdown_tx = self.fleet_shutdown_tx.clone();
                self.rt.spawn(async move {
                    let _ = shutdown_tx.send(true);
                    let handle_opt = agent.lock().unwrap().take();
                    if let Some(handle) = handle_opt {
                        let _ = crate::core::agent_host::stop(&handle).await;
                    }
                    std::process::exit(0);
                });
            }
        }
    }

    /// Fold one background message into the app state.
    pub(crate) fn handle_msg(&mut self, msg: Msg) {
        match msg {
            Msg::ServerProbed(res) => self.last_probe = Some(Msg::ServerProbed(res)),
            Msg::CaptureProbed(res) => {
                self.capture_probe_ok = res.ok;
                self.last_probe = Some(Msg::CaptureProbed(res));
            }
            Msg::ConfigSaved(Ok(())) => {
                self.login_error = None;
                self.editing_server = false;
            }
            Msg::ConfigSaved(Err(err)) => self.login_error = Some(err),
            Msg::LoggedIn(user) => {
                self.login_error = None;
                self.username = user.username;
                self.send(Command::RefreshDevices);
            }
            Msg::LoginFailed(err) => self.login_error = Some(err),
            Msg::WizardAdvanced => {
                self.wizard_step = crate::ui::wizard::next_step(self.wizard_step);
            }
            Msg::WizardCompleted => self.state.mark_wizard_completed(),
            Msg::AutostartToggled(ok) => self.autostart_enabled = ok,
            Msg::DevicesLoaded(Ok(devices)) => self.devices = devices,
            Msg::DevicesLoaded(Err(err)) => self.login_error = Some(err),
            Msg::DeviceRegistered(Ok(_)) | Msg::DeviceDeleted(Ok(_)) => {
                self.send(Command::RefreshDevices)
            }
            Msg::DeviceRegistered(Err(err)) | Msg::DeviceDeleted(Err(err)) => {
                self.login_error = Some(err)
            }
            Msg::FleetChanged => self.send(Command::RefreshDevices),
            Msg::UpdateChecked(Ok(Some(info))) => self.available_update = Some(info),
            Msg::UpdateChecked(Ok(None)) => self.available_update = None,
            Msg::UpdateChecked(Err(err)) | Msg::UpdateApplied(Err(err)) => {
                self.login_error = Some(err)
            }
            Msg::UpdateApplied(Ok(())) => {}
            Msg::AgentStarted(Ok(())) => {}
            Msg::AgentStarted(Err(err)) | Msg::AgentStopped(Err(err)) => {
                self.login_error = Some(err)
            }
            Msg::AgentStopped(Ok(())) => {}
            Msg::Tray(req) => match req {
                TrayRequest::StartAgent => self.send(Command::StartAgent),
                TrayRequest::StopAgent => self.send(Command::StopAgent),
                TrayRequest::OpenWindow => self.show_window = true,
                TrayRequest::ToggleAutostart => {
                    let next = !self.autostart_enabled;
                    self.send(Command::SetAutostart { enabled: next });
                }
                TrayRequest::Quit => self.send(Command::Quit),
            },
        }
    }
}

impl eframe::App for App {
    fn logic(&mut self, _ctx: &egui::Context, _frame: &mut eframe::Frame) {
        while let Ok(msg) = self.rx.try_recv() {
            self.handle_msg(msg);
        }
    }

    fn ui(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
        let close_requested = ui.ctx().input(|i| i.viewport().close_requested());
        if close_requested && crate::tray::should_hide_on_close(self.tray_active) {
            ui.ctx()
                .send_viewport_cmd(egui::ViewportCommand::CancelClose);
            ui.ctx()
                .send_viewport_cmd(egui::ViewportCommand::Visible(false));
        }

        if self.show_window {
            self.show_window = false;
            ui.ctx()
                .send_viewport_cmd(egui::ViewportCommand::Visible(true));
            ui.ctx().send_viewport_cmd(egui::ViewportCommand::Focus);
        }

        self.screen = if self.showing_settings {
            Screen::Settings
        } else {
            crate::ui::route(&self.state, self.editing_server)
        };
        crate::theme::apply(ui.ctx(), self.state.theme.lock().unwrap().as_deref());
        egui::CentralPanel::default().show(ui, |ui| {
            crate::ui::render(self, ui);
        });
    }
}
