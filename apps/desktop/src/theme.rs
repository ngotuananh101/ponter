//! Light/dark theme selection, mirroring the Vue app's `useTheme` behaviour.

use eframe::egui;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ThemeChoice {
    Light,
    Dark,
}

/// Resolve a stored theme string. `None`/unknown -> Light (the Vue default
/// when the system preference is unavailable in this build).
pub fn resolve(theme: Option<&str>) -> ThemeChoice {
    match theme {
        Some("dark") => ThemeChoice::Dark,
        _ => ThemeChoice::Light,
    }
}

/// Font data for Inter-Regular embedded statically in the binary.
pub const INTER_REGULAR_FONT: &[u8] = include_bytes!("../fonts/Inter-Regular.ttf");

/// Configure custom crisp typography for the egui context.
/// Installs Inter as the primary proportional font, falling back to built-in fonts.
pub fn setup_fonts(ctx: &egui::Context) {
    let mut fonts = egui::FontDefinitions::default();
    fonts.font_data.insert(
        "Inter".to_owned(),
        std::sync::Arc::new(egui::FontData::from_static(INTER_REGULAR_FONT)),
    );
    fonts
        .families
        .entry(egui::FontFamily::Proportional)
        .or_default()
        .insert(0, "Inter".to_owned());
    ctx.set_fonts(fonts);
}

/// Apply the chosen theme to the egui context.
pub fn apply(ctx: &egui::Context, theme: Option<&str>) {
    let choice = resolve(theme);
    let mut visuals = match choice {
        ThemeChoice::Dark => egui::Visuals::dark(),
        ThemeChoice::Light => egui::Visuals::light(),
    };

    // Optimize text rendering for sharpness on dark/light backgrounds:
    // 1. Disable sub-pixel binning: sub-pixel binning renders glyphs at fractional
    //    horizontal offsets, which causes text blurriness.
    // 2. Enable font hinting to snap stems to integer pixel coordinates.
    visuals.text_options.subpixel_binning = false;
    visuals.text_options.font_hinting = true;

    match choice {
        ThemeChoice::Dark => {
            // Ponter Dark theme (Zinc/Slate palette)
            visuals.panel_fill = egui::Color32::from_rgb(15, 17, 23); // #0f1117 very dark slate
            visuals.window_fill = egui::Color32::from_rgb(23, 26, 35); // #171a23 card background
            visuals.extreme_bg_color = egui::Color32::from_rgb(11, 13, 18); // #0b0d12 input box
            visuals.text_edit_bg_color = Some(egui::Color32::from_rgb(11, 13, 18));
            visuals.faint_bg_color = egui::Color32::from_rgb(28, 32, 44);
            visuals.code_bg_color = egui::Color32::from_rgb(20, 23, 31);
            visuals.window_stroke = egui::Stroke::new(1.0, egui::Color32::from_rgb(38, 43, 58));
            visuals.window_corner_radius = egui::CornerRadius::same(10);
            visuals.override_text_color = None;
            visuals.weak_text_color = Some(egui::Color32::from_rgb(148, 163, 184)); // slate-400
            visuals.hyperlink_color = egui::Color32::from_rgb(96, 165, 250); // blue-400
            visuals.warn_fg_color = egui::Color32::from_rgb(251, 191, 36); // amber-400
            visuals.error_fg_color = egui::Color32::from_rgb(248, 113, 113); // red-400

            // Interactive widgets
            visuals.widgets.noninteractive.bg_fill = egui::Color32::from_rgb(23, 26, 35);
            visuals.widgets.noninteractive.bg_stroke =
                egui::Stroke::new(1.0, egui::Color32::from_rgb(38, 43, 58));
            visuals.widgets.noninteractive.fg_stroke =
                egui::Stroke::new(1.0, egui::Color32::from_rgb(226, 232, 240));
            visuals.widgets.noninteractive.corner_radius = egui::CornerRadius::same(6);

            visuals.widgets.inactive.bg_fill = egui::Color32::from_rgb(30, 35, 48);
            visuals.widgets.inactive.bg_stroke =
                egui::Stroke::new(1.0, egui::Color32::from_rgb(45, 52, 70));
            visuals.widgets.inactive.fg_stroke =
                egui::Stroke::new(1.0, egui::Color32::from_rgb(226, 232, 240));
            visuals.widgets.inactive.corner_radius = egui::CornerRadius::same(6);

            visuals.widgets.hovered.bg_fill = egui::Color32::from_rgb(40, 48, 66);
            visuals.widgets.hovered.bg_stroke =
                egui::Stroke::new(1.0, egui::Color32::from_rgb(70, 80, 110));
            visuals.widgets.hovered.fg_stroke = egui::Stroke::new(1.0, egui::Color32::WHITE);
            visuals.widgets.hovered.corner_radius = egui::CornerRadius::same(6);

            visuals.widgets.active.bg_fill = egui::Color32::from_rgb(50, 60, 82);
            visuals.widgets.active.bg_stroke =
                egui::Stroke::new(1.0, egui::Color32::from_rgb(90, 105, 140));
            visuals.widgets.active.fg_stroke = egui::Stroke::new(1.0, egui::Color32::WHITE);
            visuals.widgets.active.corner_radius = egui::CornerRadius::same(6);

            visuals.widgets.open.bg_fill = egui::Color32::from_rgb(35, 42, 58);
            visuals.widgets.open.corner_radius = egui::CornerRadius::same(6);

            visuals.selection.bg_fill = egui::Color32::from_rgb(37, 99, 235); // blue-600
            visuals.selection.stroke =
                egui::Stroke::new(1.0, egui::Color32::from_rgb(96, 165, 250));
        }
        ThemeChoice::Light => {
            // Ponter Light theme (Zinc light palette)
            visuals.panel_fill = egui::Color32::from_rgb(248, 250, 252); // slate-50
            visuals.window_fill = egui::Color32::WHITE;
            visuals.extreme_bg_color = egui::Color32::WHITE;
            visuals.text_edit_bg_color = Some(egui::Color32::WHITE);
            visuals.faint_bg_color = egui::Color32::from_rgb(241, 245, 249); // slate-100
            visuals.code_bg_color = egui::Color32::from_rgb(241, 245, 249);
            visuals.window_stroke = egui::Stroke::new(1.0, egui::Color32::from_rgb(226, 232, 240)); // slate-200
            visuals.window_corner_radius = egui::CornerRadius::same(10);
            visuals.override_text_color = None;
            visuals.weak_text_color = Some(egui::Color32::from_rgb(100, 116, 139)); // slate-500
            visuals.hyperlink_color = egui::Color32::from_rgb(37, 99, 235); // blue-600
            visuals.warn_fg_color = egui::Color32::from_rgb(217, 119, 6); // amber-600
            visuals.error_fg_color = egui::Color32::from_rgb(220, 38, 38); // red-600

            visuals.widgets.noninteractive.bg_fill = egui::Color32::WHITE;
            visuals.widgets.noninteractive.bg_stroke =
                egui::Stroke::new(1.0, egui::Color32::from_rgb(226, 232, 240));
            visuals.widgets.noninteractive.fg_stroke =
                egui::Stroke::new(1.0, egui::Color32::from_rgb(15, 23, 42)); // slate-900
            visuals.widgets.noninteractive.corner_radius = egui::CornerRadius::same(6);

            visuals.widgets.inactive.bg_fill = egui::Color32::from_rgb(241, 245, 249); // slate-100
            visuals.widgets.inactive.bg_stroke =
                egui::Stroke::new(1.0, egui::Color32::from_rgb(203, 213, 225)); // slate-300
            visuals.widgets.inactive.fg_stroke =
                egui::Stroke::new(1.0, egui::Color32::from_rgb(15, 23, 42));
            visuals.widgets.inactive.corner_radius = egui::CornerRadius::same(6);

            visuals.widgets.hovered.bg_fill = egui::Color32::from_rgb(226, 232, 240); // slate-200
            visuals.widgets.hovered.bg_stroke =
                egui::Stroke::new(1.0, egui::Color32::from_rgb(148, 163, 184)); // slate-400
            visuals.widgets.hovered.fg_stroke =
                egui::Stroke::new(1.0, egui::Color32::from_rgb(15, 23, 42));
            visuals.widgets.hovered.corner_radius = egui::CornerRadius::same(6);

            visuals.widgets.active.bg_fill = egui::Color32::from_rgb(203, 213, 225); // slate-300
            visuals.widgets.active.bg_stroke =
                egui::Stroke::new(1.0, egui::Color32::from_rgb(100, 116, 139));
            visuals.widgets.active.fg_stroke = egui::Stroke::new(1.0, egui::Color32::BLACK);
            visuals.widgets.active.corner_radius = egui::CornerRadius::same(6);

            visuals.widgets.open.bg_fill = egui::Color32::from_rgb(226, 232, 240);
            visuals.widgets.open.corner_radius = egui::CornerRadius::same(6);

            visuals.selection.bg_fill = egui::Color32::from_rgb(191, 219, 254); // blue-200
            visuals.selection.stroke = egui::Stroke::new(1.0, egui::Color32::from_rgb(37, 99, 235));
        }
    }

    ctx.set_visuals(visuals);

    let egui_theme = match choice {
        ThemeChoice::Dark => egui::Theme::Dark,
        ThemeChoice::Light => egui::Theme::Light,
    };
    ctx.style_mut_of(egui_theme, |style| {
        style.spacing.item_spacing = egui::vec2(8.0, 10.0);
        style.spacing.button_padding = egui::vec2(14.0, 8.0);
        style.spacing.interact_size.y = 30.0;
        style.text_styles.insert(
            egui::TextStyle::Body,
            egui::FontId::new(14.0, egui::FontFamily::Proportional),
        );
        style.text_styles.insert(
            egui::TextStyle::Button,
            egui::FontId::new(14.0, egui::FontFamily::Proportional),
        );
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_defaults_to_system_or_light() {
        assert_eq!(resolve(None), ThemeChoice::Light);
    }

    #[test]
    fn resolve_explicit_dark() {
        assert_eq!(resolve(Some("dark")), ThemeChoice::Dark);
    }

    #[test]
    fn resolve_explicit_light() {
        assert_eq!(resolve(Some("light")), ThemeChoice::Light);
    }

    #[test]
    fn resolve_unknown_falls_back() {
        assert_eq!(resolve(Some("solarized")), ThemeChoice::Light);
    }

    #[test]
    fn setup_fonts_installs_inter_as_primary_proportional_font() {
        let ctx = egui::Context::default();
        setup_fonts(&ctx);

        let mut output = ctx.run_ui(Default::default(), |_| {});
        output.textures_delta.clear();
        let fonts = ctx.fonts(|f| f.definitions().clone());
        assert!(fonts.font_data.contains_key("Inter"));
        let prop = fonts
            .families
            .get(&egui::FontFamily::Proportional)
            .expect("proportional family exists");
        assert_eq!(prop.first().map(String::as_str), Some("Inter"));
    }

    #[test]
    fn apply_disables_subpixel_binning_and_enables_hinting_for_sharp_text() {
        let ctx = egui::Context::default();
        apply(&ctx, Some("dark"));

        let visuals = &ctx.style_of(egui::Theme::Dark).visuals;
        assert!(!visuals.text_options.subpixel_binning);
        assert!(visuals.text_options.font_hinting);
        assert_eq!(
            visuals.weak_text_color(),
            egui::Color32::from_rgb(148, 163, 184)
        );
    }
}
