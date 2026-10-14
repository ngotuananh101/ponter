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

/// Apply the chosen theme to the egui context.
pub fn apply(ctx: &egui::Context, theme: Option<&str>) {
    match resolve(theme) {
        ThemeChoice::Dark => ctx.set_visuals(egui::Visuals::dark()),
        ThemeChoice::Light => ctx.set_visuals(egui::Visuals::light()),
    }
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
}
