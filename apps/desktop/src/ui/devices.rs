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
    ui.heading("Devices");
    ui.horizontal(|ui| {
        ui.label(format!("Signed in as {}", app.username));
        if ui.button("Log out").clicked() {
            app.send(Command::Logout);
        }
        // Live runtime-status indicator (spec §5.2): connected / disconnected /
        // stopped / unknown, read from the live handle (no shell-side atomic).
        let agent_status = {
            let guard = app.agent.lock().unwrap();
            match &*guard {
                Some(handle) => match handle.status() {
                    ponter_agent::RuntimeStatus::Connected => "connected",
                    ponter_agent::RuntimeStatus::Disconnected => "disconnected",
                    ponter_agent::RuntimeStatus::Stopped => "stopped",
                },
                None => "unknown",
            }
        };
        ui.label(format!("Agent: {agent_status}"));
        if ui.button("Settings").clicked() {
            app.showing_settings = true;
        }
    });

    ui.separator();
    ui.label("Capabilities for this device");
    for cap in ["terminal", "desktop", "files"] {
        let mut on = app.register_capabilities.iter().any(|c| c == cap);
        if ui.checkbox(&mut on, cap).changed() {
            if on {
                app.register_capabilities.push(cap.to_string());
            } else {
                app.register_capabilities.retain(|c| c != cap);
            }
        }
    }
    if ui.button("Register this device").clicked() {
        app.send(Command::RegisterDevice {
            capabilities: app.register_capabilities.clone(),
        });
    }

    ui.separator();
    for device in app.devices.clone() {
        ui.horizontal(|ui| {
            ui.label(&device.hostname);
            ui.label(format!("[{}]", device.platform));
            ui.label(status_label(if device.is_online {
                "online"
            } else {
                "offline"
            }));
            ui.label(format!("id: {}", device.id));
            ui.label(format!("created: {}", device.created_at));
            if ui.button("Delete").clicked() {
                app.pending_delete = Some(device.id.clone());
            }
        });
    }

    // Per-row delete confirmation (spec §5.2): the delete is dispatched only
    // after the operator confirms.
    if let Some(id) = app.pending_delete.clone() {
        ui.separator();
        ui.label(format!("Delete device {id}?"));
        if ui.button("Confirm delete").clicked() {
            app.pending_delete = None;
            app.send(Command::DeleteDevice { id });
        }
        if ui.button("Cancel").clicked() {
            app.pending_delete = None;
        }
    }
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
