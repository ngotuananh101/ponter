//! Server Setup: enter the server URL, probe `/health`, then persist.

use crate::app::{App, Command, Msg};
use crate::ui::components;
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
    components::centered_card(ui, 440.0, |ui| {
        let is_editing = app.editing_server;
        let title = if is_editing {
            "Edit server URL"
        } else {
            "Connect to your server"
        };
        let subtitle = if is_editing {
            "Update the address of your Ponter server instance"
        } else {
            "Enter the base URL of your Ponter server instance to get started"
        };
        components::card_header(ui, title, Some(subtitle));

        components::field_label(ui, "Server URL");
        let mut url = app.server_url_input.clone();
        if components::text_input(ui, &mut url, "http://localhost:8787 or https://...", false)
            .changed()
        {
            app.server_url_input = url;
        }
        ui.add_space(16.0);

        // Action buttons: Test (secondary) on the left, Connect (primary) on the right.
        ui.horizontal(|ui| {
            let gap = 8.0;
            let half = (ui.available_width() - gap) / 2.0;
            let test_clicked = ui
                .add_sized(
                    [half, components::CONTROL_HEIGHT],
                    egui::Button::new("Test connection"),
                )
                .clicked();
            let save_clicked = components::primary_button(ui, "Save and continue").clicked();

            // Validate once for both actions and surface the failure inline.
            // Checking `validate(..).is_ok()` without an else branch left the
            // button dead and the UI silent on an invalid URL.
            if test_clicked || save_clicked {
                match validate(&app.server_url_input) {
                    Ok(()) => {
                        app.login_error = None;
                        if test_clicked {
                            app.send(Command::ProbeServer {
                                url: app.server_url_input.clone(),
                            });
                        }
                        if save_clicked {
                            app.send(Command::SaveServer {
                                url: app.server_url_input.clone(),
                            });
                        }
                    }
                    Err(err) => app.login_error = Some(err),
                }
            }
        });

        // Cancel / Back button if editing
        if is_editing {
            ui.add_space(8.0);
            if components::secondary_button(ui, "Back").clicked() {
                app.editing_server = false;
            }
        }

        if let Some(Msg::ServerProbed(res)) = app.last_probe.as_ref() {
            ui.add_space(16.0);
            if res.ok {
                components::success_banner(ui, &res.message);
            } else {
                components::error_banner(ui, &res.message);
            }
        }

        // The `SaveServer` arm reports through `Msg::ConfigSaved`; the fold stores a
        // failure in the shell's single inline-error slot (`login_error`).
        if let Some(err) = &app.login_error {
            ui.add_space(16.0);
            components::error_banner(ui, err);
        }
    });
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
