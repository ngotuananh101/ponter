//! Settings: theme, autostart, allow-input, update, server edit.

use crate::app::{App, Command};
use eframe::egui;

pub fn autostart_label(enabled: bool) -> &'static str {
    if enabled {
        "Enabled"
    } else {
        "Disabled"
    }
}

pub fn render(app: &mut App, ui: &mut egui::Ui) {
    ui.heading("Settings");
    if ui.button("Back").clicked() {
        app.showing_settings = false;
        app.editing_server = false;
    }

    // Server URL: edit + re-probe (spec §5.2).
    ui.horizontal(|ui| {
        let mut url = app.server_url_input.clone();
        if ui.text_edit_singleline(&mut url).changed() {
            app.server_url_input = url;
        }
        if ui.button("Re-probe").clicked() {
            app.send(Command::ProbeServer {
                url: app.server_url_input.clone(),
            });
        }
        // "Edit server" returns to the full Server Setup screen (the router's
        // manual override), where the URL is edited and re-probed.
        if ui.button("Edit server").clicked() {
            app.showing_settings = false;
            app.editing_server = true;
        }
    });

    // Theme (light/dark) — a second control surface for the stored preference.
    ui.horizontal(|ui| {
        if ui.button("Light").clicked() {
            app.send(Command::SetTheme {
                theme: "light".to_string(),
            });
        }
        if ui.button("Dark").clicked() {
            app.send(Command::SetTheme {
                theme: "dark".to_string(),
            });
        }
    });

    let mut autostart = app.autostart_enabled;
    if ui.checkbox(&mut autostart, "Start on login").changed() {
        app.send(Command::SetAutostart { enabled: autostart });
    }
    // Allow-input toggle (owner decision, spec §5.2): the SAME `allow_input`
    // preference the wizard sets — a second control surface, not a second gate.
    let mut allow_input = app.allow_input;
    if ui
        .checkbox(&mut allow_input, "Allow remote input")
        .changed()
    {
        app.send(Command::ToggleAllowInput {
            enabled: allow_input,
        });
    }

    ui.label(format!("Version {}", env!("CARGO_PKG_VERSION")));
    if ui.button("Check for updates").clicked() {
        app.send(Command::CheckUpdate);
    }
    // Surfaced after `Msg::UpdateChecked(Ok(Some(..)))` folds in: the operator
    // must opt in before the binary is replaced (guard (b)/(c)).
    if let Some(info) = &app.available_update {
        ui.label(format!("Update available: {}", info.version));
        if ui.button("Install update").clicked() {
            app.send(Command::ApplyUpdate);
        }
    }
    if ui.button("Log out").clicked() {
        app.send(Command::Logout);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn autostart_label_reflects_state() {
        assert_eq!(autostart_label(true), "Enabled");
        assert_eq!(autostart_label(false), "Disabled");
    }
}
