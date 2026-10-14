//! Devices: list registered devices, register this one, delete.

use crate::app::{App, Command};
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

pub fn render(app: &mut App, ui: &mut egui::Ui) {
    let avail_width = ui.available_width();
    let container_width = 800.0f32.min(avail_width - 32.0).max(300.0);
    let h_margin = ((avail_width - container_width) / 2.0).max(16.0);

    egui::ScrollArea::vertical()
        .auto_shrink([false, false])
        .show(ui, |ui| {
            ui.add_space(20.0);
            ui.horizontal(|ui| {
                ui.add_space(h_margin);
                ui.vertical(|ui| {
                    ui.set_width(container_width);

                    // Top Bar
                    ui.horizontal(|ui| {
                        ui.vertical(|ui| {
                            ui.add(egui::Label::new(
                                egui::RichText::new("Devices")
                                    .size(24.0)
                                    .strong()
                                    .color(ui.visuals().strong_text_color()),
                            ));
                            ui.add(egui::Label::new(
                                egui::RichText::new(format!("Signed in as {}", app.username))
                                    .size(13.0)
                                    .color(ui.visuals().text_color().gamma_multiply(0.7)),
                            ));
                        });

                        ui.with_layout(
                            egui::Layout::right_to_left(egui::Align::Center),
                            |ui| {
                                if ui
                                    .add(egui::Button::new("Log out").corner_radius(
                                        egui::CornerRadius::same(6),
                                    ))
                                    .clicked()
                                {
                                    app.send(Command::Logout);
                                }

                                if ui
                                    .add(egui::Button::new("Settings").corner_radius(
                                        egui::CornerRadius::same(6),
                                    ))
                                    .clicked()
                                {
                                    app.showing_settings = true;
                                }

                                // Live runtime-status indicator
                                let (agent_status, is_online) = {
                                    let guard = app.agent.lock().unwrap();
                                    match &*guard {
                                        Some(handle) => match handle.status() {
                                            ponter_agent::RuntimeStatus::Connected => {
                                                ("connected", true)
                                            }
                                            ponter_agent::RuntimeStatus::Disconnected => {
                                                ("disconnected", false)
                                            }
                                            ponter_agent::RuntimeStatus::Stopped => {
                                                ("stopped", false)
                                            }
                                        },
                                        None => ("unknown", false),
                                    }
                                };
                                crate::ui::components::status_badge(
                                    ui,
                                    &format!("Agent: {agent_status}"),
                                    is_online,
                                );
                            },
                        );
                    });

                    ui.add_space(16.0);

                    if let Some(err) = &app.login_error {
                        crate::ui::components::error_banner(ui, err);
                        ui.add_space(16.0);
                    }

                    // Card 1: Registration & Capabilities
                    egui::Frame::new()
                        .fill(ui.visuals().window_fill)
                        .stroke(ui.visuals().window_stroke)
                        .corner_radius(ui.visuals().window_corner_radius)
                        .inner_margin(egui::Margin::same(18))
                        .show(ui, |ui| {
                            ui.add(egui::Label::new(
                                egui::RichText::new("Register This Device")
                                    .size(16.0)
                                    .strong()
                                    .color(ui.visuals().strong_text_color()),
                            ));
                            ui.add(egui::Label::new(
                                egui::RichText::new(
                                    "Select capabilities to advertise to other operators in your fleet.",
                                )
                                .size(12.0)
                                .color(ui.visuals().text_color().gamma_multiply(0.7)),
                            ));
                            ui.add_space(12.0);

                            ui.horizontal(|ui| {
                                for cap in ["terminal", "desktop", "files"] {
                                    let mut on =
                                        app.register_capabilities.iter().any(|c| c == cap);
                                    if ui
                                        .checkbox(
                                            &mut on,
                                            egui::RichText::new(cap).size(13.0),
                                        )
                                        .changed()
                                    {
                                        if on {
                                            app.register_capabilities.push(cap.to_string());
                                        } else {
                                            app.register_capabilities.retain(|c| c != cap);
                                        }
                                    }
                                    ui.add_space(8.0);
                                }
                            });

                            ui.add_space(14.0);
                            if ui
                                .add(
                                    egui::Button::new(
                                        egui::RichText::new("Register this device").strong(),
                                    )
                                    .corner_radius(egui::CornerRadius::same(6)),
                                )
                                .clicked()
                            {
                                app.send(Command::RegisterDevice {
                                    capabilities: app.register_capabilities.clone(),
                                });
                            }
                        });

                    ui.add_space(20.0);

                    // Delete confirmation banner
                    if let Some(id) = app.pending_delete.clone() {
                        egui::Frame::new()
                            .fill(egui::Color32::from_rgba_unmultiplied(239, 68, 68, 20))
                            .stroke(egui::Stroke::new(1.0, egui::Color32::from_rgb(239, 68, 68)))
                            .corner_radius(egui::CornerRadius::same(8))
                            .inner_margin(egui::Margin::same(14))
                            .show(ui, |ui| {
                                ui.horizontal(|ui| {
                                    ui.add(egui::Label::new(
                                        egui::RichText::new(format!(
                                            "Are you sure you want to delete device {id}?"
                                        ))
                                        .strong()
                                        .color(egui::Color32::from_rgb(239, 68, 68)),
                                    ));
                                    ui.add_space(16.0);
                                    if ui
                                        .add(
                                            egui::Button::new(
                                                egui::RichText::new("Confirm delete")
                                                    .strong()
                                                    .color(egui::Color32::WHITE),
                                            )
                                            .fill(egui::Color32::from_rgb(220, 38, 38)),
                                        )
                                        .clicked()
                                    {
                                        app.pending_delete = None;
                                        app.send(Command::DeleteDevice { id });
                                    }
                                    if ui.button("Cancel").clicked() {
                                        app.pending_delete = None;
                                    }
                                });
                            });
                        ui.add_space(16.0);
                    }

                    // Card 2: Devices List
                    ui.horizontal(|ui| {
                        ui.add(egui::Label::new(
                            egui::RichText::new(format!(
                                "Registered Devices ({})",
                                app.devices.len()
                            ))
                            .size(16.0)
                            .strong()
                            .color(ui.visuals().strong_text_color()),
                        ));
                        ui.with_layout(
                            egui::Layout::right_to_left(egui::Align::Center),
                            |ui| {
                                if ui
                                    .add(egui::Button::new("Refresh").corner_radius(
                                        egui::CornerRadius::same(6),
                                    ))
                                    .clicked()
                                {
                                    app.send(Command::RefreshDevices);
                                }
                            },
                        );
                    });
                    ui.add_space(8.0);

                    if app.devices.is_empty() {
                        egui::Frame::new()
                            .fill(ui.visuals().faint_bg_color)
                            .stroke(ui.visuals().widgets.noninteractive.bg_stroke)
                            .corner_radius(ui.visuals().window_corner_radius)
                            .inner_margin(egui::Margin::same(32))
                            .show(ui, |ui| {
                                ui.vertical_centered(|ui| {
                                    ui.add(egui::Label::new(
                                        egui::RichText::new("No devices registered yet")
                                            .size(15.0)
                                            .strong(),
                                    ));
                                    ui.add_space(4.0);
                                    ui.add(egui::Label::new(
                                        egui::RichText::new(
                                            "Click 'Register this device' above to register your \
                                             desktop client with the server.",
                                        )
                                        .color(ui.visuals().text_color().gamma_multiply(0.7)),
                                    ));
                                });
                            });
                    } else {
                        for device in app.devices.clone() {
                            egui::Frame::new()
                                .fill(ui.visuals().window_fill)
                                .stroke(ui.visuals().window_stroke)
                                .corner_radius(egui::CornerRadius::same(8))
                                .inner_margin(egui::Margin::same(14))
                                .show(ui, |ui| {
                                    ui.horizontal(|ui| {
                                        ui.vertical(|ui| {
                                            ui.horizontal(|ui| {
                                                ui.add(egui::Label::new(
                                                    egui::RichText::new(&device.hostname)
                                                        .size(15.0)
                                                        .strong()
                                                        .color(
                                                            ui.visuals().strong_text_color(),
                                                        ),
                                                ));
                                                ui.add(egui::Label::new(
                                                    egui::RichText::new(format!(
                                                        "[{}]",
                                                        device.platform
                                                    ))
                                                    .size(12.0)
                                                    .monospace()
                                                    .color(
                                                        ui.visuals()
                                                            .text_color()
                                                            .gamma_multiply(0.6),
                                                    ),
                                                ));
                                                crate::ui::components::status_badge(
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
                                                ui.add(egui::Label::new(
                                                    egui::RichText::new(format!(
                                                        "id: {}",
                                                        device.id
                                                    ))
                                                    .size(11.0)
                                                    .monospace()
                                                    .color(
                                                        ui.visuals()
                                                            .text_color()
                                                            .gamma_multiply(0.6),
                                                    ),
                                                ));
                                                ui.add_space(8.0);
                                                ui.add(egui::Label::new(
                                                    egui::RichText::new(format!(
                                                        "created: {}",
                                                        device.created_at
                                                    ))
                                                    .size(11.0)
                                                    .color(
                                                        ui.visuals()
                                                            .text_color()
                                                            .gamma_multiply(0.6),
                                                    ),
                                                ));
                                            });
                                        });

                                        ui.with_layout(
                                            egui::Layout::right_to_left(egui::Align::Center),
                                            |ui| {
                                                if ui
                                                    .add(
                                                        egui::Button::new(
                                                            egui::RichText::new("Delete")
                                                                .size(12.0)
                                                                .color(
                                                                    egui::Color32::from_rgb(
                                                                        239, 68, 68,
                                                                    ),
                                                                ),
                                                        )
                                                        .corner_radius(
                                                            egui::CornerRadius::same(6),
                                                        ),
                                                    )
                                                    .clicked()
                                                {
                                                    app.pending_delete =
                                                        Some(device.id.clone());
                                                }
                                            },
                                        );
                                    });
                                });
                            ui.add_space(8.0);
                        }
                    }

                    ui.add_space(20.0);
                });
                ui.add_space(h_margin);
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
