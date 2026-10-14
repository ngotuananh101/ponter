//! Devices: list registered devices, register this one, delete.

use crate::app::{App, Command};
use crate::ui::components;
use eframe::egui;

/// Map a server device status to a display label.
pub fn status_label(status: &str) -> &'static str {
    match status {
        "online" => "Online",
        "offline" => "Offline",
        "pending" => "Pending approval",
        _ => "Unknown",
    }
}

/// Live agent runtime status for the Machine strip: `(label, online)`.
fn agent_status(app: &App) -> (&'static str, bool) {
    let guard = app.agent.lock().unwrap();
    match &*guard {
        Some(handle) => match handle.status() {
            ponter_agent::RuntimeStatus::Connected => ("Agent connected", true),
            ponter_agent::RuntimeStatus::Disconnected => ("Agent offline", false),
            ponter_agent::RuntimeStatus::Stopped => ("Agent stopped", false),
        },
        None => ("Agent stopped", false),
    }
}

pub fn render(app: &mut App, ui: &mut egui::Ui) {
    let (agent_label, agent_online) = agent_status(app);
    let hostname = app.machine_hostname.clone();
    let platform = app.machine_platform.clone();
    let capture = app.capture_probe_ok;
    let input = app.allow_input;

    components::page(ui, 760.0, |ui| {
        // Signature element: which machine is this, and is it controllable?
        components::machine_strip(
            ui,
            &hostname,
            &platform,
            agent_label,
            agent_online,
            &[("capture", capture), ("input", input)],
        );
        ui.add_space(20.0);

        // Page header (outside any card) with the session actions on the right.
        ui.horizontal(|ui| {
            ui.vertical(|ui| {
                components::page_title(
                    ui,
                    "Devices",
                    Some(&format!("Signed in as {}", app.username)),
                );
            });
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                if components::danger_button(ui, "Log out").clicked() {
                    app.send(Command::Logout);
                }
                if components::ghost_button(ui, "Settings").clicked() {
                    app.showing_settings = true;
                }
                if components::ghost_button(ui, "Refresh").clicked() {
                    app.send(Command::RefreshDevices);
                }
            });
        });
        ui.add_space(16.0);

        if let Some(err) = &app.login_error {
            components::error_banner(ui, err);
            ui.add_space(16.0);
        }

        // Card 1: Registration & Capabilities
        components::card(ui, |ui| {
            components::card_header(
                ui,
                "This device",
                Some("Choose the capabilities to advertise to other operators in your fleet."),
            );

            ui.horizontal(|ui| {
                for cap in ["terminal", "desktop", "files"] {
                    let mut on = app.register_capabilities.iter().any(|c| c == cap);
                    if ui
                        .checkbox(&mut on, egui::RichText::new(cap).size(13.0))
                        .changed()
                    {
                        if on {
                            app.register_capabilities.push(cap.to_string());
                        } else {
                            app.register_capabilities.retain(|c| c != cap);
                        }
                    }
                    ui.add_space(12.0);
                }
            });

            ui.add_space(16.0);
            if components::primary_button(ui, "Register this device").clicked() {
                app.send(Command::RegisterDevice {
                    capabilities: app.register_capabilities.clone(),
                });
            }
        });

        ui.add_space(16.0);

        // Delete confirmation banner
        if let Some(id) = app.pending_delete.clone() {
            confirm_delete_banner(ui, app, &id);
            ui.add_space(16.0);
        }

        // Card 2: Fleet list
        ui.horizontal(|ui| {
            components::section_label(ui, &format!("Fleet · {} devices", app.devices.len()));
        });
        ui.add_space(8.0);

        if app.devices.is_empty() {
            components::card(ui, |ui| {
                ui.vertical_centered(|ui| {
                    ui.add_space(8.0);
                    ui.add(egui::Label::new(
                        egui::RichText::new("No devices registered yet")
                            .size(15.0)
                            .strong()
                            .color(components::Tokens::of(ui).ink),
                    ));
                    ui.add_space(4.0);
                    components::muted_text(
                        ui,
                        "Register this device above to bring your machine into the fleet.",
                    );
                    ui.add_space(8.0);
                });
            });
        } else {
            for device in app.devices.clone() {
                device_row(ui, app, &device);
                ui.add_space(8.0);
            }
        }
    });
}

fn confirm_delete_banner(ui: &mut egui::Ui, app: &mut App, id: &str) {
    let t = components::Tokens::of(ui);
    egui::Frame::new()
        .fill(t.danger.gamma_multiply(0.12))
        .stroke(egui::Stroke::new(1.0, t.danger.gamma_multiply(0.6)))
        .corner_radius(egui::CornerRadius::same(10))
        .inner_margin(egui::Margin::same(14))
        .show(ui, |ui| {
            ui.set_width(ui.available_width());
            ui.horizontal(|ui| {
                ui.add(egui::Label::new(
                    egui::RichText::new(format!("Delete device {id}?"))
                        .strong()
                        .color(t.danger),
                ));
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    if ui
                        .add(
                            egui::Button::new(
                                egui::RichText::new("Confirm delete")
                                    .strong()
                                    .color(t.accent_fg),
                            )
                            .fill(t.danger)
                            .stroke(egui::Stroke::NONE)
                            .corner_radius(egui::CornerRadius::same(8)),
                        )
                        .clicked()
                    {
                        app.pending_delete = None;
                        app.send(Command::DeleteDevice { id: id.to_string() });
                    }
                    if components::ghost_button(ui, "Cancel").clicked() {
                        app.pending_delete = None;
                    }
                });
            });
        });
}

fn device_row(ui: &mut egui::Ui, app: &mut App, device: &crate::core::devices::DesktopDevice) {
    let t = components::Tokens::of(ui);
    egui::Frame::new()
        .fill(t.surface)
        .stroke(egui::Stroke::new(1.0, t.line))
        .corner_radius(egui::CornerRadius::same(10))
        .inner_margin(egui::Margin::symmetric(16, 14))
        .show(ui, |ui| {
            ui.set_width(ui.available_width());
            ui.horizontal(|ui| {
                ui.vertical(|ui| {
                    ui.horizontal(|ui| {
                        ui.spacing_mut().item_spacing.x = 7.0;
                        ui.add(egui::Label::new(
                            egui::RichText::new(&device.hostname)
                                .size(15.0)
                                .strong()
                                .color(t.ink),
                        ));
                        ui.add(egui::Label::new(
                            egui::RichText::new("·").size(13.0).color(t.muted),
                        ));
                        ui.add(egui::Label::new(
                            egui::RichText::new(&device.platform)
                                .size(12.0)
                                .monospace()
                                .color(t.muted),
                        ));
                        ui.add_space(4.0);
                        components::status_badge(
                            ui,
                            status_label(if device.is_online {
                                "online"
                            } else {
                                "offline"
                            }),
                            device.is_online,
                        );
                    });
                    ui.add_space(4.0);
                    ui.horizontal(|ui| {
                        components::mono_id(ui, &format!("id {}", device.id), 11.0);
                        ui.add(egui::Label::new(
                            egui::RichText::new("·").size(11.0).color(t.muted),
                        ));
                        components::muted_text(ui, &format!("created {}", device.created_at));
                    });
                });

                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    if components::danger_button(ui, "Delete").clicked() {
                        app.pending_delete = Some(device.id.clone());
                    }
                });
            });
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_label_maps_known_statuses() {
        assert_eq!(status_label("online"), "Online");
        assert_eq!(status_label("offline"), "Offline");
        assert_eq!(status_label("pending"), "Pending approval");
    }

    #[test]
    fn status_label_unknown_falls_back() {
        assert_eq!(status_label("weird"), "Unknown");
    }
}
