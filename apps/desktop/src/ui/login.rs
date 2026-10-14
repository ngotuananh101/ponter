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
    ui.heading("Sign in");
    ui.text_edit_singleline(&mut app.username_input);
    ui.add(egui::TextEdit::singleline(&mut app.password_input).password(true));
    if ui.button("Sign in").clicked() && validate(&app.username_input, &app.password_input).is_ok()
    {
        app.send(Command::Login {
            username: app.username_input.trim().to_string(),
            password: app.password_input.clone(),
        });
    }
    if let Some(err) = &app.login_error {
        ui.colored_label(egui::Color32::RED, err);
    }
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
