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
    ui.heading(progress_label(app.wizard_step));
    match app.wizard_step {
        0 => {
            // Step 1: Capture. Advancing requires an `ok` capture probe.
            if ui.button("Verify Capture").clicked() {
                app.send(Command::ProbeCapture);
            }
        }
        1 => {
            // Step 2: Input gate. The checkbox is bound to `allow_input`
            // (default off); it is Gate A of the two-gate model (ADR-42).
            let mut allow = app.allow_input;
            if ui.checkbox(&mut allow, "Allow remote input").changed() {
                app.send(Command::ToggleAllowInput { enabled: allow });
            }
        }
        _ => {
            // Step 3: Auto-start. The checkbox reflects the real OS entry.
            let mut autostart = app.autostart_enabled;
            if ui.checkbox(&mut autostart, "Open at login").changed() {
                app.send(Command::SetAutostart { enabled: autostart });
            }
            if ui.button("Done").clicked() {
                app.send(Command::SaveServer {
                    url: app.server_url_input.clone(),
                });
                app.handle_msg(crate::app::Msg::WizardCompleted);
            }
        }
    }
    if ui
        .add_enabled(
            can_advance(app.wizard_step, app.capture_probe_ok),
            egui::Button::new("Next"),
        )
        .clicked()
    {
        // Advance through the fold, exactly as "Done" does with
        // `WizardCompleted`: the UI calls `handle_msg` directly for the
        // synchronous step transition, so `Msg::WizardAdvanced` has a producer
        // (spec §5 lists it among the Wizard's outputs).
        app.handle_msg(crate::app::Msg::WizardAdvanced);
    }
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
