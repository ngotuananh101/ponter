# WS2 Peer Identity — Threat Model & Trust Boundary

**Date:** 2026-10-05
**Layer:** 2 (WS2) of Phase 5's three-layer design
**Scope:** Ed25519 peer-identity proofs that bind each WebRTC offer/answer to a
cryptographic key held by the originating peer.

## Deliverables

This document covers four deliverables. Each fails closed when its gate applies:

1. **Agent identity key (H6/C5/H5).** The Rust agent generates and persists an
   Ed25519 keypair at a disk path (`--identity-path`; the default resolves
   `$XDG_CONFIG_HOME/ponter/agent-identity.pkcs8`, falling back to
   `$HOME/.config/ponter/agent-identity.pkcs8` when `XDG_CONFIG_HOME` is unset,
   and to `./ponter/agent-identity.pkcs8` when neither is set — `resolve_identity_path`,
   `apps/agent/src/main.rs:119-133`). The public half is uploaded to the server
   over the credential-authenticated agent socket, with a proof-of-possession
   signature over a server nonce so a stolen credential cannot enroll a key it
   does not hold. The proof-of-possession message is the domain-separated string
   `ponter-ws2-agent-identity-v1\nnonce=<nonce>` (no trailing newline), signed
   with the agent's Ed25519 key — server constant `WS2_IDENTITY_PROOF_PREFIX`
   (`apps/server/src/routes/ws.ts:31`), agent builder `build_agent_identity_frame`
   (`apps/agent/src/signal.rs:263`).

2. **Agent answer proof (C3).** The agent signs its DTLS-fingerprint proof and
   sends it on the answer signal. The browser verifies the signature against the
   agent key learned from `GET /api/agents`, and against the SDP fingerprint,
   **before** calling `setRemoteDescription` — a mismatch aborts the handshake.

3. **User offer proof (M1, H3).** The browser signs its offer SDP fingerprint
   and session id with the user's Ed25519 key, and includes the raw public key
   (`userSigningPublicKey`) on the offer. The agent verifies the proof
   **before** `rtc::answer_offer` for **every** session mode (ADR-41 admission
   gate, see "Gate scope" below) — a missing, malformed, or tampered proof
   aborts the session before any answer SDP is sent. On the terminal path this
   also means no PTY is created; on the desktop and files paths it means no
   capture pipeline or files-root probe is performed.

4. **Server relay enforcement.** The signaling server does not verify
   signatures — it is a pure shape-and-relay. For offers, the server overwrites
   any client-supplied `userSigningPublicKey` with the value stored in the user
   row (server-sourced, never trusted from the client).

## Canonical proof message

Both peers sign and verify the exact same UTF-8 string:

```
ponter-ws2-v1
role=<offerer|answerer>
sessionId=<sessionId>
sdpSha256=<lowercase hex SHA-256 of the SDP string>
fingerprint=<uppercase colon-separated hex, from the SDP a=fingerprint line>
```

The `role` binding prevents a replay of an offer proof as an answer proof (and
vice versa). The `sessionId` binding prevents a proof captured in one session
from verifying in another. The `sdpSha256` and `fingerprint` fields bind the
signature to the exact SDP and DTLS certificate that were presented.

The reference implementation lives in two places and must be byte-identical:
`packages/shared/src/types/identity-proof.ts` (TypeScript) and
`apps/agent/src/identity.rs` (Rust).

A **second** domain-separated string is used for the user-identity proof that is
not bound to a session, role, or SDP:

```
ponter-ws2-user-identity-v1
userId=<userId>
```

The exact builder is `canonicalUserIdentityMessage(userId)`
(`packages/shared/src/types/identity-proof.ts:76`) using the prefix constant
`USER_IDENTITY_PROOF_PREFIX = 'ponter-ws2-user-identity-v1'`
(`packages/shared/src/types/identity-proof.ts:70`). The message uses a single
`\n` separator and **no trailing newline**. Unlike the per-session proof above,
this string is browser-signed and **server-only verified** (both sides use
`packages/shared`), so there is no second parser to keep in lockstep (contrast
ADR-77).

## Fail-closed points

| # | Point | When the check fails |
|---|-------|----------------------|
| 1 | Agent: offer has no `proof` | Session aborts before `answer_offer` — no answer SDP sent, no PTY spawned |
| 2 | Agent: offer has no `userSigningPublicKey` | Same as above |
| 3 | Agent: proof fingerprint ≠ SDP fingerprint | Same as above |
| 4 | Agent: signature does not verify against the user key | Same as above |
| 5 | Browser: answer proof is absent | `setRemoteDescription` is skipped — the local peer connection stays in `have-local-offer` and the channel never opens |
| 6 | Browser: answer fingerprint ≠ SDP fingerprint | Same as above |
| 7 | Browser: answer signature does not verify | Same as above |

Rows 1–4 are the agent-side (H3) gate; they apply to **every** session mode
(terminal, desktop, files, and unknown-capability offers), since ADR-41 hoisted
`verify_offer_identity` before the `SessionMode` dispatch so that Desktop, Files,
Terminal, and None all pass through it. Rows 5–7 are the browser-side (C3) answer
check, which runs for every session type whenever `identity` is present.

The agent's gate is `verify_offer_identity`, called **before** `rtc::answer_offer`.
All mode-dispatch paths downstream of the gate are therefore fail-closed together:
an offer without a valid proof bails out of `run_one_session` with NO answer of any
kind — not even `approved: false` — so no PTY is spawned, no desktop capture
pipeline is armed, and no files-root probe is performed.

**Gate scope — admission gate for every mode.**
**`C1 closed (Phase 6a, 2026-10-07):** ADR-41 hoisted `verify_offer_identity` to a single
admission gate that runs before the mode dispatch in `run_one_session`, so the
desktop and files paths now run the same verification the terminal path always ran;
an offer without a valid proof bails with no answer of any kind. The paragraph below
describes the state before that change; see `docs/security/2026-10-08-ws1-e2ee-rust.md`
§"What is NOT encrypted" for the sibling WS1 note.

The definition of `verify_offer_identity` is at `apps/agent/src/lib.rs:876`. Its
exactly ONE production call site is at `apps/agent/src/lib.rs:1049`, placed
**before** the `match mode` dispatch (see `apps/agent/src/lib.rs:1039-1048`): the
in-code comment there states it is "an ADMISSION gate for every session mode, not a
terminal-only step." Because the call sits upstream of `SessionMode::Desktop`
(`run_one_session` at `apps/agent/src/lib.rs:965`) and `SessionMode::Files`,
those arms no longer `return` before the gate — every mode passes through
`verify_offer_identity` first. Rows 5–7 (browser answer check) are unchanged in
meaning: the check at `packages/webrtc-core/src/connection.ts:358` (guarded by
`if (this.options.identity)`, then `verifyRemoteProof(...)`) runs whenever `identity`
is present, regardless of mode.

## TOFU trust boundary (residual risk)

WS2 uses **Trust on First Use (TOFU)**, not PKI. The trust model is:

- **Browser → agent key:** The browser learns the agent's public key from
  `GET /api/agents`, which the agent uploaded at first authenticated connect.
  A signaling server that substitutes SDP or fingerprint lines **cannot** forge
  the agent's signature, because it does not hold the agent's private key.
- **Agent → user key:** The agent learns the user's public key from the server,
  which stored it at user registration or bootstrapped it later (see "Legacy-account
  key bootstrap" below). The server **overwrites** any client-supplied key, so a
  browser cannot inject a key it does not control.

**Residual risk:** The trust boundary does **not** defend against a
signaling server that swaps the identity keys themselves. If the server were
compromised and replaced the user's `signingPublicKey` in the DB with an
attacker-controlled key, the agent would accept the attacker's proof. This is
the documented boundary of Phase 5 (spec §8): "H6 is closed with a keypair,
not a full PKI." No Phase 5 workstream delivers server-side key attestation —
spec §8 places certificate-based agent provisioning explicitly out of scope.

### Residual downgrade: a hostile server omits the agent key

A signaling server under the trust boundary (TOFU) can also attack **liveness**
rather than confidentiality. The server may simply **omit** the agent's
`signingPublicKey` from `GET /api/agents` (or the browser may fail to load its
local copy of the key). The effect chain is:

- `apps/web/src/stores/terminal.ts:154` defines the typed error class
  `PeerIdentityUnavailableError`; `apps/web/src/stores/terminal.ts:172` defines
  `resolvePeerIdentity`, which **throws** `PeerIdentityUnavailableError` when
  identity is not `'ready'` (the key is genuinely unrecoverable — see "Legacy-account
  key bootstrap" below). It never returns `undefined` and never sends a
  proof-less offer. The doc-comment there notes this fail-closed behavior.
- With no usable `identity`, the connect path surfaces a typed tab `error` and
  **no offer is sent at all**. The browser therefore builds no `IdentityProof`
  and sends no `userSigningPublicKey` on the offer. Even if an offer were
  constructed, the answer check at `packages/webrtc-core/src/connection.ts:358`
  is guarded by `if (this.options.identity)` and so would not verify the agent's
  answer proof.

**Every mode (fail-closed).** Because ADR-41 hoisted the admission gate
(`verify_offer_identity`) before the `SessionMode` dispatch, all mode arms —
terminal, desktop, and files — now fail closed under an omission attack. The
agent-side definition is at `apps/agent/src/lib.rs:876` (error strings "offer
carries no identity proof" / "offer carries no user signing key" at
`apps/agent/src/lib.rs:883` / `:887`); `rtc::answer_offer` is defined in
`apps/agent/src/rtc.rs:758` and called at `apps/agent/src/lib.rs:1117`, only
after the gate has passed. A proof-less offer is rejected with no answer of any
kind — not even `approved: false` — so no answer SDP is sent, no PTY is spawned,
no desktop capture pipeline is armed, and no files-root probe is performed: a
**denial of service** (the session cannot open), **not** a confidentiality break
— it cannot cause an unverified session to run.

A proof-less offer can only occur when the user signing key is genuinely
unrecoverable. After PR #90 the browser no longer self-degrades to a
proof-less offer on a missing key: it attempts a best-effort bootstrap on login
and restore, and only the unrecoverable cases below leave `identityStatus` as
`'unavailable'` → `resolvePeerIdentity` throws → the tab surfaces a typed error.

Accepted at WS2 by design: Phase 5's WS2 is a TOFU/bootstrap layer (spec §8).
Server-side key attestation / full PKI is **not** delivered by any Phase 5
workstream — spec §8 places certificate-based agent provisioning explicitly out
of scope.

### Legacy-account key bootstrap

Accounts created before WS2 (pre-PR-#44) carry a `null` signing key
(`packages/shared/src/types/user.ts:13`). These legacy accounts obtain a key through a
dedicated bootstrap path rather than at registration:

- **Endpoint:** `POST /api/auth/signing-key`
  (`apps/server/src/routes/auth.ts:318`), Bearer-authenticated and
  **bootstrap-only** — it does not rotate an existing key.
- **Proof:** the browser proves possession of the private key by signing the
  canonical string `ponter-ws2-user-identity-v1\nuserId=<id>`
  (prefix `USER_IDENTITY_PROOF_PREFIX = 'ponter-ws2-user-identity-v1'` at
  `packages/shared/src/types/identity-proof.ts:70`; builder
  `canonicalUserIdentityMessage(userId)` at `packages/shared/src/types/identity-proof.ts:76`).
  The server verifies the signature over
  `canonicalUserIdentityMessage(user.id)` (`apps/server/src/routes/auth.ts:342`).
  Because both sides use `packages/shared`, there is no second parser to keep
  in lockstep (contrast ADR-77).
- **No rotation:** if the user already has a key the server returns **409**
  `SIGNING_KEY_ALREADY_SET` (`apps/server/src/routes/auth.ts:371`) and never
  rotates. A bad proof is **400** `VALIDATION_ERROR`
  (`apps/server/src/routes/auth.ts:362`).
- **Client flow:** `ensureUserSigningKey` (`apps/web/src/stores/auth.ts:69`)
  runs on login (`apps/web/src/stores/auth.ts:198`) and restore
  (`apps/web/src/stores/auth.ts:179`); it is best-effort and **never throws**.
  It sets `identityStatus` (`apps/web/src/stores/auth.ts:44`, type `IdentityStatus`
  at `apps/web/src/stores/auth.ts:21`) to `'ready'` or `'unavailable'`.
- **Fail-closed on the connect path:** `resolvePeerIdentity`
  (`apps/web/src/stores/terminal.ts:172`) throws
  `PeerIdentityUnavailableError` (`apps/web/src/stores/terminal.ts:154`) when
  identity is not `'ready'`, so the session surfaces a typed tab `error` and
  **no proof-less offer is ever sent**.
- **Unrecoverable cases (never fabricate a key):** a second device (local
  private absent + server key present) and a pre-existing account whose
  non-extractable private key cannot yield its public raw (local private present
  + server null + no stored public raw). In both, `identityStatus` stays
  `'unavailable'` and the connect path fails closed with the typed error — it
  does **not** generate a mismatched key and does **not** degrade to a
  proof-less offer.

## What WS2 does NOT do

- WS2 does **not** encrypt session payloads. That is WS1 (spec §3.4; C1/C4/H7/H11).
- WS2 does **not** enforce the `approved` flag on offers. That is WS3
  (spec §3.3, H2).
- WS2 does **not** implement a certificate chain or revocation list for peer
  keys. TOFU is the intended model.
