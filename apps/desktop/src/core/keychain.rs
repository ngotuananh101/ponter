//! Thin wrapper over the OS secret store (ADR-51, ADR-79).
//!
//! The public API is intentionally minimal and synchronous; the OS keychain
//! abstracts away the platform (Windows Credential Manager,
//! GNOME/KDE Secret Service via zbus on Linux).
//!
//! Error-contract note: a *missing* credential is **not** an error for our
//! callers — Tasks 4/6 treat "no credential stored yet" as `Ok(None)` /
//! idempotent success. We therefore classify errors through [`classify`],
//! matching the dedicated `keyring::Error::NoEntry` variant while ensuring
//! `PlatformFailure` and `NoStorageAccess` (store locked, etc.) still bubble as
//! `Err`.

use anyhow::{Context, Result};
use keyring::Entry;

/// The two outcomes that matter to a caller: the entry is absent (a normal
/// "no credential yet"), or the store failed for some other reason (locked,
/// denied, backend error). A locked store must NOT read as "no credential".
#[derive(Debug, PartialEq, Eq)]
pub enum KeychainError {
    /// `keyring::Error::NoEntry` — the account simply has nothing stored.
    NoEntry,
    /// Any other failure, rendered for display.
    Other(String),
}

/// Classify a keyring error. Pure, so it is unit-tested without a real store.
pub fn classify(err: keyring::Error) -> KeychainError {
    match err {
        keyring::Error::NoEntry => KeychainError::NoEntry,
        other => KeychainError::Other(other.to_string()),
    }
}

pub fn set_secret(service: &str, account: &str, value: &str) -> Result<()> {
    let entry = Entry::new(service, account)
        .with_context(|| format!("keychain: failed to open entry for {service}/{account}"))?;
    entry
        .set_password(value)
        .with_context(|| format!("keychain: failed to store secret for {service}/{account}"))
}

pub fn get_secret(service: &str, account: &str) -> Result<Option<String>> {
    let entry = Entry::new(service, account)
        .with_context(|| format!("keychain: failed to open entry for {service}/{account}"))?;
    match entry.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(e) => match classify(e) {
            KeychainError::NoEntry => Ok(None),
            KeychainError::Other(msg) => Err(anyhow::anyhow!(
                "keychain: get failed for {service}/{account}: {msg}"
            ))
            .context("keychain: get_password returned a platform error"),
        },
    }
}

pub fn delete_secret(service: &str, account: &str) -> Result<()> {
    let entry = Entry::new(service, account)
        .with_context(|| format!("keychain: failed to open entry for {service}/{account}"))?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(e) => match classify(e) {
            KeychainError::NoEntry => Ok(()),
            KeychainError::Other(msg) => Err(anyhow::anyhow!(
                "keychain: delete failed for {service}/{account}: {msg}"
            ))
            .context("keychain: delete_credential returned a platform error"),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::test_util::keychain_lock;

    #[test]
    fn classify_distinguishes_no_entry_from_other_errors() {
        assert_eq!(classify(keyring::Error::NoEntry), KeychainError::NoEntry);
        let other =
            keyring::Error::PlatformFailure(Box::new(std::io::Error::other("store locked")));
        match classify(other) {
            KeychainError::Other(msg) => assert!(msg.contains("store locked")),
            KeychainError::NoEntry => panic!("a platform failure must not classify as NoEntry"),
        }
    }

    #[test]
    fn round_trips_a_secret() {
        if std::env::var("PONTER_KEYCHAIN_SKIP").is_ok() {
            eprintln!("PONTER_KEYCHAIN_SKIP set — skipping keychain round trip (headless CI without a secret service)");
            return;
        }
        // Serialize with every other keychain-touching test (single shared lock).
        let _guard = keychain_lock();
        let svc = "ponter-desktop-test";
        let acct = "acct-1";
        // Pre-clean so a crashed previous run cannot make this test lie.
        let _ = delete_secret(svc, acct);
        set_secret(svc, acct, "value-1").unwrap();
        assert_eq!(get_secret(svc, acct).unwrap().as_deref(), Some("value-1"));
        // Overwrite
        set_secret(svc, acct, "value-2").unwrap();
        assert_eq!(get_secret(svc, acct).unwrap().as_deref(), Some("value-2"));
        // Delete → gone
        delete_secret(svc, acct).unwrap();
        assert_eq!(get_secret(svc, acct).unwrap(), None);
        // Idempotent delete
        delete_secret(svc, acct).unwrap();
    }
}
