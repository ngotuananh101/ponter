//! Login: username + password, dispatched as `Command::Login`.

use crate::app::{App, Command};
use eframe::egui;

pub fn validate(username: &str, password: &str) -> Result<(), String> {
    if username.trim().is_empty() {
        return Err("Username is required".into());
    }
    if password.is_empty() {
        return Err("Password is required".into());
    }
    Ok(())
}

pub fn render(app: &mut App, ui: &mut egui::Ui) {
    crate::ui::components::centered_card(ui, 400.0, |ui| {
        crate::ui::components::card_header(
            ui,
            "Sign in",
            Some("Enter your credentials to access your fleet"),
        );

        // Server connection indicator
        let server_url = app.state.server_url.lock().unwrap().clone();
        ui.horizontal(|ui| {
            ui.add(egui::Label::new(
                egui::RichText::new("Server:")
                    .size(12.0)
                    .color(ui.visuals().weak_text_color()),
            ));
            ui.add(egui::Label::new(
                egui::RichText::new(&server_url).size(12.0).monospace(),
            ));
            if ui
                .add(egui::Button::new(egui::RichText::new("Change").size(11.0)))
                .clicked()
            {
                app.editing_server = true;
                app.server_url_input = server_url;
            }
        });
        ui.add_space(16.0);

        crate::ui::components::field_label(ui, "Username");
        let username_res =
            crate::ui::components::text_input(ui, &mut app.username_input, "Enter username", false);
        ui.add_space(12.0);

        crate::ui::components::field_label(ui, "Password");
        let password_res =
            crate::ui::components::text_input(ui, &mut app.password_input, "Enter password", true);
        ui.add_space(20.0);

        let enter_pressed = (username_res.lost_focus() || password_res.lost_focus())
            && ui.input(|i| i.key_pressed(egui::Key::Enter));

        let should_submit =
            crate::ui::components::primary_button(ui, "Sign in").clicked() || enter_pressed;

        if should_submit {
            match validate(&app.username_input, &app.password_input) {
                Ok(()) => {
                    app.send(Command::Login {
                        username: app.username_input.trim().to_string(),
                        password: app.password_input.clone(),
                    });
                }
                Err(err) => {
                    app.login_error = Some(err);
                }
            }
        }

        if let Some(err) = &app.login_error {
            ui.add_space(16.0);
            crate::ui::components::error_banner(ui, err);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn login_rejects_empty_username() {
        assert!(validate("", "pw").is_err());
        assert!(validate("  ", "pw").is_err());
    }

    #[test]
    fn login_rejects_empty_password() {
        assert!(validate("user", "").is_err());
    }

    #[test]
    fn login_accepts_any_non_empty() {
        assert!(validate("user", "pw").is_ok());
    }

    #[test]
    fn login_trims_username() {
        // The render path trims before sending; validate accepts surrounding
        // whitespace as long as the trimmed value is non-empty.
        assert!(validate("  user  ", "pw").is_ok());
    }
}
