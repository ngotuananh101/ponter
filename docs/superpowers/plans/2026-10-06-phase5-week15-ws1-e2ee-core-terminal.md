# Phase 5 Week 15 — WS1 part 1: E2EE Core + Terminal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the browser side of application-layer E2EE — the `EncryptionManager` (ECDH P-256 → HKDF-SHA256 → AES-GCM-256), a session-key agreement bound to the WS2 peer identity, terminal I/O encryption wired into `TerminalClient` behind a negotiation gate, and the long-lived private-key lifecycle (H4) — so that Week 16 only has to add the Rust peer and flip the gate on.

**Architecture:** WS1 is Layer 3 of the three-layer Phase 5 design (spec §3). WS2 (Week 13) gave each peer a verified Ed25519 identity and a DTLS-fingerprint proof; WS3 (Week 14) hardened the session layer. WS1 now adds payload encryption *on top of an already-authenticated peer* — the reason it is built last. This week is **JavaScript-only** (spec §3.4); the Rust equivalent lands in Week 16 (spec §3.5). Because no peer can decrypt until the Rust half exists, every browser-side addition is **negotiation-gated and additive**: `TerminalClient` encrypts only when an `E2eeContext` is supplied, and it is supplied only when the remote peer advertises the capability — which no live peer does in Week 15. The production terminal path is therefore byte-for-byte unchanged, and the whole week is a package-level addition with zero live-wire risk.

**Tech Stack:** TypeScript, Web Crypto (`crypto.subtle`), Vitest (`fake-indexeddb` for storage tests). No new runtime dependency.

**Spec:** `docs/superpowers/specs/2026-10-05-phase5-zero-trust-e2ee-design.md` (§3.4, §4.2, §5, §6, §7 gates G2/G3/G4, §8)

## Design decisions (owner review required before execution)

The spec fixes *what* WS1 part 1 must close (§3.4) but not *how*. These are this plan's decisions; each is repeated in the owning task.

1. **Week 15 is browser-only and negotiation-gated; the live terminal path does not change.** The Rust agent cannot decrypt until Week 16, so this week MUST NOT put a single encrypted byte, or a single new frame, on the live wire. `TerminalClient` encrypts/decrypts only when constructed with an `E2eeContext`; the store supplies that context only when the agent has advertised the capability, and the agent cannot advertise it until Week 16. **Alternative rejected:** wiring encryption unconditionally, or sending a hello frame the agent does not understand, would either corrupt every live terminal or change the wire for an uncomprehending peer.

2. **The gate is a capability the *agent* advertises, read from an additive optional field.** The browser is the offerer and already sends `capabilities` in its offer; the answerer (agent) today has no way to advertise. This week adds an **optional** `capabilities?: string[]` to `SignalAnswer` (purely additive — absent today, so nothing changes) so Week 16's agent can advertise `e2ee`. The browser-side store wiring that reads it is **Week 16**, alongside the Rust peer — so Week 15 stays additive at the package boundary. **Alternative rejected:** extending the WS2 proof/offer envelope would couple this week to the Rust signaling parser.

3. **The ECDH key is bound to the verified Ed25519 identity.** A peer's ECDH public key is trusted only when it carries an Ed25519 signature — made with the same WS2 signing key that signs offer proofs — over a canonical string. This closes M6: a session key is trusted only when the ECDH key that produced it is provably the one held by the identity WS2 verified. An unsigned or mis-signed key aborts negotiation (fail closed) and the session stays plaintext.

4. **HKDF with a session-bound `info` and a session `salt`.** Shared secret = ECDH P-256 (`deriveBits`, 256) → HKDF-SHA256 (salt = UTF-8 bytes of the session id, `info` = the domain-separation string `ponter-ws1-terminal-v1`) → 32-byte AES-GCM-256 key. Binding `info` to the purpose and `salt` to the session id prevents cross-session and cross-purpose key reuse. The same derivation is reproduced in Rust in Week 16, so the `info` string and the framing are **pinned constants** in `packages/shared`/`packages/crypto`.

5. **Ciphertext framing matches `ARCHITECTURE.md` §7.2.** Wire form = `[12-byte random IV][AES-GCM ciphertext ‖ 16-byte tag]`, base64-encoded inside the existing `terminal-data.payload.data` field. No new wire field; the framing is self-describing. This is the exact format Week 16's Rust code must produce and consume.

6. **`sendInput` stays synchronous; encryption runs on an ordered queue.** `TerminalClient.sendInput` is `void` and is called synchronously from `TerminalSession.write` (`packages/terminal-core/src/session.ts:24`). Web Crypto is async-only, so when encryption is active the client appends to a promise chain (`this.sendChain = this.sendChain.then(...)`) that encrypts and sends in submission order. Inbound `terminal-data` decryption uses a second ordered chain so frames are delivered in arrival order. When no context is present, both paths are the current synchronous code.

7. **H4 — the ECDH private key becomes long-lived.** `logout()` currently calls `deletePrivateKey` (`apps/web/src/stores/auth.ts:123`). An identity destroyed on logout cannot be a trust anchor, so logout stops deleting it; the key persists across sessions and is loaded at login (it already is, for signing). **Explicit non-goal:** no key-rotation or export UI this week (spec §8).

8. **Test vectors are shared with Rust, and their values are verified.** `packages/crypto/test/vectors/e2ee-vectors.json` holds HKDF-SHA256 (RFC 5869 §A.1, L=42), AES-256-GCM (a deterministic known-answer test), and ECDH P-256 (fixed private JWK + fixed peer public key → fixed secret) vectors. Every value in it was reproduced against Web Crypto before this plan was written. Week 16's Rust test consumes the same file, so interoperability is *proven*, not assumed (spec §5, gate G4).

9. **Docs deliverables.** A new `docs/security/2026-10-07-ws1-e2ee.md` (mirroring the WS2 doc), an update to `ARCHITECTURE.md` §7.2 (the class now exists), a roadmap-date reconciliation in `ARCHITECTURE.md` §8.5 (Phase 5 → Tuần 12–16, Phase 6 → 17–18, Phase 7 → 19–20), the new negotiation frames documented in `docs/guides/terminal-protocol.md`, and an extension of the existing G2 guard (`apps/web/src/__tests__/e2ee-claims.test.ts`) to cover the new doc.

## Global Constraints

- **Layer order is a gate.** WS1 part 1 MUST NOT implement the Rust-side crypto, desktop-input encryption, WS5, or flip ADR-29. Those are Week 16 (spec §3.5). No task may edit `apps/agent/**`.
- **No live-path regression.** With no `E2eeContext`, the terminal must behave exactly as today: a synchronous `terminal-data` frame whose `data` is the plain base64 of the input. A test must prove this byte-for-byte.
- **Fail-closed everywhere.** A missing, malformed, or mis-signed peer ECDH key aborts negotiation — the session stays plaintext, never half-encrypted. A decrypt failure on an inbound frame must surface as an error, never be rendered as terminal output.
- **No new runtime dependency.** Web Crypto only. No `@noble/*`, no `libsodium`. `packages/crypto` and `packages/terminal-core` stay dependency-free (their `dependencies` are workspace packages only).
- **Do not regress the 19 verified-good controls** (spec §2.1) or the WS2/WS3 wire contracts: the `offer`/`answer`/`ice-candidate` envelope, `IdentityProof` canonicalization, `pty-spawn-failed`/`session-limit-reached` spellings, `approved` normalization, the `4409` stale-guard, and the `1001` graceful close.
- **`apps/web/src/components/ui/` is generated.** Never hand-modify it. This week touches no file under `ui/`.
- **Commit discipline:** path-limited commits only (`git commit -m "..." -- <paths>`). Never `git add .`. Never `git stash`.
- **Sonar new-code gate:** keep new code non-duplicated (extract helpers; parameterize test cases rather than clone blocks). Test files count toward duplication.
- **Language:** code, commit messages, and technical docs in English. Conversation replies in Vietnamese.

## Review Focus

The failure modes the spec implies but no single task's happy-path test exercises. Each line's test is added in the owning task.

1. **A session key derived from an unverified ECDH key.** A peer that presents an ECDH public key with no valid Ed25519 signature (or one signed by a different key, or over a different ECDH key) must be refused; the session must not adopt the derived key. → Task 2.
2. **A tampered ciphertext accepted as plaintext.** A flipped bit in the IV, ciphertext, or tag must make `decrypt` throw, and the terminal must surface it as an error — never render ciphertext. → Task 1 (unit) and Task 3 (delivery).
3. **Encryption leaking onto the plaintext path.** With no `E2eeContext`, every `terminal-data` frame must be byte-identical to today's plaintext frame. → Task 3.
4. **A half-negotiated or reordered session.** A hello whose signature fails leaves the session plaintext and functional; encrypted input submitted back-to-back must arrive in order (the sync `write` → async `encrypt` boundary is where order is lost). → Task 3.
5. **Key reuse across sessions or purposes.** Two sessions must derive different keys from the same keypairs (salt = session id), and a terminal key must not validate against a different `info`. → Task 1 and Task 2.
6. **Identity destroyed on logout.** After logout, the ECDH private key must still be present and loadable — the pre-H4 behavior (deleted) is the regression this pins. → Task 4.
7. **A false claim left standing.** Any UI or doc string asserting E2EE that this week does not yet deliver end-to-end (the Rust half is Week 16) must be worded truthfully (gate G2). → Task 5.

---

### Task 1: `EncryptionManager` core (ECDH P-256 → HKDF-SHA256 → AES-GCM-256)

**Files:**
- Create: `packages/crypto/src/encrypt.ts`
- Create: `packages/crypto/test/vectors/e2ee-vectors.json`
- Create: `packages/crypto/test/encrypt.test.ts`
- Modify: `packages/crypto/src/index.ts` (re-export `./encrypt`)

**Interfaces:**
- Consumes: nothing (Web Crypto only).
- Produces:
  - `export const IV_BYTES = 12;`
  - `export async function deriveSharedSecret(privateKey: CryptoKey, peerPublicKey: CryptoKey): Promise<Uint8Array>` — ECDH `deriveBits` 256 → 32-byte secret.
  - `export async function hkdfSha256(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, length = 32): Promise<Uint8Array>`.
  - `export async function importAesGcmKey(raw: Uint8Array): Promise<CryptoKey>`.
  - `export async function aesGcmEncrypt(key: CryptoKey, iv: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array>` — returns `ciphertext ‖ tag` (Web Crypto framing).
  - `export async function aesGcmDecrypt(key: CryptoKey, iv: Uint8Array, ciphertext: Uint8Array): Promise<Uint8Array>`.
  - `export class EncryptionManager` with `static async derive(privateKey: CryptoKey, peerPublicKey: CryptoKey, info: Uint8Array, salt: Uint8Array): Promise<EncryptionManager>`, `async encrypt(plaintext: Uint8Array): Promise<Uint8Array>` (random `IV_BYTES` IV prefix), `async decrypt(framed: Uint8Array): Promise<Uint8Array>`. Task 2 constructs it; Task 3 calls `encrypt`/`decrypt`.

- [ ] **Step 1: Create the shared test-vector file**

Create `packages/crypto/test/vectors/e2ee-vectors.json`. **Every value below was reproduced against Web Crypto and Node's `crypto` module while writing this plan — do not "correct" any of them.** Week 16's Rust test reads the same file.

```json
{
  "_comment": "Shared WS1 E2EE test vectors. Consumed by packages/crypto/test/encrypt.test.ts (TS) and apps/agent's e2ee test (Rust, Week 16). All values verified against Web Crypto.",
  "hkdfSha256": {
    "_source": "RFC 5869, Appendix A.1 (Test Case 1), L=42",
    "ikmHex": "0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b",
    "saltHex": "000102030405060708090a0b0c",
    "infoHex": "f0f1f2f3f4f5f6f7f8f9",
    "length": 42,
    "okmHex": "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865"
  },
  "aesGcm256": {
    "_source": "Deterministic known-answer test (AES-256-GCM, 96-bit IV, 128-bit tag). Web Crypto output is ciphertext||tag.",
    "keyHex": "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
    "ivHex": "cafebabefacedbaddecaf888",
    "plaintextHex": "000102030405060708090a0b0c0d0e0f",
    "ciphertextHex": "8aa2a225ae7f491c4e0257d677108730",
    "tagHex": "69709ea9cfa207201b9f4f7c2eb4596e"
  },
  "ecdhP256": {
    "_source": "Fixed ECDH P-256 pair; the private key is a JWK, the peer key an uncompressed point, the secret verified identical under Web Crypto and node:crypto.",
    "privateJwk": {
      "kty": "EC",
      "crv": "P-256",
      "d": "LCtbPUi1_8F8V4m3yIpeSHzAmXQjApKfinaojeHxV10",
      "x": "xOMx8ZhNbXnDS62yLZtJD5f-rNT8t039islJSYNK5hE",
      "y": "jOgm6ZSxC0AS13ccMCeL1s4F_ycP-bg4-mdyqal88cs"
    },
    "peerPublicRawHex": "040217e617f0b6443928278f96999e69a23a4f2c152bdf6d6cdf66e5b80282d4ed194a7debcb97712d2dda3ca85aa8765a56f45fc758599652f2897c65306e5794",
    "secretHex": "722fd1ecca863b654cf195806bbfe191ce5caac7420e472303ff9c1131629bb6"
  }
}
```

- [ ] **Step 2: Write the failing tests**

Create `packages/crypto/test/encrypt.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  IV_BYTES,
  deriveSharedSecret,
  hkdfSha256,
  importAesGcmKey,
  aesGcmEncrypt,
  aesGcmDecrypt,
  EncryptionManager,
  generateUserKeyPair,
} from '../src/index';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

interface Vectors {
  hkdfSha256: { ikmHex: string; saltHex: string; infoHex: string; length: number; okmHex: string };
  aesGcm256: {
    keyHex: string; ivHex: string; plaintextHex: string;
    ciphertextHex: string; tagHex: string;
  };
  ecdhP256: {
    privateJwk: JsonWebKey; peerPublicRawHex: string; secretHex: string;
  };
}

const vectors: Vectors = JSON.parse(
  readFileSync(fileURLToPath(new URL('./vectors/e2ee-vectors.json', import.meta.url)), 'utf8'),
);

const hex = (s: string) => Uint8Array.from(Buffer.from(s, 'hex'));
const toHex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const utf8 = (s: string) => new TextEncoder().encode(s);

describe('WS1 EncryptionManager primitives', () => {
  it('1. hkdfSha256 reproduces RFC 5869 A.1 (L=42)', async () => {
    const okm = await hkdfSha256(
      hex(vectors.hkdfSha256.ikmHex),
      hex(vectors.hkdfSha256.saltHex),
      hex(vectors.hkdfSha256.infoHex),
      vectors.hkdfSha256.length,
    );
    expect(toHex(okm)).toBe(vectors.hkdfSha256.okmHex);
  });

  it('2. aesGcmEncrypt reproduces the known-answer test (ciphertext||tag)', async () => {
    const key = await importAesGcmKey(hex(vectors.aesGcm256.keyHex));
    const out = await aesGcmEncrypt(key, hex(vectors.aesGcm256.ivHex), hex(vectors.aesGcm256.plaintextHex));
    expect(toHex(out)).toBe(vectors.aesGcm256.ciphertextHex + vectors.aesGcm256.tagHex);
  });

  it('3. aesGcmDecrypt round-trips and rejects a tampered tag', async () => {
    const key = await importAesGcmKey(hex(vectors.aesGcm256.keyHex));
    const iv = hex(vectors.aesGcm256.ivHex);
    const ct = hex(vectors.aesGcm256.ciphertextHex + vectors.aesGcm256.tagHex);
    expect(toHex(await aesGcmDecrypt(key, iv, ct))).toBe(vectors.aesGcm256.plaintextHex);

    const tampered = ct.slice();
    tampered[tampered.length - 1]! ^= 0x01;
    await expect(aesGcmDecrypt(key, iv, tampered)).rejects.toThrow();
  });

  it('4. deriveSharedSecret reproduces the fixed ECDH vector', async () => {
    const priv = await crypto.subtle.importKey(
      'jwk', vectors.ecdhP256.privateJwk,
      { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits'],
    );
    const peer = await crypto.subtle.importKey(
      'raw', hex(vectors.ecdhP256.peerPublicRawHex),
      { name: 'ECDH', namedCurve: 'P-256' }, false, [],
    );
    expect(toHex(await deriveSharedSecret(priv, peer))).toBe(vectors.ecdhP256.secretHex);
  });

  it('5. two peers derive the same secret; a third key does not', async () => {
    const alice = await generateUserKeyPair();
    const bob = await generateUserKeyPair();
    const carol = await generateUserKeyPair();
    const ab = await deriveSharedSecret(alice.privateKey, bob.publicKey);
    const ba = await deriveSharedSecret(bob.privateKey, alice.publicKey);
    const ac = await deriveSharedSecret(alice.privateKey, carol.publicKey);
    expect(toHex(ab)).toBe(toHex(ba));
    expect(toHex(ab)).not.toBe(toHex(ac));
  });

  it('6. EncryptionManager round-trips and rejects a tampered frame', async () => {
    const alice = await generateUserKeyPair();
    const bob = await generateUserKeyPair();
    const info = utf8('ponter-ws1-terminal-v1');
    const salt = utf8('session-1');
    const a = await EncryptionManager.derive(alice.privateKey, bob.publicKey, info, salt);
    const b = await EncryptionManager.derive(bob.privateKey, alice.publicKey, info, salt);

    const plaintext = utf8('ls -la\n');
    const framed = await a.encrypt(plaintext);
    expect(framed.length).toBe(IV_BYTES + plaintext.length + 16);
    expect(await b.decrypt(framed)).toEqual(plaintext);

    const tampered = framed.slice();
    tampered[tampered.length - 1]! ^= 0x01;
    await expect(b.decrypt(tampered)).rejects.toThrow();
  });

  it('7. a different salt (session) yields a key that cannot decrypt', async () => {
    const alice = await generateUserKeyPair();
    const bob = await generateUserKeyPair();
    const info = utf8('ponter-ws1-terminal-v1');
    const a1 = await EncryptionManager.derive(alice.privateKey, bob.publicKey, info, utf8('s1'));
    const a2 = await EncryptionManager.derive(alice.privateKey, bob.publicKey, info, utf8('s2'));
    const framed = await a1.encrypt(utf8('x'));
    await expect(a2.decrypt(framed)).rejects.toThrow();
  });

  it('8. a short frame is rejected before decryption', async () => {
    const alice = await generateUserKeyPair();
    const bob = await generateUserKeyPair();
    const info = utf8('ponter-ws1-terminal-v1');
    const a = await EncryptionManager.derive(alice.privateKey, bob.publicKey, info, utf8('s1'));
    await expect(a.decrypt(new Uint8Array(IV_BYTES))).rejects.toThrow(/too short/);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --filter @ponter/crypto test`
Expected: FAIL — `encrypt.ts` does not exist; `EncryptionManager`, `hkdfSha256`, etc. are `undefined`.

- [ ] **Step 4: Implement `packages/crypto/src/encrypt.ts`**

```ts
//! Application-layer E2EE for the browser side of WS1 (Phase 5, Week 15).
//!
//! Key schedule: ECDH P-256 -> HKDF-SHA256 -> AES-GCM-256. The raw shared secret
//! is never used as a key: HKDF binds the derived key to a session (`salt`) and a
//! purpose (`info`). Ciphertext framing is `[12-byte IV][ct || 16-byte tag]`,
//! matching `docs/ARCHITECTURE.md` §7.2 and the Rust implementation (Week 16).

export const IV_BYTES = 12;

/** ECDH P-256 shared secret (32 bytes). */
export async function deriveSharedSecret(
  privateKey: CryptoKey,
  peerPublicKey: CryptoKey,
): Promise<Uint8Array> {
  const bits = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: peerPublicKey },
    privateKey,
    256,
  );
  return new Uint8Array(bits);
}

/** HKDF-SHA256 (RFC 5869). `length` is in bytes. */
export async function hkdfSha256(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  length = 32,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
}

/** Import a raw 32-byte key as an AES-GCM-256 key. */
export async function importAesGcmKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

/** AES-GCM encrypt with an explicit IV; returns `ciphertext || tag`. */
export async function aesGcmEncrypt(
  key: CryptoKey,
  iv: Uint8Array,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  const out = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    plaintext,
  );
  return new Uint8Array(out);
}

/** AES-GCM decrypt with an explicit IV. Throws on a bad tag. */
export async function aesGcmDecrypt(
  key: CryptoKey,
  iv: Uint8Array,
  ciphertext: Uint8Array,
): Promise<Uint8Array> {
  const out = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    ciphertext,
  );
  return new Uint8Array(out);
}

/** A per-session symmetric key with framed encrypt/decrypt. */
export class EncryptionManager {
  private constructor(private readonly key: CryptoKey) {}

  /**
   * Derive a session key from our ECDH private key and the peer's ECDH public
   * key. `salt` binds the key to one session; `info` binds it to one purpose.
   */
  static async derive(
    privateKey: CryptoKey,
    peerPublicKey: CryptoKey,
    info: Uint8Array,
    salt: Uint8Array,
  ): Promise<EncryptionManager> {
    const secret = await deriveSharedSecret(privateKey, peerPublicKey);
    const raw = await hkdfSha256(secret, salt, info, 32);
    return new EncryptionManager(await importAesGcmKey(raw));
  }

  /** Encrypt with a fresh random IV; the IV is prefixed to the output. */
  async encrypt(plaintext: Uint8Array): Promise<Uint8Array> {
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const ct = await aesGcmEncrypt(this.key, iv, plaintext);
    const framed = new Uint8Array(IV_BYTES + ct.length);
    framed.set(iv, 0);
    framed.set(ct, IV_BYTES);
    return framed;
  }

  /** Decrypt a `[iv][ct||tag]` frame. Throws if short or if the tag fails. */
  async decrypt(framed: Uint8Array): Promise<Uint8Array> {
    if (framed.length <= IV_BYTES) {
      throw new Error('e2ee frame is too short to contain an IV');
    }
    const iv = framed.subarray(0, IV_BYTES);
    const ct = framed.subarray(IV_BYTES);
    return aesGcmDecrypt(this.key, iv, ct);
  }
}
```

- [ ] **Step 5: Re-export from `packages/crypto/src/index.ts`**

Add at the end of `packages/crypto/src/index.ts`:

```ts
export * from './encrypt';
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm --filter @ponter/crypto test`
Expected: PASS (8 new tests plus the pre-existing `crypto.test.ts` / `signing.test.ts`).

- [ ] **Step 7: Commit**

```bash
git commit -m "feat(crypto): ECDH P-256 -> HKDF-SHA256 -> AES-GCM-256 EncryptionManager (WS1)" -- packages/crypto/src/encrypt.ts packages/crypto/src/index.ts packages/crypto/test/encrypt.test.ts packages/crypto/test/vectors/e2ee-vectors.json
```

---

### Task 2: Session-key agreement bound to the WS2 identity

**Files:**
- Create: `packages/shared/src/types/e2ee.ts`
- Modify: `packages/shared/src/types/index.ts` (export the new module)
- Create: `packages/shared/test/e2ee.test.ts`
- Modify: `packages/crypto/package.json` (add `@ponter/shared` — `crypto` currently has no workspace dependencies)
- Create: `packages/crypto/src/session-key.ts`
- Modify: `packages/crypto/src/index.ts` (export `./session-key`)
- Create: `packages/crypto/test/session-key.test.ts`

**Interfaces:**
- Consumes: `signProof` / `verifyProof` (Ed25519), `importPublicKeySpki` (`packages/crypto`); `EncryptionManager` (Task 1).
- Produces:
  - `export const WS1_KEY_VERSION = 'ponter-ws1-v1';`
  - `export const WS1_TERMINAL_INFO = 'ponter-ws1-terminal-v1';`
  - `export function canonicalKeyBinding(ecdhPublicKeySpkiBase64: string): string` → `` `${WS1_KEY_VERSION}\necdhPublicKey=${spki}` ``.
  - `export interface E2eeKeyBinding { ecdhPublicKey: string; signature: string; }`
  - `export async function buildSessionKey(params: BuildSessionKeyParams): Promise<EncryptionManager>` where `BuildSessionKeyParams = { myEcdhPrivateKey: CryptoKey; peerEcdhPublicKeySpkiBase64: string; peerBindingSignature: string; peerSigningPublicKey: CryptoKey; sessionId: string }` — verifies the peer's Ed25519 signature over the canonical binding **before** deriving; throws on any mismatch.

- [ ] **Step 1: Write the failing shared test**

Create `packages/shared/test/e2ee.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { canonicalKeyBinding, WS1_KEY_VERSION, WS1_TERMINAL_INFO } from '../src/index';

describe('WS1 key-binding canonicalization', () => {
  it('is domain-separated and version-tagged', () => {
    const msg = canonicalKeyBinding('AAAABBBB');
    expect(msg).toBe(`${WS1_KEY_VERSION}\necdhPublicKey=AAAABBBB`);
  });

  it('changes when the key changes (no field is optional)', () => {
    expect(canonicalKeyBinding('K1')).not.toBe(canonicalKeyBinding('K2'));
  });

  it('pins the terminal purpose string', () => {
    expect(WS1_TERMINAL_INFO).toBe('ponter-ws1-terminal-v1');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @ponter/shared test`
Expected: FAIL — `../src/index` has no `canonicalKeyBinding`.

- [ ] **Step 3: Implement `packages/shared/src/types/e2ee.ts`**

```ts
/**
 * WS1 (Phase 5) application-layer E2EE — shared, byte-pinned constants and the
 * canonical key-binding message.
 *
 * The ECDH public key a peer advertises is trusted only when it carries an
 * Ed25519 signature (by the WS2 identity key) over the exact string this module
 * produces. The reference implementation is shared with the Rust agent (Week 16);
 * changing any string here is a wire-contract change.
 */
export const WS1_KEY_VERSION = 'ponter-ws1-v1';

/** HKDF `info` for the terminal data channel. */
export const WS1_TERMINAL_INFO = 'ponter-ws1-terminal-v1';

/** The exact UTF-8 string a peer signs to bind its ECDH key to its identity. */
export function canonicalKeyBinding(ecdhPublicKeySpkiBase64: string): string {
  return `${WS1_KEY_VERSION}\necdhPublicKey=${ecdhPublicKeySpkiBase64}`;
}

/** A peer's ECDH public key plus the identity signature that authenticates it. */
export interface E2eeKeyBinding {
  /** SPKI-encoded ECDH P-256 public key, base64. */
  ecdhPublicKey: string;
  /** Ed25519 signature (base64) over `canonicalKeyBinding(ecdhPublicKey)`. */
  signature: string;
}
```

- [ ] **Step 4: Export it from `packages/shared/src/types/index.ts`**

Add alongside the existing `identity-proof` exports:

```ts
export {
  WS1_KEY_VERSION,
  WS1_TERMINAL_INFO,
  canonicalKeyBinding,
} from './e2ee.js';
export type { E2eeKeyBinding } from './e2ee.js';
```

- [ ] **Step 5: Add the `@ponter/shared` dependency to `packages/crypto/package.json`**

`packages/crypto` currently has **no** workspace dependencies (`packages/crypto/package.json` has only `devDependencies`). `session-key.ts` imports `canonicalKeyBinding`/`WS1_TERMINAL_INFO` from `@ponter/shared`, so add the dependency before writing the test:

```json
  "dependencies": {
    "@ponter/shared": "workspace:*"
  },
```

Then run `pnpm install` from the repo root so the workspace link resolves.

- [ ] **Step 6: Write the failing crypto session-key test**

Create `packages/crypto/test/session-key.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  generateUserKeyPair,
  generateSigningKeyPair,
  signProof,
  importSigningPublicKeyRaw,
  exportPublicKeySpki,
  buildSessionKey,
} from '../src/index';
import { canonicalKeyBinding } from '@ponter/shared';

async function makeBinding(signingKey: CryptoKey, ecdhSpki: string) {
  return signProof(signingKey, canonicalKeyBinding(ecdhSpki));
}

describe('WS1 session-key binding', () => {
  it('derives a working key when the peer binding verifies', async () => {
    const aliceEcdh = await generateUserKeyPair();
    const bobEcdh = await generateUserKeyPair();
    const bobSigning = await generateSigningKeyPair();
    const bobSpki = await exportPublicKeySpki(bobEcdh.publicKey);

    const key = await buildSessionKey({
      myEcdhPrivateKey: aliceEcdh.privateKey,
      peerEcdhPublicKeySpkiBase64: bobSpki,
      peerBindingSignature: await makeBinding(bobSigning.privateKey, bobSpki),
      peerSigningPublicKey: await importSigningPublicKeyRaw(bobSigning.publicKeyRawBase64),
      sessionId: 'session-1',
    });

    const framed = await key.encrypt(new TextEncoder().encode('hi'));
    expect(framed.length).toBeGreaterThan(12);
  });

  it('refuses a binding signed by a different identity (fail closed)', async () => {
    const aliceEcdh = await generateUserKeyPair();
    const bobEcdh = await generateUserKeyPair();
    const bobSigning = await generateSigningKeyPair();
    const mallorySigning = await generateSigningKeyPair();
    const bobSpki = await exportPublicKeySpki(bobEcdh.publicKey);

    await expect(
      buildSessionKey({
        myEcdhPrivateKey: aliceEcdh.privateKey,
        peerEcdhPublicKeySpkiBase64: bobSpki,
        peerBindingSignature: await makeBinding(mallorySigning.privateKey, bobSpki),
        peerSigningPublicKey: await importSigningPublicKeyRaw(bobSigning.publicKeyRawBase64),
        sessionId: 'session-1',
      }),
    ).rejects.toThrow(/key binding/i);
  });

  it('refuses a signature made over a different ECDH key', async () => {
    const aliceEcdh = await generateUserKeyPair();
    const bobEcdh = await generateUserKeyPair();
    const otherEcdh = await generateUserKeyPair();
    const bobSigning = await generateSigningKeyPair();
    const bobSpki = await exportPublicKeySpki(bobEcdh.publicKey);
    const otherSpki = await exportPublicKeySpki(otherEcdh.publicKey);

    await expect(
      buildSessionKey({
        myEcdhPrivateKey: aliceEcdh.privateKey,
        peerEcdhPublicKeySpkiBase64: bobSpki,
        peerBindingSignature: await makeBinding(bobSigning.privateKey, otherSpki),
        peerSigningPublicKey: await importSigningPublicKeyRaw(bobSigning.publicKeyRawBase64),
        sessionId: 'session-1',
      }),
    ).rejects.toThrow(/key binding/i);
  });
});
```

- [ ] **Step 7: Run it to verify it fails**

Run: `pnpm --filter @ponter/crypto test`
Expected: FAIL — `buildSessionKey` is not exported.

- [ ] **Step 8: Implement `packages/crypto/src/session-key.ts`**

```ts
import { canonicalKeyBinding, WS1_TERMINAL_INFO } from '@ponter/shared';
import { EncryptionManager } from './encrypt';
import { importPublicKeySpki, verifyProof } from './index';

/** Parameters for deriving a WS1 terminal session key. */
export interface BuildSessionKeyParams {
  /** Our own ECDH private key (non-extractable; from local storage). */
  myEcdhPrivateKey: CryptoKey;
  /** The peer's SPKI-base64 ECDH public key, as carried in its hello/ack. */
  peerEcdhPublicKeySpkiBase64: string;
  /** The peer's Ed25519 signature over `canonicalKeyBinding(peerEcdhPublicKey)`. */
  peerBindingSignature: string;
  /** The peer's Ed25519 signing public key (from the WS2 handshake). */
  peerSigningPublicKey: CryptoKey;
  /** The WebRTC session id; used as the HKDF salt. */
  sessionId: string;
}

/**
 * Verify the peer's identity signature over its ECDH key, then derive the
 * session key. Throws if the binding does not verify — the caller must fall
 * back to plaintext, never adopt an unverified key.
 */
export async function buildSessionKey(
  params: BuildSessionKeyParams,
): Promise<EncryptionManager> {
  const message = canonicalKeyBinding(params.peerEcdhPublicKeySpkiBase64);
  const ok = await verifyProof(
    params.peerSigningPublicKey,
    message,
    params.peerBindingSignature,
  );
  if (!ok) {
    throw new Error('WS1 key binding did not verify against the peer identity');
  }
  const peerEcdhPublicKey = await importPublicKeySpki(
    params.peerEcdhPublicKeySpkiBase64,
  );
  return EncryptionManager.derive(
    params.myEcdhPrivateKey,
    peerEcdhPublicKey,
    new TextEncoder().encode(WS1_TERMINAL_INFO),
    new TextEncoder().encode(params.sessionId),
  );
}
```

- [ ] **Step 9: Export from `packages/crypto/src/index.ts`**

Add: `export * from './session-key';`

- [ ] **Step 10: Run the tests to verify they pass**

Run: `pnpm --filter @ponter/shared test && pnpm --filter @ponter/crypto test`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git commit -m "feat(crypto): bind WS1 session keys to the WS2 peer identity (M6)" -- packages/shared/src/types/e2ee.ts packages/shared/src/types/index.ts packages/shared/test/e2ee.test.ts packages/crypto/package.json packages/crypto/src/session-key.ts packages/crypto/src/index.ts packages/crypto/test/session-key.test.ts
```

---

### Task 3: Negotiation class + negotiation-gated terminal I/O

**Files:**
- Modify: `packages/shared/src/types/terminal.ts` (add the two negotiation frame payload types)
- Modify: `packages/shared/src/types/signaling.ts` (additive optional `capabilities` on `SignalAnswer`)
- Modify: `packages/terminal-core/package.json` (add `@ponter/crypto` — `terminal-core` does not depend on it yet)
- Create: `packages/terminal-core/src/e2ee.ts`
- Modify: `packages/terminal-core/src/client.ts` (ordered send/receive, gated by an optional context)
- Modify: `packages/terminal-core/src/index.ts` (export `./e2ee`)
- Create: `packages/terminal-core/test/e2ee.test.ts`

**Interfaces:**
- Consumes: `EncryptionManager` + `buildSessionKey` (Tasks 1–2); `canonicalKeyBinding` (Task 2); `exportPublicKeySpki`, `signProof` (`packages/crypto`).
- Produces:
  - `export interface TerminalE2eeHello { terminalId: string; ecdhPublicKey: string; signature: string; }` and `export interface TerminalE2eeAck { terminalId: string; ecdhPublicKey: string; signature: string; }` (in `@ponter/shared`).
  - `export interface E2eeContext { ecdhPrivateKey: CryptoKey; ecdhPublicKey: CryptoKey; signingPrivateKey: CryptoKey; peerSigningPublicKey: CryptoKey; sessionId: string; }` and `export class TerminalE2ee` with `buildHello(terminalId): Promise<TerminalE2eeHello>`, `handleHello(hello): Promise<TerminalE2eeAck>`, `handleAck(ack): Promise<void>`, `isActive(): boolean`, `encrypt(data): Promise<Uint8Array>`, `decrypt(data): Promise<Uint8Array>`, `static isNegotiationFrame(type: string): boolean`.
  - `TerminalClient` constructor gains an optional third parameter `e2ee?: TerminalE2ee`.

- [ ] **Step 1: Add the frame payload types to `packages/shared/src/types/terminal.ts`**

```ts
/** WS1 E2EE negotiation: the offerer proposes a session key binding. */
export interface TerminalE2eeHello {
  terminalId: string;
  /** SPKI base64 ECDH P-256 public key. */
  ecdhPublicKey: string;
  /** Ed25519 signature over `canonicalKeyBinding(ecdhPublicKey)`. */
  signature: string;
}

/** WS1 E2EE negotiation: the answerer returns its own key binding. */
export interface TerminalE2eeAck {
  terminalId: string;
  ecdhPublicKey: string;
  signature: string;
}
```

- [ ] **Step 2: Add the additive optional capability to `packages/shared/src/types/signaling.ts`**

In `SignalAnswer`, add:

```ts
  /**
   * WS1: capabilities the answerer supports (e.g. `"e2ee"`). Optional and
   * additive — absent today, so an answer without it behaves exactly as before.
   * The browser reads it to decide whether to negotiate terminal encryption.
   */
  capabilities?: string[];
```

Leave `parseAnswer` unchanged (it already ignores unknown fields; adding the type field is enough this week, and Week 16 decides whether to normalize it).

- [ ] **Step 3: Add the `@ponter/crypto` dependency, then write the failing negotiation test**

`packages/terminal-core` depends only on `@ponter/shared` and `@ponter/webrtc-core` today. Add `@ponter/crypto` to its `dependencies` in `packages/terminal-core/package.json`:

```json
  "dependencies": {
    "@ponter/crypto": "workspace:*",
    "@ponter/shared": "workspace:*",
    "@ponter/webrtc-core": "workspace:*"
  },
```

Run `pnpm install` from the repo root, then create `packages/terminal-core/test/e2ee.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import 'fake-indexeddb/auto';
import {
  generateUserKeyPair,
  generateSigningKeyPair,
  importSigningPublicKeyRaw,
} from '@ponter/crypto';
import { TerminalE2ee } from '../src/e2ee';

async function makePeer(sessionId: string) {
  const ecdh = await generateUserKeyPair();
  const signing = await generateSigningKeyPair();
  const peerSigningPublicKey = await importSigningPublicKeyRaw(signing.publicKeyRawBase64);
  return {
    ecdhPrivateKey: ecdh.privateKey,
    ecdhPublicKey: ecdh.publicKey,
    signingPrivateKey: signing.privateKey,
    peerSigningPublicKey,
    sessionId,
  };
}

describe('WS1 terminal E2EE negotiation', () => {
  it('two peers negotiate and round-trip terminal bytes', async () => {
    const a = await makePeer('sess');
    const b = await makePeer('sess');
    const ta = new TerminalE2ee({ ...a, peerSigningPublicKey: b.peerSigningPublicKey });
    const tb = new TerminalE2ee({ ...b, peerSigningPublicKey: a.peerSigningPublicKey });

    const ack = await tb.handleHello(await ta.buildHello('t1'));
    await ta.handleAck(ack);

    expect(ta.isActive()).toBe(true);
    expect(tb.isActive()).toBe(true);

    const plaintext = new TextEncoder().encode('echo hi\n');
    expect(await tb.decrypt(await ta.encrypt(plaintext))).toEqual(plaintext);
  });

  it('a hello whose signature does not verify leaves the session plaintext', async () => {
    const a = await makePeer('sess');
    const b = await makePeer('sess');
    const mallory = await makePeer('sess');
    const tb = new TerminalE2ee({ ...b, peerSigningPublicKey: a.peerSigningPublicKey });

    await expect(tb.handleHello(await mallory.buildHello('t1'))).rejects.toThrow();
    expect(tb.isActive()).toBe(false);
  });

  it('isNegotiationFrame matches only the two negotiation frame types', () => {
    expect(TerminalE2ee.isNegotiationFrame('terminal-e2ee-hello')).toBe(true);
    expect(TerminalE2ee.isNegotiationFrame('terminal-e2ee-ack')).toBe(true);
    expect(TerminalE2ee.isNegotiationFrame('terminal-data')).toBe(false);
  });

  it('before negotiation, encrypt/decrypt are identity (dormant)', async () => {
    const a = await makePeer('sess');
    const b = await makePeer('sess');
    const ta = new TerminalE2ee({ ...a, peerSigningPublicKey: b.peerSigningPublicKey });
    expect(ta.isActive()).toBe(false);
    const data = new TextEncoder().encode('x');
    expect(await ta.encrypt(data)).toEqual(data);
    expect(await ta.decrypt(data)).toEqual(data);
  });
});
```

- [ ] **Step 4: Run it to verify it fails**

Run: `pnpm --filter @ponter/terminal-core test`
Expected: FAIL — `../src/e2ee` does not exist.

- [ ] **Step 5: Implement `packages/terminal-core/src/e2ee.ts`**

```ts
import {
  buildSessionKey,
  EncryptionManager,
  exportPublicKeySpki,
  signProof,
} from '@ponter/crypto';
import {
  canonicalKeyBinding,
  type TerminalE2eeAck,
  type TerminalE2eeHello,
} from '@ponter/shared';

/** The keys a browser needs to run terminal E2EE for one session. */
export interface E2eeContext {
  /** Our own ECDH private key (non-extractable; from local storage). */
  ecdhPrivateKey: CryptoKey;
  /** Our own ECDH public key (for the signed binding we advertise). */
  ecdhPublicKey: CryptoKey;
  /** Our Ed25519 signing private key (WS2 identity). */
  signingPrivateKey: CryptoKey;
  /** The peer's Ed25519 signing public key (verified by WS2). */
  peerSigningPublicKey: CryptoKey;
  /** The WebRTC session id; used as the HKDF salt. */
  sessionId: string;
}

/**
 * WS1 terminal E2EE negotiation (Phase 5, Week 15).
 *
 * Dormant until negotiated: `isActive()` is false and `encrypt`/`decrypt` are
 * identity, so a caller that never negotiates sends plaintext unchanged. The key
 * is derived only after the peer's ECDH key is proven (Ed25519 signature over
 * the canonical binding). Any verification failure throws and leaves the session
 * plaintext — never half-encrypted.
 */
export class TerminalE2ee {
  private manager: EncryptionManager | null = null;

  constructor(private readonly ctx: E2eeContext) {}

  /** True for the two frame types that drive negotiation. */
  static isNegotiationFrame(type: string): boolean {
    return type === 'terminal-e2ee-hello' || type === 'terminal-e2ee-ack';
  }

  isActive(): boolean {
    return this.manager !== null;
  }

  private async binding(): Promise<{ ecdhPublicKey: string; signature: string }> {
    const ecdhPublicKey = await exportPublicKeySpki(this.ctx.ecdhPublicKey);
    const signature = await signProof(
      this.ctx.signingPrivateKey,
      canonicalKeyBinding(ecdhPublicKey),
    );
    return { ecdhPublicKey, signature };
  }

  /** Offerer side: build our hello. */
  async buildHello(terminalId: string): Promise<TerminalE2eeHello> {
    return { terminalId, ...(await this.binding()) };
  }

  /** Answerer side: verify the hello, derive the key, return our ack. */
  async handleHello(hello: TerminalE2eeHello): Promise<TerminalE2eeAck> {
    this.manager = await buildSessionKey({
      myEcdhPrivateKey: this.ctx.ecdhPrivateKey,
      peerEcdhPublicKeySpkiBase64: hello.ecdhPublicKey,
      peerBindingSignature: hello.signature,
      peerSigningPublicKey: this.ctx.peerSigningPublicKey,
      sessionId: this.ctx.sessionId,
    });
    return { terminalId: hello.terminalId, ...(await this.binding()) };
  }

  /** Offerer side: verify the peer's ack and derive the key. */
  async handleAck(ack: TerminalE2eeAck): Promise<void> {
    this.manager = await buildSessionKey({
      myEcdhPrivateKey: this.ctx.ecdhPrivateKey,
      peerEcdhPublicKeySpkiBase64: ack.ecdhPublicKey,
      peerBindingSignature: ack.signature,
      peerSigningPublicKey: this.ctx.peerSigningPublicKey,
      sessionId: this.ctx.sessionId,
    });
  }

  async encrypt(data: Uint8Array): Promise<Uint8Array> {
    return this.manager ? this.manager.encrypt(data) : data;
  }

  async decrypt(data: Uint8Array): Promise<Uint8Array> {
    return this.manager ? this.manager.decrypt(data) : data;
  }
}
```

- [ ] **Step 6: Gate `TerminalClient` send/receive on the context, preserving order and parity**

Modify `packages/terminal-core/src/client.ts`:
- Import `TerminalE2ee` and `E2eeContext` from `./e2ee` (type-only for the context).
- Add a third constructor parameter `private readonly e2ee?: TerminalE2ee` and two ordered chains: `private sendChain: Promise<void> = Promise.resolve();` and `private receiveChain: Promise<void> = Promise.resolve();`.
- Rewrite `sendInput` so that when `this.e2ee?.isActive()` it appends to `sendChain` (encrypt then `sendJson` with the base64 of the framed bytes), and otherwise runs the current synchronous body unchanged.
- In `handleMessage` for `terminal-data`, when `this.e2ee?.isActive()` it appends to `receiveChain` (decode → `await decrypt` → `session.receiveOutput`, catching and forwarding decrypt failures to the error listeners), and otherwise runs the current synchronous body unchanged.
- Add `export * from './e2ee';` to `packages/terminal-core/src/index.ts`.

Target shape for `sendInput` (implementer adapts to the existing body):

```ts
sendInput(terminalId: string, data: Uint8Array | string): void {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const e2ee = this.e2ee;
  if (!e2ee || !e2ee.isActive()) {
    // Unchanged plaintext path — byte-identical to today.
    const payload: TerminalDataMessage = { terminalId, data: uint8ArrayToBase64(bytes) };
    this.dataChannelManager.sendJson('terminal', 'terminal-data', payload);
    return;
  }
  this.sendChain = this.sendChain.then(async () => {
    const framed = await e2ee.encrypt(bytes);
    const payload: TerminalDataMessage = { terminalId, data: uint8ArrayToBase64(framed) };
    this.dataChannelManager.sendJson('terminal', 'terminal-data', payload);
  });
}
```

- [ ] **Step 7: Add the client-level tests (parity, encryption, ordering)**

Append to `packages/terminal-core/test/e2ee.test.ts`:

```ts
import { TerminalClient } from '../src/client';
import type { DataChannelManager } from '@ponter/webrtc-core';
import type { DataChannelMessage } from '@ponter/shared';

function mockChannel() {
  const frames: Array<{ type: string; payload: unknown }> = [];
  let handler: ((m: DataChannelMessage) => void) | undefined;
  const manager = {
    sendJson: (_ch: string, type: string, payload: unknown) => frames.push({ type, payload }),
    onMessage: (_ch: string, cb: (m: DataChannelMessage) => void) => {
      handler = cb;
      return () => {};
    },
  } as unknown as DataChannelManager;
  return { manager, frames, emit: (m: DataChannelMessage) => handler?.(m) };
}

// `createSession()` sends a `terminal-create` frame first; these helpers isolate
// the `terminal-data` frames the assertions care about.
const dataFrames = (frames: Array<{ type: string; payload: unknown }>) =>
  frames.filter((f) => f.type === 'terminal-data');

it('plaintext parity: no e2ee context sends the exact same frame as today', () => {
  const { manager, frames } = mockChannel();
  const client = new TerminalClient('agent-1', manager);
  const session = client.createSession();
  session.write('hello world');
  expect(dataFrames(frames)).toEqual([
    { type: 'terminal-data', payload: { terminalId: session.id, data: Buffer.from('hello world').toString('base64') } },
  ]);
});

it('encrypts when active and preserves submission order', async () => {
  const a = await makePeer('sess');
  const b = await makePeer('sess');
  const ta = new TerminalE2ee({ ...a, peerSigningPublicKey: b.peerSigningPublicKey });
  const tb = new TerminalE2ee({ ...b, peerSigningPublicKey: a.peerSigningPublicKey });
  await ta.handleAck(await tb.handleHello(await ta.buildHello('t1')));

  const { manager, frames } = mockChannel();
  const client = new TerminalClient('agent-1', manager, ta);
  const session = client.createSession();
  session.write('one');
  session.write('two');
  await new Promise((r) => setTimeout(r, 0)); // let the ordered chain drain

  const decoded = await Promise.all(
    dataFrames(frames).map((f) =>
      tb.decrypt(new Uint8Array(Buffer.from((f.payload as { data: string }).data, 'base64'))),
    ),
  );
  expect(decoded.map((d) => new TextDecoder().decode(d))).toEqual(['one', 'two']);
});
```

- [ ] **Step 8: Run the whole terminal-core suite**

Run: `pnpm --filter @ponter/terminal-core test`
Expected: PASS — new tests plus the pre-existing `client.test.ts` / `client-error.test.ts` / `session.test.ts` / `buffer.test.ts` (the plaintext path stays green, including `sendInput encodes input to base64 and sends terminal-data`).

- [ ] **Step 9: Commit**

```bash
git commit -m "feat(terminal-core): negotiation-gated E2EE for terminal I/O (WS1)" -- packages/shared/src/types/terminal.ts packages/shared/src/types/signaling.ts packages/terminal-core/package.json packages/terminal-core/src/e2ee.ts packages/terminal-core/src/client.ts packages/terminal-core/src/index.ts packages/terminal-core/test/e2ee.test.ts
```

---

### Task 4: Long-lived private-key lifecycle (H4)

**Files:**
- Modify: `apps/web/src/stores/auth.ts` (remove `deletePrivateKey` from `logout()`; leave a comment)
- Create: `apps/web/src/stores/auth.test.ts` (if none exists) — pin the new behavior
- Modify: `packages/crypto/test/crypto.test.ts` (add a load-after-logout lifecycle test)

**Interfaces:**
- Consumes: `savePrivateKey`, `loadPrivateKey`, `deletePrivateKey` (`packages/crypto`).
- Produces: no new API — a behavior change: the ECDH private key survives `logout()`.

- [ ] **Step 1: Write the failing lifecycle test in the crypto package**

Add to `packages/crypto/test/crypto.test.ts`:

```ts
it('N. an ECDH private key survives a simulated logout (H4)', async () => {
  const { privateKey } = await generateUserKeyPair();
  await savePrivateKey('user-1', privateKey);
  // logout() must NOT call deletePrivateKey; the key must still load.
  expect(await loadPrivateKey('user-1')).not.toBeNull();
});
```

- [ ] **Step 2: Run it to verify it passes at the crypto layer**

Run: `pnpm --filter @ponter/crypto test`
Expected: PASS (the primitive already round-trips). The real regression lives in the store, below.

- [ ] **Step 3: Write the failing store test**

Create `apps/web/src/stores/auth.test.ts` (mirror the setup style of an existing web store test). Assert that after `logout()`, `loadPrivateKey(userId)` is still non-null:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { loadPrivateKey, savePrivateKey, generateUserKeyPair } from '@ponter/crypto';
import { useAuthStore } from './auth';

describe('auth store — H4 key lifecycle', () => {
  beforeEach(async () => {
    const req = indexedDB.deleteDatabase('remote-crypto');
    await new Promise((res, rej) => { req.onsuccess = res; req.onerror = rej; });
  });

  it('logout() does not delete the ECDH private key', async () => {
    const store = useAuthStore();
    const { privateKey } = await generateUserKeyPair();
    await savePrivateKey('user-1', privateKey);
    store.user = { id: 'user-1' } as never; // minimal shape for the logout path
    await store.logout();
    expect(await loadPrivateKey('user-1')).not.toBeNull();
  });
});
```

> The implementer adapts the store setup to the real `useAuthStore` API (`user`/`status` refs, `tokenStorage`, `apiClient`). If the store cannot be driven in a unit test without a live API client, mock `apiClient.auth.logout` with `vi.mock` — the assertion that matters is only that `loadPrivateKey` survives.

- [ ] **Step 4: Run it to verify it fails**

Run: `pnpm --filter @ponter/web test`
Expected: FAIL — `logout()` currently calls `deletePrivateKey`, so `loadPrivateKey` returns null.

- [ ] **Step 5: Implement the fix in `apps/web/src/stores/auth.ts`**

Remove the `await deletePrivateKey(user.value.id);` call (and its `try/catch`) from `logout()` (line ~117–125). Keep the server-side logout (`apiClient.auth.logout(refreshToken)`) and all other teardown. Replace the removed block with a comment:

```ts
// The ECDH identity key is long-lived (WS1/H4): it is the trust anchor for
// peer identity and session-key binding, so logout must NOT delete it. It is
// loaded again at the next login.
```

Also remove the now-unused `deletePrivateKey` import if nothing else uses it (check with `grep -n deletePrivateKey apps/web/src/stores/auth.ts`).

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm --filter @ponter/web test && pnpm --filter @ponter/crypto test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git commit -m "fix(web): keep the ECDH identity key across logout (H4)" -- apps/web/src/stores/auth.ts apps/web/src/stores/auth.test.ts packages/crypto/test/crypto.test.ts
```

---

### Task 5: Docs, G2 guard, and ARCHITECTURE reconciliation

**Files:**
- Create: `docs/security/2026-10-07-ws1-e2ee.md`
- Modify: `docs/ARCHITECTURE.md` (§7.2 status note; §8.5 roadmap dates)
- Modify: `docs/guides/terminal-protocol.md` (document the negotiation frames)
- Modify: `apps/web/src/__tests__/e2ee-claims.test.ts` (extend the G2 doc scan to the new WS1 doc)

**Interfaces:** none (docs + a test-only guard).

- [ ] **Step 1: Write `docs/security/2026-10-07-ws1-e2ee.md`**

Mirror the structure of `docs/security/2026-10-05-ws2-peer-identity.md`. Cover: what WS1 part 1 delivers (EncryptionManager, the key schedule with exact `info`/salt/framing, the `terminal-e2ee-hello`/`-ack` frames, H4); the **trust boundary** (the ECDH key is authenticated by the WS2 Ed25519 identity; the TOFU residual risk from WS2 is unchanged); a **fail-closed table** (unsigned/mis-signed ECDH key → negotiation aborts → session stays plaintext; tampered frame → decrypt throws → surfaced as an error, never rendered); and **what WS1 part 1 does NOT do** (no Rust-side crypto, no desktop-input encryption, **not active against the live agent until Week 16**, file transfer still out of application-layer scope per spec §4.3).

- [ ] **Step 2: Update `docs/ARCHITECTURE.md` §7.2**

Replace the `⚠️ Trạng thái thực tế (2026-10-01)` warning (line ~813) with a status noting that the browser-side class now exists in `packages/crypto/src/encrypt.ts` (Phase 5 Week 15) and that the Rust equivalent lands Week 16. Keep the link to the audit.

- [ ] **Step 3: Reconcile the roadmap dates in `docs/ARCHITECTURE.md`**

Change the Phase 5 heading (line ~1030) from `(Tuần 12-14)` to `(Tuần 12-16)`, Phase 6 (line ~1040) from `(Tuần 15-16)` to `(Tuần 17-18)`, Phase 7 (line ~1044) from `(Tuần 17-18)` to `(Tuần 19-20)` — matching the owner-approved 5-week schedule (spec §1). Cite the spec in the section.

- [ ] **Step 4: Document the negotiation frames in `docs/guides/terminal-protocol.md`**

Add `### 3.6 terminal-e2ee-hello` and `### 3.7 terminal-e2ee-ack` after §3.5: their payloads (`{ terminalId, ecdhPublicKey, signature }`), the canonical key-binding string, the HKDF `info` (`ponter-ws1-terminal-v1`) and salt (session id), and the framing `[12-byte IV][ct || 16-byte tag]` inside `terminal-data.payload.data`. State explicitly that a peer which does not negotiate keeps the plaintext path, and that the agent side is Week 16.

- [ ] **Step 5: Extend the G2 guard in `apps/web/src/__tests__/e2ee-claims.test.ts`**

Add the new doc to the doc-claim scan so it cannot drift into asserting live E2EE:

```ts
const WS1_DOC = '../../../docs/security/2026-10-07-ws1-e2ee.md';

describe('no false E2EE claims in the WS1 doc', () => {
  it('WS1 part 1 doc does not claim end-to-end E2EE against the live agent', () => {
    const doc = read(WS1_DOC);
    expect(doc).not.toMatch(
      /(implements|provides|enables|is|are)\s+(end-to-end\s+)?(e2ee|zero[-\s]?trust|encryption)/i,
    );
  });
});
```

- [ ] **Step 6: Grep for stray live-E2EE claims (gate G2)**

Run a repo-wide grep for affirmative E2EE/Zero-Trust claims in UI files and docs, and rule on each hit (fix now vs. defer). Because this week's E2EE is not active against the real agent, any unqualified claim must be corrected. Record the grep and the ruling in the PR description.

- [ ] **Step 7: Run the format and guard checks**

Run: `pnpm format:check` (note: `docs/` is in `.prettierignore`, so keep tables aligned by hand) and `pnpm --filter @ponter/web test` (the G2 guard must stay green).

- [ ] **Step 8: Commit**

```bash
git commit -m "docs(ws1): E2EE security note, ARCHITECTURE status, roadmap dates, G2 guard" -- docs/security/2026-10-07-ws1-e2ee.md docs/ARCHITECTURE.md docs/guides/terminal-protocol.md apps/web/src/__tests__/e2ee-claims.test.ts
```

---

## Verification (whole-branch, before the review chain)

- `pnpm lint --force`, `pnpm typecheck --force`, `pnpm format:check`, and each package's `vitest run` green.
- The **plaintext-parity** test (Task 3) proves no live-path change.
- The **fail-closed** tests (Tasks 1–2) prove no unverified key is adopted and no tampered frame is decrypted.
- `git diff main..HEAD -- apps/agent/` is **empty** (Layer-order gate: no Rust this week).
- `git diff main..HEAD -- apps/web/src/components/ui/` is **empty** (UI rule).
- No new runtime dependency: `git diff main..HEAD -- '**/package.json' pnpm-lock.yaml` shows nothing, or test-only additions.

## Carry-forward (Week 16 — WS1 part 2 + WS5, spec §3.5)

- The Rust `EncryptionManager` (via `ring`), consuming the same `e2ee-vectors.json`.
- The agent advertises `e2ee` in its answer `capabilities`; `PeerConnection` exposes it; the store builds an `E2eeContext` and passes it to `TerminalClient` — this is what activates the negotiation for real.
- Cross-language E2E gate **G3** (browser encrypts → Rust decrypts, and vice versa).
- Desktop-input encryption; CSP + security headers; token-storage review; coturn hardening; remove predictable defaults from `docker/.env.example`.
- **ADR-29 stays closed** (spec §8): input forwarding is not opened this week or next; Phase 6 opens it with evidence.
