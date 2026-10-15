//! Secure persistent storage for portal `restore_token` (ADR-90 §5.2).

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct StoredToken {
    pub version: u32,
    pub restore_token: String,
    pub granted_at: u64,
    pub device_mask: u32,
    pub session_type: String,
}

pub fn resolve_token_path() -> PathBuf {
    if let Ok(xdg) = std::env::var("XDG_CONFIG_HOME") {
        if !xdg.trim().is_empty() {
            return PathBuf::from(xdg)
                .join("ponter")
                .join("remote-desktop.token");
        }
    }
    if let Ok(home) = std::env::var("HOME") {
        return PathBuf::from(home)
            .join(".config")
            .join("ponter")
            .join("remote-desktop.token");
    }
    PathBuf::from(".ponter-remote-desktop.token")
}

pub fn load_token_from_path(path: &Path) -> Option<StoredToken> {
    if !path.exists() {
        return None;
    }
    let data = match fs::read_to_string(path) {
        Ok(d) => d,
        Err(e) => {
            tracing::warn!(error = %e, path = ?path, "failed to read remote-desktop.token");
            return None;
        }
    };
    match serde_json::from_str::<StoredToken>(&data) {
        Ok(token) => {
            if token.version == 1 && !token.restore_token.trim().is_empty() {
                Some(token)
            } else {
                tracing::warn!(path = ?path, "invalid token structure or unsupported version; removing");
                let _ = fs::remove_file(path);
                None
            }
        }
        Err(e) => {
            tracing::warn!(error = %e, path = ?path, "corrupted remote-desktop.token JSON; removing");
            let _ = fs::remove_file(path);
            None
        }
    }
}

pub fn save_token_to_path(path: &Path, restore_token: &str, device_mask: u32) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).with_context(|| format!("creating directory {:?}", parent))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(parent, fs::Permissions::from_mode(0o700));
        }
    }

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    let record = StoredToken {
        version: 1,
        restore_token: restore_token.to_string(),
        granted_at: now,
        device_mask,
        session_type: "wayland".to_string(),
    };

    let serialized = serde_json::to_string_pretty(&record).context("serializing StoredToken")?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        let mut file = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .mode(0o600)
            .open(path)
            .with_context(|| format!("opening token file {:?}", path))?;
        file.write_all(serialized.as_bytes())
            .with_context(|| format!("writing token file {:?}", path))?;
    }

    #[cfg(not(unix))]
    {
        let mut file = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(path)
            .with_context(|| format!("opening token file {:?}", path))?;
        file.write_all(serialized.as_bytes())
            .with_context(|| format!("writing token file {:?}", path))?;
    }

    Ok(())
}

pub fn clear_token_at_path(path: &Path) -> Result<()> {
    if path.exists() {
        fs::remove_file(path).with_context(|| format!("deleting token file {:?}", path))?;
    }
    Ok(())
}

pub fn load_token() -> Option<StoredToken> {
    load_token_from_path(&resolve_token_path())
}

pub fn save_token(restore_token: &str, device_mask: u32) -> Result<()> {
    save_token_to_path(&resolve_token_path(), restore_token, device_mask)
}

pub fn clear_token() -> Result<()> {
    clear_token_at_path(&resolve_token_path())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn save_and_load_round_trip() {
        let temp_dir =
            std::env::temp_dir().join(format!("ponter-token-test-{}", std::process::id()));
        let _ = fs::create_dir_all(&temp_dir);
        let token_path = temp_dir.join("remote-desktop.token");

        let token_str = "test-token-uuid-12345";
        save_token_to_path(&token_path, token_str, 3).expect("save should succeed");

        let loaded = load_token_from_path(&token_path).expect("load should find token");
        assert_eq!(loaded.version, 1);
        assert_eq!(loaded.restore_token, token_str);
        assert_eq!(loaded.device_mask, 3);
        assert_eq!(loaded.session_type, "wayland");
        assert!(loaded.granted_at > 0);

        // Check file permissions on Unix (must be 0600)
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let meta = fs::metadata(&token_path).unwrap();
            let mode = meta.permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "token file must have 0600 permissions");
        }

        // Test clear
        clear_token_at_path(&token_path).expect("clear should succeed");
        assert!(load_token_from_path(&token_path).is_none());
        assert!(!token_path.exists());

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn load_nonexistent_returns_none() {
        let path = std::path::Path::new("/tmp/nonexistent-ponter-token.token");
        assert!(load_token_from_path(path).is_none());
    }

    #[test]
    fn load_corrupted_json_clears_file_and_returns_none() {
        let temp_dir =
            std::env::temp_dir().join(format!("ponter-token-corrupt-{}", std::process::id()));
        let _ = fs::create_dir_all(&temp_dir);
        let token_path = temp_dir.join("remote-desktop.token");

        fs::write(&token_path, "{ invalid json content").unwrap();
        assert!(load_token_from_path(&token_path).is_none());
        assert!(
            !token_path.exists(),
            "corrupted token file should be automatically removed"
        );

        let _ = fs::remove_dir_all(&temp_dir);
    }
}
