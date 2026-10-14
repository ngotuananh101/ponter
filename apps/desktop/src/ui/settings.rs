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
    crate::ui::components::centered_card(ui, 540.0, |ui| {
        ui.horizontal(|ui| {
            if ui
                .add(egui::Button::new("← Back").corner_radius(egui::CornerRadius::same(6)))
                .clicked()
            {
                app.showing_settings = false;
                app.editing_server = false;
            }
        });
        ui.add_space(8.0);

        crate::ui::components::card_header(
            ui,
            "Settings",
            Some("Configure desktop client preferences, appearance, and system integration"),
        );

        // Section 1: Server Configuration
        egui::Frame::new()
            .fill(ui.visuals().faint_bg_color)
            .stroke(ui.visuals().widgets.noninteractive.bg_stroke)
            .corner_radius(egui::CornerRadius::same(8))
            .inner_margin(egui::Margin::same(14))
            .show(ui, |ui| {
                ui.add(egui::Label::new(
                    egui::RichText::new("Server Connection")
                        .size(14.0)
                        .strong()
                        .color(ui.visuals().strong_text_color()),
                ));
                ui.add_space(8.0);

                let mut url = app.server_url_input.clone();
                if crate::ui::components::text_input(ui, &mut url, "Server URL", false).changed() {
                    app.server_url_input = url;
                }
                ui.add_space(8.0);

                ui.horizontal(|ui| {
                    if ui
                        .add(
                            egui::Button::new("Re-probe")
                                .corner_radius(egui::CornerRadius::same(6)),
                        )
                        .clicked()
                    {
                        app.send(Command::ProbeServer {
                            url: app.server_url_input.clone(),
                        });
                    }
                    if ui
                        .add(
                            egui::Button::new("Edit server")
                                .corner_radius(egui::CornerRadius::same(6)),
                        )
                        .clicked()
                    {
                        app.showing_settings = false;
                        app.editing_server = true;
                    }
                });
            });

        ui.add_space(14.0);

        // Section 2: Appearance & Theme
        egui::Frame::new()
            .fill(ui.visuals().faint_bg_color)
            .stroke(ui.visuals().widgets.noninteractive.bg_stroke)
            .corner_radius(egui::CornerRadius::same(8))
            .inner_margin(egui::Margin::same(14))
            .show(ui, |ui| {
                ui.add(egui::Label::new(
                    egui::RichText::new("Appearance")
                        .size(14.0)
                        .strong()
                        .color(ui.visuals().strong_text_color()),
                ));
                ui.add_space(8.0);

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

                    if ui
                        .add_sized(
                            [80.0, 30.0],
                            egui::Button::new(if is_light { "✓ Light" } else { "Light" })
                                .corner_radius(egui::CornerRadius::same(6)),
                        )
                        .clicked()
                    {
                        app.send(Command::SetTheme {
                            theme: "light".to_string(),
                        });
                    }

                    if ui
                        .add_sized(
                            [80.0, 30.0],
                            egui::Button::new(if is_dark { "✓ Dark" } else { "Dark" })
                                .corner_radius(egui::CornerRadius::same(6)),
                        )
                        .clicked()
                    {
                        app.send(Command::SetTheme {
                            theme: "dark".to_string(),
                        });
                    }
                });
            });

        ui.add_space(14.0);

        // Section 3: System & Input Preferences
        egui::Frame::new()
            .fill(ui.visuals().faint_bg_color)
            .stroke(ui.visuals().widgets.noninteractive.bg_stroke)
            .corner_radius(egui::CornerRadius::same(8))
            .inner_margin(egui::Margin::same(14))
            .show(ui, |ui| {
                ui.add(egui::Label::new(
                    egui::RichText::new("System & Remote Access")
                        .size(14.0)
                        .strong()
                        .color(ui.visuals().strong_text_color()),
                ));
                ui.add_space(8.0);

                let mut autostart = app.autostart_enabled;
                if ui
                    .checkbox(
                        &mut autostart,
                        egui::RichText::new("Start on login").size(13.0),
                    )
                    .changed()
                {
                    app.send(Command::SetAutostart { enabled: autostart });
                }
                ui.add_space(6.0);

                let mut allow_input = app.allow_input;
                if ui
                    .checkbox(
                        &mut allow_input,
                        egui::RichText::new("Allow remote input").size(13.0),
                    )
                    .changed()
                {
                    app.send(Command::ToggleAllowInput {
                        enabled: allow_input,
                    });
                }
            });

        ui.add_space(14.0);

        // Section 4: Updates & App Info
        egui::Frame::new()
            .fill(ui.visuals().faint_bg_color)
            .stroke(ui.visuals().widgets.noninteractive.bg_stroke)
            .corner_radius(egui::CornerRadius::same(8))
            .inner_margin(egui::Margin::same(14))
            .show(ui, |ui| {
                ui.add(egui::Label::new(
                    egui::RichText::new("App Information")
                        .size(14.0)
                        .strong()
                        .color(ui.visuals().strong_text_color()),
                ));
                ui.add_space(6.0);

                ui.horizontal(|ui| {
                    ui.add(egui::Label::new(
                        egui::RichText::new(format!("Version {}", env!("CARGO_PKG_VERSION")))
                            .size(12.0)
                            .color(ui.visuals().weak_text_color()),
                    ));
                    ui.add_space(12.0);
                    if ui
                        .add(
                            egui::Button::new("Check for updates")
                                .corner_radius(egui::CornerRadius::same(6)),
                        )
                        .clicked()
                    {
                        app.send(Command::CheckUpdate);
                    }
                });

                if let Some(info) = &app.available_update {
                    ui.add_space(8.0);
                    ui.horizontal(|ui| {
                        ui.add(egui::Label::new(
                            egui::RichText::new(format!("Update available: {}", info.version))
                                .color(egui::Color32::from_rgb(34, 197, 94))
                                .strong(),
                        ));
                        if ui
                            .add(
                                egui::Button::new("Install update")
                                    .corner_radius(egui::CornerRadius::same(6)),
                            )
                            .clicked()
                        {
                            app.send(Command::ApplyUpdate);
                        }
                    });
                }
            });

        ui.add_space(20.0);

        // Logout
        if ui
            .add(
                egui::Button::new(
                    egui::RichText::new("Log out")
                        .size(13.0)
                        .color(egui::Color32::from_rgb(239, 68, 68)),
                )
                .corner_radius(egui::CornerRadius::same(6)),
            )
            .clicked()
        {
            app.send(Command::Logout);
        }
    });
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
