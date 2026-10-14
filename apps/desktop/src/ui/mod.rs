//! The screen router and the per-screen render dispatch. The gate order mirrors
//! the Vue `App.vue`: server setup -> login -> wizard -> devices, with the
//! Settings screen reachable as a manual override.

pub mod components;
pub mod devices;
pub mod login;
pub mod server_setup;
pub mod settings;
pub mod wizard;

use crate::app::{App, Screen};
use crate::core::state::CoreState;
use eframe::egui;

/// The screen the shell shows this frame. `editing_server` is the manual
/// override that returns to Server Setup from Settings.
pub fn route(state: &CoreState, editing_server: bool) -> Screen {
    if !state.has_server_url() || editing_server {
        Screen::ServerSetup
    } else if state.access_token.lock().unwrap().is_none() {
        Screen::Login
    } else if !state.wizard_completed() {
        Screen::Wizard
    } else {
        Screen::Devices
    }
}

/// Render the current screen.
pub fn render(app: &mut App, ui: &mut egui::Ui) {
    match app.screen {
        Screen::ServerSetup => server_setup::render(app, ui),
        Screen::Login => login::render(app, ui),
        Screen::Wizard => wizard::render(app, ui),
        Screen::Devices => devices::render(app, ui),
        Screen::Settings => settings::render(app, ui),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn route_follows_gate_order() {
        // Walk the gate order from the spec (§5.2): the router picks the first
        // screen whose condition is unmet.
        let state = CoreState::with_config(None);
        // 1. No server URL -> Server Setup (the manual override also wins).
        assert_eq!(route(&state, false), Screen::ServerSetup);
        assert_eq!(route(&state, true), Screen::ServerSetup);

        // 2. A server URL but no token -> Login.
        state.set_has_server_url(true);
        assert_eq!(route(&state, false), Screen::Login);

        // 3. Authenticated but the wizard has not completed -> Wizard.
        *state.access_token.lock().unwrap() = Some("tok".to_string());
        assert_eq!(route(&state, false), Screen::Wizard);

        // 4. Authenticated and the wizard done -> Devices.
        state.mark_wizard_completed();
        assert_eq!(route(&state, false), Screen::Devices);

        // The manual override still returns to Server Setup from any later screen.
        assert_eq!(route(&state, true), Screen::ServerSetup);
    }
}
