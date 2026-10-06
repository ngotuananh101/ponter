# Phase 5: Zero-Trust & End-to-End Encryption — Design Spec

- **Date:** 2026-10-05
- **Status:** Design approved by owner (2026-10-05), pending written review
- **Baseline:** `main` @ `fdead292` (PR #41 merged)
- **Schedule:** Tuần 12–16 (5 tuần, mở rộng từ 3 tuần theo yêu cầu owner)
- **Research input:** [`docs/security/2026-10-01-e2ee-zero-trust-audit.md`](../../security/2026-10-01-e2ee-zero-trust-audit.md)
- **Related:** `docs/ARCHITECTURE.md` §7 (Bảo mật), §8.5 (Phase 5), spec Tuần 9 (ADR-26..30)

---

## 1. Why Phase 5, and what "done" means here

Phase 4 (file transfer) is merged. The platform now has a working P2P data path — terminal,
desktop streaming, and file transfer — carried over WebRTC data channels.

That path is encrypted in transit by DTLS 1.2, which WebRTC mandates. **The platform is not
unencrypted.** The gap is that neither endpoint can verify *who* is on the other end of that
DTLS session, so a compromised signaling server can substitute its own DTLS fingerprint and
MITM the connection undetected. The audit calls this C3.

Phase 5 closes that gap and the surrounding Zero-Trust gaps. It is also the gate for two
downstream phases:

- **Phase 3 input forwarding** — the mechanism and wire format exist but are held closed by
  ADR-29 (`--allow-input`) pending WS2 (peer identity) and WS3 (enforce `approved`).
- **Phase 7 Agent Desktop App** — depends on WS2 giving the agent a real keypair.

**Schedule change.** The roadmap budgeted 3 weeks. The owner extended it to 5 (2026-10-05)
with the explicit constraint that **security takes priority over feature schedule** — Phases 6
and 7 shift out by 2 weeks (Phase 6 → Tuần 17–18, Phase 7 → Tuần 19–20). The reasoning: doing
E2EE badly or partially is *worse* than not doing it, because the UI advertises a guarantee
that does not exist (see §4.1).

## 2. Audit findings, re-verified against the current tree

The audit was verified against commit `64e4066`. PRs #10–#41 landed since. Findings were
re-checked against `main` @ `fdead292` before this spec was written:

| ID | Finding | Status at `fdead292` | Evidence |
|---|---|---|---|
| C1 | Application-layer E2EE entirely absent | **CONFIRMED** | `packages/crypto/src/` contains only `index.ts`; no `deriveKey`/AES-GCM anywhere |
| C2 | Documented `EncryptionManager` does not exist | **CONFIRMED** | `ARCHITECTURE.md` §7.2 marks it as target design, not implemented |
| C3 | No out-of-band DTLS-fingerprint verification | **CONFIRMED** | `devices.fingerprint` (`apps/server/src/db/client.ts:34`) is a device fingerprint, unrelated to DTLS |
| C5 | README claims client-side public-key verification | **CONFIRMED** | no verification code exists |
| H1 | Client-controlled `shell` → arbitrary binary execution | **CONFIRMED** | `apps/agent/src/main.rs:164` `resolve_shell_value()` returns any string unmodified |
| H2 | Session `approved` recorded but never enforced | **CONFIRMED** (server) / **STALE** (client) | server: `recordSignal` activated on any answer — fixed in WS3 (Week 14). client: `connection.ts` has refused `approved: false` since `2de7a23` (2026-10-01), before this spec's baseline |
| H3 | Agent has no peer identity verification | **CONFIRMED** | agent spawns a PTY on offer without verifying the requester |
| H4 | User private key deleted on logout | **CONFIRMED** | `apps/web/src/stores/auth.ts:112` calls `deletePrivateKey` inside `logout()` |
| H5 | "Client-side public-key verification" claimed, unimplemented | **CONFIRMED** | — |
| H6 | Agent registration uses browser-generated dummy keys | **CONFIRMED** | `apps/server/src/routes/devices.ts` takes `fingerprint` from the browser POST body |
| H7 | E2EE absent (data-path lens) | **CONFIRMED** | same root cause as C1 |
| H8 | CSWSH Origin bypassed by default | **CONFIRMED** | `docker/.env.example:41` sets `CORS_ORIGIN=*`; `apps/server/src/utils/cors.ts:13` reads the env with no safe default |
| H9 | No rate limiting / lockout on login | **CONFIRMED** | `apps/server/src/routes/auth.ts` has none |
| H10 | Refresh token not rotated on use | **CONFIRMED** | — |
| H11 | E2EE payload encryption missing | **CONFIRMED** | same root cause as C1 |
| M1 | Signaling plaintext, no end-to-end signature | **CONFIRMED** | — |
| M2 | Agent ignores WebSocket close codes | **PARTIALLY** | `apps/agent/src/main.rs:554` reconnects on *every* close including `4409` (replaced) and `4401`, causing a reconnect flap |
| M3 | `candidate.session_id` not validated against the active offer | **STALE** | the guard landed in `2de7a23` (2026-10-01), before this spec's baseline `fdead292`; WS3 (Week 14) added the missing regression test and mutation proof |
| M4 | `packages/crypto` is keygen + storage only | **CONFIRMED** | `packages/crypto/src/index.ts` exports only keygen/import/export/save/load/delete |
| M6 | Zero-Trust identity partial — keypair never used for peer auth | **CONFIRMED** | — |
| M7 | Browser terminal input: base64 + JSON, no crypto | **CONFIRMED** | — |
| M8 | Agent PTY output: base64 only, no crypto crates | **CONFIRMED** | `apps/agent/Cargo.toml` (lines 7–31) lists no crypto crate |
| M9 | JWT secret not validated at startup | **CONFIRMED** | `process.env.JWT_SECRET!` non-null assertion at use site |
| M10 | Revocation not consulted on WS upgrade | **CONFIRMED** | — |
| M11 | Revocation writer limited to explicit logout | **CONFIRMED** | — |
| M12 | Browser WS Origin bypass | **CONFIRMED** | same root cause as H8 |

**Also fixed outside the 5 workstreams:** the roadmap note in `ARCHITECTURE.md` §8.5 leaves a
dangling reference to the Week 3 ADR-06 deferral; §4.1 of this spec closes it via H8/M12.

### 2.1 Verified-good (do not regress)

The audit lists 19 implemented controls that are working. Phase 5 must not weaken any of them:
PBKDF2 with constant-time comparison, JWT HS256 with type/scope separation, SQLite revocation,
single-use 15-second WebSocket tickets, CSPRNG usage, per-user tenancy scoping on every route,
stale-guard on `4409` eviction (`ws.ts:736`), and the 1001 graceful-shutdown close.

## 3. Architecture — three layers, built in dependency order

The central design claim of this spec:

> **E2EE must not be the first layer built.** Wrapping AES-GCM on a channel whose peer is not
> yet authenticated encrypts only the two ends of a link an attacker may already own. It looks
> like security while adding none.

Therefore:

```
Layer 1  WS4  Auth hardening            — independent, no prerequisites
Layer 2  WS2  Peer identity             — prerequisite for everything below
Layer 3  WS3 + WS1                      — only meaningful once Layer 2 holds
```

### 3.1 Week 12 — WS4 (auth hardening) + fix false claims

Closes H9, H10, H8, M9, M10, M11, M12 — and completeness-critic **5.2**, which is the same
refresh-token rotation defect as H10 seen from a different angle.

- **Rate limiting + lockout** on the login endpoint (H9).
- **Refresh-token rotation with reuse detection** (H10, 5.2). Reuse of a rotated token revokes
  the whole family — standard theft detection.
- **`JWT_SECRET` startup validation** (M9). Fail fast at boot; remove the `!` non-null
  assertion so a missing secret cannot silently become `undefined`.
- **`CORS_ORIGIN` allowlist** (H8, M12). `apps/server/src/utils/cors.ts:13` currently reads the
  env with no safe fallback and `docker/.env.example:41` ships `*`. Replace with an explicit
  allowlist; refuse to boot on a wildcard in production configuration.
- **Revocation checks on WebSocket upgrade and on live sockets** (M10, M11). An already-open
  socket must not outlive a revocation.
- **Remove false UI claims** — see §4.1.

### 3.2 Week 13 — WS2 (peer identity & signaling integrity)

Closes C3, H3, H6, C5, H5, M1. **This is the foundation week.**

- **Give the Rust agent a real keypair** (H6, C5, H5). Today `apps/server/src/routes/devices.ts`
  accepts a `fingerprint` supplied by the *browser* — the daemon has no identity at all. The
  agent generates and retains its own keypair and presents a signed proof instead.
- **Out-of-band DTLS-fingerprint verification** (C3). The agent communicates its expected
  DTLS fingerprint over an already-authenticated channel; the browser compares it against the
  fingerprint in the remote SDP. A mismatch aborts the handshake **before any PTY is spawned**.
- **SDP signing bound to the user keypair** (M1).
- **Agent-side peer verification** (H3): verify the client's key/fingerprint before spawning a
  PTY. This is the gate that unblocks input forwarding.

### 3.3 Week 14 — WS3 (agent session hardening)

Closes H1, H2, M2, M3.

- **`shell` allowlist** (H1). `resolve_shell_value()` (`apps/agent/src/main.rs:164`) currently
  returns any client-supplied string unmodified — arbitrary binary execution on the agent host.
  Replace with an allowlist of absolute paths per platform, validated against the filesystem.
- **Enforce `approved`** in server and client (H2, completeness-critic 5.3). The flag is written
  but nothing reads it; an unapproved session must not consume SDP.
- **Close-code handling** (M2). The agent must distinguish `4409` (replaced — stop reconnecting)
  and `4401` (unauthorized — stop) from transient closes.
- **Validate `candidate.session_id`** against the active offer (M3).

### 3.4 Week 15 — WS1 part 1: E2EE core + terminal

Closes C1, C2, C4, H7, H11, M4, M7.

- **`EncryptionManager`** as designed in `ARCHITECTURE.md` §7.2: ECDH P-256 → HKDF → AES-GCM-256.
- **Session keys bound to verified peer identity** (M6) — depends on WS2 (Week 13).
- **Private-key lifecycle** (H4). Load the key at login; **stop deleting it on logout**. Identity
  persists across sessions; that is the point of a long-lived keypair.
- **Terminal I/O both directions**, browser side, using Web Crypto.

### 3.5 Week 16 — WS1 part 2: Rust agent + desktop input + WS5

Closes M8, M6, H4, plus completeness-critic 5.1, 5.4, 5.5.

- **Rust-side equivalent** of `EncryptionManager` via `ring` (see §6 for the build-time risk).
- **Desktop input forwarding** encrypted on the same path.
- **CSP + security headers** on the Web SPA (5.1).
- **Token storage** — `localStorage` review (5.4).
- **coturn hardening** — pin image, drop host networking, rotate the static secret (5.5).
- **Remove predictable defaults** from `docker/.env.example` (audit §7 item).

## 4. Scope decisions

### 4.1 False E2EE claims in the UI — fixed in Week 12

Four user-visible labels currently assert protections that do not exist:

| File | Claim |
|---|---|
| `apps/web/src/components/layout/AppHeader.vue:132` | `E2EE Ready` |
| `apps/web/src/components/auth/RegisterForm.vue:87` | `E2EE Keygen` |
| `apps/web/src/components/auth/LoginForm.vue:55` | `Zero-Trust Auth` |
| `apps/web/src/views/DashboardView.vue:269` | `Zero-Trust E2EE` |

An authentication page advertising "E2EE Keygen" when no E2EE exists is a false assurance to a
user who is, at that exact moment, deciding whether to trust this platform with credentials.
Replace with wording that is true today (e.g. `DTLS-secured connection`, `Password-derived
keys`). Scheduled in Week 12 rather than Week 15 because a false claim costs nothing to fix
now and actively misleads for 3 weeks if deferred.

### 4.2 E2EE applies to terminal, desktop input, and signaling — not video

Owner decision (2026-10-05). Encrypted: terminal I/O, desktop input (pointer/keyboard),
SDP/ICE signaling. Not encrypted: video streams.

Video already runs over DTLS, and encrypting it at the application layer would break the
WebCodecs pipeline built in Phase 3 (Week 8) — an architectural change well beyond Phase 5.

### 4.3 File transfer is NOT encrypted at the application layer

Owner decision (2026-10-05), on the recommendation of the PM.

File transfer is excluded for a measured reason, not a security one. Week 11 spent its final
hours driving a 50 MiB transfer from 6.5 MB/s to **10.94 MB/s** on a 2-vCPU CI runner by
optimizing the Rust build and batching ACKs. Adding AES-GCM to that path spends CPU on the
exact bottleneck that was just resolved, and would likely push sustained throughput back below
the threshold the team just spent a full day defending.

File transfer still gains protection: it traverses the **same DTLS session whose peer is
verified in Week 13**. Fingerprint verification is a connection-level control — it applies to
every channel on that connection. Excluding file transfer from *payload* encryption costs
nothing in protection, because the peer it is talking to is already authenticated.

**This boundary is a gate, not a preference.** If an implementer defaults file transfer into
the encrypted-channel set, that is a defect and the CI gate G4 (§7) must fail.

## 5. Testing strategy

- **Unit** — `EncryptionManager` against published NIST/RFC test vectors for AES-GCM-256 and
  ECDH P-256. The same vector file is consumed by the JS and Rust implementations, so Week 16
  proves interoperability rather than trusting two independent implementations to be correct.
- **Cross-language E2E** — the browser encrypts, the Rust agent decrypts, and vice versa. This
  is the gate that actually proves E2EE; a JS-only round-trip proves nothing about the agent.
- **Negative** — fingerprint mismatch, unapproved session, disallowed `shell`, replayed refresh
  token, wrong-origin upgrade. Each must fail closed.
- **Regression guard for §4.3** — assert that file transfer is *not* routed through
  `EncryptionManager`, and that the Phase 4 throughput measurement still holds.

## 6. Risks and stop conditions

| # | Risk | Mitigation |
|---|---|---|
| 1 | **Rust crypto build time on 6 platforms.** `ring`/`aws-lc-rs` may push `Build Agent` past runner timeouts. | Measure in Week 15, not Week 16. If it does not fit, evaluate a smaller primitive (e.g. XChaCha20-Poly1305 via a lighter crate) before cutting scope. |
| 2 | **Pressure to encrypt file transfer anyway** "for consistency". | §4.3 is an approved boundary. Violating it trades a measured regression for a cosmetic one. |
| 3 | **UI claims get re-added** as part of E2EE feature work. | Gate G2 (§7) is a review checklist item. |
| 4 | **WS2 slips**, and WS1 starts without a foundation. | WS1 has an explicit dependency (§3.2). Starting it early is a design error, not an efficiency gain. |
| 5 | **3-week schedule pressure returns.** | The 5-week schedule is an owner decision (2026-10-05). Cutting WS5 is the designated release valve. |

## 7. Definition of done — exit gates

| Gate | Condition |
|---|---|
| **G1** | All 5 workstreams complete; no open critical or high finding |
| **G2** | No UI or docs text claims E2EE/Zero-Trust that the code does not implement |
| **G3** | Cross-language E2E test proves the Rust agent correctly decrypts browser-encrypted payloads |
| **G4** | CI green on all 6 agent targets; crypto test vectors present and passing |
| **G5** | Zero-Trust audit re-run; closed findings carry evidence |

## 8. Explicitly out of scope

- **Opening the ADR-29 input-forwarding gate.** Phase 5 closes H1 and H2, the two prerequisites
  ADR-29 names. But opening the gate is the largest attack-surface change the product can make,
  and doing it one week after E2EE lands is premature. Keep ADR-29 closed; Phase 6 opens it with
  evidence.
- **Hardware-accelerated video codecs** (ADR-25) — deferred to Phase 6.
- **Certificate-based agent provisioning** — H6 is closed with a keypair, not a full PKI.