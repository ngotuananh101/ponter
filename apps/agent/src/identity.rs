//! The agent's long-lived Ed25519 peer identity (WS2).
//!
//! The agent had no on-disk state before WS2; the credential is argv/env only.
//! An identity that is regenerated per run would invalidate every trust binding
//! the browser established, so this key is generated once and persisted as
//! PKCS#8 with owner-only permissions.

use anyhow::{bail, Context, Result};
use ring::rand::SystemRandom;
use ring::signature::{Ed25519KeyPair, KeyPair, UnparsedPublicKey, ED25519};
use std::path::Path;

pub const PROOF_VERSION: &str = "ponter-ws2-v1";

pub struct AgentIdentity {
    key_pair: Ed25519KeyPair,
}

impl AgentIdentity {
    /// Load the PKCS#8 key at `path`, generating and persisting one if absent.
    pub fn load_or_generate(path: &Path) -> Result<Self> {
        if path.exists() {
            let bytes = std::fs::read(path).context("read agent identity")?;
            let key_pair = Ed25519KeyPair::from_pkcs8(&bytes)
                .map_err(|_| anyhow::anyhow!("agent identity is not a valid Ed25519 PKCS#8 key"))?;
            return Ok(Self { key_pair });
        }

        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).context("create identity directory")?;
        }
        let rng = SystemRandom::new();
        let pkcs8 = Ed25519KeyPair::generate_pkcs8(&rng)
            .map_err(|_| anyhow::anyhow!("failed to generate agent identity"))?;
        write_private(path, pkcs8.as_ref())?;
        let key_pair = Ed25519KeyPair::from_pkcs8(pkcs8.as_ref())
            .map_err(|_| anyhow::anyhow!("generated identity did not parse"))?;
        Ok(Self { key_pair })
    }

    pub fn public_key_raw(&self) -> [u8; 32] {
        let mut out = [0u8; 32];
        out.copy_from_slice(self.key_pair.public_key().as_ref());
        out
    }

    pub fn public_key_base64(&self) -> String {
        use base64::Engine as _;
        base64::engine::general_purpose::STANDARD.encode(self.public_key_raw())
    }

    #[allow(dead_code)]
    pub fn sign(&self, message: &[u8]) -> Vec<u8> {
        self.key_pair.sign(message).as_ref().to_vec()
    }
}

fn write_private(path: &Path, bytes: &[u8]) -> Result<()> {
    #[cfg(unix)]
    {
        use std::io::Write as _;
        use std::os::unix::fs::OpenOptionsExt as _;
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(path)
            .context("create identity file")?;
        f.write_all(bytes).context("write identity file")?;
        f.sync_all().ok();
        Ok(())
    }
    #[cfg(not(unix))]
    {
        std::fs::write(path, bytes).context("write identity file")
    }
}

/// Byte-identical to `canonicalProofMessage` in
/// `packages/shared/src/types/identity-proof.ts`. Any divergence is a defect.
#[allow(dead_code)]
pub fn canonical_proof_message(role: &str, session_id: &str, sdp_sha256_hex: &str, fingerprint: &str) -> String {
    format!(
        "{PROOF_VERSION}\nrole={role}\nsessionId={session_id}\nsdpSha256={sdp_sha256_hex}\nfingerprint={fingerprint}"
    )
}

#[allow(dead_code)]
pub fn sha256_hex(bytes: &[u8]) -> String {
    use ring::digest::{digest, SHA256};
    let d = digest(&SHA256, bytes);
    let mut s = String::with_capacity(64);
    for b in d.as_ref() {
        use std::fmt::Write as _;
        let _ = write!(s, "{b:02x}");
    }
    s
}

#[allow(dead_code)]
pub fn verify_proof(public_key_raw: &[u8], message: &[u8], signature: &[u8]) -> bool {
    UnparsedPublicKey::new(&ED25519, public_key_raw)
        .verify(message, signature)
        .is_ok()
}

/// Extract and normalize the first `a=fingerprint:sha-256 …` line from an SDP.
#[allow(dead_code)]
pub fn parse_sdp_fingerprint(sdp: &str) -> Result<String> {
    for line in sdp.split(['\r', '\n']) {
        let line = line.trim();
        if line.to_ascii_lowercase().starts_with("a=fingerprint:") {
            let value = line
                .split_once(' ')
                .map(|(_, v)| v.trim())
                .ok_or_else(|| anyhow::anyhow!("malformed fingerprint line"))?;
            return normalize_fingerprint(value);
        }
    }
    bail!("SDP carries no a=fingerprint line")
}

#[allow(dead_code)]
fn normalize_fingerprint(value: &str) -> Result<String> {
    let parts: Vec<&str> = value.split(':').collect();
    if parts.len() != 32 || parts.iter().any(|p| p.len() != 2 || !p.chars().all(|c| c.is_ascii_hexdigit())) {
        bail!("malformed DTLS fingerprint: {value}");
    }
    Ok(value.to_ascii_uppercase())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn tmp_path(name: &str) -> PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("ponter-id-{}-{}", std::process::id(), name));
        p
    }

    #[test]
    fn generates_then_reloads_the_same_public_key() {
        let path = tmp_path("persist.pkcs8");
        let _ = std::fs::remove_file(&path);
        let a = AgentIdentity::load_or_generate(&path).unwrap();
        let pk_a = a.public_key_raw();
        let b = AgentIdentity::load_or_generate(&path).unwrap();
        assert_eq!(pk_a, b.public_key_raw(), "key must survive a reload");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn identity_file_is_owner_only() {
        let path = tmp_path("perms.pkcs8");
        let _ = std::fs::remove_file(&path);
        let _ = AgentIdentity::load_or_generate(&path).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o077, 0, "no group/other bits allowed");
        }
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn sign_and_verify_round_trip() {
        let path = tmp_path("sign.pkcs8");
        let _ = std::fs::remove_file(&path);
        let id = AgentIdentity::load_or_generate(&path).unwrap();
        let msg = canonical_proof_message("answerer", "s1", "aa", "AB:CD");
        let sig = id.sign(msg.as_bytes());
        assert!(verify_proof(&id.public_key_raw(), msg.as_bytes(), &sig));
        assert!(!verify_proof(&id.public_key_raw(), b"other", &sig));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn canonical_message_binds_role_and_session() {
        let a = canonical_proof_message("offerer", "s1", "aa", "FP");
        let b = canonical_proof_message("answerer", "s1", "aa", "FP");
        let c = canonical_proof_message("offerer", "s2", "aa", "FP");
        assert_ne!(a, b);
        assert_ne!(a, c);
        assert!(a.starts_with("ponter-ws2-v1\n"));
    }

    #[test]
    fn parses_and_normalizes_sdp_fingerprint() {
        let sdp = "v=0\r\na=fingerprint:sha-256 ab:cd:ef:01:23:45:67:89:ab:cd:ef:01:23:45:67:89:ab:cd:ef:01:23:45:67:89:ab:cd:ef:01:23:45:67:89\r\n";
        assert_eq!(
            parse_sdp_fingerprint(sdp).unwrap(),
            "AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89"
        );
        assert!(parse_sdp_fingerprint("v=0\r\n").is_err());
    }
}
