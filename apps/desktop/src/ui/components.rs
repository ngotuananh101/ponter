//! Reusable UI primitives for the Ponter desktop shell.
//!
//! Everything here reads its colors from [`crate::theme::Tokens`] so a screen
//! never hand-mixes `Color32`s: hierarchy comes from the token roles
//! (`canvas` page, `surface` card, `inset` grouping, `line` hairline) rather
//! than from a different card on every element.

pub use crate::theme::Tokens;
use eframe::egui;

/// Standard interactive control height (px) shared by text inputs and buttons,
/// so form rows line up on a single baseline grid.
pub const CONTROL_HEIGHT: f32 = 36.0;

/// The single source of horizontal rhythm for cards and pages (px).
const PAGE_PAD: f32 = 24.0;

// ---------------------------------------------------------------------------
// Page & card scaffolding
// ---------------------------------------------------------------------------

/// Top-aligned, horizontally centered, scrollable page column bounded to
/// `max_width`. Use this for screens that own their own page header (Devices,
/// Settings); use [`centered_card`] for the compact auth screens.
pub fn page<R>(
    ui: &mut egui::Ui,
    max_width: f32,
    add_contents: impl FnOnce(&mut egui::Ui) -> R,
) -> R {
    let avail = ui.available_width();
    let width = max_width.min(avail - 32.0).max(280.0);
    let h_margin = ((avail - width) / 2.0).max(16.0);

    egui::ScrollArea::vertical()
        .auto_shrink([false, false])
        .show(ui, |ui| {
            let mut result = None;
            ui.horizontal(|ui| {
                ui.add_space(h_margin);
                ui.vertical(|ui| {
                    ui.set_width(width);
                    ui.add_space(24.0);
                    result = Some(add_contents(ui));
                    ui.add_space(24.0);
                });
                ui.add_space(h_margin);
            });
            result.expect("page content rendered")
        })
        .inner
}

/// A surface card: raised fill, hairline border, generous padding.
pub fn card<R>(ui: &mut egui::Ui, add_contents: impl FnOnce(&mut egui::Ui) -> R) -> R {
    let t = Tokens::of(ui);
    let mut result = None;
    egui::Frame::new()
        .fill(t.surface)
        .stroke(egui::Stroke::new(1.0, t.line))
        .corner_radius(egui::CornerRadius::same(12))
        .inner_margin(egui::Margin::same(PAGE_PAD as i8))
        .show(ui, |ui| {
            ui.set_width(ui.available_width());
            result = Some(add_contents(ui));
        });
    result.expect("card content rendered")
}

/// A recessed grouping *inside* a card (muted fill, hairline border).
pub fn inset<R>(ui: &mut egui::Ui, add_contents: impl FnOnce(&mut egui::Ui) -> R) -> R {
    let t = Tokens::of(ui);
    let mut result = None;
    egui::Frame::new()
        .fill(t.inset)
        .stroke(egui::Stroke::new(1.0, t.line))
        .corner_radius(egui::CornerRadius::same(10))
        .inner_margin(egui::Margin::same(14))
        .show(ui, |ui| {
            ui.set_width(ui.available_width());
            result = Some(add_contents(ui));
        });
    result.expect("inset content rendered")
}

/// Wraps contents in a centered, bounded card — the compact auth screens
/// (Server Setup, Login) per ADR-69.
pub fn centered_card<R>(
    ui: &mut egui::Ui,
    max_width: f32,
    add_contents: impl FnOnce(&mut egui::Ui) -> R,
) -> R {
    let avail_width = ui.available_width();
    let card_width = max_width.min(avail_width - 32.0).max(280.0);
    let h_margin = ((avail_width - card_width) / 2.0).max(16.0);

    egui::ScrollArea::vertical()
        .auto_shrink([false, false])
        .show(ui, |ui| {
            let avail_height = ui.available_height();
            let v_pad = ((avail_height - 440.0) / 4.0).clamp(24.0, 72.0);
            ui.add_space(v_pad);

            let mut result = None;
            ui.horizontal(|ui| {
                ui.add_space(h_margin);
                ui.vertical(|ui| {
                    ui.set_width(card_width);
                    card(ui, |ui| result = Some(add_contents(ui)));
                });
                ui.add_space(h_margin);
            });
            result.expect("card content rendered")
        })
        .inner
}

// ---------------------------------------------------------------------------
// Typography
// ---------------------------------------------------------------------------

/// A page-level title rendered *outside* any card, with an optional muted
/// subtitle. This is what breaks the "every element is a card" monotony.
pub fn page_title(ui: &mut egui::Ui, title: &str, subtitle: Option<&str>) {
    let t = Tokens::of(ui);
    ui.add(egui::Label::new(
        egui::RichText::new(title).size(22.0).strong().color(t.ink),
    ));
    if let Some(sub) = subtitle {
        ui.add_space(2.0);
        ui.add(egui::Label::new(
            egui::RichText::new(sub).size(13.0).color(t.muted),
        ));
    }
}

/// A card header: title (18px) with an optional muted description.
pub fn card_header(ui: &mut egui::Ui, title: &str, subtitle: Option<&str>) {
    let t = Tokens::of(ui);
    ui.add(egui::Label::new(
        egui::RichText::new(title).size(18.0).strong().color(t.ink),
    ));
    if let Some(sub) = subtitle {
        ui.add_space(4.0);
        ui.add(egui::Label::new(
            egui::RichText::new(sub).size(13.0).color(t.muted),
        ));
    }
    ui.add_space(16.0);
}

/// A small, muted section heading used inside a page or card.
pub fn section_label(ui: &mut egui::Ui, text: &str) {
    let t = Tokens::of(ui);
    ui.add(egui::Label::new(
        egui::RichText::new(text).size(12.0).strong().color(t.muted),
    ));
}

/// A form field label.
pub fn field_label(ui: &mut egui::Ui, label: &str) {
    let t = Tokens::of(ui);
    ui.add(egui::Label::new(
        egui::RichText::new(label).size(13.0).strong().color(t.ink),
    ));
    ui.add_space(4.0);
}

/// Muted helper / description text.
pub fn muted_text(ui: &mut egui::Ui, text: &str) {
    let t = Tokens::of(ui);
    ui.add(egui::Label::new(
        egui::RichText::new(text).size(12.5).color(t.muted),
    ));
}

/// A monospaced identifier (device id, server URL, token) — the *only* place
/// monospace is used, and only for machine identifiers.
pub fn mono_id(ui: &mut egui::Ui, text: &str, size: f32) {
    let t = Tokens::of(ui);
    ui.add(egui::Label::new(
        egui::RichText::new(text)
            .size(size)
            .monospace()
            .color(t.muted),
    ));
}

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

/// Primary action: filled with the single accent color, full width.
pub fn primary_button(ui: &mut egui::Ui, text: &str) -> egui::Response {
    primary_button_enabled(ui, text, true)
}

/// An accent-filled primary action that can be rendered in a disabled state
/// (muted fill, no hover). Used by the wizard's gated "Continue" so a blocked
/// primary action still reads as the primary action, not as a neutral button.
pub fn primary_button_enabled(ui: &mut egui::Ui, text: &str, enabled: bool) -> egui::Response {
    let t = Tokens::of(ui);
    let width = ui.available_width();
    let (fill, fg) = if enabled {
        (t.accent, t.accent_fg)
    } else {
        (t.line, t.muted)
    };
    ui.add_enabled(
        enabled,
        egui::Button::new(egui::RichText::new(text).strong().size(14.0).color(fg))
            .min_size(egui::vec2(width, CONTROL_HEIGHT))
            .fill(fill)
            .stroke(egui::Stroke::NONE)
            .corner_radius(egui::CornerRadius::same(8)),
    )
}

/// Secondary action: neutral surface button, full width.
pub fn secondary_button(ui: &mut egui::Ui, text: &str) -> egui::Response {
    let t = Tokens::of(ui);
    let width = ui.available_width();
    ui.add_sized(
        [width, CONTROL_HEIGHT],
        egui::Button::new(egui::RichText::new(text).size(14.0).color(t.ink))
            .fill(t.surface)
            .stroke(egui::Stroke::new(1.0, t.line_strong))
            .corner_radius(egui::CornerRadius::same(8)),
    )
}

/// A compact, borderless button for headers and inline actions.
pub fn ghost_button(ui: &mut egui::Ui, text: &str) -> egui::Response {
    let t = Tokens::of(ui);
    ui.add(
        egui::Button::new(egui::RichText::new(text).size(13.0).color(t.ink))
            .fill(egui::Color32::TRANSPARENT)
            .stroke(egui::Stroke::NONE)
            .corner_radius(egui::CornerRadius::same(8)),
    )
}

/// A destructive-tinted text button (Log out, Delete).
pub fn danger_button(ui: &mut egui::Ui, text: &str) -> egui::Response {
    let t = Tokens::of(ui);
    ui.add(
        egui::Button::new(egui::RichText::new(text).size(13.0).color(t.danger))
            .fill(egui::Color32::TRANSPARENT)
            .stroke(egui::Stroke::NONE)
            .corner_radius(egui::CornerRadius::same(8)),
    )
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/// Renders a single-line text input with a stable, button-aligned height.
///
/// `egui::TextEdit::singleline` ignores the global `interact_size.y` and sizes
/// itself from its font line height plus its own frame margin, which yields a
/// ~19px-tall box — noticeably shorter than a 36px button. Forcing `min_size.y`
/// makes the painted frame a consistent height so inputs line up with
/// [`primary_button`] / [`secondary_button`], and the extra frame margin gives
/// comfortable horizontal padding so text never hugs the border.
pub fn text_input(
    ui: &mut egui::Ui,
    value: &mut String,
    hint: &str,
    password: bool,
) -> egui::Response {
    ui.add(
        egui::TextEdit::singleline(value)
            .hint_text(hint)
            .password(password)
            .desired_width(f32::INFINITY)
            .margin(egui::Margin::symmetric(10, 10))
            .min_size(egui::vec2(0.0, CONTROL_HEIGHT)),
    )
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/// A small filled status dot.
fn status_dot(ui: &mut egui::Ui, color: egui::Color32) {
    let (rect, _) = ui.allocate_exact_size(egui::vec2(8.0, 8.0), egui::Sense::hover());
    ui.painter().circle_filled(rect.center(), 4.0, color);
}

/// A status pill: a colored dot plus a sentence-case label on a tinted fill.
pub fn status_badge(ui: &mut egui::Ui, text: &str, is_online: bool) {
    let t = Tokens::of(ui);
    let (tint, fg) = if is_online {
        (t.ok.gamma_multiply(0.18), t.ok)
    } else {
        (t.muted.gamma_multiply(0.16), t.muted)
    };
    egui::Frame::new()
        .fill(tint)
        .stroke(egui::Stroke::new(1.0, fg.gamma_multiply(0.5)))
        .corner_radius(egui::CornerRadius::same(255))
        .inner_margin(egui::Margin::symmetric(10, 4))
        .show(ui, |ui| {
            ui.horizontal(|ui| {
                ui.spacing_mut().item_spacing.x = 6.0;
                status_dot(ui, fg);
                ui.add(egui::Label::new(
                    egui::RichText::new(text).size(12.0).strong().color(fg),
                ));
            });
        });
}

/// A one-line banner (error / success / info). The icon is a plain glyph in the
/// banner's own color; copy states what happened and what to do next.
fn banner(ui: &mut egui::Ui, color: egui::Color32, glyph: &str, message: &str) {
    egui::Frame::new()
        .fill(color.gamma_multiply(0.14))
        .stroke(egui::Stroke::new(1.0, color.gamma_multiply(0.55)))
        .corner_radius(egui::CornerRadius::same(8))
        .inner_margin(egui::Margin::symmetric(12, 10))
        .show(ui, |ui| {
            ui.set_width(ui.available_width());
            ui.horizontal(|ui| {
                ui.spacing_mut().item_spacing.x = 8.0;
                ui.add(egui::Label::new(
                    egui::RichText::new(glyph).size(14.0).strong().color(color),
                ));
                ui.add(egui::Label::new(
                    egui::RichText::new(message).size(13.0).color(color),
                ));
            });
        });
}

pub fn error_banner(ui: &mut egui::Ui, message: &str) {
    let t = Tokens::of(ui);
    banner(ui, t.danger, "⚠", message);
}

pub fn success_banner(ui: &mut egui::Ui, message: &str) {
    let t = Tokens::of(ui);
    banner(ui, t.ok, "✓", message);
}

pub fn info_banner(ui: &mut egui::Ui, message: &str) {
    let t = Tokens::of(ui);
    banner(ui, t.accent, "ℹ", message);
}

// ---------------------------------------------------------------------------
// Machine strip — the shell's signature element
// ---------------------------------------------------------------------------

/// The persistent "this machine" band shown above the content of every
/// post-setup screen. It answers the one question the whole app exists to
/// answer: *which machine is this, and can it be controlled right now?*
///
/// `ports` are `(label, on)` triples rendered as mini status pills — e.g.
/// `("capture", true)`, `("input", false)`.
pub fn machine_strip(
    ui: &mut egui::Ui,
    hostname: &str,
    platform: &str,
    agent_status: &str,
    agent_online: bool,
    ports: &[(&str, bool)],
) {
    let t = Tokens::of(ui);
    egui::Frame::new()
        .fill(t.surface)
        .stroke(egui::Stroke::new(1.0, t.line))
        .corner_radius(egui::CornerRadius::same(12))
        .inner_margin(egui::Margin::symmetric(18, 14))
        .show(ui, |ui| {
            ui.set_width(ui.available_width());
            ui.horizontal(|ui| {
                ui.vertical(|ui| {
                    ui.add(egui::Label::new(
                        egui::RichText::new("Ponter")
                            .size(15.0)
                            .strong()
                            .color(t.ink),
                    ));
                    ui.add_space(1.0);
                    ui.horizontal(|ui| {
                        ui.spacing_mut().item_spacing.x = 6.0;
                        ui.add(egui::Label::new(
                            egui::RichText::new(hostname)
                                .size(12.0)
                                .monospace()
                                .color(t.ink),
                        ));
                        ui.add(egui::Label::new(
                            egui::RichText::new("·").size(12.0).color(t.muted),
                        ));
                        ui.add(egui::Label::new(
                            egui::RichText::new(platform).size(12.0).color(t.muted),
                        ));
                    });
                });

                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    status_badge(ui, agent_status, agent_online);
                    for (label, on) in ports.iter().rev() {
                        port_pill(ui, label, *on);
                    }
                });
            });
        });
}

/// A tiny labeled port indicator used by [`machine_strip`].
fn port_pill(ui: &mut egui::Ui, label: &str, on: bool) {
    let t = Tokens::of(ui);
    let color = if on { t.ok } else { t.muted };
    egui::Frame::new()
        .fill(egui::Color32::TRANSPARENT)
        .stroke(egui::Stroke::new(1.0, t.line))
        .corner_radius(egui::CornerRadius::same(255))
        .inner_margin(egui::Margin::symmetric(8, 3))
        .show(ui, |ui| {
            ui.horizontal(|ui| {
                ui.spacing_mut().item_spacing.x = 5.0;
                status_dot(ui, color);
                ui.add(egui::Label::new(
                    egui::RichText::new(label).size(11.0).color(t.muted),
                ));
            });
        });
}

// ---------------------------------------------------------------------------
// Stepper
// ---------------------------------------------------------------------------

/// A horizontal numbered stepper for the setup wizard. `steps` are the step
/// labels in order; `current` is the active index.
pub fn stepper(ui: &mut egui::Ui, steps: &[&str], current: usize) {
    let t = Tokens::of(ui);
    ui.horizontal(|ui| {
        ui.spacing_mut().item_spacing.x = 0.0;
        for (i, label) in steps.iter().enumerate() {
            let done = i < current;
            let active = i == current;

            // Marker: a filled circle when active, a check when done, else a ring.
            let (fill, fg) = if active {
                (t.accent, t.accent_fg)
            } else if done {
                (t.ok.gamma_multiply(0.18), t.ok)
            } else {
                (egui::Color32::TRANSPARENT, t.muted)
            };
            egui::Frame::new()
                .fill(fill)
                .stroke(egui::Stroke::new(
                    1.0,
                    if active { t.accent } else { t.line_strong },
                ))
                .corner_radius(egui::CornerRadius::same(255))
                .inner_margin(egui::Margin::symmetric(9, 3))
                .show(ui, |ui| {
                    let glyph = if done {
                        "✓".to_string()
                    } else {
                        format!("{}", i + 1)
                    };
                    ui.add(egui::Label::new(
                        egui::RichText::new(glyph).size(12.0).strong().color(fg),
                    ));
                });

            ui.add_space(8.0);
            let label_color = if active { t.ink } else { t.muted };
            ui.add(egui::Label::new(
                egui::RichText::new(*label)
                    .size(12.0)
                    .strong()
                    .color(label_color),
            ));

            if i + 1 < steps.len() {
                ui.add_space(8.0);
                // Connector line.
                let (rect, _) = ui.allocate_exact_size(egui::vec2(24.0, 1.0), egui::Sense::hover());
                let y = rect.center().y;
                ui.painter().line_segment(
                    [egui::pos2(rect.left(), y), egui::pos2(rect.right(), y)],
                    egui::Stroke::new(1.0, t.line_strong),
                );
                ui.add_space(8.0);
            }
        }
    });
}

// ---------------------------------------------------------------------------
// Preference row (used by wizard + settings)
// ---------------------------------------------------------------------------

/// An interactive preference row: label + description on the left, a control on
/// the right, on an inset fill. Returns the inner closure's result.
pub fn pref_row<R>(
    ui: &mut egui::Ui,
    title: &str,
    description: &str,
    add_control: impl FnOnce(&mut egui::Ui) -> R,
) -> R {
    let t = Tokens::of(ui);
    let mut result = None;
    egui::Frame::new()
        .fill(t.inset)
        .stroke(egui::Stroke::new(1.0, t.line))
        .corner_radius(egui::CornerRadius::same(10))
        .inner_margin(egui::Margin::same(14))
        .show(ui, |ui| {
            ui.set_width(ui.available_width());
            ui.horizontal(|ui| {
                ui.vertical(|ui| {
                    ui.set_width(ui.available_width() - 48.0);
                    ui.add(egui::Label::new(
                        egui::RichText::new(title).size(14.0).strong().color(t.ink),
                    ));
                    if !description.is_empty() {
                        ui.add_space(3.0);
                        ui.add(egui::Label::new(
                            egui::RichText::new(description).size(12.0).color(t.muted),
                        ));
                    }
                });
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    result = Some(add_control(ui));
                });
            });
        });
    result.expect("pref row control rendered")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    /// Lay out `build` inside a headless egui pass and return the measured
    /// height of the widget it produces.
    fn measure_height(mut build: impl FnMut(&mut egui::Ui) -> egui::Response) -> f32 {
        let ctx = egui::Context::default();
        let height = RefCell::new(0.0f32);
        let mut out = ctx.run_ui(egui::RawInput::default(), |ui| {
            *height.borrow_mut() = build(ui).rect.height();
        });
        out.textures_delta.clear();
        height.into_inner()
    }

    #[test]
    fn text_input_height_matches_control_height() {
        let mut value = String::new();
        let h = measure_height(|ui| text_input(ui, &mut value, "hint", false));
        assert_eq!(h, CONTROL_HEIGHT);
    }

    #[test]
    fn text_input_height_matches_primary_button_height() {
        let mut value = String::new();
        let input_h = measure_height(|ui| text_input(ui, &mut value, "hint", false));
        let button_h = measure_height(|ui| primary_button(ui, "Sign in"));
        assert_eq!(input_h, button_h);
    }

    #[test]
    fn plain_singleline_is_shorter_than_control_height() {
        // Regression guard: documents why `text_input` exists. A bare
        // `TextEdit::singleline` ignores `interact_size.y` and renders short.
        let mut value = String::new();
        let h = measure_height(|ui| {
            ui.add(egui::TextEdit::singleline(&mut value).desired_width(f32::INFINITY))
        });
        assert!(h < CONTROL_HEIGHT, "bare singleline measured {h}px");
    }

    /// Every primitive renders inside a headless pass without panicking and
    /// without leaving the layout in an invalid state.
    #[test]
    fn primitives_render_headless() {
        let ctx = egui::Context::default();
        let mut out = ctx.run_ui(egui::RawInput::default(), |ui| {
            page_title(ui, "Devices", Some("Signed in as operator"));
            card(ui, |ui| {
                card_header(ui, "This device", Some("Register this machine"));
                inset(ui, |ui| section_label(ui, "Capabilities"));
                field_label(ui, "Server URL");
                muted_text(ui, "Enter the base URL of your server");
                mono_id(ui, "studio-linux-8f2c", 12.0);
                primary_button(ui, "Register this device");
                primary_button_enabled(ui, "Continue", false);
                secondary_button(ui, "Cancel");
                ghost_button(ui, "Refresh");
                danger_button(ui, "Log out");
                status_badge(ui, "Online", true);
                error_banner(ui, "Something went wrong");
                success_banner(ui, "Saved");
                info_banner(ui, "Heads up");
                machine_strip(
                    ui,
                    "studio-linux",
                    "linux",
                    "Agent connected",
                    true,
                    &[("capture", true), ("input", false)],
                );
                stepper(ui, &["capture", "input", "auto-start"], 1);
                let mut on = false;
                pref_row(ui, "Allow remote input", "Read-only when off", |ui| {
                    ui.checkbox(&mut on, "")
                });
            });
        });
        out.textures_delta.clear();
    }
}
