//! Signed auto-update (ADR-57). Pure decision helpers are unit-tested;
//! network/plugin wiring is thin.
//!
//! ## Canonical signed bytes decision
//! The release step (see `build-desktop.yml` `assemble-manifest`) writes
//! `latest.json` by serializing the `Manifest` with `serde_json::to_string`
//! (compact, field order as declared, no trailing whitespace, no signature
//! field in the signed body) and signs those exact bytes with minisign.
//! `verify_manifest` here reconstructs the same canonical bytes and verifies
//! the signature against them. The release step and this verifier MUST both
//! serialize without the `signature` field and MUST both use compact JSON —
//! any divergence invalidates every signature.

use serde::{Deserialize, Serialize};

/// The compiled-in minisign public key (base64). Only the PUBLIC key is
/// stored here; the private key lives solely in CI as `TAURI_SIGNING_PRIVATE_KEY`
/// and is never committed or printed.
const PUBKEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDQ3QUZGQzFCNTgzRTM1NTEKUldSUk5UNVlHL3l2Unp3cTc0SE1ETWUxTlRPZ3FGUHI1cVoxN2d6a0xzL3J2V2dmOEJvczVaMkIK";

/// Info about an available update, returned to the frontend.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub version: String,
    pub notes: Option<String>,
    pub date: Option<String>,
}

/// The decoded updater manifest (shape of `latest.json`).
#[derive(Debug, Clone, Deserialize, Serialize)]
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

/// PURE: verify the manifest's minisign signature against the COMPILED public
/// key. An unsigned manifest (signature None) → Err. A bad signature → Err.
pub fn verify_manifest(m: &Manifest) -> Result<(), String> {
    let sig = m
        .signature
        .as_ref()
        .ok_or_else(|| "manifest is unsigned (no signature)".to_string())?;

    let public_key = minisign_verify::PublicKey::from_base64(PUBKEY)
        .map_err(|e| format!("public key decode error: {e}"))?;
    let signature = minisign_verify::Signature::decode(sig)
        .map_err(|e| format!("signature decode error: {e}"))?;

    // Canonical bytes: re-serialize the manifest WITHOUT the signature field so
    // the signed payload matches what the release step signs.
    let mut body = m.clone();
    body.signature = None;
    let manifest_bytes =
        serde_json::to_string(&body).map_err(|e| format!("manifest serialization error: {e}"))?;

    public_key
        .verify(manifest_bytes.as_bytes(), &signature, false)
        .map_err(|e| format!("signature verification failed: {e}"))
}

/// Build a manifest with no signature, for the unsigned-manifest test.
#[cfg(test)]
fn unsigned_manifest() -> Manifest {
    Manifest {
        version: "1.0.0".to_string(),
        notes: None,
        date: None,
        platforms: serde_json::from_str("{}").unwrap(),
        signature: None,
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

    #[test]
    fn refuses_an_unsigned_manifest() {
        assert!(verify_manifest(&unsigned_manifest()).is_err());
    }

    #[test]
    fn refuses_a_bad_signature() {
        // A manifest with a signature that does not verify → Err.
        let mut m = unsigned_manifest();
        m.signature = Some("not-a-real-signature".to_string());
        assert!(verify_manifest(&m).is_err());
    }
}
