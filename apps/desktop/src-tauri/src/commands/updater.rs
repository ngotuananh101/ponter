//! Signed auto-update (ADR-57). The updater plugin (`tauri-plugin-updater`)
//! handles manifest fetching and per-artifact minisign signature verification
//! internally during `updater.check()` / `update.download_and_install()`. This
//! module provides the thin Tauri command wrappers plus a PURE semver decision
//! helper that is unit-tested without network.
//!
//! Why no `verify_manifest` here: the real static manifest (see ADR-57 and the
//! Tauri updater spec) carries a PER-PLATFORM signature inside
//! `platforms[<{os}-{arch}-{bundle_type}>].signature` — there is no
//! top-level manifest signature. Verifying those per-platform signatures is the
//! plugin's job (it does so against the downloaded bytes during `download()`).
//! Duplicating that logic here would require a second base64/minisign dependency
//! and would risk diverging from the plugin. The decision helper `should_apply`,
//! however, is app-level policy (strictly newer → apply) and stays.

use serde::{Deserialize, Serialize};

/// Info about an available update, returned to the frontend.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub version: String,
    pub notes: Option<String>,
    pub date: Option<String>,
}

/// The decoded updater manifest (shape of `latest.json`). Kept for completeness
/// of the wire shape; the plugin deserializes the actual manifest internally.
#[derive(Debug, Clone, Deserialize)]
pub struct Manifest {
    pub version: String,
    pub notes: Option<String>,
    #[serde(rename = "pub_date")]
    pub date: Option<String>,
    pub platforms: serde_json::Value,
    pub signature: Option<String>,
}

/// PURE: return Some(UpdateInfo) ONLY when `latest` is strictly newer than
/// `current` (semver). Returns None on equal/older or unparseable versions.
pub fn should_apply(current: &str, latest: &str) -> Option<UpdateInfo> {
    let cur = semver::Version::parse(current.trim_start_matches('v')).ok()?;
    let new = semver::Version::parse(latest.trim_start_matches('v')).ok()?;
    if new > cur {
        Some(UpdateInfo {
            version: latest.to_string(),
            notes: None,
            date: None,
        })
    } else {
        None
    }
}

// ---- Tauri command wrappers ----

/// Tauri command: check the endpoint for a newer signed release.
#[tauri::command]
pub async fn check_update(handle: tauri::AppHandle) -> Result<Option<UpdateInfo>, String> {
    use tauri_plugin_updater::UpdaterExt;
    let updater = handle.updater().map_err(|e| format!("updater init: {e}"))?;
    let current = env!("CARGO_PKG_VERSION");
    match updater.check().await {
        Ok(Some(update)) => {
            if should_apply(current, &update.version).is_some() {
                Ok(Some(UpdateInfo {
                    version: update.version,
                    notes: update.body,
                    date: update.date.map(|d| d.to_string()),
                }))
            } else {
                Ok(None)
            }
        }
        Ok(None) => Ok(None),
        Err(e) => Err(format!("update check failed: {e}")),
    }
}

/// Tauri command: download + install the pending update.
#[tauri::command]
pub async fn apply_update(handle: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_updater::UpdaterExt;
    let updater = handle.updater().map_err(|e| format!("updater init: {e}"))?;
    if let Some(update) = updater.check().await.map_err(|e| format!("check: {e}"))? {
        update
            .download_and_install(|_, _| {}, || {})
            .await
            .map_err(|e| format!("install failed: {e}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_an_older_version() {
        assert!(should_apply("1.0.0", "0.9.0").is_none());
    }
}
