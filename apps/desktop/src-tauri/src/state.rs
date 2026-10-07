//! Application managed state shared across Tauri commands (ADR-52).
//!
//! `AppState` is registered via `tauri::Builder::manage` in `lib.rs`. The
//! access token lives only here, in backend memory, and is never passed into
//! the webview or persisted to disk.

use std::sync::Mutex;

pub struct AppState {
    pub http: reqwest::Client,
    pub server_url: String,
    /// Access token: memory only, never persisted. Guarded by a Mutex so the
    /// login command can write it and future commands (Task 5+) can read it.
    pub access_token: Mutex<Option<String>>,
}

impl AppState {
    pub fn new() -> Self {
        // reqwest 0.13 with `rustls-no-provider` panics at Client build time if
        // no process-default crypto provider is installed. Install the ring
        // provider once, before any Client is constructed. A second call to
        // `install_default` returns Err (already installed) — ignored.
        let _ = rustls::crypto::ring::default_provider().install_default();
        Self {
            http: reqwest::Client::new(),
            server_url: std::env::var("PONTER_SERVER_URL")
                .unwrap_or_else(|_| "http://localhost:8787".to_string()),
            access_token: Mutex::new(None),
        }
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}
