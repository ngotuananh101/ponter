//! Settings: theme, autostart, allow-input, update, server edit.

use crate::app::{App, Command};
use crate::ui::components;
use eframe::egui;

pub fn autostart_label(enabled: bool) -> &'static str {
    if enabled {
        "Enabled"
    } else {
        "Disabled"
    }
}

/// A settings section: an inset card with a title and its contents.
fn section<R>(ui: &mut egui::Ui, title: &str, add_contents: impl FnOnce(&mut egui::Ui) -> R) -> R {
    components::inset(ui, |ui| {
        components::section_label(ui, title);
        ui.add_space(10.0);
        add_contents(ui)
    })
}

pub fn render(app: &mut App, ui: &mut egui::Ui) {
    let t = components::Tokens::of(ui);

    components::page(ui, 560.0, |ui| {
        if components::ghost_button(ui, "← Back").clicked() {
            app.showing_settings = false;
            app.editing_server = false;
        }
        ui.add_space(8.0);
        components::page_title(
            ui,
            "Settings",
            Some("Desktop client preferences, appearance, and system integration"),
        );
        ui.add_space(16.0);

        // Section 1: Server Configuration
        section(ui, "Server connection", |ui| {
            let mut url = app.server_url_input.clone();
            if components::text_input(ui, &mut url, "Server URL", false).changed() {
                app.server_url_input = url;
            }
            ui.add_space(10.0);
            ui.horizontal(|ui| {
                if components::secondary_button(ui, "Re-probe").clicked() {
                    app.send(Command::ProbeServer {
                        url: app.server_url_input.clone(),
                    });
                }
                if components::ghost_button(ui, "Edit server").clicked() {
                    app.showing_settings = false;
                    app.editing_server = true;
                }
            });
        });

        ui.add_space(14.0);

        // Section 2: Appearance & Theme
        section(ui, "Appearance", |ui| {
            let current_theme = app
                .state
                .theme
                .lock()
                .unwrap()
                .clone()
                .unwrap_or_else(|| "light".to_string());

            ui.horizontal(|ui| {
                let is_light = current_theme == "light";
                let is_dark = current_theme == "dark";

                if theme_button(ui, "Light", is_light, t).clicked() {
                    app.send(Command::SetTheme {
                        theme: "light".to_string(),
                    });
                }
                if theme_button(ui, "Dark", is_dark, t).clicked() {
                    app.send(Command::SetTheme {
                        theme: "dark".to_string(),
                    });
                }
            });
        });

        ui.add_space(14.0);

        // Section 3: System & Input Preferences
        section(ui, "System & remote access", |ui| {
            let mut autostart = app.autostart_enabled;
            let a = components::pref_row(
                ui,
                "Start on login",
                "Launch the agent automatically when you log in.",
                |ui| ui.checkbox(&mut autostart, "").changed(),
            );
            if a {
                app.send(Command::SetAutostart { enabled: autostart });
            }
            ui.add_space(8.0);

            let mut allow_input = app.allow_input;
            let b = components::pref_row(
                ui,
                "Allow remote input",
                "Let remote operators control this machine.",
                |ui| ui.checkbox(&mut allow_input, "").changed(),
            );
            if b {
                app.send(Command::ToggleAllowInput {
                    enabled: allow_input,
                });
            }
        });

        ui.add_space(14.0);

        // Section 4: Updates & App Info
        section(ui, "App information", |ui| {
            ui.horizontal(|ui| {
                components::mono_id(ui, &format!("v{}", env!("CARGO_PKG_VERSION")), 12.0);
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    if components::ghost_button(ui, "Check for updates").clicked() {
                        app.send(Command::CheckUpdate);
                    }
                });
            });

            if let Some(info) = &app.available_update {
                ui.add_space(10.0);
                components::info_banner(ui, &format!("Update available: {}", info.version));
                ui.add_space(8.0);
                if components::secondary_button(ui, "Install update").clicked() {
                    app.send(Command::ApplyUpdate);
                }
            }
        });

        ui.add_space(20.0);

        // Logout
        if components::danger_button(ui, "Log out").clicked() {
            app.send(Command::Logout);
        }
    });
}

/// A theme-choice toggle button that shows a check when selected.
fn theme_button(
    ui: &mut egui::Ui,
    label: &str,
    selected: bool,
    t: components::Tokens,
) -> egui::Response {
    let text = if selected {
        format!("✓ {label}")
    } else {
        label.to_string()
    };
    let (fill, stroke, fg) = if selected {
        (t.accent, egui::Stroke::NONE, t.accent_fg)
    } else {
        (t.surface, egui::Stroke::new(1.0, t.line_strong), t.ink)
    };
    ui.add_sized(
        [96.0, 32.0],
        egui::Button::new(egui::RichText::new(text).size(13.0).color(fg))
            .fill(fill)
            .stroke(stroke)
            .corner_radius(egui::CornerRadius::same(8)),
    )
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
