# WS2 Peer Identity — Threat Model & Trust Boundary

**Date:** 2026-10-05
**Layer:** 2 (WS2) of Phase 5's three-layer design
**Scope:** Ed25519 peer-identity proofs that bind each WebRTC offer/answer to a
cryptographic key held by the originating peer.

## Deliverables

This document covers four deliverables, all of which are fail-closed:

1. **Agent identity key (H6/C5/H5).** The Rust agent generates and persists an
   Ed25519 keypair at a disk path (`--identity-path`, default
   `$XDG_CONFIG_HOME/ponter/agent-identity.pkcs8`). The public half is uploaded
   to the server over the credential-authenticated agent socket, with a
   proof-of-possession signature over a server nonce so a stolen credential
   cannot enroll a key it does not hold.

2. **Agent answer proof (C3).** The agent signs its DTLS-fingerprint proof and
   sends it on the answer signal. The browser verifies the signature against the
   agent key learned from `GET /api/agents`, and against the SDP fingerprint,
   **before** calling `setRemoteDescription` — a mismatch aborts the handshake.

3. **User offer proof (M1).** The browser signs its offer SDP fingerprint and
   session id with the user's Ed25519 key, and includes the raw public key
   (`userSigningPublicKey`) on the offer. The agent verifies the proof **before**
   `rtc::answer_offer` — a missing, malformed, or tampered proof aborts the
   session before any answer SDP is sent and before any PTY is created.

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

The agent's gate is positioned at `main.rs:verify_offer_identity`, called
**before** `rtc::answer_offer`. Both PTY spawn sites (the dispatcher task and
the implicit spawn-on-demand) are downstream of the poll task, which is only
spawned after the answer is accepted — so gating the answer gates every
downstream path.

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
not a full PKI." WS3 (spec §3.3) may address server-side identity attestation
in a future phase.

## What WS2 does NOT do

- WS2 does **not** encrypt session payloads. That is WS1 (spec §3.1, H1).
- WS2 does **not** enforce the `approved` flag on offers. That is WS3
  (spec §3.3, H2).
- WS2 does **not** implement a certificate chain or revocation list for peer
  keys. TOFU is the intended model.
