//! Server Setup: enter the server URL, probe `/health`, then persist.

use crate::app::{App, Command, Msg};
use eframe::egui;

/// Validate a server URL before probing.
pub fn validate(url: &str) -> Result<(), String> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return Err("Server URL is required".into());
    }
    if !(trimmed.starts_with("http://") || trimmed.starts_with("https://")) {
        return Err("Server URL must start with http:// or https://".into());
    }
    Ok(())
}

pub fn render(app: &mut App, ui: &mut egui::Ui) {
    ui.heading("Connect to your server");
    let mut url = app.server_url_input.clone();
    if ui.text_edit_singleline(&mut url).changed() {
        app.server_url_input = url;
    }
    if ui.button("Test connection").clicked() && validate(&app.server_url_input).is_ok() {
        app.send(Command::ProbeServer {
            url: app.server_url_input.clone(),
        });
    }
    if let Some(Msg::ServerProbed(res)) = app.last_probe.as_ref() {
        ui.colored_label(
            if res.ok {
                egui::Color32::GREEN
            } else {
                egui::Color32::RED
            },
            &res.message,
        );
    }
    if ui.button("Save and continue").clicked() && validate(&app.server_url_input).is_ok() {
        app.send(Command::SaveServer {
            url: app.server_url_input.clone(),
        });
    }
    // The `SaveServer` arm reports through `Msg::ConfigSaved`; the fold stores a
    // failure in the shell's single inline-error slot (`login_error`).
    if let Some(err) = &app.login_error {
        ui.colored_label(egui::Color32::RED, err);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn server_setup_rejects_empty() {
        assert!(validate("").is_err());
        assert!(validate("   ").is_err());
    }

    #[test]
    fn server_setup_rejects_no_scheme() {
        assert!(validate("host:8787").is_err());
    }

    #[test]
    fn server_setup_accepts_http() {
        assert!(validate("http://localhost:8787").is_ok());
    }

    #[test]
    fn server_setup_accepts_https() {
        assert!(validate("https://example.com").is_ok());
    }

    #[test]
    fn server_setup_trims_whitespace() {
        assert!(validate("  https://example.com  ").is_ok());
    }
}
