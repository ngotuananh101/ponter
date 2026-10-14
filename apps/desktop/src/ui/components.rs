//! Reusable UI styling components for Ponter desktop shell.
//! Provides card containers, form helpers, buttons, and alert banners
//! following modern shadcn/Ponter design conventions.

use eframe::egui;

/// Standard interactive control height (px) shared by text inputs and buttons,
/// so form rows line up on a single baseline grid.
pub const CONTROL_HEIGHT: f32 = 36.0;

/// Wraps contents in a centered, bounded card with subtle borders and shadows.
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
                    egui::Frame::new()
                        .fill(ui.visuals().window_fill)
                        .stroke(ui.visuals().window_stroke)
                        .corner_radius(ui.visuals().window_corner_radius)
                        .inner_margin(egui::Margin::same(24))
                        .show(ui, |ui| {
                            ui.set_width(card_width - 48.0);
                            result = Some(add_contents(ui));
                        });
                });
                ui.add_space(h_margin);
            });
            result.expect("card content rendered")
        })
        .inner
}

/// Renders a standardized card header with title and optional description.
pub fn card_header(ui: &mut egui::Ui, title: &str, subtitle: Option<&str>) {
    ui.vertical(|ui| {
        ui.add(egui::Label::new(
            egui::RichText::new(title)
                .size(20.0)
                .strong()
                .color(ui.visuals().strong_text_color()),
        ));
        if let Some(sub) = subtitle {
            ui.add_space(4.0);
            ui.add(egui::Label::new(
                egui::RichText::new(sub)
                    .size(13.0)
                    .color(ui.visuals().weak_text_color()),
            ));
        }
    });
    ui.add_space(16.0);
}

/// Renders a form field label.
pub fn field_label(ui: &mut egui::Ui, label: &str) {
    ui.add(egui::Label::new(
        egui::RichText::new(label)
            .size(13.0)
            .strong()
            .color(ui.visuals().strong_text_color()),
    ));
    ui.add_space(4.0);
}

/// Renders an alert banner for errors.
pub fn error_banner(ui: &mut egui::Ui, message: &str) {
    egui::Frame::new()
        .fill(egui::Color32::from_rgba_unmultiplied(239, 68, 68, 20))
        .stroke(egui::Stroke::new(1.0, egui::Color32::from_rgb(239, 68, 68)))
        .corner_radius(egui::CornerRadius::same(6))
        .inner_margin(egui::Margin::symmetric(12, 10))
        .show(ui, |ui| {
            ui.horizontal(|ui| {
                ui.colored_label(egui::Color32::from_rgb(239, 68, 68), "⚠");
                ui.add(egui::Label::new(
                    egui::RichText::new(message)
                        .size(13.0)
                        .color(egui::Color32::from_rgb(239, 68, 68)),
                ));
            });
        });
}

/// Renders an alert banner for success messages.
pub fn success_banner(ui: &mut egui::Ui, message: &str) {
    egui::Frame::new()
        .fill(egui::Color32::from_rgba_unmultiplied(34, 197, 94, 20))
        .stroke(egui::Stroke::new(1.0, egui::Color32::from_rgb(34, 197, 94)))
        .corner_radius(egui::CornerRadius::same(6))
        .inner_margin(egui::Margin::symmetric(12, 10))
        .show(ui, |ui| {
            ui.horizontal(|ui| {
                ui.colored_label(egui::Color32::from_rgb(34, 197, 94), "✓");
                ui.add(egui::Label::new(
                    egui::RichText::new(message)
                        .size(13.0)
                        .color(egui::Color32::from_rgb(34, 197, 94)),
                ));
            });
        });
}

/// Renders a primary action button sized to fill the available width.
pub fn primary_button(ui: &mut egui::Ui, text: &str) -> egui::Response {
    let width = ui.available_width();
    let dark = ui.visuals().dark_mode;
    let (bg, fg) = if dark {
        (
            egui::Color32::from_rgb(244, 244, 245),
            egui::Color32::from_rgb(9, 9, 11),
        )
    } else {
        (
            egui::Color32::from_rgb(24, 24, 27),
            egui::Color32::from_rgb(250, 250, 250),
        )
    };

    ui.add_sized(
        [width, CONTROL_HEIGHT],
        egui::Button::new(egui::RichText::new(text).strong().size(14.0).color(fg))
            .fill(bg)
            .corner_radius(egui::CornerRadius::same(6)),
    )
}

/// Renders a secondary button sized to fill the available width.
pub fn secondary_button(ui: &mut egui::Ui, text: &str) -> egui::Response {
    let width = ui.available_width();
    ui.add_sized(
        [width, CONTROL_HEIGHT],
        egui::Button::new(egui::RichText::new(text).size(14.0))
            .corner_radius(egui::CornerRadius::same(6)),
    )
}

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

/// Renders a badge tag with color status.
pub fn status_badge(ui: &mut egui::Ui, text: &str, is_online: bool) {
    let (bg, fg, stroke) = if is_online {
        (
            egui::Color32::from_rgba_unmultiplied(34, 197, 94, 25),
            egui::Color32::from_rgb(34, 197, 94),
            egui::Stroke::new(1.0, egui::Color32::from_rgb(34, 197, 94)),
        )
    } else {
        (
            egui::Color32::from_rgba_unmultiplied(148, 163, 184, 20),
            egui::Color32::from_rgb(148, 163, 184),
            egui::Stroke::new(1.0, egui::Color32::from_rgb(148, 163, 184)),
        )
    };

    egui::Frame::new()
        .fill(bg)
        .stroke(stroke)
        .corner_radius(egui::CornerRadius::same(12))
        .inner_margin(egui::Margin::symmetric(8, 3))
        .show(ui, |ui| {
            ui.add(egui::Label::new(
                egui::RichText::new(text).size(11.0).strong().color(fg),
            ));
        });
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
}
