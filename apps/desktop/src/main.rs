#![allow(dead_code)]

//! `ponter-desktop` — the native desktop shell (ADR-79).

mod app;
pub mod autostart;
mod core;

use eframe::egui;

fn main() -> eframe::Result<()> {
    ponter_agent::logging::init();

    // One-instance guard (ADR-79, replaces `tauri-plugin-single-instance`): a
    // second launch must not open a second window over the same tray/agent.
    // Held for the whole process — the lock releases on exit.
    let _singleton = single_instance::SingleInstance::new("ponter-desktop")
        .expect("acquire the single-instance lock");

    let native_options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_title("Ponter Desktop")
            .with_inner_size([800.0, 600.0]),
        ..Default::default()
    };

    eframe::run_native(
        "Ponter Desktop",
        native_options,
        Box::new(|cc| Ok(Box::new(app::App::new(cc)))),
    )
}
