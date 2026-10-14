//! Reusable UI styling components for Ponter desktop shell.
//! Provides card containers, form helpers, buttons, and alert banners
//! following modern shadcn/Ponter design conventions.

use eframe::egui;

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
                    .color(ui.visuals().text_color().gamma_multiply(0.7)),
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
        [width, 36.0],
        egui::Button::new(egui::RichText::new(text).strong().size(14.0).color(fg))
            .fill(bg)
            .corner_radius(egui::CornerRadius::same(6)),
    )
}

/// Renders a secondary button sized to fill the available width.
pub fn secondary_button(ui: &mut egui::Ui, text: &str) -> egui::Response {
    let width = ui.available_width();
    ui.add_sized(
        [width, 36.0],
        egui::Button::new(egui::RichText::new(text).size(14.0))
            .corner_radius(egui::CornerRadius::same(6)),
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
