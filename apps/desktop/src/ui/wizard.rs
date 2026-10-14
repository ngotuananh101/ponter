//! Setup wizard: three steps — capture, input gate, auto-start (spec §5.2).

use crate::app::{App, Command};
use eframe::egui;

pub fn step_count() -> usize {
    3
}

pub fn next_step(step: usize) -> usize {
    (step + 1).min(step_count())
}

/// The stable slug for a step (0-based). Out-of-range steps read as `"done"`.
pub fn step_label(step: usize) -> &'static str {
    match step {
        0 => "capture",
        1 => "input gate",
        2 => "auto-start",
        _ => "done",
    }
}

/// R1: the store-level advance gate. Only the capture step is probe-gated; the
/// input-gate and auto-start steps advance unconditionally (gate B lives at
/// admission, ADR-42), and the terminal step never advances.
pub fn can_advance(step: usize, capture_probe_ok: bool) -> bool {
    match step {
        0 => capture_probe_ok,
        1 | 2 => true,
        _ => false,
    }
}

/// The one-based progress heading, e.g. `Setup — step 1 of 3`.
pub fn progress_label(step: usize) -> String {
    format!("Setup — step {} of {}", step + 1, step_count())
}

pub fn render(app: &mut App, ui: &mut egui::Ui) {
    crate::ui::components::centered_card(ui, 480.0, |ui| {
        let step = app.wizard_step;
        let subtitle = match step {
            0 => "Step 1 of 3: Verify screen capture capability",
            1 => "Step 2 of 3: Remote input admission gate",
            2 => "Step 3 of 3: System startup preference",
            _ => "Setup completed",
        };
        crate::ui::components::card_header(ui, &progress_label(step), Some(subtitle));

        // Step progress pill bar
        ui.horizontal(|ui| {
            for i in 0..step_count() {
                let is_current = i == step;
                let is_done = i < step;
                let (fill, stroke_color) = if is_current {
                    (
                        ui.visuals().selection.bg_fill,
                        ui.visuals().selection.stroke.color,
                    )
                } else if is_done {
                    (
                        egui::Color32::from_rgba_unmultiplied(34, 197, 94, 40),
                        egui::Color32::from_rgb(34, 197, 94),
                    )
                } else {
                    (
                        ui.visuals().faint_bg_color,
                        ui.visuals().widgets.noninteractive.bg_stroke.color,
                    )
                };

                egui::Frame::new()
                    .fill(fill)
                    .stroke(egui::Stroke::new(1.0, stroke_color))
                    .corner_radius(egui::CornerRadius::same(4))
                    .inner_margin(egui::Margin::symmetric(10, 4))
                    .show(ui, |ui| {
                        let text = format!("{}. {}", i + 1, step_label(i));
                        let color = if is_current || is_done {
                            ui.visuals().strong_text_color()
                        } else {
                            ui.visuals().text_color().gamma_multiply(0.5)
                        };
                        ui.add(egui::Label::new(
                            egui::RichText::new(text).size(11.0).strong().color(color),
                        ));
                    });
            }
        });
        ui.add_space(20.0);

        match step {
            0 => {
                // Step 1: Capture. Advancing requires an `ok` capture probe.
                ui.add(egui::Label::new(
                    egui::RichText::new(
                        "Ponter needs screen capture permissions to stream your desktop \
                         to authorized remote clients. Click below to verify availability.",
                    )
                    .size(13.0)
                    .color(ui.visuals().text_color().gamma_multiply(0.8)),
                ));
                ui.add_space(16.0);

                if ui
                    .add_sized(
                        [ui.available_width(), 36.0],
                        egui::Button::new(
                            egui::RichText::new("Verify Capture Capability").strong(),
                        ),
                    )
                    .clicked()
                {
                    app.send(Command::ProbeCapture);
                }

                if app.capture_probe_ok {
                    ui.add_space(16.0);
                    crate::ui::components::success_banner(
                        ui,
                        "Screen capture verified and ready. You may proceed.",
                    );
                } else if let Some(crate::app::Msg::CaptureProbed(res)) = app.last_probe.as_ref() {
                    if !res.ok {
                        ui.add_space(16.0);
                        crate::ui::components::error_banner(ui, &res.message);
                    }
                }
            }
            1 => {
                // Step 2: Input gate. The checkbox is bound to `allow_input`
                // (default off); it is Gate A of the two-gate model (ADR-42).
                ui.add(egui::Label::new(
                    egui::RichText::new(
                        "Configure whether remote operators are permitted to send mouse, \
                         keyboard, and touch input to this machine.",
                    )
                    .size(13.0)
                    .color(ui.visuals().text_color().gamma_multiply(0.8)),
                ));
                ui.add_space(16.0);

                egui::Frame::new()
                    .fill(ui.visuals().faint_bg_color)
                    .stroke(ui.visuals().widgets.noninteractive.bg_stroke)
                    .corner_radius(egui::CornerRadius::same(6))
                    .inner_margin(egui::Margin::same(12))
                    .show(ui, |ui| {
                        let mut allow = app.allow_input;
                        if ui
                            .checkbox(
                                &mut allow,
                                egui::RichText::new("Allow remote input").strong(),
                            )
                            .changed()
                        {
                            app.send(Command::ToggleAllowInput { enabled: allow });
                        }
                        ui.add_space(4.0);
                        ui.add(egui::Label::new(
                            egui::RichText::new(
                                "When disabled, remote viewers can only observe your screen \
                                 in read-only mode.",
                            )
                            .size(12.0)
                            .color(ui.visuals().text_color().gamma_multiply(0.7)),
                        ));
                    });
            }
            _ => {
                // Step 3: Auto-start. The checkbox reflects the real OS entry.
                ui.add(egui::Label::new(
                    egui::RichText::new(
                        "Set up system autostart so Ponter Desktop runs in the background \
                         when you log in.",
                    )
                    .size(13.0)
                    .color(ui.visuals().text_color().gamma_multiply(0.8)),
                ));
                ui.add_space(16.0);

                egui::Frame::new()
                    .fill(ui.visuals().faint_bg_color)
                    .stroke(ui.visuals().widgets.noninteractive.bg_stroke)
                    .corner_radius(egui::CornerRadius::same(6))
                    .inner_margin(egui::Margin::same(12))
                    .show(ui, |ui| {
                        let mut autostart = app.autostart_enabled;
                        if ui
                            .checkbox(
                                &mut autostart,
                                egui::RichText::new("Open at login").strong(),
                            )
                            .changed()
                        {
                            app.send(Command::SetAutostart { enabled: autostart });
                        }
                    });
                ui.add_space(20.0);

                if crate::ui::components::primary_button(ui, "Finish Setup").clicked() {
                    app.send(Command::SaveServer {
                        url: app.server_url_input.clone(),
                    });
                    app.handle_msg(crate::app::Msg::WizardCompleted);
                }
            }
        }

        // Navigation button (Next for steps 0 & 1)
        if step < 2 {
            ui.add_space(20.0);
            let can_go = can_advance(step, app.capture_probe_ok);
            if ui
                .add_enabled(
                    can_go,
                    egui::Button::new(egui::RichText::new("Next →").strong().size(14.0))
                        .min_size(egui::vec2(ui.available_width(), 36.0))
                        .corner_radius(egui::CornerRadius::same(6)),
                )
                .clicked()
            {
                app.handle_msg(crate::app::Msg::WizardAdvanced);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    // Ported from Vue `wizard.test.ts` (10 pure step/validation cases; the
    // remaining 13 cases — 8 that mounted DOM components and 5 Pinia invoke-wrapper
    // cases whose backend logic is covered by Tasks 8 and 9 — are deleted with
    // the Vue app). 10 cases.

    #[test]
    fn wizard_has_three_steps() {
        assert_eq!(step_count(), 3);
    }

    #[test]
    fn wizard_next_advances_and_clamps() {
        assert_eq!(next_step(0), 1);
        assert_eq!(next_step(1), 2);
        assert_eq!(next_step(2), 3);
        assert_eq!(next_step(3), 3);
    }

    #[test]
    fn step_labels_are_stable_and_terminal_is_done() {
        assert_eq!(step_label(0), "capture");
        assert_eq!(step_label(1), "input gate");
        assert_eq!(step_label(2), "auto-start");
        assert_eq!(step_label(3), "done");
    }

    #[test]
    fn progress_label_is_one_based() {
        assert_eq!(progress_label(0), "Setup — step 1 of 3");
        assert_eq!(progress_label(2), "Setup — step 3 of 3");
    }

    // R1: the capture step only advances once the probe succeeded.
    #[test]
    fn capture_step_advances_only_when_probe_ok() {
        assert!(!can_advance(0, false));
        assert!(can_advance(0, true));
    }

    // R1 negative: a failed probe leaves the capture step unadvanceable.
    #[test]
    fn capture_step_refuses_advance_on_failed_probe() {
        assert!(!can_advance(0, false));
    }

    // The input-gate and auto-start steps advance unconditionally (gate B is at
    // admission, ADR-42).
    #[test]
    fn input_gate_and_autostart_advance_unconditionally() {
        assert!(can_advance(1, false));
        assert!(can_advance(2, false));
    }

    // The terminal step never advances.
    #[test]
    fn terminal_step_never_advances() {
        assert!(!can_advance(3, true));
    }

    // The gate default is closed (guard (a)): with no probe, step 0 cannot
    // advance even though every later step can.
    #[test]
    fn default_state_cannot_advance_past_capture() {
        let probe_ok = false;
        assert!(!can_advance(0, probe_ok));
        assert!(can_advance(1, probe_ok));
    }

    // Advancing from the last step clamps instead of overflowing.
    #[test]
    fn advancing_past_the_end_is_idempotent() {
        assert_eq!(next_step(next_step(2)), 3);
        assert_eq!(next_step(3), 3);
    }
}
