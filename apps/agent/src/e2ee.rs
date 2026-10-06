//! WS1 end-to-end encryption core (Task 1): a byte-identical Rust `EncryptionManager`
//! counterpart to the browser's `EncryptionManager`, verified against the shared
//! test vectors and a deterministic AES-256-GCM KAT.

use ring::aead::{self, Aad, LessSafeKey, Nonce, UnboundKey};
use ring::agreement::{self, EphemeralPrivateKey, UnparsedPublicKey};
use ring::hkdf;
use ring::rand::{SecureRandom, SystemRandom};

use serde::{Deserialize, Serialize};

use crate::identity::{self, base64_decode, base64_encode, AgentIdentity};

pub const IV_BYTES: usize = 12;
pub const TAG_BYTES: usize = 16;
pub const WS1_KEY_VERSION: &str = "ponter-ws1-v1";
pub const WS1_TERMINAL_INFO: &str = "ponter-ws1-terminal-v1";

/// DER prefix for an uncompressed P-256 point as an SPKI (id-ecPublicKey +
/// prime256v1), matching what the browser's `exportPublicKeySpki` emits.
const P256_SPKI_PREFIX: [u8; 26] = [
    0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a,
    0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00,
];

#[derive(Debug, PartialEq, Eq)]
pub enum E2eeError {
    BindingNotVerified,
    Crypto,
    MalformedFrame,
    Encoding,
}

impl From<ring::error::Unspecified> for E2eeError {
    fn from(_: ring::error::Unspecified) -> Self {
        E2eeError::Crypto
    }
}

/// Canonical binding label for WS1 key derivation, binding this ECDH public key
/// (SPKI form, base64) to the `ponter-ws1-v1` protocol version.
pub fn canonical_key_binding(ecdh_public_key_spki_b64: &str) -> String {
    format!("{WS1_KEY_VERSION}\necdhPublicKey={ecdh_public_key_spki_b64}")
}

/// `ring`'s only `KeyType` impl returns the digest output length; RFC 5869 §A.1
/// asks for 42 bytes, so wrap the length in a local `KeyType`.
struct OutLen(usize);
impl hkdf::KeyType for OutLen {
    fn len(&self) -> usize {
        self.0
    }
}

/// HKDF-SHA256 extract-then-expand (RFC 5869) returning `length` bytes.
pub fn hkdf_sha256(ikm: &[u8], salt: &[u8], info: &[u8], length: usize) -> Vec<u8> {
    let salt = hkdf::Salt::new(hkdf::HKDF_SHA256, salt);
    let prk = salt.extract(ikm);
    let info_list = [info];
    let okm = prk.expand(&info_list, OutLen(length)).expect("hkdf expand");
    let mut out = vec![0u8; length];
    okm.fill(&mut out).expect("hkdf fill");
    out
}

/// Encode a raw 65-byte uncompressed P-256 point as an SPKI DER blob,
/// base64-standard-encoded — byte-identical to the browser's
/// `exportPublicKeySpki`.
pub fn spki_from_raw_point(raw_point: &[u8]) -> String {
    let mut der = Vec::with_capacity(P256_SPKI_PREFIX.len() + raw_point.len());
    der.extend_from_slice(&P256_SPKI_PREFIX);
    der.extend_from_slice(raw_point);
    base64_encode(&der)
}

/// Decode an SPKI blob (base64-standard) back to the raw 65-byte uncompressed
/// point. Returns `MalformedFrame` if the DER does not end in a valid
/// uncompressed point.
pub fn raw_point_from_spki_b64(spki_b64: &str) -> Result<Vec<u8>, E2eeError> {
    let der = base64_decode(spki_b64).map_err(|_| E2eeError::Encoding)?;
    if der.len() < 65 {
        return Err(E2eeError::MalformedFrame);
    }
    let point = der[der.len() - 65..].to_vec();
    if point[0] != 0x04 {
        return Err(E2eeError::MalformedFrame);
    }
    Ok(point)
}

/// Generate a fresh ephemeral ECDH P-256 key pair.
pub fn generate_ephemeral() -> Result<EphemeralPrivateKey, E2eeError> {
    let rng = SystemRandom::new();
    EphemeralPrivateKey::generate(&agreement::ECDH_P256, &rng).map_err(Into::into)
}

/// Compute the shared 32-byte X25519-style secret from `my_private` and the
/// peer's raw 65-byte uncompressed point.
pub fn derive_shared_secret(
    my_private: EphemeralPrivateKey,
    peer_point: &[u8],
) -> Result<Vec<u8>, E2eeError> {
    let peer = UnparsedPublicKey::new(&agreement::ECDH_P256, peer_point);
    agreement::agree_ephemeral(my_private, &peer, |secret| secret.to_vec()).map_err(Into::into)
}

/// AES-256-GCM session key + framing engine.
pub struct EncryptionManager {
    key: LessSafeKey,
}

impl EncryptionManager {
    /// Build from a 32-byte AES-256 key.
    pub fn from_key_bytes(key_bytes: &[u8]) -> Result<Self, E2eeError> {
        let unbound =
            UnboundKey::new(&aead::AES_256_GCM, key_bytes).map_err(|_| E2eeError::Crypto)?;
        Ok(Self {
            key: LessSafeKey::new(unbound),
        })
    }

    /// Derive the session key: ECDH → HKDF-SHA256 → AES-256-GCM.
    pub fn derive(
        my_private: EphemeralPrivateKey,
        peer_point: &[u8],
        info: &[u8],
        salt: &[u8],
    ) -> Result<Self, E2eeError> {
        let shared = derive_shared_secret(my_private, peer_point)?;
        let key_bytes = hkdf_sha256(&shared, salt, info, 32);
        Self::from_key_bytes(&key_bytes)
    }

    /// Deterministic seal used by the KAT test (the caller supplies the IV).
    pub fn seal_with_iv(
        &self,
        iv: &[u8; IV_BYTES],
        plaintext: &[u8],
    ) -> Result<Vec<u8>, E2eeError> {
        let nonce = Nonce::assume_unique_for_key(*iv);
        let mut in_out = plaintext.to_vec();
        self.key
            .seal_in_place_append_tag(nonce, Aad::empty(), &mut in_out)
            .map_err(|_| E2eeError::Crypto)?;
        Ok(in_out)
    }

    /// Frame: `[12-byte random IV][AES-GCM ciphertext ‖ 16-byte tag]`.
    pub fn encrypt(&self, plaintext: &[u8]) -> Result<Vec<u8>, E2eeError> {
        let rng = SystemRandom::new();
        let mut iv = [0u8; IV_BYTES];
        rng.fill(&mut iv).map_err(|_| E2eeError::Crypto)?;
        let ct = self.seal_with_iv(&iv, plaintext)?;
        let mut framed = Vec::with_capacity(IV_BYTES + ct.len());
        framed.extend_from_slice(&iv);
        framed.extend_from_slice(&ct);
        Ok(framed)
    }

    pub fn decrypt(&self, framed: &[u8]) -> Result<Vec<u8>, E2eeError> {
        if framed.len() <= IV_BYTES + TAG_BYTES {
            return Err(E2eeError::MalformedFrame);
        }
        let (iv, ct) = framed.split_at(IV_BYTES);
        let nonce = Nonce::try_assume_unique_for_key(iv).map_err(|_| E2eeError::MalformedFrame)?;
        let mut in_out = ct.to_vec();
        let plaintext = self
            .key
            .open_in_place(nonce, Aad::empty(), &mut in_out)
            .map_err(|_| E2eeError::Crypto)?;
        Ok(plaintext.to_vec())
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct E2eeHello {
    pub terminal_id: String,
    pub ecdh_public_key: String,
    pub signature: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct E2eeAck {
    pub terminal_id: String,
    pub ecdh_public_key: String,
    pub signature: String,
}

/// Answerer-side negotiation state. Created only after a hello's Ed25519 binding
/// verified, so a session that exists is always a session that may encrypt.
pub struct E2eeSession {
    manager: EncryptionManager,
}

impl E2eeSession {
    pub fn accept_hello(
        identity: &AgentIdentity,
        session_id: &str,
        hello: &E2eeHello,
        peer_signing_public_key_raw: &[u8; 32],
    ) -> Result<(Self, E2eeAck), E2eeError> {
        // 1. Verify the peer's binding signature BEFORE deriving anything.
        let binding = canonical_key_binding(&hello.ecdh_public_key);
        let signature = base64_decode(&hello.signature).map_err(|_| E2eeError::Encoding)?;
        if !identity::verify_proof(peer_signing_public_key_raw, binding.as_bytes(), &signature) {
            return Err(E2eeError::BindingNotVerified);
        }

        // 2. Generate our ephemeral key and derive the session key.
        let my_private = generate_ephemeral()?;
        let my_public_raw = my_private.compute_public_key()?.as_ref().to_vec();
        let my_spki = spki_from_raw_point(&my_public_raw);
        let peer_point = raw_point_from_spki_b64(&hello.ecdh_public_key)?;
        let manager = EncryptionManager::derive(
            my_private,
            &peer_point,
            WS1_TERMINAL_INFO.as_bytes(),
            session_id.as_bytes(),
        )?;

        // 3. Build our signed ack (the browser derives the same key from it).
        let ack_signature = identity.sign(canonical_key_binding(&my_spki).as_bytes());
        let ack = E2eeAck {
            terminal_id: hello.terminal_id.clone(),
            ecdh_public_key: my_spki,
            signature: base64_encode(&ack_signature),
        };
        Ok((Self { manager }, ack))
    }

    pub fn encrypt(&self, plaintext: &[u8]) -> Result<Vec<u8>, E2eeError> {
        self.manager.encrypt(plaintext)
    }

    pub fn decrypt(&self, framed: &[u8]) -> Result<Vec<u8>, E2eeError> {
        self.manager.decrypt(framed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vectors() -> serde_json::Value {
        // The same file the Vitest suite consumes. Path is relative to the agent
        // crate manifest so it resolves in-repo (CI checks out the whole monorepo).
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../packages/crypto/test/vectors/e2ee-vectors.json"
        );
        let raw = std::fs::read_to_string(path).expect("read e2ee-vectors.json");
        serde_json::from_str(&raw).expect("parse e2ee-vectors.json")
    }

    fn hex_to_vec(hex: &str) -> Vec<u8> {
        assert!(hex.len() % 2 == 0, "odd hex length");
        (0..hex.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).expect("hex"))
            .collect()
    }

    fn to_hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    #[test]
    fn hkdf_matches_rfc5869_a1_vector() {
        let v = vectors();
        let hk = &v["hkdfSha256"];
        let okm = hkdf_sha256(
            &hex_to_vec(hk["ikmHex"].as_str().unwrap()),
            &hex_to_vec(hk["saltHex"].as_str().unwrap()),
            &hex_to_vec(hk["infoHex"].as_str().unwrap()),
            hk["length"].as_u64().unwrap() as usize,
        );
        assert_eq!(to_hex(&okm), hk["okmHex"].as_str().unwrap());
    }

    #[test]
    fn aes_gcm_matches_kat_vector() {
        let v = vectors();
        let g = &v["aesGcm256"];
        let key = hex_to_vec(g["keyHex"].as_str().unwrap());
        let iv: [u8; IV_BYTES] = hex_to_vec(g["ivHex"].as_str().unwrap()).try_into().unwrap();
        let pt = hex_to_vec(g["plaintextHex"].as_str().unwrap());
        let mgr = EncryptionManager::from_key_bytes(&key).unwrap();

        let ct_tag = mgr.seal_with_iv(&iv, &pt).unwrap();
        let expected = format!(
            "{}{}",
            g["ciphertextHex"].as_str().unwrap(),
            g["tagHex"].as_str().unwrap()
        );
        assert_eq!(to_hex(&ct_tag), expected);

        // And the framed decrypt round-trips.
        let mut framed = iv.to_vec();
        framed.extend_from_slice(&ct_tag);
        assert_eq!(mgr.decrypt(&framed).unwrap(), pt);
    }

    #[test]
    fn p256_public_point_spki_matches_js_export() {
        let v = vectors();
        let point = hex_to_vec(v["ecdhP256"]["peerPublicRawHex"].as_str().unwrap());
        assert_eq!(point.len(), 65);
        let spki = spki_from_raw_point(&point);
        assert_eq!(
            spki,
            "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEAhfmF/C2RDkoJ4+WmZ5pojpPLBUr321s32bluAKC1O0ZSn3ry5dxLS3aPKhaqHZaVvRfx1hZllLyiXxlMG5XlA=="
        );
        assert_eq!(raw_point_from_spki_b64(&spki).unwrap(), point);
    }

    #[test]
    fn ecdh_two_ephemeral_keys_agree() {
        let alice = generate_ephemeral().unwrap();
        let bob = generate_ephemeral().unwrap();
        let alice_pub = alice.compute_public_key().unwrap().as_ref().to_vec();
        let bob_pub = bob.compute_public_key().unwrap().as_ref().to_vec();
        let a = derive_shared_secret(alice, &bob_pub).unwrap();
        let b = derive_shared_secret(bob, &alice_pub).unwrap();
        assert_eq!(a, b);
        assert_eq!(a.len(), 32);
    }

    #[test]
    fn encryption_manager_round_trips_and_rejects_tamper() {
        let mgr = EncryptionManager::from_key_bytes(&[7u8; 32]).unwrap();
        let framed = mgr.encrypt(b"hello").unwrap();
        assert!(framed.len() > IV_BYTES + TAG_BYTES);
        assert_eq!(mgr.decrypt(&framed).unwrap(), b"hello");

        let mut tampered = framed.clone();
        let last = tampered.len() - 1;
        tampered[last] ^= 0x01;
        assert!(mgr.decrypt(&tampered).is_err());

        // A frame with no room for a tag is rejected, never panics.
        assert!(mgr.decrypt(&[0u8; IV_BYTES]).is_err());
    }
}

#[cfg(test)]
mod negotiation_tests {
    use super::*;
    use crate::identity::{verify_proof, AgentIdentity};

    fn temp_identity(dir: &std::path::Path) -> AgentIdentity {
        AgentIdentity::load_or_generate(&dir.join("id.json")).expect("identity")
    }

    #[allow(dead_code)]
    fn hex_to_vec(hex: &str) -> Vec<u8> {
        (0..hex.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
            .collect()
    }

    fn vector_peer_signing_key() -> [u8; 32] {
        // Any fixed 32-byte Ed25519 public key works for the binding test; we
        // generate one so the test is self-contained.
        [0x11u8; 32]
    }

    #[test]
    fn accept_hello_derives_and_round_trips() {
        let dir = std::env::temp_dir().join(format!("ponter-e2ee-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let identity = temp_identity(&dir);

        // Simulate the browser: an ephemeral ECDH key + a binding signed by the
        // browser's Ed25519 key. The agent verifies against that public key.
        let browser = generate_ephemeral().unwrap();
        let browser_pub = browser.compute_public_key().unwrap().as_ref().to_vec();
        let browser_spki = spki_from_raw_point(&browser_pub);
        // Sign with a throwaway Ed25519 key whose raw public key we hand the agent.
        let browser_signing = AgentIdentity::load_or_generate(&dir.join("browser.json")).unwrap();
        let browser_signing_pub = browser_signing.public_key_raw();
        let sig = browser_signing.sign(canonical_key_binding(&browser_spki).as_bytes());

        let hello = E2eeHello {
            terminal_id: "t1".into(),
            ecdh_public_key: browser_spki.clone(),
            signature: base64_encode(&sig),
        };

        let (session, ack) =
            E2eeSession::accept_hello(&identity, "sess", &hello, &browser_signing_pub).unwrap();

        // The agent's ack is a valid binding signed by the agent's identity.
        let ack_binding = canonical_key_binding(&ack.ecdh_public_key);
        let ack_sig = base64_decode(&ack.signature).unwrap();
        assert!(verify_proof(
            &identity.public_key_raw(),
            ack_binding.as_bytes(),
            &ack_sig
        ));

        // The browser, given the ack, derives the same key: derive here directly.
        let agent_point = raw_point_from_spki_b64(&ack.ecdh_public_key).unwrap();
        let browser_shared = derive_shared_secret(browser, &agent_point).unwrap();
        let browser_key = hkdf_sha256(&browser_shared, b"sess", WS1_TERMINAL_INFO.as_bytes(), 32);
        let browser_mgr = EncryptionManager::from_key_bytes(&browser_key).unwrap();

        let framed = session.encrypt(b"pty output").unwrap();
        assert_eq!(browser_mgr.decrypt(&framed).unwrap(), b"pty output");
        let framed_back = browser_mgr.encrypt(b"keystroke").unwrap();
        assert_eq!(session.decrypt(&framed_back).unwrap(), b"keystroke");
    }

    #[test]
    fn a_mis_signed_hello_is_rejected_and_yields_no_session() {
        let dir = std::env::temp_dir().join(format!("ponter-e2ee-neg-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let identity = temp_identity(&dir);

        let browser = generate_ephemeral().unwrap();
        let browser_pub = browser.compute_public_key().unwrap().as_ref().to_vec();
        let browser_spki = spki_from_raw_point(&browser_pub);

        // Signature made by a DIFFERENT key than the expected peer key.
        let mallory = AgentIdentity::load_or_generate(&dir.join("mallory.json")).unwrap();
        let sig = mallory.sign(canonical_key_binding(&browser_spki).as_bytes());
        let hello = E2eeHello {
            terminal_id: "t1".into(),
            ecdh_public_key: browser_spki,
            signature: base64_encode(&sig),
        };

        let err = E2eeSession::accept_hello(&identity, "sess", &hello, &vector_peer_signing_key());
        assert!(matches!(err, Err(E2eeError::BindingNotVerified)));
    }
}
