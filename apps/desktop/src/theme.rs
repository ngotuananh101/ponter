//! Light/dark theme selection and the shell's design tokens.
//!
//! The palette mirrors the Web app's shadcn/Tailwind tokens (`apps/web/src/style.css`)
//! so the native shell and the browser stay visually consistent (ADR-69..72), while
//! the [`Tokens`] struct gives the UI code one place to read named colors from
//! instead of hand-mixing `Color32`s per widget.

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

/// The shell's named color tokens for one theme.
///
/// `canvas` is the page background, `surface` the raised card, `inset` a
/// recessed grouping inside a card, `line` a hairline border. `ink`/`muted` are
/// the two text weights, `accent` is the single product blue (primary actions
/// and active state), and `ok`/`danger`/`warn` are the semantic states.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Tokens {
    pub canvas: egui::Color32,
    pub surface: egui::Color32,
    pub inset: egui::Color32,
    pub line: egui::Color32,
    pub line_strong: egui::Color32,
    pub ink: egui::Color32,
    pub muted: egui::Color32,
    pub accent: egui::Color32,
    pub accent_hover: egui::Color32,
    pub accent_active: egui::Color32,
    pub accent_fg: egui::Color32,
    pub hover: egui::Color32,
    pub ok: egui::Color32,
    pub danger: egui::Color32,
    pub warn: egui::Color32,
}

impl Tokens {
    /// The token set for a given mode. Pure, so it is cheap to call per frame
    /// and testable without an egui context.
    pub const fn for_dark(dark: bool) -> Self {
        if dark {
            Self {
                canvas: egui::Color32::from_rgb(13, 16, 23),
                surface: egui::Color32::from_rgb(21, 26, 35),
                inset: egui::Color32::from_rgb(27, 33, 44),
                line: egui::Color32::from_rgb(35, 42, 54),
                line_strong: egui::Color32::from_rgb(54, 64, 80),
                ink: egui::Color32::from_rgb(231, 235, 243),
                muted: egui::Color32::from_rgb(147, 160, 180),
                accent: egui::Color32::from_rgb(61, 165, 240),
                accent_hover: egui::Color32::from_rgb(52, 146, 214),
                accent_active: egui::Color32::from_rgb(43, 124, 182),
                accent_fg: egui::Color32::from_rgb(13, 16, 23),
                hover: egui::Color32::from_rgb(30, 37, 48),
                ok: egui::Color32::from_rgb(52, 211, 153),
                danger: egui::Color32::from_rgb(248, 113, 113),
                warn: egui::Color32::from_rgb(251, 191, 36),
            }
        } else {
            Self {
                canvas: egui::Color32::from_rgb(245, 247, 250),
                surface: egui::Color32::from_rgb(255, 255, 255),
                inset: egui::Color32::from_rgb(241, 244, 249),
                line: egui::Color32::from_rgb(228, 233, 241),
                line_strong: egui::Color32::from_rgb(203, 213, 225),
                ink: egui::Color32::from_rgb(15, 23, 42),
                muted: egui::Color32::from_rgb(90, 100, 115),
                accent: egui::Color32::from_rgb(37, 99, 235),
                accent_hover: egui::Color32::from_rgb(29, 78, 216),
                accent_active: egui::Color32::from_rgb(30, 64, 175),
                accent_fg: egui::Color32::from_rgb(255, 255, 255),
                hover: egui::Color32::from_rgb(238, 242, 247),
                ok: egui::Color32::from_rgb(22, 163, 74),
                danger: egui::Color32::from_rgb(220, 38, 38),
                warn: egui::Color32::from_rgb(217, 119, 6),
            }
        }
    }

    /// The tokens for the mode the given `Ui` is currently rendering in.
    pub fn of(ui: &egui::Ui) -> Self {
        Self::for_dark(ui.visuals().dark_mode)
    }
}

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

/// Map a [`Tokens`] set onto egui's global `Visuals`.
fn visuals_from(tokens: Tokens, dark: bool) -> egui::Visuals {
    let mut visuals = if dark {
        egui::Visuals::dark()
    } else {
        egui::Visuals::light()
    };

    // Optimize text rendering for sharpness on dark/light backgrounds:
    // 1. Disable sub-pixel binning: sub-pixel binning renders glyphs at fractional
    //    horizontal offsets, which causes text blurriness.
    // 2. Enable font hinting to snap stems to integer pixel coordinates.
    visuals.text_options.subpixel_binning = false;
    visuals.text_options.font_hinting = true;

    visuals.panel_fill = tokens.canvas;
    visuals.window_fill = tokens.surface;
    visuals.extreme_bg_color = tokens.surface;
    visuals.text_edit_bg_color = Some(tokens.surface);
    visuals.faint_bg_color = tokens.inset;
    visuals.code_bg_color = tokens.inset;
    visuals.window_stroke = egui::Stroke::new(1.0, tokens.line);
    visuals.window_corner_radius = egui::CornerRadius::same(12);
    visuals.override_text_color = Some(tokens.ink);
    visuals.weak_text_color = Some(tokens.muted);
    visuals.hyperlink_color = tokens.accent;
    visuals.warn_fg_color = tokens.warn;
    visuals.error_fg_color = tokens.danger;

    // Interactive widgets. Buttons read `weak_bg_fill`; containers read `bg_fill`.
    let set = |w: &mut egui::style::WidgetVisuals,
               bg: egui::Color32,
               stroke: egui::Stroke,
               fg: egui::Color32| {
        w.bg_fill = bg;
        w.weak_bg_fill = bg;
        w.bg_stroke = stroke;
        w.fg_stroke = egui::Stroke::new(1.0, fg);
        w.corner_radius = egui::CornerRadius::same(8);
    };

    set(
        &mut visuals.widgets.noninteractive,
        tokens.surface,
        egui::Stroke::new(1.0, tokens.line),
        tokens.ink,
    );
    set(
        &mut visuals.widgets.inactive,
        tokens.surface,
        egui::Stroke::new(1.0, tokens.line),
        tokens.ink,
    );
    set(
        &mut visuals.widgets.hovered,
        tokens.hover,
        egui::Stroke::new(1.0, tokens.line_strong),
        tokens.ink,
    );
    set(
        &mut visuals.widgets.active,
        tokens.hover,
        egui::Stroke::new(1.0, tokens.line_strong),
        tokens.ink,
    );
    set(
        &mut visuals.widgets.open,
        tokens.hover,
        egui::Stroke::new(1.0, tokens.line_strong),
        tokens.ink,
    );

    visuals.selection.bg_fill = tokens.accent.gamma_multiply(0.25);
    visuals.selection.stroke = egui::Stroke::new(1.0, tokens.accent);

    visuals
}

/// Apply the chosen theme to the egui context.
pub fn apply(ctx: &egui::Context, theme: Option<&str>) {
    let choice = resolve(theme);
    let dark = choice == ThemeChoice::Dark;
    let tokens = Tokens::for_dark(dark);

    let egui_theme = if dark {
        egui::Theme::Dark
    } else {
        egui::Theme::Light
    };
    // Write the palette into the chosen theme's slot AND make that theme the
    // active preference, so the stored choice wins over the OS theme.
    ctx.set_visuals_of(egui_theme, visuals_from(tokens, dark));
    ctx.set_theme(egui_theme);

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
        assert_eq!(visuals.weak_text_color(), Tokens::for_dark(true).muted);
    }

    #[test]
    fn tokens_light_and_dark_differ_across_the_palette() {
        let light = Tokens::for_dark(false);
        let dark = Tokens::for_dark(true);
        assert_ne!(light.canvas, dark.canvas);
        assert_ne!(light.surface, dark.surface);
        assert_ne!(light.ink, dark.ink);
        assert_ne!(light.accent, dark.accent);
    }

    #[test]
    fn apply_maps_tokens_onto_visuals() {
        let ctx = egui::Context::default();
        apply(&ctx, Some("light"));

        let light = Tokens::for_dark(false);
        let visuals = &ctx.style_of(egui::Theme::Light).visuals;
        assert_eq!(visuals.panel_fill, light.canvas);
        assert_eq!(visuals.window_fill, light.surface);
        assert_eq!(visuals.window_stroke.color, light.line);
        assert_eq!(visuals.widgets.inactive.weak_bg_fill, light.surface);
    }
}
