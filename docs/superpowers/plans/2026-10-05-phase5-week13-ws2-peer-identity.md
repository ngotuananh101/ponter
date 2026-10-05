# Phase 5 Week 13 — WS2 Peer Identity & Signaling Integrity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give both peers a real cryptographic identity and bind the WebRTC handshake to it — the Rust agent generates and persists its own Ed25519 keypair (H6, C5, H5); the agent signs its DTLS certificate fingerprint and the browser verifies it against the SDP before applying the answer (C3); the browser signs its offer with the user's Ed25519 key (M1); and the agent verifies the user's identity and DTLS fingerprint before it spawns a PTY (H3). This is the foundation week that unblocks input forwarding (still left closed — ADR-29, spec §8).

**Architecture:** WS2 is Layer 2 of the three-layer Phase 5 design. Its single primitive is an **Ed25519 identity keypair per peer** (one for the browser user, one for the Rust agent), a **canonical proof message** signed with it, and an **`IdentityProof`** (`{signature, fingerprint}`) that rides on the existing `offer`/`answer` signals. The two peers already hold the raw SDP string at the exact moment they need it — the browser at `connection.ts:handleSignal` (`msg.data.sdp`) and the agent at `rtc.rs:send_answer` (`offer.sdp` / `answer.sdp`) — so no new SDP accessor on the adapter seam is required. Every control is **fail-closed**: a missing, malformed, or mismatched proof aborts the handshake, and on the agent side aborts **before any PTY is spawned**. Work is server-side (`apps/server`), Rust (`apps/agent`), the shared wire contract (`packages/shared`), the browser crypto (`packages/crypto`), and the connection core (`packages/webrtc-core`).

**Tech Stack:** TypeScript, Hono 4.x, Drizzle ORM, better-sqlite3, `ws`, Vitest; Rust 1.85+, `ring` 0.17.14 (already in the lock graph — no new crate version), `rtc` 0.21, `tokio`; WebCrypto `Ed25519` (Node 24 + current Chrome/Firefox/Safari); Vue 3 (one dialog change).

**Spec:** `docs/superpowers/specs/2026-10-05-phase5-zero-trust-e2ee-design.md` (§3.2, §4.3, §5, §7, §8)

## Design decisions (owner review required before execution)

The spec fixes *what* WS2 must achieve but not *how*. These are the implementation decisions this plan makes; each is called out again in the owning task.

1. **Signature primitive = Ed25519.** The user's existing keypair (`packages/crypto/src/index.ts`) is **ECDH P-256, `deriveBits` only, non-extractable** — it cannot sign. WS1 (Week 15) keeps that key for E2EE key agreement; WS2 adds a **separate Ed25519 signing keypair** per peer. Ed25519 gives fixed 32-byte public keys (trivial to canonicalize across JS and Rust), is supported by WebCrypto in Node 24 and current browsers, and is already available in the agent's dependency graph via `ring` 0.17.14 (transitively present; Task 3 adds it as a *direct* dependency, changing no locked version).
2. **Agent key persistence is new and required.** The agent today has **no on-disk state** (credential is argv/env only). A key that is regenerated per run breaks every previously-established trust binding and makes proofs unverifiable across restarts. Task 3 persists the key (PKCS#8, mode `0600`) at a path resolved from `--identity-path` / `AGENT_IDENTITY_PATH`, defaulting to `$XDG_CONFIG_HOME/ponter/agent-identity.pkcs8` (fallback `$HOME/.config/ponter/...`).
3. **The agent's public key is registered at first authenticated connect, not by the browser.** H6 exists precisely because the browser fabricates the agent key (`RegisterAgentDialog.vue:82`). Task 6 removes that fabrication; the agent uploads its real Ed25519 public key over its credential-authenticated WebSocket, with a **proof-of-possession** signature over a server nonce so a stolen credential cannot enroll a key the holder does not own.
4. **The user's signing public key is delivered to the agent by the server.** The agent authenticates with its credential and cannot call user-JWT routes, so the server enriches the offer it pushes to the agent with the session owner's signing public key (never trusted from the client; always overwritten server-side). Task 5 stores it; Task 7 delivers it.
5. **Trust boundary = TOFU, stated explicitly.** The browser learns the agent's key from `GET /api/agents`; the agent learns the user's key from the server. This closes C3 against a signaling server that *substitutes SDP/fingerprints* (it cannot forge the agent's signature), but it does **not** defend against a server that swaps the identity keys themselves. That is the documented boundary: spec §8 — "H6 is closed with a keypair, not a full PKI." The plan records this in `docs/` (Task 10).
6. **`approved` is NOT enforced here.** That is WS3 (spec §3.3, H2). WS2 must not read or act on `approved`.
7. **ADR-29 stays closed.** WS2 closes H1/H2's *prerequisites* by giving the agent a verifiable peer identity, but the input-forwarding gate (`--allow-input` / `AGENT_ALLOW_INPUT`, default OFF) must remain OFF (spec §8). No task may flip it.

## Global Constraints

- **Layer order is a gate.** WS2 is Layer 2 and MUST NOT implement WS1 (E2EE / `EncryptionManager` / AES-GCM) or WS3 (enforce `approved`, `shell` allowlist, close-code handling). Do not encrypt payloads; do not add session-key derivation.
- **Fail-closed everywhere.** A proof that is absent, malformed, has an unknown/invalid signature, or whose fingerprint does not match the SDP must abort the handshake. Verification is never optional when the peer key is known. No "verify if present, else proceed".
- **Abort before side effects.** On the agent, verification completes **before** `PtyManager::spawn_session` at either site (`main.rs:912` and `main.rs:993`); the single choke point is between the channel-open gate (`main.rs:~1075`) and the poll-task spawn (`main.rs:~1091`). On the browser, verification completes **before** `setRemoteDescription(answer)` (`connection.ts:301`).
- **One canonical proof message, byte-identical in JS and Rust.** Both sides sign/verify the exact same UTF-8 bytes (Task 1 defines it). Any divergence is a defect; the cross-language E2E (Task 10) is the proof.
- **No new runtime dependency** except `ring` as a *direct* agent dependency at the version already in `apps/agent/Cargo.lock` (`0.17.14`). Do not bump any locked crate. Do not add a JS crypto package — WebCrypto is built in.
- **Do not regress the 19 verified-good controls** (spec §2.1): PBKDF2 constant-time comparison, JWT HS256 with type/scope separation, SQLite revocation, single-use 15s WS tickets, CSPRNG usage, per-user tenancy scoping, the `4409` stale-guard (`ws.ts:736`), and the `1001` graceful-shutdown close.
- **Preserve the credential contract.** `agents-sessions.test.ts:329-401` pins `ag_[0-9a-f]{32}`, the 64-hex `credential_hash`, digest-includes-prefix, 409-no-remint, and no `credentialHash` leakage through `toPublicAgent`. Task 6 adds a signing key; it must not disturb these.
- **`apps/web/src/components/ui/` is generated.** Never hand-modify it; new UI must be added outside `ui/` (byte-identical registry copies only). The only web files this plan touches are non-`ui/` (`RegisterAgentDialog.vue`, `stores/auth.ts`, connection wiring).
- **Commit discipline:** path-limited commits only (`git commit -m "..." -- <paths>`). Never `git add .`.
- **Language:** code, commit messages, and technical docs in English. Conversation replies in Vietnamese.

## Review Focus

The failure modes the spec implies but no single task's happy-path test exercises. Each line's test is added in the owning task, in that task's own step style.

1. **A valid proof replayed into a different session.** A `(signature, fingerprint)` pair captured from session A must not verify for session B — the canonical message binds `sessionId`. → Task 1 (canonical binding) and Task 10 (E2E negative).
2. **Role reflection: an offer proof accepted as an answer proof.** The two directions must not be interchangeable — the canonical message binds `role=offerer|answerer`. → Task 1.
3. **Fingerprint format drift between the parser and the wire.** `a=fingerprint:sha-256 AB:CD:…` (SDP line), `AB:CD:…` (normalized), and `ab:cd:…` (lowercase) must all normalize to one value; a *different* certificate must never normalize equal. → Task 1 (parser tests) and Task 8/Task 9 (comparison).
4. **The agent's identity key rotates on restart.** If the key is regenerated each run, a browser that pinned the old key fails every future connection and the failure is silent. The key must load from disk unchanged across process restarts. → Task 3.
5. **A missing proof is accepted (fail-open).** An `offer`/`answer` with no `proof` when the peer key is known must be **rejected**, not treated as "legacy peer, allow". → Task 8 and Task 9 negative tests.

---

### Task 1: Canonical proof message + DTLS fingerprint parser (shared, pure)

**Files:**
- Create: `packages/shared/src/types/identity-proof.ts`
- Modify: `packages/shared/src/types/index.ts` (re-export)
- Test: `packages/shared/test/identity-proof.test.ts`

**Interfaces:**
- Produces:
  - `PROOF_VERSION = 'ponter-ws2-v1'`
  - `type PeerRole = 'offerer' | 'answerer'`
  - `canonicalProofMessage(input: { role: PeerRole; sessionId: string; sdpSha256Hex: string; fingerprint: string }): string` — returns the exact UTF-8 string both peers sign.
  - `normalizeFingerprint(raw: string): string` — accepts an SDP `a=fingerprint:sha-256 …` line OR a bare `AB:CD:…` value; returns uppercase colon-separated hex, or throws on malformed input.
  - `parseSdpFingerprint(sdp: string): string` — extracts the first `a=fingerprint:sha-256 …` line from an SDP string, normalized; throws if absent.
- Consumes: nothing.

- [ ] **Step 1: Write the failing test**

Create `packages/shared/test/identity-proof.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  PROOF_VERSION,
  canonicalProofMessage,
  normalizeFingerprint,
  parseSdpFingerprint,
} from '../src/types/identity-proof';

const FP = 'AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89';

describe('canonicalProofMessage', () => {
  it('is byte-stable for identical inputs', () => {
    const a = canonicalProofMessage({
      role: 'offerer',
      sessionId: 's1',
      sdpSha256Hex: 'aa',
      fingerprint: FP,
    });
    const b = canonicalProofMessage({
      role: 'offerer',
      sessionId: 's1',
      sdpSha256Hex: 'aa',
      fingerprint: FP,
    });
    expect(a).toBe(b);
  });

  it('binds the role so an offer proof cannot verify as an answer proof', () => {
    const offer = canonicalProofMessage({
      role: 'offerer',
      sessionId: 's1',
      sdpSha256Hex: 'aa',
      fingerprint: FP,
    });
    const answer = canonicalProofMessage({
      role: 'answerer',
      sessionId: 's1',
      sdpSha256Hex: 'aa',
      fingerprint: FP,
    });
    expect(offer).not.toBe(answer);
  });

  it('binds the sessionId so a proof cannot be replayed into another session', () => {
    const s1 = canonicalProofMessage({
      role: 'offerer',
      sessionId: 's1',
      sdpSha256Hex: 'aa',
      fingerprint: FP,
    });
    const s2 = canonicalProofMessage({
      role: 'offerer',
      sessionId: 's2',
      sdpSha256Hex: 'aa',
      fingerprint: FP,
    });
    expect(s1).not.toBe(s2);
  });

  it('starts with the version tag and contains every field on its own line', () => {
    const msg = canonicalProofMessage({
      role: 'answerer',
      sessionId: 'sX',
      sdpSha256Hex: 'deadbeef',
      fingerprint: FP,
    });
    const lines = msg.split('\n');
    expect(lines[0]).toBe(PROOF_VERSION);
    expect(lines).toContain('role=answerer');
    expect(lines).toContain('sessionId=sX');
    expect(lines).toContain('sdpSha256=deadbeef');
    expect(lines).toContain(`fingerprint=${FP}`);
  });
});

describe('normalizeFingerprint', () => {
  it('normalizes a bare colon-separated value to uppercase', () => {
    expect(normalizeFingerprint(FP.toLowerCase())).toBe(FP);
  });

  it('strips the SDP prefix and normalizes', () => {
    expect(normalizeFingerprint(`a=fingerprint:sha-256 ${FP.toLowerCase()}`)).toBe(FP);
  });

  it('rejects a value that is not 32 colon-separated hex byte pairs', () => {
    expect(() => normalizeFingerprint('AB:CD')).toThrow();
    expect(() => normalizeFingerprint('ZZ:'.repeat(31) + 'ZZ')).toThrow();
    expect(() => normalizeFingerprint('')).toThrow();
  });
});

describe('parseSdpFingerprint', () => {
  const sdp = [
    'v=0',
    'o=- 1 2 IN IP4 127.0.0.1',
    `a=fingerprint:sha-256 ${FP.toLowerCase()}`,
    'a=setup:passive',
    '',
  ].join('\r\n');

  it('extracts and normalizes the fingerprint line', () => {
    expect(parseSdpFingerprint(sdp)).toBe(FP);
  });

  it('throws when the SDP carries no fingerprint', () => {
    expect(() => parseSdpFingerprint('v=0\r\n')).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ponter/shared test identity-proof`
Expected: FAIL — cannot resolve `../src/types/identity-proof`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/shared/src/types/identity-proof.ts`:

```ts
/**
 * The canonical WS2 peer-identity proof.
 *
 * Both the browser (WebCrypto) and the Rust agent (`ring`) sign and verify the
 * EXACT same UTF-8 bytes. Every field is on its own line, the version tag is
 * first, and no field is optional: a signature over this string is bound to the
 * role (no offer/answer reflection), the session (no cross-session replay), the
 * exact SDP, and the exact DTLS fingerprint.
 */
export const PROOF_VERSION = 'ponter-ws2-v1';

export type PeerRole = 'offerer' | 'answerer';

export interface CanonicalProofInput {
  role: PeerRole;
  sessionId: string;
  sdpSha256Hex: string;
  fingerprint: string;
}

export function canonicalProofMessage(input: CanonicalProofInput): string {
  return [
    PROOF_VERSION,
    `role=${input.role}`,
    `sessionId=${input.sessionId}`,
    `sdpSha256=${input.sdpSha256Hex}`,
    `fingerprint=${input.fingerprint}`,
  ].join('\n');
}

const FP_RE = /^[0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){31}$/;

/**
 * Normalize a DTLS certificate fingerprint to uppercase colon-separated hex.
 *
 * Accepts either the full SDP line (`a=fingerprint:sha-256 AB:CD:…`) or the bare
 * value, because the two peers read it from different places (the browser from
 * the answer SDP text, the agent from the offer SDP text) but must compare
 * equal. Throws on anything that is not 32 SHA-256 byte pairs, so a truncated
 * or non-hex value fails closed instead of comparing as "different".
 */
export function normalizeFingerprint(raw: string): string {
  const value = raw.trim().replace(/^a=fingerprint:[^ ]+\s+/i, '');
  if (!FP_RE.test(value)) {
    throw new Error(`malformed DTLS fingerprint: ${JSON.stringify(raw)}`);
  }
  return value.toUpperCase();
}

/** Extract the first `a=fingerprint:sha-256 …` line from an SDP string. */
export function parseSdpFingerprint(sdp: string): string {
  for (const line of sdp.split(/\r?\n/)) {
    if (/^a=fingerprint:/i.test(line.trim())) {
      return normalizeFingerprint(line.trim());
    }
  }
  throw new Error('SDP carries no a=fingerprint line');
}
```

Add to `packages/shared/src/types/index.ts` (append near the signaling re-export block):

```ts
export {
  PROOF_VERSION,
  canonicalProofMessage,
  normalizeFingerprint,
  parseSdpFingerprint,
} from './identity-proof.js';
export type {
  PeerRole,
  CanonicalProofInput,
} from './identity-proof.js';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @ponter/shared test identity-proof`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/types/identity-proof.ts packages/shared/src/types/index.ts packages/shared/test/identity-proof.test.ts
git commit -m "feat(shared): canonical WS2 identity-proof message + fingerprint parser"
```

---

### Task 2: Browser Ed25519 signing identity (`packages/crypto`)

**Files:**
- Modify: `packages/crypto/src/index.ts` (add signing functions + IndexedDB store entry)
- Test: `packages/crypto/test/signing.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1 (this task is key material only).
- Produces:
  - `interface SigningKeyPair { publicKeyRawBase64: string; privateKey: CryptoKey; publicKey: CryptoKey }`
  - `generateSigningKeyPair(): Promise<SigningKeyPair>` — Ed25519; private key non-extractable, `['sign']`; public key extractable, `['verify']`.
  - `exportSigningPublicKeyRaw(key: CryptoKey): Promise<string>` — raw 32-byte public key, base64.
  - `importSigningPublicKeyRaw(base64: string): Promise<CryptoKey>`
  - `signProof(privateKey: CryptoKey, message: string): Promise<string>` — Ed25519 signature over UTF-8 bytes, base64.
  - `verifyProof(publicKey: CryptoKey, message: string, signatureBase64: string): Promise<boolean>`
  - `saveSigningKey(userId: string, key: CryptoKey): Promise<void>` / `loadSigningKey(userId: string): Promise<CryptoKey | null>` — persisted under a distinct IndexedDB store so the ECDH key store is untouched.

- [ ] **Step 1: Write the failing test**

Create `packages/crypto/test/signing.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  generateSigningKeyPair,
  exportSigningPublicKeyRaw,
  importSigningPublicKeyRaw,
  signProof,
  verifyProof,
} from '../src/index';

describe('Ed25519 signing identity', () => {
  it('round-trips a signature through raw public-key export/import', async () => {
    const pair = await generateSigningKeyPair();
    const raw = await exportSigningPublicKeyRaw(pair.publicKey);
    expect(Buffer.from(raw, 'base64')).toHaveLength(32);

    const msg = 'ponter-ws2-v1\nrole=offerer\nsessionId=s1';
    const sig = await signProof(pair.privateKey, msg);

    const imported = await importSigningPublicKeyRaw(raw);
    expect(await verifyProof(imported, msg, sig)).toBe(true);
  });

  it('rejects a signature over different bytes', async () => {
    const pair = await generateSigningKeyPair();
    const sig = await signProof(pair.privateKey, 'a');
    expect(await verifyProof(pair.publicKey, 'b', sig)).toBe(false);
  });

  it('rejects a signature from a different key', async () => {
    const a = await generateSigningKeyPair();
    const b = await generateSigningKeyPair();
    const sig = await signProof(a.privateKey, 'm');
    expect(await verifyProof(b.publicKey, 'm', sig)).toBe(false);
  });

  it('rejects a malformed signature without throwing', async () => {
    const pair = await generateSigningKeyPair();
    expect(await verifyProof(pair.publicKey, 'm', 'not-base64!!')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ponter/crypto test signing`
Expected: FAIL — `generateSigningKeyPair is not a function`.

- [ ] **Step 3: Write minimal implementation**

Append to `packages/crypto/src/index.ts` (keep the existing ECDH code untouched):

```ts
/** A freshly generated Ed25519 signing keypair (WS2 peer identity). */
export interface SigningKeyPair {
  /** Raw 32-byte public key, base64. The value registered with the backend. */
  publicKeyRawBase64: string;
  /** Non-extractable private key. Stored locally; never transmitted. */
  privateKey: CryptoKey;
  /** The public half, for local use. */
  publicKey: CryptoKey;
}

const SIGNING_STORE = 'signing-keys';

/** Generate an Ed25519 signing keypair for a peer identity. */
export async function generateSigningKeyPair(): Promise<SigningKeyPair> {
  const keyPair = (await crypto.subtle.generateKey('Ed25519', true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;

  // Re-import the private half as non-extractable so it cannot be exfiltrated
  // by script after generation (the public half stays extractable to register).
  const pkcs8 = await crypto.subtle.exportKey('pkcs8', keyPair.privateKey);
  const privateKey = await crypto.subtle.importKey('pkcs8', pkcs8, 'Ed25519', false, [
    'sign',
  ]);

  return {
    publicKeyRawBase64: await exportSigningPublicKeyRaw(keyPair.publicKey),
    privateKey,
    publicKey: keyPair.publicKey,
  };
}

/** Export an Ed25519 public key to its raw 32-byte base64 form. */
export async function exportSigningPublicKeyRaw(key: CryptoKey): Promise<string> {
  const raw = await crypto.subtle.exportKey('raw', key);
  return bufferToBase64(raw);
}

/** Import an Ed25519 public key from raw 32-byte base64. */
export async function importSigningPublicKeyRaw(base64: string): Promise<CryptoKey> {
  return await crypto.subtle.importKey('raw', base64ToBuffer(base64), 'Ed25519', true, [
    'verify',
  ]);
}

/** Sign a UTF-8 message; returns a base64 Ed25519 signature. */
export async function signProof(privateKey: CryptoKey, message: string): Promise<string> {
  const sig = await crypto.subtle.sign('Ed25519', privateKey, new TextEncoder().encode(message));
  return bufferToBase64(sig);
}

/** Verify a base64 Ed25519 signature over a UTF-8 message. Never throws. */
export async function verifyProof(
  publicKey: CryptoKey,
  message: string,
  signatureBase64: string,
): Promise<boolean> {
  try {
    const sig = base64ToBuffer(signatureBase64);
    return await crypto.subtle.verify('Ed25519', publicKey, sig, new TextEncoder().encode(message));
  } catch {
    return false;
  }
}

/** Persist a user's Ed25519 signing key locally (separate store from ECDH). */
export async function saveSigningKey(userId: string, key: CryptoKey): Promise<void> {
  const db = await openDatabase(SIGNING_STORE);
  return runWriteTransaction(db, SIGNING_STORE, 'Failed to save signing key', (store) => {
    store.put(key, userId);
  });
}

/** Load a user's Ed25519 signing key, or null if none is stored. */
export async function loadSigningKey(userId: string): Promise<CryptoKey | null> {
  const db = await openDatabase(SIGNING_STORE);
  return readKey(db, SIGNING_STORE, userId, 'Failed to load signing key');
}
```

Refactor the existing helpers minimally so the new store reuses them (this is a **behavior-preserving** refactor of Task 2, not a rewrite):
- Change `openDatabase()` → `openDatabase(storeName: string = STORE_NAME)` and have `onupgradeneeded` create the store if missing (create both `keys` and `signing-keys`).
- Change `runWriteTransaction(db, failureMessage, run)` → `runWriteTransaction(db, storeName, failureMessage, run)` and update the one existing caller (`savePrivateKey`/`deletePrivateKey`) to pass `STORE_NAME`.
- Extract the read logic in `loadPrivateKey` into `readKey(db, storeName, key, failureMessage): Promise<CryptoKey | null>` and have `loadPrivateKey` call it with `STORE_NAME`.

- [ ] **Step 4: Run the full crypto + web suites to prove no regression**

Run: `pnpm --filter @ponter/crypto test && pnpm --filter @ponter/web test`
Expected: PASS — new signing tests green and the existing `loadPrivateKey`/`savePrivateKey` tests unchanged.

- [ ] **Step 5: Commit**

```bash
git add packages/crypto/src/index.ts packages/crypto/test/signing.test.ts
git commit -m "feat(crypto): Ed25519 signing identity for WS2 peer proofs"
```

---

### Task 3: Rust agent Ed25519 identity + on-disk persistence

**Files:**
- Create: `apps/agent/src/identity.rs`
- Modify: `apps/agent/src/main.rs` (module decl, `Cli` field, load-at-startup, thread into `SessionConfig`)
- Modify: `apps/agent/Cargo.toml` (add `ring = "0.17.14"` as a direct dependency)
- Test: `apps/agent/src/identity.rs` (`#[cfg(test)] mod tests`)

**Interfaces:**
- Consumes: Task 1's canonical message format (re-implemented in Rust — the *string* must match `packages/shared/src/types/identity-proof.ts` byte-for-byte).
- Produces:
  - `pub struct AgentIdentity { key_pair: ring::signature::Ed25519KeyPair }`
  - `AgentIdentity::load_or_generate(path: &Path) -> Result<AgentIdentity>`
  - `AgentIdentity::public_key_raw(&self) -> [u8; 32]` and `public_key_base64(&self) -> String`
  - `AgentIdentity::sign(&self, message: &[u8]) -> Vec<u8>`
  - `pub fn canonical_proof_message(role: &str, session_id: &str, sdp_sha256_hex: &str, fingerprint: &str) -> String`
  - `pub fn verify_proof(public_key_raw: &[u8], message: &[u8], signature: &[u8]) -> bool`
  - `pub fn sha256_hex(bytes: &[u8]) -> String`
  - `pub fn parse_sdp_fingerprint(sdp: &str) -> Result<String>` (normalized uppercase)
  - `pub const PROOF_VERSION: &str = "ponter-ws2-v1";`

- [ ] **Step 1: Write the failing test**

Append to `apps/agent/src/identity.rs` (the file is created with the test module first):

```rust
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --manifest-path apps/agent/Cargo.toml identity`
Expected: FAIL — module `identity` does not exist / `AgentIdentity` not found.

- [ ] **Step 3: Write minimal implementation**

Create `apps/agent/src/identity.rs`:

```rust
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
        return Ok(());
    }
    #[cfg(not(unix))]
    {
        std::fs::write(path, bytes).context("write identity file")
    }
}

/// Byte-identical to `canonicalProofMessage` in
/// `packages/shared/src/types/identity-proof.ts`. Any divergence is a defect.
pub fn canonical_proof_message(role: &str, session_id: &str, sdp_sha256_hex: &str, fingerprint: &str) -> String {
    format!(
        "{PROOF_VERSION}\nrole={role}\nsessionId={session_id}\nsdpSha256={sdp_sha256_hex}\nfingerprint={fingerprint}"
    )
}

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

pub fn verify_proof(public_key_raw: &[u8], message: &[u8], signature: &[u8]) -> bool {
    UnparsedPublicKey::new(&ED25519, public_key_raw)
        .verify(message, signature)
        .is_ok()
}

/// Extract and normalize the first `a=fingerprint:sha-256 …` line from an SDP.
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

fn normalize_fingerprint(value: &str) -> Result<String> {
    let parts: Vec<&str> = value.split(':').collect();
    if parts.len() != 32 || parts.iter().any(|p| p.len() != 2 || !p.chars().all(|c| c.is_ascii_hexdigit())) {
        bail!("malformed DTLS fingerprint: {value}");
    }
    Ok(value.to_ascii_uppercase())
}
```

In `apps/agent/Cargo.toml`, add under `[dependencies]` (version already resolved in the lock):

```toml
ring = "0.17.14"
```

In `apps/agent/src/main.rs`:
- Add `mod identity;` beside the other `mod` declarations (near line 21).
- Add a CLI field after `credential` (~line 75):

```rust
    /// Path to the persisted Ed25519 identity (PKCS#8). Generated on first run.
    #[arg(long, env = "AGENT_IDENTITY_PATH")]
    identity_path: Option<String>,
```

- Add a resolver beside `resolve_credential` (~line 146):

```rust
fn resolve_identity_path(cli: &Cli) -> std::path::PathBuf {
    if let Some(p) = &cli.identity_path {
        if !p.trim().is_empty() {
            return std::path::PathBuf::from(p);
        }
    }
    let base = std::env::var("XDG_CONFIG_HOME")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| std::env::var("HOME").ok().map(|h| format!("{h}/.config")))
        .unwrap_or_else(|| ".".to_string());
    std::path::PathBuf::from(base).join("ponter").join("agent-identity.pkcs8")
}
```

- In `main()` (~line 300), load the identity and pass it down:

```rust
    let identity = identity::AgentIdentity::load_or_generate(&resolve_identity_path(&cli))?;
    tracing::info!(public_key = %identity.public_key_base64(), "agent identity loaded");
```

- Thread `Arc<identity::AgentIdentity>` through `run_with_reconnect` → `SessionConfig` (add `identity: Arc<identity::AgentIdentity>` to `SessionConfig`, `main.rs:~425`). Full wiring is completed in Task 9 (where the identity is used); here it only needs to compile and be reachable from the session loop.

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test --manifest-path apps/agent/Cargo.toml identity`
Expected: PASS — all five tests green.

- [ ] **Step 5: Commit**

```bash
git add apps/agent/src/identity.rs apps/agent/src/main.rs apps/agent/Cargo.toml apps/agent/Cargo.lock
git commit -m "feat(agent): persistent Ed25519 peer identity (WS2)"
```

---

### Task 4: Wire types carry the identity proof (shared + Rust mirror)

**Files:**
- Modify: `packages/shared/src/types/signaling.ts` (`IdentityProof`, add `proof` to `SignalOffer`/`SignalAnswer`)
- Modify: `packages/shared/src/types/index.ts` (export `IdentityProof`)
- Modify: `packages/webrtc-core/src/transport.ts` (`parseSignalItem` carries `proof`)
- Modify: `packages/webrtc-core/src/signal-handler.ts` (`createOfferSignal`/`createAnswerSignal` accept an optional `proof`)
- Modify: `apps/agent/src/signal.rs` (`IdentityProof` struct; `proof: Option<IdentityProof>` on offer/answer)
- Test: `packages/webrtc-core/test/signal-handler.test.ts` (extend), `apps/agent/src/signal.rs` (`#[cfg(test)]` round-trip)

**Interfaces:**
- Consumes: Task 1 (`normalizeFingerprint` not needed here).
- Produces:
  - TS: `interface IdentityProof { signature: string; fingerprint: string }`
  - `SignalOffer.proof?: IdentityProof`, `SignalAnswer.proof?: IdentityProof`
  - Rust: `pub struct IdentityProof { pub signature: String, pub fingerprint: String }`; `SignalOffer.proof: Option<IdentityProof>`, `SignalAnswer.proof: Option<IdentityProof>`.

- [ ] **Step 1: Write the failing tests**

Extend `packages/webrtc-core/test/signal-handler.test.ts`:

```ts
it('carries an IdentityProof on an offer signal', () => {
  const msg = createOfferSignal('s1', { sdp: 'v=0', type: 'offer' } as RTCSessionDescriptionInit, ['terminal'], {
    signature: 'c2ln',
    fingerprint: 'AB:CD',
  });
  expect(msg.data).toMatchObject({
    proof: { signature: 'c2ln', fingerprint: 'AB:CD' },
  });
});

it('carries an IdentityProof on an answer signal', () => {
  const msg = createAnswerSignal('s1', { sdp: 'v=0', type: 'answer' } as RTCSessionDescriptionInit, true, {
    signature: 'c2ln',
    fingerprint: 'AB:CD',
  });
  expect(msg.data).toMatchObject({ proof: { signature: 'c2ln', fingerprint: 'AB:CD' } });
});
```

Add a Rust round-trip test in `apps/agent/src/signal.rs`:

```rust
#[test]
fn carries_an_identity_proof() {
    let raw = r#"{"type":"answer","data":{"sessionId":"s1","sdp":"v=0","approved":true,"proof":{"signature":"c2ln","fingerprint":"AB:CD"}}}"#;
    let parsed: SignalMessage = serde_json::from_str(raw).unwrap();
    let SignalMessage::Answer(a) = parsed else { panic!("expected answer") };
    assert_eq!(a.proof.unwrap().fingerprint, "AB:CD");
}

#[test]
fn proof_is_optional_for_backward_shapes() {
    let raw = r#"{"type":"offer","data":{"sessionId":"s1","sdp":"v=0","capabilities":[]}}"#;
    let parsed: SignalMessage = serde_json::from_str(raw).unwrap();
    let SignalMessage::Offer(o) = parsed else { panic!("expected offer") };
    assert!(o.proof.is_none());
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @ponter/webrtc-core test signal-handler && cargo test --manifest-path apps/agent/Cargo.toml signal`
Expected: FAIL — `proof` not accepted / not parsed.

- [ ] **Step 3: Write minimal implementation**

In `packages/shared/src/types/signaling.ts`, add and wire:

```ts
/** A peer's signed DTLS-fingerprint proof (WS2). */
export interface IdentityProof {
  /** Ed25519 signature (base64) over the canonical proof message. */
  signature: string;
  /** SHA-256 DTLS certificate fingerprint, normalized uppercase `XX:XX:…`. */
  fingerprint: string;
}

export interface SignalOffer {
  sessionId: string;
  sdp: string;
  capabilities: string[];
  /** Signed by the offerer's identity key. Absent only for legacy/loopback tests. */
  proof?: IdentityProof;
}

export interface SignalAnswer {
  sessionId: string;
  sdp: string;
  approved: boolean;
  /** Signed by the answerer's identity key. */
  proof?: IdentityProof;
}
```

In `packages/shared/src/types/index.ts`, add `IdentityProof` to the `SignalOffer, SignalAnswer, …` export-type list.

In `packages/webrtc-core/src/transport.ts`, in `parseSignalItem`, carry the proof through (both `offer` and `answer` cases):

```ts
proof: (payload.proof as IdentityProof | undefined) ?? undefined,
```

In `packages/webrtc-core/src/signal-handler.ts`, extend the two factories with an optional trailing `proof` parameter and include it when present:

```ts
export function createOfferSignal(
  sessionId: string,
  desc: RTCSessionDescriptionInit,
  capabilities: string[] = [],
  proof?: IdentityProof,
): SignalMessage {
  return {
    type: 'offer',
    data: { sessionId, sdp: desc.sdp ?? '', capabilities, ...(proof ? { proof } : {}) },
  };
}

export function createAnswerSignal(
  sessionId: string,
  desc: RTCSessionDescriptionInit,
  approved = true,
  proof?: IdentityProof,
): SignalMessage {
  return {
    type: 'answer',
    data: { sessionId, sdp: desc.sdp ?? '', approved, ...(proof ? { proof } : {}) },
  };
}
```

(Import `IdentityProof` from `@ponter/shared` in both files.)

In `apps/agent/src/signal.rs`, add the struct and the optional fields:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct IdentityProof {
    pub signature: String,
    pub fingerprint: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SignalOffer {
    pub session_id: String,
    pub sdp: String,
    #[serde(default)]
    pub capabilities: Vec<String>,
    #[serde(default)]
    pub proof: Option<IdentityProof>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SignalAnswer {
    pub session_id: String,
    pub sdp: String,
    pub approved: bool,
    #[serde(default)]
    pub proof: Option<IdentityProof>,
}
```

Update the existing `SignalAnswer { session_id, sdp, approved }` construction in `rtc.rs:782` to add `proof: None` (Task 9 replaces it with the real proof).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @ponter/webrtc-core test signal-handler && cargo test --manifest-path apps/agent/Cargo.toml signal`
Expected: PASS. Also run `pnpm --filter @ponter/shared build` to confirm types compile.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/types/signaling.ts packages/shared/src/types/index.ts packages/webrtc-core/src/transport.ts packages/webrtc-core/src/signal-handler.ts apps/agent/src/signal.rs apps/agent/src/rtc.rs
git commit -m "feat(signaling): carry IdentityProof on offer/answer (TS + Rust)"
```

---

### Task 5: Server stores the user's signing public key and delivers it to the agent

**Files:**
- Modify: `apps/server/src/db/schema.ts` (`users.signingPublicKey`)
- Modify: `apps/server/src/db/client.ts` (DDL + `ALTER TABLE` migration)
- Modify: `apps/server/src/routes/auth.ts` (`register` accepts optional `signingPublicKey`)
- Modify: `apps/server/src/utils/user.ts` (`PublicUser.signingPublicKey`)
- Modify: `apps/server/src/routes/signal.ts` (enrich the pushed offer with the session owner's signing key)
- Test: `apps/server/test/ws2-signing-key.test.ts`

**Interfaces:**
- Consumes: Task 4 (`SignalOffer.proof` shape).
- Produces:
  - `users.signing_public_key TEXT` (nullable — legacy rows predate WS2).
  - `POST /api/auth/register` accepts optional `signingPublicKey: string` (base64 raw Ed25519), stored verbatim; validation only that it is non-empty when present.
  - `PublicUser.signingPublicKey: string | null`.
  - The offer pushed to the agent carries `data.userSigningPublicKey: string | null` (server-added; any client-supplied value is overwritten).

- [ ] **Step 1: Write the failing test**

Create `apps/server/test/ws2-signing-key.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { createApp } from '../src/app';
import { closeDb } from '../src/db/client';

const app = createApp();
const SIGNING = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8='; // 32 bytes base64

async function register(username: string, signingPublicKey?: string) {
  return app.fetch(
    new Request('http://localhost/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username,
        password: 'password123',
        publicKey: 'ecdh-pk',
        ...(signingPublicKey ? { signingPublicKey } : {}),
      }),
    }),
  );
}

describe('WS2 user signing key', () => {
  beforeEach(() => closeDb());

  it('stores the signing public key and returns it on the public user', async () => {
    const res = await register('ws2_user_a', SIGNING);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { user: { signingPublicKey: string | null } };
    expect(body.user.signingPublicKey).toBe(SIGNING);
  });

  it('accepts registration without a signing key (legacy shape)', async () => {
    const res = await register('ws2_user_b');
    expect(res.status).toBe(201);
    const body = (await res.json()) as { user: { signingPublicKey: string | null } };
    expect(body.user.signingPublicKey).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ponter/server test ws2-signing-key`
Expected: FAIL — `signingPublicKey` is undefined.

- [ ] **Step 3: Write minimal implementation**

`apps/server/src/db/schema.ts` — add to the `users` table after `publicKey`:

```ts
  signingPublicKey: text('signing_public_key'),
```

`apps/server/src/db/client.ts` — add to the `CREATE TABLE users` DDL after `public_key TEXT NOT NULL,`:

```sql
      signing_public_key TEXT,
```

and add a migration beside the existing `ALTER TABLE` block (~line 114):

```ts
  try {
    sqlite.exec(`ALTER TABLE users ADD COLUMN signing_public_key TEXT;`);
  } catch {}
```

`apps/server/src/routes/auth.ts` — accept and store it. Extend the body type and validation:

```ts
      publicKey?: string;
      signingPublicKey?: string;
```

after the existing required-field check, add:

```ts
  const signingPublicKey =
    typeof body.signingPublicKey === 'string' && body.signingPublicKey.trim()
      ? body.signingPublicKey
      : null;
```

and include `signingPublicKey` in the `.values({ … })` insert.

`apps/server/src/utils/user.ts` — add `signingPublicKey: string | null;` to `PublicUser` and `signingPublicKey: user.signingPublicKey ?? null,` to `toPublicUser`.

`apps/server/src/routes/signal.ts` — in `POST /offer`, look up the owner's signing key and enrich the **pushed** message (stored message unchanged):

```ts
  // The agent authenticates with its credential and cannot read user rows, so
  // the session owner's signing public key is delivered with the offer. The
  // value is always server-sourced; a client-supplied one is ignored.
  const owner = await db
    .select({ signingPublicKey: users.signingPublicKey })
    .from(users)
    .where(eq(users.id, session.userId))
    .get();

  const pushed: SignalMessage = {
    type: 'offer',
    data: {
      ...message.data,
      userSigningPublicKey: owner?.signingPublicKey ?? null,
    } as SignalMessage['data'],
  };

  if (session.agentId) {
    pushToAgent(session.agentId, pushed);
  }
```

Import `users` from `../db/schema.js`. Add `userSigningPublicKey?: string | null` to the shared `SignalOffer` (Task 4 file) so the type is honest; document it as **server-added, never client-trusted**.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @ponter/server test ws2-signing-key && pnpm --filter @ponter/server test auth`
Expected: PASS, and existing auth tests unchanged.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/db/schema.ts apps/server/src/db/client.ts apps/server/src/routes/auth.ts apps/server/src/utils/user.ts apps/server/src/routes/signal.ts packages/shared/src/types/signaling.ts apps/server/test/ws2-signing-key.test.ts
git commit -m "feat(server): store user signing key and deliver it with the offer"
```

---

### Task 6: Agent registers its real public key at first connect (H6, C5, H5)

**Files:**
- Modify: `apps/server/src/db/schema.ts` (`agents.signingPublicKey`)
- Modify: `apps/server/src/db/client.ts` (DDL + `ALTER TABLE`)
- Modify: `apps/server/src/routes/ws.ts` (agent identity frame + nonce challenge + proof-of-possession)
- Modify: `apps/server/src/utils/agent.ts` (`toPublicAgent` exposes `signingPublicKey`)
- Modify: `packages/shared/src/types/user.ts` (`Agent.signingPublicKey`) + `packages/shared/src/types/signaling.ts` (agent identity frames)
- Modify: `apps/web/src/components/agent/RegisterAgentDialog.vue` (stop fabricating a key)
- Test: `apps/server/test/ws2-agent-identity.test.ts`

**Interfaces:**
- Consumes: Task 3 (`public_key_base64`), Task 1 (`canonicalProofMessage` is not used here — the nonce proof uses a distinct domain string, defined below).
- Produces:
  - `agents.signing_public_key TEXT` (nullable until first connect).
  - Agent → server frame `{ type: 'agent-identity', data: { publicKey: string; nonce: string; signature: string } }`.
  - Server → agent frame `{ type: 'identity-challenge', data: { nonce: string } }` sent on connect.
  - The nonce proof message is `"ponter-ws2-agent-identity-v1\nnonce=<nonce>"`, signed with the agent's Ed25519 key (base64).
  - `Agent.signingPublicKey: string | null`.

- [ ] **Step 1: Write the failing test**

Create `apps/server/test/ws2-agent-identity.test.ts` — register a user + agent, open the agent socket with the credential, expect an `identity-challenge` frame, send a valid `agent-identity` (sign with a locally generated Ed25519 key via Node `crypto`), then `GET /api/agents` shows the stored `signingPublicKey`. Include negatives: a bad signature is rejected and the key is not stored; re-connect with the same key is idempotent.

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { webcrypto } from 'node:crypto';
import { createApp } from '../src/app';
import { startServer, stopServer } from '../src/index'; // adjust to the real export
// ... (full harness: register user, POST /api/agents, connect WS with Bearer credential,
//      receive identity-challenge, sign nonce, send agent-identity, assert stored key)
```

> Implementer: reuse the socket harness pattern from `apps/server/test/signaling.test.ts` (it already registers an agent and connects with `Bearer ${credential}`). Generate the Ed25519 key with `webcrypto.subtle.generateKey('Ed25519', true, ['sign','verify'])`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ponter/server test ws2-agent-identity`
Expected: FAIL — no `identity-challenge` frame, no `signingPublicKey`.

- [ ] **Step 3: Write minimal implementation**

Schema + DDL + migration: add `signingPublicKey: text('signing_public_key')` to the `agents` table; add `signing_public_key TEXT,` to the `CREATE TABLE agents` DDL and an `ALTER TABLE agents ADD COLUMN signing_public_key TEXT;` migration beside the users one.

`apps/server/src/routes/ws.ts` — in the agent connection handler (`ws.ts:718`), after the ICE push:
- Generate a nonce (`crypto.randomUUID()` or 32 random bytes hex), send `{ type: 'identity-challenge', data: { nonce } }`, and store the expected nonce on the `AgentConnection` object.
- In `handleInboundMessage`, add an `agent-identity` case: verify the signature over `"ponter-ws2-agent-identity-v1\nnonce=<nonce>"` with `webcrypto.subtle.verify('Ed25519', importedKey, sig, msg)` against the supplied `publicKey`; on success `UPDATE agents SET signing_public_key = ? WHERE id = ?`; on failure close the socket with `4401` and do not store.

`apps/server/src/utils/agent.ts` — add `signingPublicKey: agent.signingPublicKey ?? null` to `toPublicAgent` and the `PublicAgent`/`Agent` type.

`packages/shared/src/types/user.ts` — add `signingPublicKey: string | null;` to `Agent`.

`apps/web/src/components/agent/RegisterAgentDialog.vue` — remove the fabricated key entirely (lines 81-88): send `publicKey: ''` is not allowed by the server, so instead the dialog no longer sends `publicKey` at all and the server accepts an agent with a placeholder that is overwritten at first connect. Concretely:
- Server `POST /api/agents`: keep `publicKey` required for the ECDH/legacy field but allow an explicit empty string, OR make it optional and default to `''`. Choose **optional, default `''`**, and update `agents-sessions.test.ts` only if a test asserts the 400 (it does not — it always sends a key).
- Dialog: drop `generateUserKeyPair()` and the hardcoded fallback; send `{ id, hostname, platform, capabilities }` only. Update `RegisterAgentDialog.test.ts` to assert `create` is called **without** `publicKey` and that no fabricated key appears.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @ponter/server test ws2-agent-identity && pnpm --filter @ponter/server test agents-sessions && pnpm --filter @ponter/web test RegisterAgentDialog`
Expected: PASS. `agents-sessions.test.ts` credential-contract tests (lines 329-401) must still pass unchanged.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/db/schema.ts apps/server/src/db/client.ts apps/server/src/routes/ws.ts apps/server/src/utils/agent.ts apps/server/src/routes/agents.ts packages/shared/src/types/user.ts packages/shared/src/types/signaling.ts apps/web/src/components/agent/RegisterAgentDialog.vue apps/web/src/__tests__/RegisterAgentDialog.test.ts apps/server/test/ws2-agent-identity.test.ts
git commit -m "feat(server): agent registers its real Ed25519 public key (H6/C5/H5)"
```

---

### Task 7: Signal routes transport proofs end-to-end (server)

**Files:**
- Modify: `apps/server/src/routes/signal.ts` (accept + forward `proof` on offer/answer)
- Modify: `apps/server/src/routes/ws.ts` (`parseSignalMessage` carries `proof`)
- Test: `apps/server/test/ws2-signal-proof.test.ts`

**Interfaces:**
- Consumes: Task 4 (proof shape), Task 5 (offer enrichment).
- Produces: `POST /api/signal/offer` and `/answer` accept an optional `proof` object and store it in `signals.payload`; the browser-WS path (`ws.ts` signal handler) forwards it unchanged.

- [ ] **Step 1: Write the failing test**

`apps/server/test/ws2-signal-proof.test.ts`: post an offer with a `proof` and assert `GET /api/signal/poll/:sessionId` returns it verbatim; same for an answer.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ponter/server test ws2-signal-proof`
Expected: FAIL — `proof` dropped.

- [ ] **Step 3: Write minimal implementation**

In `POST /offer` and `POST /answer`, read `proof` from the body (validate shape: `{ signature: string, fingerprint: string }` or absent) and include it in `message.data`. In `ws.ts`'s `parseSignalMessage`, carry `proof` through for `offer` and `answer`. Do **not** validate the signature server-side — the server is not a trust root for the proof (spec §1); it only transports it. (An invalid proof is rejected by the peer, not the server.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @ponter/server test ws2-signal-proof && pnpm --filter @ponter/server test signaling`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/routes/signal.ts apps/server/src/routes/ws.ts apps/server/test/ws2-signal-proof.test.ts
git commit -m "feat(server): transport identity proofs on offer/answer"
```

---

### Task 8: Browser signs the offer and verifies the agent's answer proof (M1, C3)

**Files:**
- Modify: `packages/webrtc-core/src/types.ts` (`PeerConnectionOptions.identity`)
- Modify: `packages/webrtc-core/src/connection.ts` (sign offer; verify answer proof before `setRemoteDescription`)
- Modify: `apps/web/src/stores/auth.ts` (generate/persist/load the signing key at login/register)
- Modify: the web call site that constructs `PeerConnection` (locate with `grep -rn "new PeerConnection(" apps/web/src`)
- Test: `packages/webrtc-core/test/identity-verification.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 2, 4.
- Produces:
  - `PeerConnectionOptions.identity?: { role: 'offerer' | 'answerer'; sign: (message: string) => Promise<string>; verifyPeer: (message: string, signatureBase64: string) => Promise<boolean>; }`
  - On `start()` (offerer): after `createOffer()`, compute `sdpSha256Hex`, `parseSdpFingerprint(offer.sdp)`, build the canonical message, `sign()`, and attach `proof` to the offer signal.
  - On `handleSignal` `answer` (offerer): **before** `setRemoteDescription`, require `proof`; verify signature over the canonical message built from the answer, and assert `normalizeFingerprint(proof.fingerprint) === parseSdpFingerprint(answer.sdp)`; on any failure, set a refusal reason and do not apply the answer.

- [ ] **Step 1: Write the failing test**

`packages/webrtc-core/test/identity-verification.test.ts` (uses the werift adapter + a real Ed25519 key via `node:crypto`):
- offerer with a valid identity signs its offer and the peer (test harness) sees a `proof`;
- a correct answer proof is accepted and `setRemoteDescription` runs;
- an answer with a **tampered SDP** (fingerprint changed) is rejected before `setRemoteDescription`;
- an answer with **no proof** is rejected (fail-closed);
- an answer signed by a **different key** is rejected.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ponter/webrtc-core test identity-verification`
Expected: FAIL — `identity` option ignored.

- [ ] **Step 3: Write minimal implementation**

`types.ts` — extend `PeerConnectionOptions`:

```ts
  /** WS2 peer identity: signs this peer's SDP and verifies the remote proof. */
  identity?: {
    role: 'offerer' | 'answerer';
    sign: (message: string) => Promise<string>;
    verifyPeer: (message: string, signatureBase64: string) => Promise<boolean>;
  };
```

`connection.ts` — in `start()`, after `const offer = await this.peer.createOffer()`:

```ts
    let proof: IdentityProof | undefined;
    if (this.options.identity) {
      const fingerprint = parseSdpFingerprint(offer.sdp ?? '');
      const sdpSha256Hex = await sha256HexUtf8(offer.sdp ?? '');
      const message = canonicalProofMessage({
        role: 'offerer',
        sessionId: this.transportSessionId, // see note
        sdpSha256Hex,
        fingerprint,
      });
      proof = { signature: await this.options.identity.sign(message), fingerprint };
    }
    const signal = createOfferSignal('', offer, capabilities, proof);
```

> Session-id note: `PeerConnection` builds signals with `sessionId: ''` today and the transport re-stamps it. The proof must bind the **real** sessionId. Resolve this by adding a required `sessionId` to `PeerConnectionOptions` (preferred — one source of truth) OR by having the transport expose it. **Chosen: add `sessionId: string` to `PeerConnectionOptions`** and have `connection.ts` use it both in the proof and in `createOfferSignal`/`createAnswerSignal`; the transport's re-stamp then becomes a no-op safety net. Update the web call site and the E2E harness to pass `sessionId`.

In `handleSignal` `answer` case, before `setRemoteDescription`:

```ts
        const answerDesc = toSessionDescriptionInit(msg.data, 'answer');
        if (this.options.identity) {
          const proof = msg.data.proof;
          const ok =
            proof &&
            (await this.verifyRemoteProof('answerer', msg.data.sessionId, answerDesc.sdp ?? '', proof));
          if (!ok) {
            this.refusalReason = 'the agent answer failed peer-identity verification';
            return; // do NOT setRemoteDescription
          }
        }
        await this.peer.setRemoteDescription(answerDesc);
```

where `verifyRemoteProof(role, sessionId, sdp, proof)` builds the canonical message (`parseSdpFingerprint(sdp)`, `sha256HexUtf8(sdp)`) and calls `this.options.identity.verifyPeer(message, proof.signature)`, then checks `normalizeFingerprint(proof.fingerprint) === parseSdpFingerprint(sdp)`.

`apps/web/src/stores/auth.ts` — on register: `generateSigningKeyPair()`, send `signingPublicKey: pair.publicKeyRawBase64`, `saveSigningKey(userId, pair.privateKey)`. On login: `loadSigningKey(userId)` and `importSigningPublicKeyRaw` the agent key on demand.

The web connection call site — construct `identity: { role: 'offerer', sign: (m) => signProof(privateKey, m), verifyPeer: (m, s) => verifyProof(agentKey, m, s) }`, where `agentKey` comes from `apiClient.agents.get(agentId).signingPublicKey`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @ponter/webrtc-core test identity-verification && pnpm --filter @ponter/webrtc-core test p2p && pnpm --filter @ponter/web test`
Expected: PASS. `p2p.test.ts` (which passes no `identity`) must be unaffected — verification is skipped when `options.identity` is undefined, preserving all existing mock tests.

- [ ] **Step 5: Commit**

```bash
git add packages/webrtc-core/src/types.ts packages/webrtc-core/src/connection.ts packages/webrtc-core/test/identity-verification.test.ts apps/web/src/stores/auth.ts <web-call-site>
git commit -m "feat(webrtc-core): sign offer and verify agent proof before applying answer (M1/C3)"
```

---

### Task 9: Agent verifies the user's proof before spawning a PTY (H3)

**Files:**
- Modify: `apps/agent/src/rtc.rs` (`send_answer` attaches the agent's proof)
- Modify: `apps/agent/src/main.rs` (verify the offer proof at the single choke point; gate both PTY spawn sites)
- Modify: `apps/agent/src/signal.rs` (already has `proof`; add `user_signing_public_key` field to `SignalOffer`)
- Test: `apps/agent/src/main.rs` (`#[cfg(test)]`) + `apps/agent/src/rtc.rs` (`#[cfg(test)]`)

**Interfaces:**
- Consumes: Tasks 1, 3, 4, 5.
- Produces:
  - `SignalOffer.user_signing_public_key: Option<String>` (server-added; camelCase `userSigningPublicKey`).
  - A `verify_offer_identity(offer, identity) -> Result<()>` that:
    1. requires `offer.proof` and `offer.user_signing_public_key` (fail-closed);
    2. rebuilds the canonical message with `role="offerer"`, `offer.session_id`, `sha256_hex(offer.sdp)`, `parse_sdp_fingerprint(&offer.sdp)`;
    3. verifies the signature with the user's raw public key;
    4. asserts `normalize(proof.fingerprint) == parse_sdp_fingerprint(&offer.sdp)`.
  - `send_answer` builds and attaches the agent proof (`role="answerer"`, `sha256_hex(answer.sdp)`, `parse_sdp_fingerprint(&answer.sdp)`).

- [ ] **Step 1: Write the failing test**

Unit tests in `main.rs`/`rtc.rs`:
- `verify_offer_identity` accepts a correctly signed offer whose `userSigningPublicKey` matches;
- rejects a tampered SDP (fingerprint changed) — fail-closed;
- rejects a missing proof;
- rejects a proof signed by a different key.

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --manifest-path apps/agent/Cargo.toml offer_identity`
Expected: FAIL — `verify_offer_identity` not found.

- [ ] **Step 3: Write minimal implementation**

`signal.rs` — add to `SignalOffer`:

```rust
    #[serde(default)]
    pub user_signing_public_key: Option<String>,
```

`rtc.rs` — in `send_answer`, after building `answer`, compute the proof and attach it. `send_answer` must gain access to the agent identity; pass `&AgentIdentity` down from `run_one_session`:

```rust
    let fingerprint = identity::parse_sdp_fingerprint(&answer.sdp)?;
    let sdp_hash = identity::sha256_hex(answer.sdp.as_bytes());
    let message = identity::canonical_proof_message("answerer", &offer.session_id, &sdp_hash, &fingerprint);
    let proof = signal::IdentityProof {
        signature: base64_encode(&identity.sign(message.as_bytes())),
        fingerprint,
    };
    // ... SignalAnswer { session_id, sdp: answer.sdp, approved, proof: Some(proof) }
```

`main.rs` — add `verify_offer_identity` and call it in `run_one_session` at the single choke point: **after** the channel-open gate (~line 1075) and **before** the poll-task spawn (~line 1091), which precedes both PTY spawn sites (`main.rs:912`, `main.rs:993`):

```rust
fn verify_offer_identity(
    offer: &signal::SignalOffer,
    identity: &identity::AgentIdentity,
) -> Result<()> {
    let proof = offer
        .proof
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("offer carries no identity proof"))?;
    let user_pk = offer
        .user_signing_public_key
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("offer carries no user signing key"))?;
    let pk = base64_decode(user_pk)?;
    let fingerprint = identity::parse_sdp_fingerprint(&offer.sdp)?;
    if normalize(&proof.fingerprint)? != fingerprint {
        bail!("offer fingerprint does not match the SDP");
    }
    let message = identity::canonical_proof_message(
        "offerer",
        &offer.session_id,
        &identity::sha256_hex(offer.sdp.as_bytes()),
        &fingerprint,
    );
    if !identity::verify_proof(&pk, message.as_bytes(), &base64_decode(&proof.signature)?) {
        bail!("offer identity signature is invalid");
    }
    Ok(())
}
```

Call it right after the handshake, before spawning the poll task; on error, close the session and return without ever starting the dispatcher/poll loop.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --manifest-path apps/agent/Cargo.toml`
Expected: PASS — all agent tests, including the pre-existing PTY echo and signal round-trip tests.

- [ ] **Step 5: Commit**

```bash
git add apps/agent/src/rtc.rs apps/agent/src/main.rs apps/agent/src/signal.rs
git commit -m "feat(agent): verify user identity before spawning a PTY (H3)"
```

---

### Task 10: Cross-language E2E + docs + false-claim guard

**Files:**
- Modify: `packages/webrtc-core/test/e2e/harness.ts` (real Ed25519 keys both sides; `sessionId` in options)
- Create: `packages/webrtc-core/test/e2e/identity.e2e.test.ts`
- Create: `docs/security/2026-10-05-ws2-peer-identity.md` (threat model + trust boundary)
- Modify: the G2 guard test (locate: `grep -rln "does not claim E2EE" apps/web/src`)
- Test: the new E2E suite (Linux-only, matches the existing `describe.skipIf(!isLinux)` pattern)

**Interfaces:**
- Consumes: every prior task.
- Produces: a green cross-language proof that the Rust agent's signature verifies in JS and vice versa, plus a negative E2E (tampered SDP → no PTY).

- [ ] **Step 1: Write the failing E2E test**

`identity.e2e.test.ts`:
- seed a user with a real Ed25519 signing key and register an agent;
- spawn the agent with `--identity-path` pointing at a temp file;
- complete a terminal handshake where the browser offer carries a valid proof and the agent answer carries a valid proof;
- assert the terminal echo round-trips (identity did not break the happy path);
- **negative:** tamper the offer SDP fingerprint in the harness before delivering it to the agent; assert the session never spawns a PTY (no channel opens / the agent closes).

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ponter/webrtc-core test:e2e identity`
Expected: FAIL — harness sends no proofs / no `sessionId` in options.

- [ ] **Step 3: Implement the harness changes + docs**

Update `harness.ts` `seed()` to register real Ed25519 public keys, `openTerminalPeer()` to pass `sessionId` and an `identity`, and add the tamper hook. Write `docs/security/2026-10-05-ws2-peer-identity.md` documenting: the four deliverables, the canonical message, the fail-closed points, and the **TOFU trust boundary** (design decision 5) with the exact residual risk. Extend the G2 guard to assert no doc claims E2EE that WS2 does not implement.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @ponter/webrtc-core test:e2e identity`
Expected: PASS on Linux.

- [ ] **Step 5: Commit**

```bash
git add packages/webrtc-core/test/e2e/harness.ts packages/webrtc-core/test/e2e/identity.e2e.test.ts docs/security/2026-10-05-ws2-peer-identity.md <g2-guard-file>
git commit -m "test(e2e): cross-language WS2 identity proof + docs + guard"
```

---

## Verification

Run these on the frozen branch tip before the review chain. Every command must be green.

- [ ] **Typecheck / lint / format (all workspaces)**

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm format:check
```

> `format:check` is **mandatory** here (Week 12 carry-forward: a plan §Verification that omits it shipped a red CI). It runs `prettier --check .` from the root. Remember `apps/web/src/components/ui/` is in `.prettierignore` — do not add generated files back.

- [ ] **Node tests (server + web + shared + crypto + webrtc-core)**

```bash
pnpm --filter @ponter/shared test
pnpm --filter @ponter/crypto test
pnpm --filter @ponter/server test
pnpm --filter @ponter/web test
pnpm --filter @ponter/webrtc-core test
```

- [ ] **Rust agent tests**

```bash
cargo test --manifest-path apps/agent/Cargo.toml
cargo clippy --manifest-path apps/agent/Cargo.toml --all-targets -- -D warnings
cargo fmt --manifest-path apps/agent/Cargo.toml -- --check
```

- [ ] **Cross-language E2E (Linux)**

```bash
cargo build --locked --manifest-path apps/agent/Cargo.toml
pnpm --filter @ponter/webrtc-core test:e2e
```

- [ ] **Negative-control spot checks (must fail closed)**

```bash
# 1. Remove the offer proof from the E2E harness → the agent must refuse (no PTY).
# 2. Swap the answer fingerprint in the harness → the browser must not apply the answer.
# 3. Restart the agent process → the public key must be identical (identity persisted).
```

- [ ] **Spec exit-gate check (partial — G1/G2 only; G3–G5 land in WS1/WS5)**

- G1 (partial): no open critical/high finding from C3, H3, H6, C5, H5, M1 — each closed with the test named in its task.
- G2: `grep -rin "e2ee\|zero-trust" apps/web/src docs` returns no claim the code does not implement; the guard test passes.

## Self-review notes (author)

- **Spec coverage:** §3.2 bullets (a) agent keypair → Tasks 3, 6; (b) out-of-band DTLS fingerprint → Tasks 8, 9; (c) SDP signing bound to user key → Tasks 2, 5, 8; (d) agent-side peer verification → Task 9. C3/H3/H6/C5/H5/M1 each map to a task with a failing test.
- **Boundary guards:** no task implements E2EE (WS1) or enforces `approved` (WS3); ADR-29 stays closed; file transfer is untouched (§4.3).
- **Type consistency:** `IdentityProof { signature, fingerprint }`, `canonicalProofMessage(role, sessionId, sdpSha256Hex, fingerprint)`, and `normalizeFingerprint`/`parseSdpFingerprint` are used identically across Tasks 1, 4, 8, 9; the Rust mirror in Task 3 matches byte-for-byte.
- **Open item flagged for the owner:** design decision 5 (TOFU boundary) and design decision 3 (server-side key enrollment with proof-of-possession) are the two places the spec is silent; both are recorded for explicit owner sign-off before execution.
