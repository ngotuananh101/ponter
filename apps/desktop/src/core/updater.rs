//! Standalone minisign-verified self-updater (ADR-80).
//!
//! Provides automated check, verification, and binary self-replacement
//! against GitHub releases using minisign signatures.

use base64::Engine as _;
use serde::Deserialize;

pub const UPDATER_PUBKEY_B64: &str =
    "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDQ3QUZGQzFCNTgzRTM1NTEKUldSUk5UNVlHL3l2Unp3cTc0SE1ETWUxTlRPZ3FGUHI1cVoxN2d6a0xzL3J2V2dmOEJvczVaMkIK";

pub const UPDATE_ENDPOINT: &str =
    "https://github.com/ngotuananh101/ponter/releases/latest/download/latest.json";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdateInfo {
    pub version: String,
    pub url: String,
    pub signature: String,
}

pub fn should_apply(current: &str, latest: &str) -> Option<UpdateInfo> {
    let current = semver::Version::parse(current.trim_start_matches('v')).ok()?;
    let latest = semver::Version::parse(latest.trim_start_matches('v')).ok()?;
    if latest > current {
        Some(UpdateInfo {
            version: latest.to_string(),
            url: String::new(),
            signature: String::new(),
        })
    } else {
        None
    }
}

pub fn platform_key() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows-x86_64-msi"
    } else {
        "linux-x86_64-appimage"
    }
}

pub fn manifest_entry(manifest: &serde_json::Value, platform_key: &str) -> Option<UpdateInfo> {
    let version = manifest.get("version")?.as_str()?.to_string();
    let entry = manifest.get("platforms")?.get(platform_key)?;
    let url = entry.get("url")?.as_str()?.to_string();
    let signature = entry.get("signature")?.as_str()?.to_string();
    Some(UpdateInfo {
        version,
        url,
        signature,
    })
}

#[derive(Debug, Deserialize)]
pub struct Manifest {
    pub version: String,
    pub platforms: std::collections::BTreeMap<String, ManifestEntry>,
}

#[derive(Debug, Deserialize)]
pub struct ManifestEntry {
    pub url: String,
    pub signature: String,
}

pub fn verify(public_key_b64: &str, payload: &[u8], signature_text: &str) -> Result<(), String> {
    let pub_file = base64::engine::general_purpose::STANDARD
        .decode(public_key_b64)
        .map_err(|e| format!("invalid updater public key: {e}"))?;
    let pub_file =
        String::from_utf8(pub_file).map_err(|e| format!("invalid updater public key: {e}"))?;
    let key_line = pub_file
        .lines()
        .map(|l| l.trim())
        .rfind(|l| !l.is_empty())
        .ok_or_else(|| "updater public key is empty".to_string())?;

    let public_key = minisign_verify::PublicKey::from_base64(key_line)
        .map_err(|e| format!("invalid updater public key: {e}"))?;
    let signature = minisign_verify::Signature::decode(signature_text)
        .map_err(|e| format!("invalid update signature: {e}"))?;
    public_key
        .verify(payload, &signature, false)
        .map_err(|e| format!("update signature verification failed: {e}"))
}

pub async fn check(
    client: &reqwest::Client,
    current_version: &str,
) -> Result<Option<UpdateInfo>, String> {
    let resp = client
        .get(UPDATE_ENDPOINT)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!(
            "update check failed (HTTP {})",
            resp.status().as_u16()
        ));
    }
    let body = resp.text().await.map_err(|e| e.to_string())?;
    let manifest: Manifest =
        serde_json::from_str(&body).map_err(|e| format!("invalid manifest: {e}"))?;
    if should_apply(current_version, &manifest.version).is_none() {
        return Ok(None);
    }
    match manifest.platforms.get(platform_key()) {
        Some(entry) => Ok(Some(UpdateInfo {
            version: manifest.version.clone(),
            url: entry.url.clone(),
            signature: entry.signature.clone(),
        })),
        None => Ok(None),
    }
}

pub async fn apply_with<D, R>(
    info: &UpdateInfo,
    download: D,
    replace_binary: R,
) -> Result<(), String>
where
    D: std::future::Future<Output = Result<Vec<u8>, String>>,
    R: FnOnce(&[u8]) -> Result<(), String>,
{
    let bytes = download.await?;
    verify(UPDATER_PUBKEY_B64, &bytes, &info.signature)?;
    replace_binary(&bytes)
}

pub async fn apply(client: &reqwest::Client, info: &UpdateInfo) -> Result<(), String> {
    apply_with(info, download(client, &info.url), self_replace).await
}

async fn download(client: &reqwest::Client, url: &str) -> Result<Vec<u8>, String> {
    Ok(client
        .get(url)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .bytes()
        .await
        .map_err(|e| e.to_string())?
        .to_vec())
}

fn self_replace(bytes: &[u8]) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let tmp = exe.with_extension("new");
    std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&tmp)
            .map_err(|e| e.to_string())?
            .permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&tmp, perms).map_err(|e| e.to_string())?;
    }
    std::fs::rename(&tmp, &exe).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn should_apply_newer_version_returns_update() {
        let update =
            should_apply("0.1.0", "0.2.0").expect("should return update for newer version");
        assert_eq!(update.version, "0.2.0");

        let update_v = should_apply("v0.1.0", "v0.2.0").expect("should support v prefix");
        assert_eq!(update_v.version, "0.2.0");
    }

    #[test]
    fn should_apply_equal_version_returns_none() {
        assert!(should_apply("0.1.0", "0.1.0").is_none());
        assert!(should_apply("1.2.3", "1.2.3").is_none());
        assert!(should_apply("v1.2.3", "1.2.3").is_none());
    }

    #[test]
    fn should_apply_older_version_returns_none() {
        assert!(should_apply("1.0.0", "0.9.0").is_none());
        assert!(should_apply("0.2.0", "0.1.9").is_none());
    }

    #[test]
    fn should_apply_rejects_unparsable_version() {
        assert!(should_apply("invalid", "1.0.0").is_none());
        assert!(should_apply("1.0.0", "not-a-version").is_none());
        assert!(should_apply("", "").is_none());
    }

    #[test]
    fn manifest_selects_the_platform_entry() {
        let manifest_json = serde_json::json!({
            "version": "0.2.0",
            "platforms": {
                "linux-x86_64-appimage": {
                    "url": "https://example.com/ponter-0.2.0.AppImage",
                    "signature": "sig-linux"
                },
                "windows-x86_64-msi": {
                    "url": "https://example.com/ponter-0.2.0.msi",
                    "signature": "sig-win"
                }
            }
        });

        let entry = manifest_entry(&manifest_json, platform_key())
            .expect("must find entry for current platform");
        assert_eq!(entry.version, "0.2.0");
        if cfg!(target_os = "windows") {
            assert_eq!(entry.url, "https://example.com/ponter-0.2.0.msi");
            assert_eq!(entry.signature, "sig-win");
        } else {
            assert_eq!(entry.url, "https://example.com/ponter-0.2.0.AppImage");
            assert_eq!(entry.signature, "sig-linux");
        }
    }

    #[test]
    fn manifest_without_this_platform_yields_none() {
        let manifest_json = serde_json::json!({
            "version": "0.2.0",
            "platforms": {
                "macos-aarch64": {
                    "url": "https://example.com/dmg",
                    "signature": "sig-mac"
                }
            }
        });

        let entry = manifest_entry(&manifest_json, platform_key());
        assert!(entry.is_none());
    }

    #[test]
    fn verify_accepts_a_valid_signature() {
        let keypair = minisign::KeyPair::generate_unencrypted_keypair().unwrap();
        let pk_box = keypair.pk.to_box().unwrap().to_string();
        let pubkey_b64 = base64::engine::general_purpose::STANDARD.encode(pk_box.as_bytes());
        let payload = b"Hello, Ponter Desktop Update!";
        let sig_box = minisign::sign(
            Some(&keypair.pk),
            &keypair.sk,
            std::io::Cursor::new(payload),
            None,
            None,
        )
        .unwrap();
        let sig_str = sig_box.to_string();

        let res = verify(&pubkey_b64, payload, &sig_str);
        assert!(res.is_ok(), "verify failed: {:?}", res);
    }

    #[test]
    fn verify_rejects_a_tampered_payload() {
        let keypair = minisign::KeyPair::generate_unencrypted_keypair().unwrap();
        let pk_box = keypair.pk.to_box().unwrap().to_string();
        let pubkey_b64 = base64::engine::general_purpose::STANDARD.encode(pk_box.as_bytes());
        let payload = b"Hello, Ponter Desktop Update!";
        let sig_box = minisign::sign(
            Some(&keypair.pk),
            &keypair.sk,
            std::io::Cursor::new(payload),
            None,
            None,
        )
        .unwrap();
        let sig_str = sig_box.to_string();

        let tampered_payload = b"Tampered payload!";
        let res = verify(&pubkey_b64, tampered_payload, &sig_str);
        assert!(res.is_err());
    }

    #[test]
    fn verify_rejects_a_bad_signature() {
        let keypair = minisign::KeyPair::generate_unencrypted_keypair().unwrap();
        let pk_box = keypair.pk.to_box().unwrap().to_string();
        let pubkey_b64 = base64::engine::general_purpose::STANDARD.encode(pk_box.as_bytes());
        let payload = b"Hello, Ponter Desktop Update!";

        let res = verify(&pubkey_b64, payload, "invalid signature text");
        assert!(res.is_err());
    }

    #[tokio::test]
    async fn apply_refuses_a_bad_signature_without_touching_the_binary() {
        let info = UpdateInfo {
            version: "0.2.0".to_string(),
            url: "http://example.com/bin".to_string(),
            signature: "bad-signature".to_string(),
        };

        let mut touched = false;
        let res = apply_with(&info, async { Ok(b"binary-bytes".to_vec()) }, |_bytes| {
            touched = true;
            Ok(())
        })
        .await;

        assert!(res.is_err());
        assert!(
            !touched,
            "replace_binary must not be called when signature verification fails"
        );
    }
}
