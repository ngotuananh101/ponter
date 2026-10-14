//! Setup wizard: three steps — capture, input gate, auto-start (spec §5.2).

use crate::app::{App, Command};
use crate::ui::components;
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

/// Human-readable step names for the visual stepper.
fn step_names() -> [&'static str; 3] {
    ["Screen capture", "Input gate", "Auto-start"]
}

pub fn render(app: &mut App, ui: &mut egui::Ui) {
    components::centered_card(ui, 520.0, |ui| {
        let step = app.wizard_step;

        components::page_title(ui, "Set up this machine", Some(&progress_label(step)));
        ui.add_space(14.0);

        // Visual stepper (replaces the pill row).
        let names = step_names();
        components::stepper(ui, &names, step);
        ui.add_space(20.0);

        match step {
            0 => {
                // Step 1: Capture. Advancing requires an `ok` capture probe.
                components::muted_text(
                    ui,
                    "Ponter needs screen capture permission to stream this desktop to \
                     authorized remote clients. Verify availability to continue.",
                );
                ui.add_space(16.0);

                if components::secondary_button(ui, "Verify capture capability").clicked() {
                    app.send(Command::ProbeCapture);
                }

                if app.capture_probe_ok {
                    ui.add_space(16.0);
                    components::success_banner(
                        ui,
                        "Screen capture verified and ready. You may continue.",
                    );
                } else if let Some(crate::app::Msg::CaptureProbed(res)) = app.last_probe.as_ref() {
                    if !res.ok {
                        ui.add_space(16.0);
                        components::error_banner(ui, &res.message);
                    }
                }
            }
            1 => {
                // Step 2: Input gate — Gate A of the two-gate model (ADR-42).
                components::muted_text(
                    ui,
                    "Decide whether remote operators may send mouse, keyboard, and touch \
                     input to this machine.",
                );
                ui.add_space(16.0);

                let mut allow = app.allow_input;
                let changed = components::pref_row(
                    ui,
                    "Allow remote input",
                    "When off, remote viewers can only observe your screen.",
                    |ui| ui.checkbox(&mut allow, "").changed(),
                );
                if changed {
                    app.send(Command::ToggleAllowInput { enabled: allow });
                }
            }
            _ => {
                // Step 3: Auto-start. The checkbox reflects the real OS entry.
                components::muted_text(
                    ui,
                    "Run Ponter Desktop in the background automatically when you log in.",
                );
                ui.add_space(16.0);

                let mut autostart = app.autostart_enabled;
                let changed = components::pref_row(
                    ui,
                    "Open at login",
                    "Start the agent automatically when this machine boots.",
                    |ui| ui.checkbox(&mut autostart, "").changed(),
                );
                if changed {
                    app.send(Command::SetAutostart { enabled: autostart });
                }
                ui.add_space(20.0);

                if components::primary_button(ui, "Finish setup").clicked() {
                    app.send(Command::SaveServer {
                        url: app.server_url_input.clone(),
                    });
                    app.handle_msg(crate::app::Msg::WizardCompleted);
                }
            }
        }

        // Navigation button (Continue for steps 0 & 1).
        if step < 2 {
            ui.add_space(20.0);
            let can_go = can_advance(step, app.capture_probe_ok);
            if components::primary_button_enabled(ui, "Continue", can_go).clicked() {
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
