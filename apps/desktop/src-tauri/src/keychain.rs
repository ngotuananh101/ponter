//! Thin wrapper over the OS secret store (ADR-51).
//!
//! The public API is intentionally minimal and synchronous; the OS keychain
//! abstracts away the platform (macOS Keychain, Windows Credential Manager,
//! GNOME/KDE Secret Service via zbus on Linux).
//!
//! Error-contract note: a *missing* credential is **not** an error for our
//! callers — Tasks 4/6 treat "no credential stored yet" as `Ok(None)` /
//! idempotent success. We therefore match the dedicated `keyring::Error::NoEntry`
//! variant (re-exported from `keyring_core::Error`) instead of stringifying or
//! blanket-mapping errors. That distinction matters: `PlatformFailure` and
//! `NoStorageAccess` (store locked, etc.) must still bubble as `Err`.

use anyhow::{Context, Result};
use keyring::Entry;

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
        // `keyring::Error::NoEntry` is re-exported from `keyring_core::Error`
        // (verified against the keyring 4.2.0 crate source at
        // keyring-core-1.0.0/src/error.rs — the variant is "This indicates
        // that there is no underlying credential entry in the platform for
        // this entry. Either one was never set, or it was deleted.").
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(anyhow::anyhow!(
            "keychain: get failed for {service}/{account}: {e:?}"
        ))
        .context("keychain: get_password returned a platform error"),
    }
}

pub fn delete_secret(service: &str, account: &str) -> Result<()> {
    let entry = Entry::new(service, account)
        .with_context(|| format!("keychain: failed to open entry for {service}/{account}"))?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        // Idempotent: a missing credential is a successful delete.
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(anyhow::anyhow!(
            "keychain: delete failed for {service}/{account}: {e:?}"
        ))
        .context("keychain: delete_credential returned a platform error"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_a_secret() {
        if std::env::var("PONTER_KEYCHAIN_SKIP").is_ok() {
            eprintln!("PONTER_KEYCHAIN_SKIP set — skipping keychain round trip (headless CI without a secret service)");
            return;
        }
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
