# Phase 5 Week 16 — WS1 part 2 (Rust peer + negotiation activation) + WS5 (web/ops polish) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete application-layer E2EE (WS1) by giving the Rust agent a byte-identical crypto peer — ECDH P-256 → HKDF-SHA256 → AES-GCM-256 over `ring`, bound to the WS2 Ed25519 identity — and by activating the negotiation end-to-end (the agent advertises `e2ee` on its answer; the server relay and browser parser forward the capability; the browser store builds the `E2eeContext` and hands it to `TerminalClient`), proven by the cross-language E2E gate G3; then close the four WS5 polish items (CSP/security headers, token-storage review, coturn hardening, predictable env defaults).

**Architecture:** WS1 part 1 (Week 15) shipped the browser-only half behind a negotiation gate — `EncryptionManager`, `buildSessionKey`, `TerminalE2ee`, and a gated `TerminalClient` — but no peer advertises the capability, so the live terminal path is unchanged. Week 16 adds the missing peer: a Rust `EncryptionManager` in `apps/agent` (reusing the `ring` crate already in the agent's lock graph for its Ed25519 identity), a negotiation driver that produces/consumes `terminal-e2ee-hello`/`-ack` and encrypts terminal data, and the three edits that let the capability travel — the agent's answer, the server relay (`apps/server/src/routes/ws.ts`), and the browser parser (`packages/webrtc-core/src/transport.ts`). The two halves are pinned to the same constants (`WS1_KEY_VERSION`, `WS1_TERMINAL_INFO`, `canonicalKeyBinding`, framing `[12-byte IV][ct ‖ 16-byte tag]`) and the same `e2ee-vectors.json`, so gate G3 proves interoperability rather than assuming it. WS5 is independent polish on the web/ops surface.

**Tech Stack:** TypeScript, Web Crypto, Vitest; Rust 1.85+, `ring` 0.17.14 (already a direct dependency — no new crate), `rtc` 0.21, `tokio`, `serde_json`; Vue 3 (store wiring only); Docker Compose (coturn), Cloudflare Workers Static Assets (`_headers`).

**Spec:** `docs/superpowers/specs/2026-10-05-phase5-zero-trust-e2ee-design.md` (§3.5, §4.2, §4.3, §5, §6, §7 gates G2/G3/G4, §8)

## Design decisions (owner review required before execution)

The spec fixes *what* Week 16 must close (§3.5) but not *how*. These are this plan's decisions; each is repeated in the owning task.

1. **The Rust crypto reuses `ring` 0.17.14 — no new crate.** `ring` is already a direct agent dependency (`apps/agent/Cargo.toml:15`) and already backs the WS2 Ed25519 identity (`apps/agent/src/identity.rs:9-10`). It exposes `agreement::ECDH_P256`, `hkdf::Prk`, and `aead::AES_256_GCM`, which is exactly the WS1 key schedule. Spec §6 risk #1 (measure `ring` build time in Week 15) is **resolved by inspection**: the crate is already compiled on all 6 agent targets for Ed25519, so adding ECDH/HKDF/AES-GCM usage adds code, not build time. **Alternative rejected:** `aws-lc-rs` or a new crate — a second crypto provider with no interoperability upside.

2. **The cross-language contract is the vector file, not a second implementation.** `packages/crypto/test/vectors/e2ee-vectors.json` (HKDF RFC 5869 §A.1, AES-256-GCM KAT, ECDH P-256 fixed vector) is consumed by **both** the Vitest suite and a new Rust unit test. Gate G3 then adds a live round trip (browser encrypts → Rust decrypts and vice versa). This is the spec's §5 intent: interoperability is *proven*, not assumed.

3. **Negotiation activation is three edits on the capability path, and it is the only live-wire change this week.** Week 15 added `capabilities?: string[]` to `SignalAnswer` but nothing reads it. Week 16: (a) the agent sets `capabilities: ["e2ee"]` on its answer when it holds an ECDH key; (b) the server relay's answer branch carries `capabilities` through (today it carries only `sessionId`/`sdp`/`approved`/`proof`); (c) the browser parser's `answer` case reads `capabilities`. All three are additive — a peer that omits the field behaves exactly as today. **Alternative rejected:** a new signal type or channel — the capability belongs on the existing answer envelope.

4. **The negotiation gate stays capability-driven and fail-closed.** The browser builds an `E2eeContext` and passes it to `TerminalClient` **only** when the agent's answer advertised `e2ee` *and* the browser holds its own ECDH key. Absent either, the terminal runs the unchanged plaintext path. The agent encrypts only after a hello whose Ed25519 binding it verified. A mis-signed or malformed hello aborts negotiation and the session stays plaintext on both sides.

5. **Desktop-input encryption rides the same session key, and ADR-29 stays CLOSED.** Spec §3.5 lists "desktop input forwarding encrypted on the same path"; spec §8 keeps the input gate (`--allow-input` / `AGENT_ALLOW_INPUT`, default OFF) closed. Both hold: the desktop-input frames are encrypted with the session key **when the gate is open**, but this plan flips no gate and the default build injects nothing. The gate-closed E2E from Week 9 remains the contract. **Alternative rejected:** opening the gate — explicitly out of scope (spec §8; Phase 6 owns it).

6. **WS5 CSP lands on the real deployment path.** The SPA is served by **Cloudflare Workers Static Assets** (`apps/web/wrangler.toml`), not Caddy/nginx (Caddy only proxies `/api`). The header file is therefore `apps/web/public/_headers` (Vite copies `public/*` into `dist/`), which applies on `wrangler deploy`. A `<meta>` CSP cannot set `frame-ancestors`/HSTS, and a Caddy/nginx header would never reach the SPA.

7. **WS5 token storage is reviewed, and the decision is recorded, not hand-waved.** Audit 5.4 notes `localStorage` is XSS-exfiltrable and pairs with the CSP gap. The browser WebSocket auth model chose it because cookies cannot be set on a `ws` upgrade. This plan's decision: **keep `localStorage`, harden the surface** (strict CSP from item 6 is the mitigation the audit names), and document the tradeoff in the WS1/WS5 security note. Redesigning storage (HttpOnly cookies) would require a WebSocket-auth change well beyond Phase 5. **Alternative rejected:** an in-memory adapter — it breaks refresh-across-tabs for no XSS benefit.

8. **WS5 coturn and env defaults are configuration hardening with pinned values.** coturn: pin the image by digest, and record the `network_mode: host` decision (it is required for TURN's port range; the plan states the residual risk and the mitigation rather than silently dropping it). `.env.example`: the two remaining predictable secrets (`JWT_SECRET`, `REFRESH_TOKEN_SECRET`) are blanked to match the Week 12 CORS pattern (empty ⇒ operator must generate; the server already fails fast on a weak/absent secret via `validate-env.ts`).

9. **Docs close the carry-forward ledger.** A new `docs/security/2026-10-08-ws1-e2ee-rust.md` (or an extension of the Week 15 doc) records the now-complete WS1 boundary and the cross-language proof; `ARCHITECTURE.md` §7.2 loses its "Rust lands Week 16" caveat; the carry-forward notes from Week 15 (half-negotiation race, `capabilities` relay/parse gap) are marked closed; the G2 guard extends to any new doc.

## Global Constraints

- **Layer order is complete — this is the last Phase 5 build week.** WS1 part 2 is the final Layer-3 piece. Do NOT open ADR-29 (`--allow-input` / `AGENT_ALLOW_INPUT` stays default OFF); do NOT implement Phase 6 (low-latency) or Phase 7 (desktop app).
- **Byte-identical cross-language contract.** The `info` string, salt, canonical key-binding string, and framing MUST match Week 15's JS exactly. Any divergence is a defect, and gate G3 is the proof.
- **Fail-closed everywhere.** A hello whose Ed25519 binding does not verify aborts negotiation on both sides; the session stays plaintext. A decrypt failure on any inbound frame surfaces as an error, never as rendered terminal output.
- **No new runtime dependency.** Rust: `ring` is already present (no version bump). JS: Web Crypto only. No new npm package, no new crate.
- **Do not regress the 19 verified-good controls** (spec §2.1) or the WS2/WS3 wire contracts: the `offer`/`answer`/`ice-candidate` envelope, `IdentityProof` canonicalization, `pty-spawn-failed`/`session-limit-reached` spellings, `approved` normalization, the `4409` stale-guard, the `1001` graceful close, and the Week 9 gate-closed input contract.
- **File transfer is NOT encrypted at the application layer** (spec §4.3). This is a boundary, not a preference: no task routes file-transfer payloads through `EncryptionManager`.
- **`apps/web/src/components/ui/` is generated.** Never hand-modify it. This week touches no file under `ui/`.
- **Commit discipline:** path-limited commits only (`git commit -m "..." -- <paths>`). Never `git add .`. Never `git stash`.
- **Sonar new-code gate:** keep new code non-duplicated (extract helpers; parameterize test cases rather than clone blocks). Test files count toward duplication — the Week 13 gotcha (18.3% duplication in test files) is the cautionary case.
- **Language:** code, commit messages, and technical docs in English. Conversation replies in Vietnamese.

## Review Focus

The failure modes the spec implies but no single task's happy-path test exercises. Each line's test is added in the owning task.

1. **A Rust/JS key-schedule divergence that still round-trips within one language.** Two implementations that each pass their own tests can still disagree on `info`, salt, or framing. → Task 1 (shared vector file, both languages) and Task 7 (cross-language E2E).
2. **A session key derived from an unverified ECDH key on the Rust side.** The agent must verify the browser's Ed25519 binding over the ECDH key before deriving — the Week 15 fail-closed rule, now enforced in Rust. → Task 2 and Task 3.
3. **The capability path silently dropping `e2ee`.** If the server relay or the browser parser drops `capabilities`, negotiation never starts and the failure is silent (the session just stays plaintext). → Task 4 and Task 5 (round-trip test through relay + parser).
4. **A half-negotiated session rendering ciphertext.** The Week 15 carry-forward race: if activation can happen between a hello and its ack, a frame could be encrypted before the peer can decrypt. → Task 3 and Task 5 (never render ciphertext; activate atomically; order negotiation through the same chain as data).
5. **Encryption leaking onto the plaintext path when no peer negotiates.** A legacy agent (no `e2ee` capability) must get a byte-identical plaintext terminal. → Task 5 and Task 7.
6. **The input gate opened by accident.** The desktop-input path must stay inert by default; a capability value must never gate input (it is attacker-controlled). → Task 6 (gate-closed test still passes).
7. **A false E2EE claim now that the feature is real end-to-end — or a stale "not yet active" claim.** Gate G2 cuts both ways: the docs must now say the terminal path *is* end-to-end encrypted when both peers negotiate, and must not over-claim (e.g., file transfer, video). → Task 9.

---

## File map

| File | Task | Responsibility |
|------|------|----------------|
| `apps/agent/src/e2ee.rs` | 1, 2 | Rust `EncryptionManager` (ECDH/HKDF/AES-GCM over `ring`), constants, framing, `E2eeSession` negotiation driver, `E2eeHello`/`E2eeAck`. |
| `apps/agent/src/main.rs` | 1, 2, 3 | `mod e2ee;`; wire the negotiation + encryption into the terminal session loop. |
| `apps/agent/src/identity.rs` | 2 | Make `sign`/`verify_proof`/`base64_*` usable by `e2ee` (drop `#[allow(dead_code)]`, ensure `pub(crate)`). |
| `apps/agent/src/signal.rs` | 3 | Add `capabilities` to `SignalAnswer`. |
| `apps/agent/src/rtc.rs` | 3 | `send_answer` sets `capabilities: ["e2ee"]` when the offer proposed it. |
| `apps/agent/src/pty.rs` | 3 | `Outbound` enum + `build_terminal_data_frame` so the pump can encrypt before framing. |
| `apps/server/src/routes/ws.ts` | 4 | Relay forwards `capabilities` on the answer branch. |
| `apps/server/src/routes/signal.ts` | 4 | REST answer route forwards `capabilities`. |
| `packages/shared/src/types/signaling.ts` | 4 | `parseAnswer` carries `capabilities`. |
| `packages/shared/src/types/e2ee.ts` | 2 (read-only ref) | Canonical constants; unchanged (already complete). |
| `packages/webrtc-core/src/signal-handler.ts` | 5 | `createAnswerSignal` takes `capabilities`. |
| `packages/webrtc-core/src/connection.ts` | 5 | Answerer passes capabilities; offerer stores/ exposes `remoteCapabilities`. |
| `packages/webrtc-core/src/transport.ts` | 5 | `parseSignalItem` answer case carries `capabilities`. |
| `packages/webrtc-core/src/types.ts` | 5 | Document `capabilities`; add the remote-capabilities accessor type. |
| `packages/crypto/src/index.ts` | 5 | `savePublicKey`/`loadPublicKey` for the browser ECDH public key. |
| `apps/web/src/stores/auth.ts` | 5 | Persist the ECDH public key at registration. |
| `packages/terminal-core/src/client.ts` | 5 | Drive hello/ack negotiation; order negotiation through the data chain. |
| `apps/web/src/stores/terminal.ts` | 5, 6 | Build `E2eeContext`; add `e2ee` to offer capabilities; pass context to `TerminalClient`/`DesktopClient`. |
| `packages/desktop-core/src/client.ts` | 6 | Encrypt desktop-input frames when the control session is E2EE-active. |
| `apps/agent/src/main.rs` (desktop dispatch) | 6 | Negotiate + decrypt desktop-input before `apply_if_allowed`. |
| `packages/webrtc-core/test/e2e/terminal-e2ee.e2e.test.ts` | 7 | New cross-language E2EE E2E (gate G3). |
| `packages/webrtc-core/test/e2e/harness.ts` | 7 | Helpers to open an E2EE terminal peer and negotiate. |
| `apps/web/public/_headers` | 8 | CSP + security headers for the Cloudflare-served SPA. |
| `apps/web/src/__tests__/headers.test.ts` | 8 | Asserts the CSP/security-header file is present and strict. |
| `docker/docker-compose.prod.yml` | 9 | Pin coturn by digest; document `network_mode: host`. |
| `docker/.env.example` | 9 | Blank `JWT_SECRET`/`REFRESH_TOKEN_SECRET`. |
| `docs/security/2026-10-08-ws1-e2ee-rust.md` | 9 | New: complete WS1 boundary + cross-language proof + token-storage decision. |
| `docs/ARCHITECTURE.md` | 9 | §7.2 loses the "Rust lands Week 16" caveat. |
| `docs/guides/terminal-protocol.md` | 9 | §3.7 marks the agent side shipped. |
| `apps/web/src/__tests__/e2ee-claims.test.ts` | 9 | G2 guard extended to the new doc. |

---

### Task 1: Rust crypto core (`EncryptionManager` over `ring`) with shared-vector parity

**Files:**
- Create: `apps/agent/src/e2ee.rs`
- Modify: `apps/agent/src/main.rs` (add `mod e2ee;` to the module list at the top)
- Test: the `#[cfg(test)] mod tests` inside `apps/agent/src/e2ee.rs`

**Interfaces:**
- Consumes: `crate::identity::{base64_encode, base64_decode}` (make them `pub(crate)` if they are not already); `ring` 0.17.14; `serde_json`.
- Produces (used by Tasks 2, 3, 7):
  - `pub const IV_BYTES: usize = 12;`
  - `pub const TAG_BYTES: usize = 16;`
  - `pub const WS1_KEY_VERSION: &str = "ponter-ws1-v1";`
  - `pub const WS1_TERMINAL_INFO: &str = "ponter-ws1-terminal-v1";`
  - `pub fn canonical_key_binding(ecdh_public_key_spki_b64: &str) -> String`
  - `pub fn hkdf_sha256(ikm: &[u8], salt: &[u8], info: &[u8], length: usize) -> Vec<u8>`
  - `pub fn spki_from_raw_point(raw_point: &[u8]) -> String`
  - `pub fn raw_point_from_spki_b64(spki_b64: &str) -> Result<Vec<u8>, E2eeError>`
  - `pub fn generate_ephemeral() -> Result<ring::agreement::EphemeralPrivateKey, E2eeError>`
  - `pub struct EncryptionManager` with `derive`, `from_key_bytes`, `encrypt`, `decrypt`, and a deterministic `seal_with_iv`
  - `pub enum E2eeError { BindingNotVerified, Crypto, MalformedFrame, Encoding }`

- [ ] **Step 1: Add the module declaration**

In `apps/agent/src/main.rs`, add `mod e2ee;` to the alphabetical `mod` block (`mod desktop; mod files; mod identity; mod input; mod logging; mod pty; mod rtc; mod shell_policy; mod signal;` → insert `mod e2ee;` after `mod desktop;`).

- [ ] **Step 2: Write the failing vector-parity test first**

Create `apps/agent/src/e2ee.rs` containing only the constants, the helper signatures, and the test module below (implementations can `unimplemented!()` for the first run).

```rust
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
        let iv: [u8; IV_BYTES] = hex_to_vec(g["ivHex"].as_str().unwrap())
            .try_into()
            .unwrap();
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
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cargo test --manifest-path apps/agent/Cargo.toml e2ee`
Expected: FAIL to compile (`hkdf_sha256`, `EncryptionManager`, etc. not yet implemented).

- [ ] **Step 4: Implement the module**

Replace the `unimplemented!()` bodies with:

```rust
use ring::aead::{self, Aad, LessSafeKey, Nonce, UnboundKey};
use ring::agreement::{self, EphemeralPrivateKey, UnparsedPublicKey};
use ring::hkdf;
use ring::rand::SystemRandom;

use crate::identity::{base64_decode, base64_encode};

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

pub fn hkdf_sha256(ikm: &[u8], salt: &[u8], info: &[u8], length: usize) -> Vec<u8> {
    let salt = hkdf::Salt::new(hkdf::HKDF_SHA256, salt);
    let prk = salt.extract(ikm);
    let okm = prk.expand(&[info], OutLen(length)).expect("hkdf expand");
    let mut out = vec![0u8; length];
    okm.fill(&mut out).expect("hkdf fill");
    out
}

pub fn spki_from_raw_point(raw_point: &[u8]) -> String {
    let mut der = Vec::with_capacity(P256_SPKI_PREFIX.len() + raw_point.len());
    der.extend_from_slice(&P256_SPKI_PREFIX);
    der.extend_from_slice(raw_point);
    base64_encode(&der)
}

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

pub fn generate_ephemeral() -> Result<EphemeralPrivateKey, E2eeError> {
    let rng = SystemRandom::new();
    EphemeralPrivateKey::generate(&agreement::ECDH_P256, &rng).map_err(Into::into)
}

pub fn derive_shared_secret(
    my_private: EphemeralPrivateKey,
    peer_point: &[u8],
) -> Result<Vec<u8>, E2eeError> {
    let peer = UnparsedPublicKey::new(&agreement::ECDH_P256, peer_point);
    agreement::agree_ephemeral(my_private, &peer, |secret| Ok(secret.to_vec())).map_err(Into::into)
}

pub struct EncryptionManager {
    key: LessSafeKey,
}

impl EncryptionManager {
    pub fn from_key_bytes(key_bytes: &[u8]) -> Result<Self, E2eeError> {
        let unbound = UnboundKey::new(&aead::AES_256_GCM, key_bytes).map_err(|_| E2eeError::Crypto)?;
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
    pub fn seal_with_iv(&self, iv: &[u8; IV_BYTES], plaintext: &[u8]) -> Result<Vec<u8>, E2eeError> {
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
```

> Note the short-frame guard uses `<= IV_BYTES + TAG_BYTES` (not `<= IV_BYTES`): a frame with an IV but no tag cannot be authenticated, so it is malformed. This is stricter than the Week 15 JS guard and is the correct Rust-side check.

- [ ] **Step 5: Run the test to verify it passes**

Run: `cargo test --manifest-path apps/agent/Cargo.toml e2ee`
Expected: PASS — 5 tests.

- [ ] **Step 6: Verify no clippy/format regressions**

Run: `cargo fmt --manifest-path apps/agent/Cargo.toml -- --check && cargo clippy --manifest-path apps/agent/Cargo.toml -- -D warnings`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add apps/agent/src/e2ee.rs apps/agent/src/main.rs apps/agent/src/identity.rs
git commit -m "feat(agent): WS1 Rust crypto core (ECDH/HKDF/AES-GCM) with shared-vector parity"
```

---

### Task 2: Rust negotiation driver (`E2eeSession`) with Ed25519 binding verification

**Files:**
- Modify: `apps/agent/src/e2ee.rs`
- Modify: `apps/agent/src/identity.rs` (drop `#[allow(dead_code)]` on `sign`; ensure `sign`, `verify_proof`, `base64_encode`, `base64_decode` are `pub(crate)`)
- Test: the `#[cfg(test)] mod tests` inside `apps/agent/src/e2ee.rs`

**Interfaces:**
- Consumes (Task 1): `EncryptionManager`, `generate_ephemeral`, `spki_from_raw_point`, `raw_point_from_spki_b64`, `canonical_key_binding`, `WS1_TERMINAL_INFO`.
- Consumes (`apps/agent/src/identity.rs`): `AgentIdentity::sign(&self, message: &[u8]) -> Vec<u8>`, `verify_proof(public_key_raw: &[u8; 32], message: &[u8], signature: &[u8]) -> bool`, `base64_encode`, `base64_decode`.
- Produces (used by Task 3):
  - `pub struct E2eeHello { pub terminal_id: String, pub ecdh_public_key: String, pub signature: String }` (`#[serde(rename_all = "camelCase")]`, `Deserialize`)
  - `pub struct E2eeAck { pub terminal_id: String, pub ecdh_public_key: String, pub signature: String }` (`Serialize`)
  - `pub struct E2eeSession` with:
    - `pub fn accept_hello(identity: &AgentIdentity, session_id: &str, hello: &E2eeHello, peer_signing_public_key_raw: &[u8; 32]) -> Result<(E2eeSession, E2eeAck), E2eeError>`
    - `pub fn encrypt(&self, plaintext: &[u8]) -> Result<Vec<u8>, E2eeError>`
    - `pub fn decrypt(&self, framed: &[u8]) -> Result<Vec<u8>, E2eeError>`

- [ ] **Step 1: Write the failing tests**

Append to `apps/agent/src/e2ee.rs`:

```rust
#[cfg(test)]
mod negotiation_tests {
    use super::*;
    use crate::identity::AgentIdentity;

    fn temp_identity(dir: &std::path::Path) -> AgentIdentity {
        AgentIdentity::load_or_generate(&dir.join("id.json")).expect("identity")
    }

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

        let (mut session, ack) =
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
        let browser_key = hkdf_sha256(
            &browser_shared,
            b"sess",
            WS1_TERMINAL_INFO.as_bytes(),
            32,
        );
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test --manifest-path apps/agent/Cargo.toml e2ee::negotiation_tests`
Expected: FAIL to compile (`E2eeSession`, `E2eeHello`, `E2eeAck` undefined).

- [ ] **Step 3: Implement the driver**

Add to `apps/agent/src/e2ee.rs`:

```rust
use serde::{Deserialize, Serialize};

use crate::identity::{self, AgentIdentity};

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
```

In `apps/agent/src/identity.rs`: remove `#[allow(dead_code)]` from `sign` (it is now used by `e2ee`); confirm `sign`, `verify_proof`, `base64_encode`, `base64_decode` are `pub(crate)` (add the qualifier if any is private).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test --manifest-path apps/agent/Cargo.toml e2ee`
Expected: PASS — 7 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/agent/src/e2ee.rs apps/agent/src/identity.rs
git commit -m "feat(agent): WS1 E2eeSession negotiation with Ed25519 binding verification"
```

---

### Task 3: Agent advertises `e2ee` and encrypts terminal I/O

**Files:**
- Modify: `apps/agent/src/signal.rs` (`SignalAnswer` gains `capabilities`)
- Modify: `apps/agent/src/rtc.rs` (`send_answer` sets capabilities)
- Modify: `apps/agent/src/pty.rs` (`Outbound` enum + `build_terminal_data_frame`)
- Modify: `apps/agent/src/main.rs` (terminal session loop: hello/ack handling, encrypted pump)
- Test: `apps/agent/src/pty.rs` unit test + `apps/agent/src/rtc.rs` unit test

**Interfaces:**
- Consumes (Task 2): `E2eeSession`, `E2eeHello`, `E2eeAck`; `identity::base64_decode`/`base64_encode`.
- Produces (used by Task 8's E2E):
  - `SignalAnswer.capabilities: Vec<String>` on the wire.
  - An encrypted terminal path: `terminal-e2ee-hello` in → `terminal-e2ee-ack` out → subsequent `terminal-data` payloads are ciphertext, byte-compatible with the browser's framing.

- [ ] **Step 1: Write the failing tests**

Add to `apps/agent/src/pty.rs`:

```rust
#[cfg(test)]
mod outbound_tests {
    use super::*;

    #[test]
    fn plaintext_frame_is_byte_identical_to_today() {
        // The wire shape is the NESTED DataChannelMessage envelope
        // (`{type, channel, payload:{terminalId,data}, timestamp}`), matching
        // `frame_pty_output` in pty.rs:104-112. `build_terminal_data_frame` must
        // reproduce it byte-for-byte so the plaintext path is unchanged.
        let frame = build_terminal_data_frame("t1", b"hello world", 123);
        let v: serde_json::Value = serde_json::from_str(&frame).unwrap();
        assert_eq!(v["type"], "terminal-data");
        assert_eq!(v["channel"], "terminal");
        assert_eq!(v["payload"]["terminalId"], "t1");
        assert_eq!(v["payload"]["data"], "aGVsbG8gd29ybGQ=");
        assert_eq!(v["timestamp"], 123);
    }

    #[test]
    fn outbound_terminal_data_carries_raw_bytes() {
        let o = Outbound::TerminalData {
            terminal_id: "t1".into(),
            bytes: b"x".to_vec(),
            timestamp_ms: 5,
        };
        match o {
            Outbound::TerminalData { bytes, .. } => assert_eq!(bytes, b"x"),
            _ => panic!("wrong variant"),
        }
    }
}
```

Add to `apps/agent/src/rtc.rs` (a focused test of the capability selection rule):

```rust
#[cfg(test)]
mod answer_capability_tests {
    use super::*;

    #[test]
    fn answer_advertises_e2ee_only_when_offer_proposed_it() {
        assert_eq!(negotiated_capabilities(&["terminal".into(), "e2ee".into()]), vec!["e2ee".to_string()]);
        assert!(negotiated_capabilities(&["terminal".into()]).is_empty());
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test --manifest-path apps/agent/Cargo.toml pty::outbound_tests rtc::answer_capability_tests`
Expected: FAIL to compile (`build_terminal_data_frame`, `Outbound`, `negotiated_capabilities` undefined).

- [ ] **Step 3: Add `capabilities` to the answer type**

In `apps/agent/src/signal.rs`, extend `SignalAnswer` (currently `{ session_id, sdp, approved, proof }`):

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SignalAnswer {
    pub session_id: String,
    pub sdp: String,
    pub approved: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proof: Option<IdentityProof>,
    /// WS1: capabilities the answerer selected from the offer (e.g. `"e2ee"`).
    /// Additive — omitted when empty, so a legacy answer is byte-identical.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub capabilities: Vec<String>,
}
```

- [ ] **Step 4: Select capabilities in `rtc.rs` and thread them into `send_answer`**

Add to `apps/agent/src/rtc.rs`:

```rust
/// The capability token the agent answers with when it can encrypt.
pub const E2EE_CAPABILITY: &str = "e2ee";

/// Select `e2ee` from the offer's capabilities. The answerer only ever echoes a
/// capability the offerer proposed, so a legacy offer never yields an e2ee answer.
pub fn negotiated_capabilities(offer_capabilities: &[String]) -> Vec<String> {
    if offer_capabilities.iter().any(|c| c == E2EE_CAPABILITY) {
        vec![E2EE_CAPABILITY.to_string()]
    } else {
        Vec::new()
    }
}
```

Update `answer_offer(peer, offer, outbound, identity)`: it already computes `approved` from `offer.capabilities`. Compute `let capabilities = negotiated_capabilities(&offer.capabilities);` and pass it to `send_answer`. Update `send_answer` to build the answer as:

```rust
SignalMessage::Answer(SignalAnswer {
    session_id: offer.session_id.clone(),
    sdp: answer.sdp,
    approved,
    proof: Some(proof),
    capabilities,
})
```

Leave `refuse_offer` with `capabilities: Vec::new()` (a refusal advertises nothing).

- [ ] **Step 5: Introduce the `Outbound` enum in `pty.rs`**

Change the reader→pump channel payload from `String` to `Outbound`:

```rust
/// A frame the pump will emit. Control frames stay pre-serialized JSON; terminal
/// output carries raw bytes so the pump can encrypt before framing.
#[derive(Debug, Clone)]
pub enum Outbound {
    /// A pre-serialized JSON frame that is never encrypted (control frames).
    Json(String),
    /// Terminal output bytes, framed (and encrypted when the session is active).
    TerminalData {
        terminal_id: String,
        bytes: Vec<u8>,
        timestamp_ms: i64,
    },
}

/// Build the `terminal-data` frame JSON. `data` is the (possibly encrypted)
/// payload; base64-encoding happens here so both paths share one spelling.
///
/// The wire shape is the NESTED `DataChannelMessage` envelope — reuse the same
/// struct `frame_pty_output` uses so the plaintext path stays byte-identical:
/// `{"type":"terminal-data","channel":"terminal","payload":{"terminalId":..,"data":..},"timestamp":..}`.
pub fn build_terminal_data_frame(terminal_id: &str, data: &[u8], timestamp_ms: i64) -> String {
    let message = DataChannelMessage {
        r#type: "terminal-data".to_string(),
        channel: "terminal".to_string(),
        payload: TerminalDataMessage {
            terminal_id: terminal_id.to_string(),
            data: STANDARD.encode(data),
        },
        timestamp: timestamp_ms,
    };
    serde_json::to_string(&message).expect("a frame of strings cannot fail to serialize")
}
```

Refactor `frame_pty_output(terminal_id, bytes, timestamp_ms)` to delegate to `build_terminal_data_frame(terminal_id, bytes, timestamp_ms)` (same nested shape → plaintext path unchanged). Change `start_reader`'s converter to emit `Outbound::TerminalData { terminal_id, bytes, timestamp_ms }` instead of a JSON string. Any producer that emits a control frame (`terminal-exit`, `terminal-error`, spawn-failed) wraps its JSON in `Outbound::Json(...)`.

- [ ] **Step 6: Wire negotiation + encryption into the terminal session (`main.rs`)**

In `run_one_session`'s terminal branch (after `verify_offer_identity`, before/around `rtc::answer_offer`):

1. Parse the browser's signing key raw bytes from the offer (`verify_offer_identity` already resolves `offer.user_signing_public_key`; reuse that decoded `[u8; 32]`).
2. Change the pump loop (which today drains `frame_rx: mpsc::Receiver<String>` → `dc.send_text`) to drain `Outbound`:

```rust
while let Some(item) = frame_rx.recv().await {
    let text = match item {
        Outbound::Json(s) => s,
        Outbound::TerminalData { terminal_id, bytes, timestamp_ms } => {
            let data = match &e2ee_session {
                Some(session) => match session.encrypt(&bytes) {
                    Ok(ct) => ct,
                    // Fail-closed: drop the frame rather than emit plaintext.
                    Err(e) => {
                        tracing::debug!("terminal-data encrypt failed, dropping frame: {e:?}");
                        continue;
                    }
                },
                None => bytes,
            };
            pty::build_terminal_data_frame(&terminal_id, &data, timestamp_ms)
        }
    };
    dc.send_text(&text).await?;
}
```

3. In the dispatch loop, handle the two negotiation frames **before** the terminal-data arm. Note the wire frame is the nested envelope, so the hello fields live under `payload`:

```rust
"terminal-e2ee-hello" => {
    // Only negotiate if the offer proposed e2ee and the peer key is known.
    if negotiated && e2ee_session.is_none() {
        // The frame is `{type, channel, payload:{terminalId,ecdhPublicKey,signature}, timestamp}`.
        let hello: E2eeHello = match serde_json::from_value(envelope["payload"].clone()) {
            Ok(h) => h,
            Err(e) => { tracing::debug!("bad e2ee-hello, staying plaintext: {e:?}"); continue; }
        };
        match E2eeSession::accept_hello(&cfg.identity, &session_id, &hello, &peer_signing_raw) {
            Ok((session, ack)) => {
                e2ee_session = Some(session);
                // The ack is itself a nested DataChannelMessage envelope.
                let ack_json = serde_json::json!({
                    "type": "terminal-e2ee-ack",
                    "channel": "terminal",
                    "payload": {
                        "terminalId": ack.terminal_id,
                        "ecdhPublicKey": ack.ecdh_public_key,
                        "signature": ack.signature,
                    },
                    "timestamp": pty::now_ms(),
                });
                dispatch_tx.send(Outbound::Json(ack_json.to_string())).await?;
            }
            // Fail-closed: a hello that does not verify leaves the session plaintext.
            Err(e) => { tracing::debug!("e2ee-hello rejected, staying plaintext: {e:?}"); }
        }
    }
}
```

4. In the `terminal-data` arm (input path), decrypt when a session is active — fail-closed (drop, never forward plaintext on a decrypt failure):

```rust
let raw = STANDARD_ENGINE.decode(data_b64)?;
let bytes = match &e2ee_session {
    Some(session) => match session.decrypt(&raw) {
        Ok(pt) => pt,
        Err(e) => { tracing::debug!("terminal-data decrypt failed, dropping input: {e:?}"); continue; }
    },
    None => raw,
};
manager_for_dispatch.send_input(terminal_id, bytes);
```

5. After the agent sends its answer, if the offer proposed `e2ee`, mark `negotiated = true` so a hello is accepted. The agent never *initiates* — the browser sends the hello first.

> **Atomicity (Review Focus #4).** The agent sets `e2ee_session` only inside the `accept_hello` success arm, and it emits the ack into the same ordered `dispatch_tx` the pump drains. Because a DataChannel preserves order, the browser receives the ack before any ciphertext frame; combined with Task 5's ordered receive chain, no frame is ever rendered before its key exists.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cargo test --manifest-path apps/agent/Cargo.toml && cargo clippy --manifest-path apps/agent/Cargo.toml -- -D warnings`
Expected: PASS (all agent tests), clippy clean.

- [ ] **Step 8: Verify the plaintext contract is untouched**

Run: `cargo test --manifest-path apps/agent/Cargo.toml pty`
Expected: PASS — the `plaintext_frame_is_byte_identical_to_today` test pins the exact JSON.

- [ ] **Step 9: Commit**

```bash
git add apps/agent/src/signal.rs apps/agent/src/rtc.rs apps/agent/src/pty.rs apps/agent/src/main.rs
git commit -m "feat(agent): advertise e2ee capability and encrypt terminal I/O"
```

---

### Task 4: Server relay and shared parser forward `capabilities`

**Files:**
- Modify: `apps/server/src/routes/ws.ts` (`parseSignalMessage` answer branch, ~line 1119)
- Modify: `apps/server/src/routes/signal.ts` (`POST /api/signal/answer`, ~lines 125-195)
- Modify: `packages/shared/src/types/signaling.ts` (`parseAnswer`, ~lines 216-228)
- Test: `packages/shared/test/signaling.test.ts` (add a case) and `apps/server/test/signal.test.ts` (add a case)

**Interfaces:**
- Consumes: `SignalAnswer.capabilities?: string[]` (already declared in `packages/shared/src/types/signaling.ts`).
- Produces: an answer that round-trips `capabilities` from the agent → server → browser. Byte-identical when `capabilities` is absent.

- [ ] **Step 1: Write the failing shared test**

Add to `packages/shared/test/signaling.test.ts`:

```ts
it('parseAnswer preserves capabilities when present and omits it when absent', () => {
  const withCaps = parseAnswer({
    type: 'answer',
    data: { sessionId: 's1', sdp: 'v=0', approved: true, capabilities: ['e2ee'] },
  });
  expect(withCaps.data.capabilities).toEqual(['e2ee']);

  const withoutCaps = parseAnswer({
    type: 'answer',
    data: { sessionId: 's1', sdp: 'v=0', approved: true },
  });
  expect('capabilities' in withoutCaps.data).toBe(false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @ponter/shared test -- signaling`
Expected: FAIL — `capabilities` is dropped by `parseAnswer`.

- [ ] **Step 3: Carry `capabilities` in `parseAnswer`**

In `packages/shared/src/types/signaling.ts`, `parseAnswer` currently returns `{ type:'answer', data:{ sessionId, sdp, approved: inner.approved !== false } }`. Read `capabilities` and include it only when it is a non-empty string array:

```ts
const capabilities = Array.isArray(inner.capabilities)
  ? (inner.capabilities as unknown[]).filter((c): c is string => typeof c === 'string')
  : [];
return {
  type: 'answer',
  data: {
    sessionId,
    sdp,
    approved: inner.approved !== false,
    ...(capabilities.length > 0 ? { capabilities } : {}),
  },
};
```

- [ ] **Step 4: Write the failing server test**

Add to `apps/server/test/signal.test.ts` (or the route's existing test file):

```ts
it('POST /api/signal/answer forwards capabilities to the agent', async () => {
  // ...arrange a session + a fake agent socket (see existing cases in this file)...
  const res = await app.request('/api/signal/answer', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ sessionId, sdp: 'v=0', approved: true, capabilities: ['e2ee'] }),
  });
  expect(res.status).toBe(200);
  const pushed = lastAgentPush(); // existing helper in this file
  expect(pushed.data.capabilities).toEqual(['e2ee']);
});
```

- [ ] **Step 5: Carry `capabilities` in the REST answer route**

In `apps/server/src/routes/signal.ts`, extend the body type to `{ sessionId?; sdp?; approved?; proof?; capabilities?: string[] }` and build the message with the field only when non-empty:

```ts
const capabilities = Array.isArray(body.capabilities)
  ? body.capabilities.filter((c): c is string => typeof c === 'string')
  : [];
const message: SignalMessage = {
  type: 'answer',
  data: {
    sessionId,
    sdp,
    approved: body.approved !== false,
    ...(proof ? { proof } : {}),
    ...(capabilities.length > 0 ? { capabilities } : {}),
  },
};
```

- [ ] **Step 6: Carry `capabilities` in the WebSocket relay**

In `apps/server/src/routes/ws.ts`, `parseSignalMessage`'s `answer` branch (currently reads only `sessionId`/`sdp`/`approved`/`proof`) — add:

```ts
const capabilities = Array.isArray(inner.capabilities)
  ? inner.capabilities.filter((c): c is string => typeof c === 'string')
  : [];
// ...include in the returned answer:
...(capabilities.length > 0 ? { capabilities } : {}),
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm --filter @ponter/shared test -- signaling && pnpm --filter @ponter/server test -- signal`
Expected: PASS.

- [ ] **Step 8: Add a relay round-trip guard (Review Focus #3)**

Add a test that asserts the answer survives the **full** server path (WS relay parse → push), not just the REST route — so a future refactor that drops the field on either hop goes red. Use the existing `parseSignalMessage` unit test surface in `apps/server/test/`:

```ts
it('the WS answer relay preserves capabilities', () => {
  const parsed = parseSignalMessage({
    type: 'answer',
    data: { sessionId: 's1', sdp: 'v=0', approved: true, capabilities: ['e2ee'] },
  });
  expect(parsed.data.capabilities).toEqual(['e2ee']);
});
```

- [ ] **Step 9: Commit**

```bash
git add apps/server/src/routes/ws.ts apps/server/src/routes/signal.ts packages/shared/src/types/signaling.ts packages/shared/test/signaling.test.ts apps/server/test/signal.test.ts
git commit -m "feat(signaling): relay capabilities through server and shared parser"
```

---

### Task 5: Browser capability path + `E2eeContext` builder + negotiation wiring

**Files:**
- Modify: `packages/webrtc-core/src/signal-handler.ts` (`createAnswerSignal`)
- Modify: `packages/webrtc-core/src/connection.ts` (answerer passes capabilities; offerer stores/exposes them)
- Modify: `packages/webrtc-core/src/transport.ts` (`parseSignalItem` answer case)
- Modify: `packages/crypto/src/index.ts` (`savePublicKey`/`loadPublicKey`)
- Modify: `apps/web/src/stores/auth.ts` (persist the ECDH public key at registration)
- Modify: `packages/terminal-core/src/client.ts` (hello/ack + ordered chain)
- Modify: `apps/web/src/stores/terminal.ts` (build `E2eeContext`, add `e2ee` to offer capabilities, pass context)
- Test: `packages/webrtc-core/test/*`, `packages/crypto/test/index.test.ts`, `packages/terminal-core/test/e2ee.test.ts`, `apps/web/src/stores/__tests__/terminal.test.ts`

**Interfaces:**
- Consumes: `SignalAnswer.capabilities?: string[]`; `TerminalE2ee`, `E2eeContext` (Week 15); `loadPrivateKey`/`loadSigningKey`/`importSigningPublicKeyRaw` from `@ponter/crypto`.
- Produces:
  - `PeerConnection.getRemoteCapabilities(): string[]` — the answerer's selected capabilities.
  - `createAnswerSignal(sessionId, desc, approved?, proof?, capabilities?)`.
  - `savePublicKey(userId, key)` / `loadPublicKey(userId)`.
  - `TerminalClient` negotiates automatically when it holds an `E2eeContext` and the peer advertised `e2ee`.

- [ ] **Step 1: Write the failing webrtc-core tests**

Add to the relevant `packages/webrtc-core/test/*.test.ts`:

```ts
it('createAnswerSignal includes capabilities only when non-empty', () => {
  const withCaps = createAnswerSignal('s1', { type: 'answer', sdp: 'v=0' } as never, true, undefined, ['e2ee']);
  expect((withCaps.data as { capabilities?: string[] }).capabilities).toEqual(['e2ee']);
  const without = createAnswerSignal('s1', { type: 'answer', sdp: 'v=0' } as never, true);
  expect('capabilities' in (without.data as object)).toBe(false);
});

it('the answer parser preserves capabilities', () => {
  const item = { type: 'answer', data: { sessionId: 's1', sdp: 'v=0', approved: true, capabilities: ['e2ee'] } };
  const parsed = (transport as never as { parseSignalItem(i: unknown): { data: { capabilities?: string[] } } })
    .parseSignalItem(item);
  expect(parsed.data.capabilities).toEqual(['e2ee']);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @ponter/webrtc-core test`
Expected: FAIL.

- [ ] **Step 3: Thread capabilities through webrtc-core**

- `signal-handler.ts`: `createAnswerSignal(sessionId, desc, approved = true, proof?, capabilities: string[] = [])` — include `capabilities` only when non-empty.
- `connection.ts` `case 'offer'` (answerer): pass the selected capabilities into `createAnswerSignal`. The offerer's `case 'answer'`: read `msg.data.capabilities` into a private `remoteCapabilities` field; add `getRemoteCapabilities(): string[]` returning it (empty when absent).
- `transport.ts` `parseSignalItem` answer case: add `...(capabilities.length > 0 ? { capabilities } : {})` mirroring `parseAnswer`.

- [ ] **Step 4: Write the failing crypto test for public-key persistence**

Add to `packages/crypto/test/index.test.ts`:

```ts
it('savePublicKey/loadPublicKey round-trip', async () => {
  const kp = await generateUserKeyPair();
  await savePublicKey('u1', kp.publicKey);
  const loaded = await loadPublicKey('u1');
  expect(await exportPublicKeySpki(loaded)).toBe(kp.publicKeySpkiBase64);
});
```

- [ ] **Step 5: Implement `savePublicKey`/`loadPublicKey`**

In `packages/crypto/src/index.ts`, mirror `savePrivateKey`/`loadPrivateKey` but store the public `CryptoKey` (extractable) in the same IndexedDB store under a `:pub` suffix (or a sibling store — match the existing private-key persistence mechanism exactly):

```ts
export async function savePublicKey(userId: string, key: CryptoKey): Promise<void> { /* mirror savePrivateKey */ }
export async function loadPublicKey(userId: string): Promise<CryptoKey> { /* mirror loadPrivateKey */ }
```

- [ ] **Step 6: Persist the public key at registration**

In `apps/web/src/stores/auth.ts` register flow, after `savePrivateKey(res.user.id, keyPair.privateKey)`, add `await savePublicKey(res.user.id, keyPair.publicKey);`.

- [ ] **Step 7: Write the failing `TerminalClient` negotiation tests**

Add to `packages/terminal-core/test/e2ee.test.ts`:

```ts
it('negotiates when the peer advertises e2ee: sends a hello and activates on ack', async () => {
  const a = await makePeer('sess');
  const b = await makePeer('sess');
  const { manager, frames, emit } = mockChannel();
  const ta = new TerminalE2ee({ ...a, peerSigningPublicKey: b.peerSigningPublicKey });
  const tb = new TerminalE2ee({ ...b, peerSigningPublicKey: a.peerSigningPublicKey });
  const client = new TerminalClient('agent-1', manager, ta);
  client.createSession();
  client.negotiate('t1');            // NEW: drives hello
  await waitForFrameType(frames, 'terminal-e2ee-hello');
  const hello = frames.find((f) => f.type === 'terminal-e2ee-hello')!.payload as never;
  const ack = await tb.handleHello(hello);      // peer answers
  emit({ type: 'terminal-e2ee-ack', channel: 'terminal', payload: ack, timestamp: 1 } as never);
  await waitFor(() => ta.isActive());
  expect(ta.isActive()).toBe(true);
});

it('never renders ciphertext: a data frame arriving after the ack decrypts, not renders raw', async () => {
  const a = await makePeer('sess');
  const b = await makePeer('sess');
  const { manager, emit } = mockChannel();
  const ta = new TerminalE2ee({ ...a, peerSigningPublicKey: b.peerSigningPublicKey });
  const tb = new TerminalE2ee({ ...b, peerSigningPublicKey: a.peerSigningPublicKey });
  const client = new TerminalClient('agent-1', manager, ta);
  const session = client.createSession();
  const got: Uint8Array[] = [];
  session.onData((d) => got.push(d));

  // Drive ack then a ciphertext frame through the same emit() the client sees.
  await ta.handleAck(await tb.handleHello(await ta.buildHello('t1')));
  const framed = await tb.encrypt(new TextEncoder().encode('decrypted text\n'));
  emit({ type: 'terminal-data', channel: 'terminal', payload: { terminalId: session.id, data: Buffer.from(framed).toString('base64') }, timestamp: 1 } as never);

  await waitFor(() => got.length === 1);
  // Delivered bytes are the plaintext — never the raw [IV][ct‖tag] frame.
  expect(new TextDecoder().decode(got[0])).toBe('decrypted text\n');
});
```

- [ ] **Step 8: Implement negotiation in `TerminalClient`**

In `packages/terminal-core/src/client.ts`:
- Add `negotiate(terminalId: string): void` — if `this.e2ee`, enqueue `this.e2ee.buildHello(terminalId)` on the **same `sendChain`** used for data, then `sendJson('terminal', 'terminal-e2ee-hello', hello)`.
- In `handleMessage`, when `TerminalE2ee.isNegotiationFrame(msg.type)`:
  - `terminal-e2ee-ack` → enqueue `this.e2ee.handleAck(msg.payload)` on the **`receiveChain`** (so it is processed in order relative to subsequent `terminal-data` frames).
  - `terminal-e2ee-hello` is answerer-side (browser is always offerer here) — ignore or handle symmetrically if the browser ever answers.
- Because `terminal-data` already flows through `receiveChain`, ordering guarantees the ack's key is installed before any ciphertext is decrypted. A decrypt failure still surfaces via `errorListeners` and delivers nothing.

- [ ] **Step 9: Write the failing store test**

Add to `apps/web/src/stores/__tests__/terminal.test.ts` a case asserting: when the resolved agent advertises `e2ee` and the user has an ECDH key, the terminal `PeerConnection` is constructed with `capabilities` including `'e2ee'` and `TerminalClient` receives an `E2eeContext`; when the agent does **not** advertise `e2ee`, `TerminalClient` is constructed **without** the third argument (plaintext parity).

- [ ] **Step 10: Wire the store**

In `apps/web/src/stores/terminal.ts`:
- Add a builder `async function buildE2eeContext(agentId: string, sessionId: string): Promise<E2eeContext | null>` near `resolvePeerIdentity` (lines 143-162): load the user's ECDH private + public keys (`loadPrivateKey`/`loadPublicKey`), the user's signing key (`loadSigningKey`), and the agent's signing public key (`importSigningPublicKeyRaw(agentKeyRawBase64)`); return `null` if any is missing.
- In `getOrConnectAgent` (307-427): set the terminal `PeerConnection` `capabilities` to `['terminal', 'e2ee']` **only when** a context can be built; construct `new TerminalClient(agentId, peer.dataChannels, e2ee)` where `e2ee = new TerminalE2ee(context)`; after `await peer.waitForChannel('terminal')`, call `client.negotiate(...)` when `peer.getRemoteCapabilities().includes('e2ee')`.

> **Fail-closed (Review Focus #5).** If the agent's answer lacks `e2ee`, or the user has no ECDH key, `TerminalClient` is constructed exactly as today (no third argument) and no hello is sent — the plaintext path is byte-identical.

- [ ] **Step 11: Run all affected tests**

Run: `pnpm --filter @ponter/webrtc-core test && pnpm --filter @ponter/crypto test && pnpm --filter @ponter/terminal-core test && pnpm --filter @ponter/web test`
Expected: PASS.

- [ ] **Step 12: Commit**

```bash
git add packages/webrtc-core/src/signal-handler.ts packages/webrtc-core/src/connection.ts packages/webrtc-core/src/transport.ts packages/crypto/src/index.ts apps/web/src/stores/auth.ts packages/terminal-core/src/client.ts apps/web/src/stores/terminal.ts packages/webrtc-core/test packages/crypto/test packages/terminal-core/test apps/web/src/stores/__tests__/terminal.test.ts
git commit -m "feat(web): activate WS1 e2ee negotiation end-to-end"
```

---

### Task 6: Desktop-input encryption on the same session key (ADR-29 stays CLOSED)

**Files:**
- Modify: `packages/desktop-core/src/client.ts` (`sendControl`/`sendInput` encrypt when active)
- Modify: `apps/agent/src/main.rs` (desktop dispatch: negotiate + decrypt before `apply_if_allowed`)
- Modify: `apps/web/src/stores/terminal.ts` (desktop `PeerConnection` capabilities + `DesktopClient` context)
- Test: `packages/desktop-core/test/*`, `apps/agent` desktop dispatch test

**Interfaces:**
- Consumes: `E2eeSession` (Task 2/3); `TerminalE2ee` (reused as the desktop negotiation driver); `input::apply_if_allowed(allow_input, text, source, injector)`.
- Produces: desktop-input frames are `[IV][ct‖tag]`-framed on the `control` channel when the session negotiated E2EE; the gate-closed behavior is unchanged.

- [ ] **Step 1: Write the failing tests**

In `packages/desktop-core/test/`: assert `sendInput` emits the plaintext `desktop-input` frame when no E2EE context is present (byte-identical to today) and emits a ciphertext frame (decryptable by the peer's key) when one is. In `apps/agent`: assert a `desktop-input` frame with a **closed** gate is still dropped (log contains `dropping desktop-input`), and that decryption happens before the gate check.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @ponter/desktop-core test && cargo test --manifest-path apps/agent/Cargo.toml desktop`
Expected: FAIL.

- [ ] **Step 3: Encrypt on the browser side**

In `packages/desktop-core/src/client.ts`, thread an optional `TerminalE2ee` (the same driver class, reused) into the desktop client; in `sendControl(type, payload)`, when active and `type === 'desktop-input'`, encrypt the serialized payload bytes and send `{ terminalId?, data: base64(framed) }`; otherwise send exactly as today.

- [ ] **Step 4: Decrypt on the agent side**

In `apps/agent/src/main.rs`, mirror the terminal path on the `control` channel: accept a `desktop-e2ee-hello`, verify, ack, and **decrypt** an inbound `desktop-input` frame before calling `input::apply_if_allowed(allow_input, text, &current_source, injector.as_mut())`. The `allow_input` value still comes only from `cfg.allow_input` — never from a capability (Review Focus #6).

- [ ] **Step 5: Wire the store**

In `apps/web/src/stores/terminal.ts` desktop branch (703-749): add `'e2ee'` to the desktop `PeerConnection` `capabilities` when a context can be built, and pass the driver into `DesktopClient`.

- [ ] **Step 6: Run the tests**

Run: `pnpm --filter @ponter/desktop-core test && cargo test --manifest-path apps/agent/Cargo.toml && pnpm --filter @ponter/web test`
Expected: PASS.

- [ ] **Step 7: Prove the gate is still closed (Review Focus #6)**

Run: `pnpm --filter @ponter/webrtc-core test:e2e -- desktop`
Expected: PASS — the Week 9 test "drops it when the gate is closed" is unchanged and still green.

- [ ] **Step 8: Commit**

```bash
git add packages/desktop-core/src/client.ts packages/desktop-core/test apps/agent/src/main.rs apps/web/src/stores/terminal.ts
git commit -m "feat: encrypt desktop-input on the WS1 session key (ADR-29 gate stays closed)"
```

---

### Task 7: Cross-language E2E gate G3

**Files:**
- Create: `packages/webrtc-core/test/e2e/terminal-e2ee.e2e.test.ts`
- Modify: `packages/webrtc-core/test/e2e/harness.ts` (add `openE2eeTerminalPeer` / `negotiateTerminalE2ee`)
- Modify: `.github/workflows/ci-e2e.yml` only if the new test needs a longer timeout (path filter already covers `packages/webrtc-core/**`, `apps/agent/**`).

**Interfaces:**
- Consumes: `seedSignedTerminal` (harness 1209-1244), `spawnAgent`, `buildPeerIdentity`, `frameBytes`, `sendKeystrokes`, `waitForTerminalOutput`, `TerminalClient`, `TerminalE2ee`.
- Produces: a green gate G3 test that proves browser↔Rust interoperability on the live wire.

- [ ] **Step 1: Write the failing E2E test**

Create `packages/webrtc-core/test/e2e/terminal-e2ee.e2e.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
// ...imports from ./harness (setupE2E, teardownE2E, seedSignedTerminal, agents, ...)

describe.skipIf(!isLinux)('cross-language terminal E2EE (gate G3)', () => {
  beforeAll(setupE2E);
  afterAll(teardownE2E);

  it('negotiates E2EE and round-trips terminal bytes across the language boundary', async () => {
    const seeded = await seedSignedTerminal();              // agent + WS2 identity
    const peer = await openE2eeTerminalPeer(seeded);        // offerer with ['terminal','e2ee'] + TerminalE2ee
    await negotiateTerminalE2ee(peer);                      // hello → ack, both active
    expect(peer.e2ee.isActive()).toBe(true);

    await sendKeystrokes(peer.connection, peer.terminalId, 'echo ponter-e2ee\n');
    const out = await waitForTerminalOutput(peer.connection, peer.terminalId, 'ponter-e2ee');
    // The output arrived as ciphertext and was decrypted by the browser:
    expect(new TextDecoder().decode(out)).toContain('ponter-e2ee');
  });

  it('a legacy agent (no e2ee capability) yields a plaintext, byte-identical terminal', async () => {
    // Seed an agent whose answer omits e2ee (or drive the offer without e2ee):
    // assert getRemoteCapabilities() lacks 'e2ee' and TerminalClient has no context.
  });
});
```

- [ ] **Step 2: Add the harness helpers**

In `packages/webrtc-core/test/e2e/harness.ts`, add `openE2eeTerminalPeer(seeded)` that builds the offerer `PeerConnection` with `capabilities: ['terminal', 'e2ee']` and constructs a `TerminalClient` + `TerminalE2ee` from the seeded WS2 keys, and `negotiateTerminalE2ee(peer)` that sends the hello and awaits activation. Reuse `buildPeerIdentity` (586-605) for the signing keys.

- [ ] **Step 3: Run to verify failure, then pass**

Run: `pnpm --filter @ponter/webrtc-core test:e2e -- terminal-e2ee`
Expected: FAIL first (helpers missing), then PASS after Step 2.

- [ ] **Step 4: Run the whole E2E suite for regressions**

Run: `pnpm --filter @ponter/webrtc-core test:e2e`
Expected: PASS — including the existing `terminal.e2e.test.ts` and `desktop.e2e.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add packages/webrtc-core/test/e2e/terminal-e2ee.e2e.test.ts packages/webrtc-core/test/e2e/harness.ts
git commit -m "test(e2e): cross-language terminal E2EE round trip (gate G3)"
```

---

### Task 8: WS5 CSP and security headers

**Files:**
- Create: `apps/web/public/_headers`
- Test: `apps/web/src/__tests__/headers.test.ts` (asserts the file exists and contains the required directives)

**Interfaces:**
- Consumes: `apps/web/wrangler.toml` (`[assets] directory = "./dist"`).
- Produces: the SPA response carries a strict CSP + security headers on Cloudflare.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/__tests__/headers.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const headers = readFileSync(fileURLToPath(new URL('../../public/_headers', import.meta.url)), 'utf8');

it('sets a strict CSP with no unsafe-inline and a frame-ancestors lockdown', () => {
  expect(headers).toContain('Content-Security-Policy:');
  expect(headers).toContain("default-src 'self'");
  expect(headers).toContain("frame-ancestors 'none'");
  expect(headers).not.toContain("'unsafe-eval'");
  expect(headers).toContain('Strict-Transport-Security');
  expect(headers).toContain('X-Content-Type-Options: nosniff');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @ponter/web test -- headers`
Expected: FAIL (file missing).

- [ ] **Step 3: Write `_headers`**

Create `apps/web/public/_headers`:

```
/*
  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' https: wss:; media-src 'self' blob:; font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'
  Strict-Transport-Security: max-age=63072000; includeSubDomains; preload
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: camera=(), microphone=(), geolocation=()
```

> `style-src` keeps `'unsafe-inline'` because Vue/shadcn inject scoped styles; `script-src` does **not** — that is the directive that matters for XSS (audit 5.1). `connect-src` allows `https:`/`wss:` for the API + signaling. Verify against the built `dist/index.html` after `pnpm --filter @ponter/web build` that no inline script is required.

- [ ] **Step 4: Run the test and a build smoke check**

Run: `pnpm --filter @ponter/web test -- headers && pnpm --filter @ponter/web build`
Expected: PASS; `dist/_headers` present.

- [ ] **Step 5: Commit**

```bash
git add apps/web/public/_headers apps/web/src/__tests__/headers.test.ts
git commit -m "feat(web): WS5 CSP and security headers for the Cloudflare-served SPA"
```

---

### Task 9: WS5 token storage, coturn pin, env defaults, and docs (G2)

**Files:**
- Modify: `docker/docker-compose.prod.yml` (pin coturn by digest; document `network_mode: host`)
- Modify: `docker/.env.example` (blank `JWT_SECRET`, `REFRESH_TOKEN_SECRET`)
- Create: `docs/security/2026-10-08-ws1-e2ee-rust.md`
- Modify: `docs/ARCHITECTURE.md` (§7.2)
- Modify: `docs/guides/terminal-protocol.md` (§3.7)
- Modify: `apps/web/src/__tests__/e2ee-claims.test.ts` (extend the G2 guard)

**Interfaces:**
- Consumes: the shipped implementation from Tasks 1-8.
- Produces: configuration hardening + a documentation ledger that matches reality, guarded by G2.

- [ ] **Step 1: Blank the predictable secrets**

In `docker/.env.example`, change line 31 to `JWT_SECRET=` and line 34 to `REFRESH_TOKEN_SECRET=` (leave a comment above each: `# generate: openssl rand -base64 32`). Confirm `apps/server`'s `validate-env.ts` fails fast on an empty value in production mode (it does — that is the Week 12 pattern).

- [ ] **Step 2: Pin coturn and record the host-network decision**

In `docker/docker-compose.prod.yml`, replace `image: coturn/coturn:latest` with `image: coturn/coturn:4.6.3@sha256:<digest>` (resolve the digest with `docker buildx imagetools inspect coturn/coturn:4.6.3`). Add a comment above the service:

```yaml
# network_mode: host is required so TURN can bind the UDP relay port range
# (49152-49200) and advertise the host IP. Residual risk: the container shares
# the host network namespace. Mitigation: coturn runs unprivileged with a
# static auth secret and no shell; ports are firewalled to the TURN range only.
```

- [ ] **Step 3: Write the WS1 Rust + WS5 security note**

Create `docs/security/2026-10-08-ws1-e2ee-rust.md` documenting: the Rust `EncryptionManager` and its byte-identical constants; the shared `e2ee-vectors.json` consumed by both languages; the negotiation flow (offer proposes `e2ee` → agent answers `e2ee` → browser hello → agent ack); the fail-closed table (mis-signed hello, tampered frame, absent capability, legacy agent); the token-storage decision (keep `localStorage`, mitigated by the CSP from Task 8, with the WebSocket-auth rationale); and explicitly **what is NOT encrypted** (file transfer per spec §4.3; video media per spec §4.2).

- [ ] **Step 4: Reconcile the architecture and protocol docs**

- `docs/ARCHITECTURE.md` §7.2: replace the "Rust parity … will arrive Week 16" sentence with the shipped statement, and correct the stale inline `EncryptionManager` sketch (it shows JWK + `deriveKey`; the shipped API is `buildSessionKey` + `EncryptionManager.derive`). Remove the "E2EE only takes effect once the agent advertises capabilities" caveat — it now does.
- `docs/guides/terminal-protocol.md` §3.7: replace "the Rust agent consumes these frames starting **Week 16**" with the shipped statement.

- [ ] **Step 5: Extend the G2 guard**

In `apps/web/src/__tests__/e2ee-claims.test.ts`, add `2026-10-08-ws1-e2ee-rust.md` to the doc list checked by the claim regex, so a future over-claim (or a stale "not yet active" claim) goes red.

- [ ] **Step 6: Run the guard and the docs check**

Run: `pnpm --filter @ponter/web test -- e2ee-claims`
Expected: PASS — the new doc's claims are consistent with the shipped reality.

- [ ] **Step 7: Commit**

```bash
git add docker/docker-compose.prod.yml docker/.env.example docs/security/2026-10-08-ws1-e2ee-rust.md docs/ARCHITECTURE.md docs/guides/terminal-protocol.md apps/web/src/__tests__/e2ee-claims.test.ts
git commit -m "docs+ops: WS5 token-storage note, coturn pin, env defaults, WS1 closure"
```

---

## Final verification (whole-branch, before the merge decision)

- [ ] **Rust:** `cargo test --manifest-path apps/agent/Cargo.toml` — all green; `cargo clippy -- -D warnings` clean; `cargo fmt --check` clean.
- [ ] **JS/TS:** `pnpm -r test` — all packages green; `pnpm lint`, `pnpm typecheck`, `pnpm format:check` clean (Week 12 gotcha: `format:check` is part of the required gate).
- [ ] **E2E:** `pnpm --filter @ponter/webrtc-core test:e2e` — includes the new gate G3 test; the desktop gate-closed test still passes.
- [ ] **G4:** all 6 agent targets build (the CI `Build Agent Verify` job); `e2ee-vectors.json` present and consumed by both suites.
- [ ] **G2:** the claims guard passes over every UI file, WS2 file, and both WS1 docs.
- [ ] **No `ui/` diff:** `git diff --stat -- apps/web/src/components/ui` is empty.
- [ ] **No new dependency:** `git diff --stat -- pnpm-lock.yaml apps/agent/Cargo.lock` shows no added package.
