# E2EE & Zero-Trust Audit — Phase 5 Research Input

- **Date:** 2026-10-01
- **Status:** Research note — required reading before starting **Phase 5 (E2EE & Security & Polish, Weeks 12-14)**
- **Audit scope:** end-to-end encryption (E2EE) and Zero-Trust compliance across `apps/web`, `apps/server`, `apps/agent`, `packages/*`
- **Method:** adversarial multi-agent audit — 6 independent finder lenses → 48 claims → 28 claims selected for verification → 56 independent adversarial verifiers (2 per claim: one prompted to refute, one to re-derive independently) → completeness critic. 63 agents total. All 28 verified claims survived both verifiers (**CONFIRMED**, 0 refuted, 0 uncertain).
- **Verified against commit:** `64e4066` (branch `feat/fe-ws-signaling`). Line numbers are accurate as of that commit — re-check before acting.
- **Provenance:** workflow run `wf_13b522c3-61f`; the raw journal and full JSON result are retained in local session artifacts (not committed to the repo).

> **Context — why this document exists.** The design specs already defer most of these gaps to Phase 5 on purpose
> (`docs/superpowers/specs/2026-09-25-phase1-week3-frontend-design.md`,
> `2026-09-25-phase2-week4-webrtc-core-design.md:50-52`,
> `2026-09-26-phase2-week5-terminal-agent-design.md:96-98`).
> The project is in active development, so docs and UI legitimately run ahead of the implementation
> ("E2EE Ready" in the app header, "Zero-Trust E2EE" on the dashboard, §7.2 of `ARCHITECTURE.md`).
> This audit is the **Phase 5 work list** — it is not a blocker for Phases 2-4.

---

## 0. Verdict summary

- **E2EE: not compliant at the application layer.** There is no application-layer E2EE anywhere in the
  repository. The only payload protection today is the WebRTC-mandatory transport encryption
  (DTLS 1.2 / SCTP-over-DTLS) between browser and agent — which a compromised signaling path can MITM,
  because no out-of-band DTLS-fingerprint or peer-identity verification exists (C3).
  `packages/crypto` contains key generation and storage only; the documented `EncryptionManager`
  (`ARCHITECTURE.md` §7.2) was never implemented (C2).
- **Zero-Trust: partially compliant.** A solid authentication foundation is in place (PBKDF2 with
  constant-time comparison, JWT HS256 pinning with type/scope separation, revocation via SQLite,
  single-use 15-second WebSocket tickets, CSPRNG everywhere, per-user tenancy scoping on every route —
  see §6). But the audit verified **5 critical + 11 high + 12 medium** gaps (§2–§4), plus 5 additional
  areas flagged by the completeness critic (§5).
- **Numbers:** 48 claims found; 28 adversarially verified (all CONFIRMED); 19 info-level implemented
  items (verified only by finders, not adversarially); 1 medium finding not selected for verification;
  5 completeness-critic areas.
- **Lens duplicates are intentional.** Several findings from different lenses describe the same
  underlying gap (e.g. the E2EE-absence theme appears in `crypto-e2ee`, `data-path`, `docs-defaults`,
  and `server-authz`). They were kept as separate entries because each was independently verified from a
  different attack surface; cross-references are noted.

---

## 1. How to read this document

- **Severity:** `critical` = breaks the E2EE / Zero-Trust promise end-to-end; `high` = exploitable with a
  realistic attacker position; `medium` = hardening gap or defense-in-depth loss; `info` = verified as
  implemented (good).
- **Classification:** `absent-gap` = feature/control missing; `claimed-in-docs-but-absent` = documentation
  or UI claims it, code does not implement it; `implemented-partial` = exists but incomplete/unenforced;
  `implemented` = working as intended.
- **CONFIRMED** means both an adversarial refuter and an independent re-derivation failed to refute the
  claim (56/56 verifier verdicts came back CONFIRMED for the 28 claims below).
- Evidence quotes are verbatim from the codebase at commit `64e4066`.

---

## 2. Critical findings (5)

### C1 — Application-layer E2EE is completely absent

- **ID:** `crypto-e2ee:claim-e2ee-app-layer-missing` (absent-gap)
- **Statement:** Application-layer end-to-end encryption is absent across all packages and applications;
  terminal sessions transmit raw plaintext payloads (base64 inside a JSON envelope).
- **Evidence:** `packages/terminal-core/src/client.ts:113-115` —
  `const payload: TerminalDataMessage = { terminalId, data: uint8ArrayToBase64(bytes) }; this.dataChannelManager.sendJson('terminal', 'terminal-data', payload);`
  Repo-wide `grep -rnE "(subtle\.encrypt|subtle\.decrypt|AES-GCM|deriveKey)"` returns zero production occurrences.
- **Impact:** Terminal input/output travels unencrypted at the application layer. If signaling is
  intercepted or the signaling server is compromised, an attacker can MITM the WebRTC SDP negotiation
  and read all terminal traffic in cleartext.
- **Verdict:** CONFIRMED (refute + re-derive). Verifier note: DTLS 1.2 (SCTP-over-DTLS) is transport
  encryption, not application-layer E2EE; without out-of-band identity verification it does not stop a
  signaling-path MITM.

### C2 — Documented `EncryptionManager` (`packages/crypto/src/encrypt.ts`) does not exist

- **ID:** `crypto-e2ee:claim-arch-encryption-manager-absent` (claimed-in-docs-but-absent)
- **Statement:** The `EncryptionManager` class and `packages/crypto/src/encrypt.ts` documented in
  `ARCHITECTURE.md` §7.2 do not exist in the codebase.
- **Evidence:** `docs/ARCHITECTURE.md:757-761` documents `// packages/crypto/src/encrypt.ts` /
  `export class EncryptionManager {`. `packages/crypto/src/` contains only `index.ts`;
  `grep -rn "EncryptionManager"` across apps and packages yields zero matches.
- **Impact:** Architecture documentation specifies an active E2EE implementation (ECDH P-256 `deriveKey`
  + AES-GCM-256) that was never implemented.
- **Verdict:** CONFIRMED (refute + re-derive). Verifier note: the week4/week5 specs already record this
  as deferred to Phase 5 and state the `EncryptionManager` is "documentation-only".

### C3 — No out-of-band DTLS-fingerprint verification → signaling MITM

- **ID:** `data-path:mitm-sdp-fingerprint-unverified` (absent-gap)
- **Statement:** There is no mechanism to verify the DTLS fingerprint carried in SDP out-of-band; a
  malicious signaling server can Man-in-the-Middle the connection and decrypt all terminal data.
- **Evidence:** `packages/webrtc-core/src/connection.ts:187-189` —
  `const offerDesc = toSessionDescriptionInit(msg.data, 'offer'); await this.peer.setRemoteDescription(offerDesc);`
  and `:207-209` for the answer; `apps/agent/src/rtc.rs:186` —
  `let approved = offer.capabilities.iter().any(|c| c == TERMINAL_LABEL);`.
  No logic anywhere extracts or compares `a=fingerprint:` values out-of-band.
- **Impact:** WebRTC DTLS uses self-signed certificates whose fingerprints travel inside the SDP via the
  signaling server. A compromised server (or anyone who can tamper with signaling) can substitute both
  fingerprints and MITM the session while both peers remain unaware.
- **Verdict:** CONFIRMED (refute + re-derive). No WebRTC Identity Provider (RFC 8827) or any equivalent
  exists.

### C4 — Docs/README claim E2EE via `EncryptionManager`, code does not implement it

- **ID:** `docs-defaults:e2ee-payload-encryption` (claimed-in-docs-but-absent)
- **Statement:** Documentation and README claim end-to-end encryption via `EncryptionManager`
  (ECDH P-256 + AES-GCM-256), but `packages/crypto/src/encrypt.ts` does not exist and no payload
  encryption is implemented.
- **Evidence:** `docs/ARCHITECTURE.md:757-761` (§7.2 "E2EE Implementation");
  `docs/superpowers/specs/2026-09-25-phase2-week4-webrtc-core-design.md:50-52` — "packages/crypto
  currently has no encrypt.ts; the EncryptionManager in the architecture document is documentation-only."
- **Impact:** Data channels carry plaintext bytes over DTLS; if signaling or connection credentials are
  intercepted there is no second layer of protection.
- **Verdict:** CONFIRMED (refute + re-derive). Overlaps C1/C2 — same underlying gap, independently
  verified from the documentation lens.

### C5 — README claims "client-side public-key verification"; none exists

- **ID:** `docs-defaults:zero-trust-public-key-verification` (claimed-in-docs-but-absent)
- **Statement:** The project claims Zero-Trust with client-side public-key verification, but public keys
  are never verified or used for cryptographic authentication, and agent registration falls back to a
  dummy placeholder key.
- **Evidence:** `README.md:18` — "Zero-Trust & E2EE: Secure by default with client-side public-key
  verification"; `apps/web/src/components/agent/RegisterAgentDialog.vue:82` —
  `let publicKey = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExamplePublicKey';`;
  `apps/agent/src/main.rs:75-80` (`resolve_credential`) — the Rust agent authenticates solely via a
  bearer credential, with no keypair.
- **Impact:** No public-key verification, challenge-response, or signature check exists anywhere; stored
  public keys are never used for any security decision.
- **Verdict:** CONFIRMED (refute + re-derive). Specs record that only keypair generation/storage was in
  scope so far; actual use is Phase 5.

---

## 3. High findings (11)

### H1 — Client-controlled `shell` parameter → arbitrary binary execution on the agent host

- **ID:** `agent-trust:CLAIM-01-CLIENT-SHELL-INJECTION` (absent-gap)
- **Statement:** The browser/client fully controls the `shell` parameter of the `terminal-create` frame;
  the agent executes it directly via `CommandBuilder::new(shell)` with no allowlist or validation.
- **Evidence:** `apps/agent/src/main.rs:489` —
  `let sh = create.shell.unwrap_or_else(|| shell_for_dispatch.clone());`;
  `apps/agent/src/pty.rs:317` — `let mut cmd = CommandBuilder::new(shell);`.
- **Impact:** Any client that can establish a WebRTC DataChannel (or an attacker who takes over a
  session) can make the agent spawn any executable the agent process can run on the host.
- **Verdict:** CONFIRMED (refute + re-derive). No allowlist, path filter, or `/etc/shells` check exists.

### H2 — Session `approved` flag recorded but never enforced

- **ID:** `agent-trust:CLAIM-02-SESSION-APPROVAL-UNENFORCED` (absent-gap)
- **Statement:** The agent's `approved` refusal flag is not checked or enforced by either the signaling
  server or the browser client.
- **Evidence (as of `64e4066`):** `docs/guides/handshake-connection-flow.md:155` — "nothing enforces
  approved === false server-side today — a refusal is visible only in the flag.";
  `packages/webrtc-core/src/connection.ts:207-208` consumes the SDP answer without checking `approved`;
  `packages/webrtc-core/src/transport.ts:277` records `approved` but never gates `setRemoteDescription`.
- **Impact:** When the agent refuses (busy, no terminal capability), the browser still consumes the
  answer and hangs until ICE/connect timeout instead of surfacing a clear refusal; a hostile signaling
  server can deliver an answer the browser honors despite an agent refusal.
- **Verdict:** CONFIRMED (refute + re-derive).
- **Status:** **CLOSED** by WS3 (PR #45, `9eab552`). The `approved` flag is now enforced on both sides:
  the server's `recordSignal` only advances a session `pending → active` when `approved !== false`
  (`apps/server/src/utils/signals.ts:55`), and the browser refuses a refusal answer before
  `setRemoteDescription` (`packages/webrtc-core/src/connection.ts:350`). The quotes above are the
  snapshot at `64e4066`; the guide line they cite was rewritten in PR #94 (`430b749`) and now reads
  (line 157): "Since Week 14 (WS3) the server enforces it… enforcement gates the transition, not the
  message."

### H3 — Agent has no peer identity verification (trusts the signaling server blindly)

- **ID:** `agent-trust:CLAIM-03-ZERO-TRUST-PEER-VERIFICATION-MISSING` (absent-gap)
- **Statement:** The agent does not authenticate the client's identity or verify its public key /
  DTLS fingerprint; `publicKey` is collected but never used.
- **Evidence:** `apps/agent/src/rtc.rs:186` — approval is granted purely on the `terminal` capability
  label; `apps/server/src/db/schema.ts:10,51` — `publicKey: text('public_key').notNull()` stored but
  never used cryptographically.
- **Impact:** Violates "Never Trust, Always Verify": a compromised signaling server can open PTY
  sessions and execute code on every connected agent.
- **Verdict:** CONFIRMED (refute + re-derive). Server-side JWT/credential auth is classic client-server
  trust; it is not peer-to-peer verification at the agent.

### H4 — User ECDH private key is dead storage (and deleted on logout)

- **ID:** `crypto-e2ee:claim-user-private-key-dead-storage` (absent-gap)
- **Statement:** The user ECDH private key is saved to IndexedDB at registration, never loaded or used
  by any feature, and permanently deleted on logout.
- **Evidence:** `packages/crypto/src/index.ts:162` defines `loadPrivateKey`;
  `apps/web/src/stores/auth.ts:86` calls `savePrivateKey` at registration;
  `:101` calls `deletePrivateKey` on logout. `loadPrivateKey` is never invoked in production code —
  only in a test fixture (`packages/crypto/test/crypto.test.ts:71`).
- **Impact:** The keypair serves no operational security purpose today; deleting it on logout leaves
  subsequent logins without a private key.
- **Verdict:** CONFIRMED (refute + re-derive).

### H5 — "Client-side public-key verification" claimed, zero implementation

- **ID:** `crypto-e2ee:claim-client-public-key-verification-absent` (claimed-in-docs-but-absent)
- **Statement:** README claims client-side public-key verification, but no public-key verification,
  fingerprint checking, signature validation, or TOFU mechanism exists in the repository.
- **Evidence:** `README.md:18`; repository-wide grep returns zero implementation in `apps/web`,
  `apps/agent`, and `packages`.
- **Impact:** Clients never verify a remote host/agent key before exchanging data.
- **Verdict:** CONFIRMED (refute + re-derive). Verifier note: `apps/server/src/utils/jwt.ts` `verify()`
  is symmetric HMAC validation of JWTs with a shared server secret — not client-side public-key
  verification. `importPublicKeySpki()` in `packages/crypto` only imports a key for ECDH `deriveBits`.

### H6 — Agent registration uses browser-generated dummy keys; daemon has no keypair

- **ID:** `crypto-e2ee:claim-agent-keypair-mock-bypass` (absent-gap)
- **Statement:** Agent registration uses browser-generated keys with discarded private keys plus a
  hardcoded fallback, while the Rust daemon authenticates solely via bearer token.
- **Evidence:** `apps/web/src/components/agent/RegisterAgentDialog.vue:82-86` — hardcoded
  `ssh-ed25519 ... ExamplePublicKey` fallback, replaced by `generateUserKeyPair()` whose private half is
  discarded; `apps/agent/src/signal.rs:235` —
  `HeaderValue::from_str(&format!("Bearer {credential}"))`.
- **Impact:** The agent's public key in the database is generated in the browser and immediately
  discarded; the daemon never possesses a private key, so host cryptographic verification is impossible
  under this flow.
- **Verdict:** CONFIRMED (refute + re-derive).

### H7 — Application-layer E2EE absent (data-path lens; UI advertises it)

- **ID:** `data-path:app-layer-e2ee-absent` (claimed-in-docs-but-absent)
- **Statement:** The `EncryptionManager` layer described in the architecture document is not implemented;
  the UI and README nonetheless advertise E2EE.
- **Evidence:** `docs/ARCHITECTURE.md:760-761`;
  `docs/superpowers/specs/2026-09-26-phase2-week5-terminal-agent-design.md:96` — "Owner: Phase 5,
  Weeks 12-14". UI claims: `apps/web/src/views/DashboardView.vue:245` ("Zero-Trust E2EE"),
  `apps/web/src/components/layout/AppHeader.vue:119` ("E2EE Ready"), `README.md:12`.
- **Impact:** Users are told E2EE is active while only WebRTC DTLS transport encryption exists.
- **Verdict:** CONFIRMED (refute + re-derive). Overlaps C1/C2/C4.

### H8 — CSWSH Origin check bypassed by default (`CORS_ORIGIN=*`)

- **ID:** `docs-defaults:cswsh-origin-check-default` (implemented-partial)
- **Statement:** Browser WebSocket Origin verification is completely bypassed when `CORS_ORIGIN` is
  unset or `*` — which is the default in `docker/.env.example`.
- **Evidence:** `apps/server/src/utils/cors.ts:14` — `if (!corsOrigin || corsOrigin === '*') return '*';`;
  `apps/server/src/routes/ws.ts:564-569` — Origin check skipped when `allowed === '*'`;
  `docker/.env.example:41` — `CORS_ORIGIN=*`.
- **Impact:** Any malicious site can connect to `/api/ws/browser` if it captures an active ticket.
  Verifier note: exploitable surface is limited — a single-use 15-second ticket is required, and
  `docker-compose.prod.yml:40` overrides `CORS_ORIGIN=https://${DOMAIN}` — but the default loses the
  defense-in-depth layer.
- **Verdict:** CONFIRMED (refute + re-derive).

### H9 — No rate limiting / lockout on login

- **ID:** `server-auth:AUTH-RATE-LIMIT-ABSENT` (absent-gap)
- **Statement:** `/api/auth/login` lacks rate limiting, failed-attempt counters, and account lockout.
- **Evidence:** `apps/server/src/routes/auth.ts:141` (`auth.post('/login', ...)`) and `:172-179`
  (password verification with no attempt tracking). No protection at reverse proxy (`docker/Caddyfile`,
  `docker/nginx.conf.example`), middleware (`apps/server/src/app.ts`), route, or DB layers.
- **Impact:** Unlimited automated brute-force / credential-stuffing against user accounts.
- **Verdict:** CONFIRMED (refute + re-derive).

### H10 — Refresh token not rotated on use

- **ID:** `server-auth:JWT-REFRESH-NO-ROTATION` (absent-gap)
- **Statement:** The refresh endpoint echoes back the exact same refresh token; no rotation, single-use
  binding, or reuse detection exists.
- **Evidence:** `apps/server/src/routes/auth.ts:253-257` —
  `return c.json({ token, refreshToken: body.refreshToken, expiresIn: ... });`.
- **Impact:** A stolen refresh token is replayable for its full 7-day TTL without detection or
  invalidation.
- **Verdict:** CONFIRMED. (Also flagged independently by the completeness critic — §5.2.)

### H11 — E2EE payload encryption missing (authz lens)

- **ID:** `server-authz:e2ee-payload-encryption-missing` (claimed-in-docs-but-absent)
- **Statement:** E2EE payload encryption (`EncryptionManager`, ECDH P-256 + AES-GCM) is described in the
  architecture document and shown in the UI but not implemented (deferred to Phase 5).
- **Evidence:** `docs/ARCHITECTURE.md:757-763` vs.
  `docs/superpowers/specs/2026-09-25-phase2-week4-webrtc-core-design.md:10` and the actual
  `packages/crypto/src/` (only `index.ts`).
- **Impact:** DataChannel traffic (terminal, input, future file transfer) is protected only by WebRTC's
  default DTLS/SCTP layer; the client only generates/stores an ECDH P-256 keypair in IndexedDB.
- **Verdict:** CONFIRMED. Overlaps C1/C2/C4/H7.

---

## 4. Medium findings (12)

### M1 — Signaling (SDP + ICE) travels as plaintext JSON; no end-to-end signature

- **ID:** `agent-trust:CLAIM-04-SIGNALING-SDP-PLAINTEXT-MITM` (absent-gap)
- **Evidence:** `apps/server/src/routes/signal.ts:117` —
  `payload: JSON.stringify(message.data)`;
  `packages/webrtc-core/src/transport.ts:265-280` parses `sdp` with no signature check. The `signals`
  table has no signature/MAC column and `SignalMessage` has no signature field.
- **Impact:** A compromised server can swap SDP and MITM the session despite DTLS (see C3); transport
  auth (JWT / SHA-256-hashed agent credential) authenticates peers only *to the server*, not to each
  other.
- **Verdict:** CONFIRMED (refute + re-derive).

### M2 — Agent ignores WebSocket close codes → reconnect flap loop

- **ID:** `agent-trust:CLAIM-05-WS-CLOSE-CODE-IGNORED-FLAPPING` (absent-gap)
- **Evidence:** `apps/agent/src/signal.rs:354` — `Message::Close(_) => return Ok(())`;
  server sends `4409` (`apps/server/src/routes/ws.ts:699`, "Replaced by new connection") and `4401`
  (`:692`); `apps/agent/src/main.rs:227-254` reconnect loop resets delay to `BACKOFF_INITIAL` on every
  connect.
- **Impact:** Eviction or revocation causes infinite reconnect churn (every ~200ms–2s) instead of a
  terminal stop or long backoff.
- **Verdict:** CONFIRMED (refute + re-derive). Verifier note: the browser side
  (`packages/webrtc-core/src/transport.ts:528`) also ignores close codes but bounds retries
  (`maxRetries`, default 5); the Rust agent has no such cap.

### M3 — Agent does not validate `candidate.session_id` against the active offer

- **ID:** `agent-trust:CLAIM-06-AGENT-CANDIDATE-SESSION-VALIDATION-MISSING` (absent-gap)
- **Evidence:** `apps/agent/src/main.rs:777-778` routes candidates to `rtc::apply_candidate(peer, pending, candidate)`
  without comparing `candidate.session_id` to `offer.session_id`; `rtc.rs:297-319` applies without check.
- **Impact:** Stale or foreign-session ICE candidates can pollute the live connection's ICE state.
  Verifier note: candidates arriving while *no* session is active are dropped by the supervisor
  (`main.rs:350-361`); the gap is within a live session.
- **Verdict:** CONFIRMED (refute + re-derive).

### M4 — `packages/crypto` scope is keypair generation + storage only

- **ID:** `crypto-e2ee:claim-crypto-package-scope-limited` (implemented-partial)
- **Evidence:** `packages/crypto/src/index.ts` exports only `generateUserKeyPair` (114),
  `exportPublicKeySpki` (131), `importPublicKeySpki` (137), `savePrivateKey` (151), `loadPrivateKey`
  (162), `deletePrivateKey` (193). No encrypt/decrypt/cipher/HKDF/MAC functions exist.
- **Impact:** No primitives exist yet to establish an application-layer secure channel.
- **Verdict:** CONFIRMED (refute + re-derive).

### M5 — Device trust (`devices.is_trusted`) is unenforced

- **ID:** `crypto-e2ee:claim-zero-trust-device-trust-unenforced` (implemented-partial)
- **Evidence:** `apps/server/src/db/schema.ts:33` — `isTrusted ... default(false)`;
  `apps/server/src/routes/sessions.ts:70` checks only ownership, never `isTrusted`. No endpoint updates
  trust; `apps/web` never calls `POST /api/devices`.
- **Impact:** The device-authorization field is decorative; untrusted devices are interchangeable.
- **Verdict:** CONFIRMED (refute + re-derive).

### M6 — Zero-Trust identity is partial: keypair exists but is never used for peer authentication

- **ID:** `data-path:zero-trust-identity-partial` (implemented-partial)
- **Evidence:** `packages/crypto/src/index.ts:114-128` (generation/storage only);
  `apps/agent/src/rtc.rs:186` (capability-label check only). No mutual cryptographic peer
  authentication anywhere.
- **Impact:** Anyone able to tamper with signaling can request a PTY session on an agent.
- **Verdict:** CONFIRMED (refute + re-derive). Overlaps H3/M4.

### M7 — Browser terminal input: base64 + JSON only, no crypto

- **ID:** `data-path:browser-terminal-input-no-crypto` (implemented-partial)
- **Evidence:** `packages/terminal-core/src/client.ts:108-116` (base64 encode → `sendJson('terminal', 'terminal-data', payload)`);
  `packages/webrtc-core/src/data-channel.ts:87` (`channel.send(JSON.stringify(message))`).
- **Impact:** Base64 is serialization, not encryption; keystrokes (including `sudo` passwords) are
  plaintext at the application layer.
- **Verdict:** CONFIRMED (refute + re-derive).

### M8 — Agent PTY output: base64 only; no crypto crates in `Cargo.toml`

- **ID:** `data-path:agent-pty-output-no-crypto` (implemented-partial)
- **Evidence:** `apps/agent/src/pty.rs:103-113` (`frame_pty_output` → `STANDARD.encode(bytes)`);
  `apps/agent/src/main.rs:557-558` (decode); `apps/agent/Cargo.toml:7-20` — no crypto crates
  (no `aes-gcm`, `ring`, `sodiumoxide`, etc.).
- **Impact:** The agent cannot decrypt E2EE payloads or encrypt PTY output; data flows raw into the
  DataChannel.
- **Verdict:** CONFIRMED (refute + re-derive).

### M9 — JWT secret: no startup validation; middleware bypasses env helper

- **ID:** `server-auth:JWT-SECRET-NO-STARTUP-VALIDATION` (absent-gap)
- **Evidence:** `apps/server/src/middleware/auth.ts:31` — `process.env.JWT_SECRET!,` (direct access);
  `apps/server/src/utils/env.ts:13-17` — `getJwtSecret()` throws only *on use*. No startup check in
  `index.ts`, the Docker entrypoint, or compose files.
- **Impact:** The server boots with a missing/empty/trivially weak secret; runtime crash or undefined
  HMAC behavior on first authenticated request.
- **Verdict:** CONFIRMED (refute + re-derive).

### M10 — Token revocation not consulted on WebSocket upgrade / active connections

- **ID:** `server-auth:REVOCATION-WEBSOCKET-GAP` (implemented-partial)
- **Evidence:** `apps/server/src/routes/ws.ts:553` verifies the ws-ticket without a `revoked_tokens`
  check; active browser/agent sockets are never re-checked.
- **Impact:** Instant-revocation guarantee applies to REST only. Verifier note: the ticket *mint*
  (`ws.ts:441`, via `authMiddleware`) does check revocation, so the window is bounded by the 15-second
  ticket TTL at upgrade time — but a revocation after upgrade does not close existing sockets.
- **Verdict:** CONFIRMED (refute + re-derive).

### M11 — Revocation table writer coverage limited to explicit logout

- **ID:** `server-auth:REVOCATION-SQLITE-IMPLEMENTATION` (implemented-partial)
- **Evidence:** `apps/server/src/routes/auth.ts:271-276` writes `revoked_tokens` only on `/logout`;
  checked by `verifyTokenForUser` (`apps/server/src/utils/auth.ts:102-108`).
- **Impact:** No automatic invalidation on password change, account deactivation, or refresh-token
  reuse (rotation itself is absent — H10).
- **Verdict:** CONFIRMED (refute + re-derive).

### M12 — Browser WS Origin bypass (authz lens; same root cause as H8)

- **ID:** `server-authz:ws-browser-origin-bypass` (implemented-partial)
- **Evidence:** `apps/server/src/routes/ws.ts:564-570` + `apps/server/src/utils/cors.ts:13-15`
  (`'*'` when `CORS_ORIGIN` unset/`*`).
- **Impact:** Loss of the CSWSH defense-in-depth layer; partially mitigated by single-use 15-second
  tickets.
- **Verdict:** CONFIRMED (refute + re-derive).

---

## 5. Completeness-critic areas (additional; not part of the 28 verified claims)

These were surfaced by the final completeness critic as gaps the finder lenses did not claim formally.
They have quick-check evidence but did not go through the 56-verifier adversarial pass.

### 5.1 — No CSP or security headers on the Web SPA

- **Quick check:** `apps/web/vite.config.ts`, `apps/web/index.html`, `apps/web/wrangler.toml` — zero
  matches for `Content-Security-Policy` or any security response header. (`docker/nginx.conf.example`
  sets `X-Frame-Options`, `X-XSS-Protection`, `X-Content-Type-Options`, `Referrer-Policy`, but no CSP.)
- **Why it matters:** Tokens live in `localStorage` (5.4), so any successful injection immediately
  enables token theft.

### 5.2 — Refresh token not rotated on use

- Duplicate of H10, independently flagged by the critic (`apps/server/src/routes/auth.ts:271-272`
  echoes `body.refreshToken`).

### 5.3 — `approved` flag recorded but never gates SDP consumption

- Duplicate of H2, independently flagged by the critic
  (`packages/webrtc-core/src/transport.ts:277` stores `approved` with no conditional branch).

### 5.4 — Tokens persisted in `localStorage` (XSS-exfiltrable)

- **Quick check:** `apps/web/src/services/token-storage.ts:23,27` — `localStorage` get/set for keys
  `remote.accessToken` / `remote.refreshToken`. No HttpOnly/Secure/SameSite protection (the browser
  WebSocket auth model chose this because cookies cannot be set on `ws` upgrade in the browser).
- **Why it matters:** Pairs the CSP gap (5.1) with a direct bearer-token theft path.

### 5.5 — coturn: host networking, unpinned image, static shared secret

- **Quick check:** `docker/docker-compose.prod.yml:53` — `network_mode: host`;
  `:45-58` — image `coturn/coturn:latest` (unpinned) with `--static-auth-secret`.
- **Why it matters:** A coturn compromise reaches the host network; the agent does not sign/verify the
  TURN credentials it mints (`apps/server/src/utils/ice.ts:33-48` uses HMAC-SHA1 with a shared secret).

---

## 6. Verified-good: implemented controls (info level, 19 items)

These were found by the lenses and judged implemented; they were not sent through the adversarial
verifier pass. **Do not regress these while implementing Phase 5.**

- **WebRTC transport encryption present** — DTLS/SCTP DataChannels between browser and agent
  (`apps/agent/src/rtc.rs:22-60`, `packages/webrtc-core/src/p2p.ts:25-100`;
  `rtc.rs:120-124`, `connection.ts:117-121` per RFC 8826/8827).
- **PBKDF2 password hashing** — 100,000 iterations, 16-byte random salt, SHA-256, 32-byte key, verified
  with constant-time XOR comparison (`apps/server/src/utils/crypto.ts:1-2, 87-107`).
- **JWT hardening** — HS256 pinned, `exp` enforced, type/scope separation
  (`apps/server/src/utils/jwt.ts:85, 122-152`); access 900s, refresh 604800s, ws-ticket 15s
  (`jwt.ts:161, 180, 209`).
- **CSPRNG enforcement** — all secrets/salts/tokens use `crypto.getRandomValues` / `crypto.randomUUID`
  (`apps/server/src/utils/agent.ts:62-65`, `apps/server/src/utils/crypto.ts:19`).
- **Browser WS auth predicates** — `subscribe` / `signal` enforce `session.userId === connection.userId`
  (`apps/server/src/routes/ws.ts:385-388, 405-408`).
- **Agent WS upgrade auth** — Bearer credential matched by SHA-256 hash against SQLite before handshake;
  `signal` frames check both `session.userId` and `session.agentId` (`ws.ts:481-487, 851-859`).
- **Single-use WS tickets** — minted behind `authMiddleware` with `scope: 'ws-ticket'`, 15s TTL,
  consumed once (`ws.ts:441-450, 560-562`; `apps/server/src/utils/ws-ticket.ts:28-34`;
  `apps/server/src/middleware/auth.ts:51-53`; `apps/server/src/utils/auth.ts:49-58`).
- **REST signal polling scoped** — `GET /api/signal/poll/:sessionId` checks session ownership
  (`apps/server/src/routes/signal.ts:220-224`).
- **Tenancy scoping on every HTTP route** — all routers use `authMiddleware` + userId predicates
  (`routes/users.ts:9`, `devices.ts:9,90`, `agents.ts:15,118,140`, `sessions.ts:10,67,...`,
  `signal.ts:12,35,97,163,220`).
- **Token revocation enforced per REST request** — `revoked_tokens` + `isActive` checked before user
  lookup (`apps/server/src/utils/auth.ts:103-122`).
- **Agent credential lifecycle** — CSPRNG `ag_` + 32 hex chars (128-bit), stored as SHA-256, returned
  once at registration (`apps/server/src/utils/agent.ts:63, 97-114`, `routes/agents.ts:88`).
- **Agent session limits** — max 10 concurrent PTY sessions, 1-hour session cap
  (`apps/agent/src/main.rs:447, 710, 841-842`).
- **Server visibility boundary** — signaling server only relays SDP/ICE; never carries PTY bytes
  (`routes/signal.ts:15-184`, `routes/ws.ts:307-314`).
- **TURN visibility boundary** — TURN sees network metadata only; HMAC-SHA1 time-limited credentials
  (`apps/server/src/utils/ice.ts:33-48`).
- **Docker privilege drop** — entrypoint chowns data volume then `su-exec node` from root
  (`docker/entrypoint.sh:28-32`, `docker/Dockerfile.server:91-93`).

---

## 7. Found but not adversarially verified (1 medium item)

### Insecure default secrets in `docker/.env.example`

- **ID:** `docs-defaults:insecure-default-secrets` (implemented-partial, medium) — **not selected for the
  verification pass**, treat as lower-confidence.
- **Evidence:** `docker/.env.example:31` — `JWT_SECRET=local-dev-jwt-secret-key-32-chars-min`;
  `:34` — `REFRESH_TOKEN_SECRET=local-dev-refresh-secret-key-32-chars`;
  `apps/server/src/utils/env.ts:14-23` only checks *presence* on use.
- **Impact:** A deployment that copies the example file verbatim ships with publicly known signing
  secrets.

---

## 8. Phase 5 workstreams (suggested ordering)

### WS1 — Application-layer E2EE (the Phase 5 headline)

- [ ] Implement `packages/crypto/src/encrypt.ts` `EncryptionManager` (ECDH P-256 → HKDF → AES-GCM-256)
      per `ARCHITECTURE.md` §7.2. — closes C1, C2, C4, H7, H11, M4, M6
- [ ] Wire encryption into `packages/terminal-core` (browser input) and the Rust PTY path
      (add crypto crates to `apps/agent/Cargo.toml`). — closes M7, M8
- [ ] Fix private-key lifecycle: load the key on login; stop deleting it on logout (or re-derive).
      — closes H4
- [ ] Bind session keys to verified peer identity (depends on WS2). — closes M6

### WS2 — Peer identity & signaling integrity

- [ ] Out-of-band DTLS-fingerprint verification and/or SDP signing bound to the user keypair.
      — closes C3, M1
- [ ] Give the Rust agent a real keypair; replace bearer-only auth and the browser-dummy key flow.
      — closes H6, C5, H5
- [ ] Agent-side peer verification (verify the client's key/fingerprint before spawning a PTY).
      — closes H3

### WS3 — Agent session hardening

- [ ] `shell` allowlist / validation in the agent. — closes H1
- [ ] Enforce the `approved` flag in client + server. — closes H2, 5.3
- [ ] Handle WS close codes `4401`/`4409` (stop or long-backoff instead of flap). — closes M2
- [ ] Validate `candidate.session_id` against the active offer. — closes M3

### WS4 — Auth hardening

- [ ] Login rate limiting + lockout. — closes H9
- [ ] Refresh-token rotation with reuse detection. — closes H10, 5.2
- [ ] JWT secret startup validation. — closes M9
- [ ] Revocation checks on WS upgrade/active sockets. — closes M10, M11
- [ ] Tighten the `CORS_ORIGIN` default (explicit allowlist, no `*`). — closes H8, M12, and the
      week3 ADR-06 deferral

### WS5 — Web/ops polish

- [ ] CSP + security headers on the Web SPA. — closes 5.1
- [ ] Address token storage in `localStorage` (CSP mitigation, or storage redesign). — closes 5.4
- [ ] coturn: pin the image, drop host networking, rotate the static secret. — closes 5.5
- [ ] Remove predictable defaults from `docker/.env.example`. — closes §7 item

---

## 9. References & provenance

- **Workflow:** `e2ee-zero-trust-audit`, run `wf_13b522c3-61f` — 6 finder lenses
  (`crypto-e2ee`, `server-auth`, `server-authz`, `agent-trust`, `data-path`, `docs-defaults`),
  48 claims, 28 selected for verification, 56 verifiers (refute + re-derive), 1 completeness critic.
  63 agents, ~4.3M subagent tokens, ~22 minutes.
- **Raw artifacts (local session, not committed):** workflow journal and full JSON result under the
  Claude Code session directory for this project.
- **Repo constraints relevant to Phase 5:** `apps/agent` (Rust) and
  `packages/webrtc-core/src/connection.ts` were treated as read-only during the audit; Phase 5
  implementation will need to modify both.
- **Related repo documents:** `docs/ARCHITECTURE.md` §7 (Security), §8 (roadmap);
  `docs/superpowers/specs/2026-09-25-phase1-week3-frontend-design.md` (ADR-02, ADR-06);
  `docs/superpowers/specs/2026-09-25-phase2-week4-webrtc-core-design.md` (§deferred);
  `docs/superpowers/specs/2026-09-26-phase2-week5-terminal-agent-design.md` (§deferred);
  `docs/guides/handshake-connection-flow.md`.
