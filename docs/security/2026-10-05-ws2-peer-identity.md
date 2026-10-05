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
   `apps/agent/src/main.rs:153-168`). The public half is uploaded to the server
   over the credential-authenticated agent socket, with a proof-of-possession
   signature over a server nonce so a stolen credential cannot enroll a key it
   does not hold. The proof-of-possession message is the domain-separated string
   `ponter-ws2-agent-identity-v1\nnonce=<nonce>` (no trailing newline), signed
   with the agent's Ed25519 key — server constant `WS2_IDENTITY_PROOF_PREFIX`
   (`apps/server/src/routes/ws.ts:31`), agent builder `build_agent_identity_frame`
   (`apps/agent/src/signal.rs:260-266`).

2. **Agent answer proof (C3).** The agent signs its DTLS-fingerprint proof and
   sends it on the answer signal. The browser verifies the signature against the
   agent key learned from `GET /api/agents`, and against the SDP fingerprint,
   **before** calling `setRemoteDescription` — a mismatch aborts the handshake.

3. **User offer proof (M1, H3).** The browser signs its offer SDP fingerprint
   and session id with the user's Ed25519 key, and includes the raw public key
   (`userSigningPublicKey`) on the offer. On the **terminal** path the agent
   verifies the proof **before** `rtc::answer_offer` — a missing, malformed, or
   tampered proof aborts the session before any answer SDP is sent and before
   any PTY is created. (The gate is terminal-scoped by design; see "Gate scope"
   below.)

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

Rows 1–4 are the agent-side (H3) gate; they apply to the **terminal** path only
(see "Gate scope" below). Rows 5–7 are the browser-side (C3) answer check, which
runs for every session type whenever `identity` is present.

The agent's gate is `verify_offer_identity`, called **before** `rtc::answer_offer`.
Both PTY spawn sites (the dispatcher task and the implicit spawn-on-demand) are
downstream of the poll task, which is only spawned after the answer is accepted —
so on the **terminal** path, gating the answer gates every downstream path.

**Gate scope — terminal only.** `verify_offer_identity` has exactly one call site,
`apps/agent/src/main.rs:956`, inside the `SessionMode::Terminal` arm. The
`SessionMode::Desktop` (`main.rs:902`) and `SessionMode::Files` (`main.rs:922`)
arms `return` **before** it and reach `rtc::send_desktop_answer` /
`rtc::send_approved_answer` without verifying the user's offer proof. This is by
design: spec §3.2 defines H3 as "verify the client's key/fingerprint **before
spawning a PTY**", and desktop/files sessions spawn no PTY. The asymmetry is
deliberate and one-directional:

- **Browser-side (C3) verifies the agent for every session type** — the answer
  check at `connection.ts:341-353` runs whenever `identity` is present,
  regardless of mode.
- **Agent-side (H3) verifies the browser only for terminal** — the PTY path is
  the one that unblocks input forwarding, so it is the path H3 gates.

Desktop input remains separately held closed by ADR-29 (`--allow-input`, default
off); file transfer is out of application-layer scope (spec §4.3). Extending
agent-side offer verification to desktop/files is **out of scope for WS2**.

## TOFU trust boundary (residual risk)

WS2 uses **Trust on First Use (TOFU)**, not PKI. The trust model is:

- **Browser → agent key:** The browser learns the agent's public key from
  `GET /api/agents`, which the agent uploaded at first authenticated connect.
  A signaling server that substitutes SDP or fingerprint lines **cannot** forge
  the agent's signature, because it does not hold the agent's private key.
- **Agent → user key:** The agent learns the user's public key from the server,
  which stored it at user registration. The server **overwrites** any
  client-supplied key, so a browser cannot inject a key it does not control.

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

- `apps/web/src/stores/terminal.ts:143-162` — `resolvePeerIdentity` returns
  `undefined` when `!agent.signingPublicKey` (line 152) or when the local
  signing key fails to load. The doc-comment there already notes this fallback
  is "identical to the pre-WS2 behavior."
- With no `identity`, the caller connects with `identity: undefined`. The
  browser therefore builds no `IdentityProof` and sends no
  `userSigningPublicKey` on the offer, and — because the answer check at
  `connection.ts:341` is guarded by `if (this.options.identity)` — it also does
  not verify the agent's answer proof.

**Terminal path (fail-closed).** `apps/agent/src/main.rs:765-796`
(`verify_offer_identity`) rejects the offer ("offer carries no identity proof" /
"offer carries no user signing key") **before** `rtc::answer_offer`
(main.rs:956→958). The answer is never produced, so no answer SDP is sent and no
PTY is spawned: a **denial of service** (the session cannot open), **not** a
confidentiality break — it cannot cause an unverified session to run.

**Desktop/files paths (fail-open, by design).** These arms are not H3-gated (see
"Gate scope" above). Under the same omission attack the session still opens with
no peer-identity verification on either side. This is the intended WS2 boundary,
not a regression: H3 is PTY-specific (spec §3.2), desktop input stays closed by
ADR-29 (`--allow-input` default off), and file transfer is out of
application-layer scope (spec §4.3). Extending agent-side offer verification to
these arms is **out of scope for WS2**.

Accepted at WS2 by design: Phase 5's WS2 is a TOFU/bootstrap layer (spec §8).
Server-side key attestation / full PKI is **not** delivered by any Phase 5
workstream — spec §8 places certificate-based agent provisioning explicitly out
of scope.

## What WS2 does NOT do

- WS2 does **not** encrypt session payloads. That is WS1 (spec §3.4; C1/C4/H7/H11).
- WS2 does **not** enforce the `approved` flag on offers. That is WS3
  (spec §3.3, H2).
- WS2 does **not** implement a certificate chain or revocation list for peer
  keys. TOFU is the intended model.
