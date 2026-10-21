# Node/TypeScript Agent Rewrite — Design Spec

- **Date:** 2026-10-21
- **Status:** Draft for owner review
- **Branch:** `feat/agent-node-ts-rewrite` (off `main` @ `1515c36`)
- **ADRs proposed:** ADR-93 (Node/TypeScript agent runtime), ADR-94 (in-process N-API native addon), ADR-95 (desktop-only distribution model)
- **Supersedes / Amends:** ADR-86 (amended — the sidecar process boundary is dropped, the supervisor survives as an in-process host), ADR-89 (amended — the Rust shared-API module `ponter_agent::api` and its `build-agent.yml` boundary gate are replaced by the TypeScript equivalent `api-access-gate`)
- **Related ADRs:** ADR-13, ADR-15, ADR-22, ADR-24, ADR-45, ADR-47, ADR-50, ADR-55, ADR-86, ADR-89
- **Related Files:** `apps/agent/**`, `packages/{shared,crypto,webrtc-core,api-client}/**`, `apps/desktop/src/main/{agent-supervisor,agent-control}.ts`, `apps/server/src/routes/ws.ts`, `.github/workflows/{build-agent,ci-node,build-desktop,ci-e2e}.yml`

---

## 1. Intent and the Why

The desktop agent (`apps/agent`) is currently a Rust binary: ~20,858 lines of Rust
across 20 source files plus a vendored `xcap` fork, gated by a 4-target
cross-compilation matrix, published to a GitHub Release, and installed on user
machines by hand via a CLI guide.

Three owner decisions (2026-10-21) invalidate that shape:

1. **Rewrite the agent in Node/TypeScript.** The repository already carries a
   TypeScript monorepo (`packages/shared`, `packages/crypto`,
   `packages/webrtc-core`, `packages/api-client`, `apps/server`, `apps/web`,
   `apps/desktop`). The agent was the single remaining Rust island, and it
   duplicated work those packages already do — the agent carries its own
   signalling types, its own URL rewriting, its own E2EE key schedule, and its
   own error envelope.
2. **Option A (TypeScript core) + Option C (N-API addon compiled into Node).**
   The TypeScript core is the agent's logic; the native addon supplies the two
   operations TypeScript cannot perform at acceptable latency — screen capture
   and H.264 encoding. **"Option C" means an in-process N-API native addon
   under architecture A. It does NOT mean a full C++ core.** The Rust
   implementation is not retained in any form (no fallback, no dual build).
3. **The agent CLI is no longer distributed.** Everything converges on the
   desktop app. There is no standalone binary, no GitHub Release for the agent,
   no `systemd` unit, no cross-compilation matrix, and no user-installed
   runtime.

The consequence is that the agent stops being a *product* and becomes a
*component of the desktop app*. That single fact removes the distribution
constraints that shaped the Rust design and opens the in-process question
(§5).

### 1.1 Goals

| # | Goal | How it is measured |
|---|---|---|
| G1 | The desktop app ships one self-contained runtime that can capture the screen, encode H.264, inject input, and run a PTY | One installer artifact per platform; no separate agent download |
| G2 | The agent's wire protocol is preserved **byte-for-byte** | Cross-implementation conformance tests over the shared vectors; browser↔agent E2E suites stay green |
| G3 | The TypeScript core reuses existing workspace packages instead of re-implementing them | `packages/shared`, `packages/crypto`, `packages/webrtc-core`, `packages/api-client` consumed, not forked |
| G4 | Every behaviour the Rust agent had is either ported or explicitly retired with a recorded rationale | Behaviour inventory (§4) — no silent drops |
| G5 | The rewrite is incremental and reviewable | Each phase lands as its own PR with its own review chain |

### 1.2 Non-goals

| # | Non-goal | Rationale |
|---|---|---|
| N1 | Keeping the Rust agent as a fallback or a feature flag | Owner decision: no Rust fallback. A dual implementation doubles the surface for a project still in development |
| N2 | Shipping the agent as a standalone CLI / npm package / system service | Owner decision: desktop app only |
| N3 | Porting the Rust `xcap` fork's internals | Capture is platform-native work; the addon owns it (§4.2), the TS core does not |
| N4 | Changing the browser/web client protocol | The browser is the other peer; changing its protocol would break every deployed client for no gain. G2 forbids it |
| N5 | Re-implementing the WebRTC stack | `werift` 0.24.4 is already a workspace dependency of `@ponter/webrtc-core` |
| N6 | Audio streaming | The Rust agent has no audio track; out of scope for parity |

### 1.3 Anti-goals — what would make this a failure

- **A rewrite that changes observable behaviour.** If the browser client needs a
  change to work with the new agent, the port has failed even if the code is
  prettier. The wire protocol is a compatibility contract, not an internal
  detail.
- **A rewrite that cannot be debugged in the field.** The Rust agent's stderr
  tail (`AgentSupervisor.captureStderr`, 20-line ring buffer) is surfaced in
  the desktop UI to explain a failed start. The TypeScript agent must keep an
  equivalent diagnostic channel, or a corrupt-identity crash becomes an
  unexplained failure.
- **A rewrite that trades a working pipeline for a prettier one.** The capture →
  downscale → encode → RTP path has three production-hardened behaviours
  (SIMD downscale, static-frame skip, sustain ladder) that exist because the
  naive version dropped frames. They are ported, not redesigned.
- **A rewrite that only works on one platform.** Linux (Wayland portal) and
  Windows (WGC → DXGI → GDI) are both supported today. One platform working is
  a failed port.

---

## 2. Constraints

### 2.1 Hard constraints (verified against the repository at `1515c36`)

| ID | Constraint | Evidence |
|---|---|---|
| C1 | The agent must speak the existing signalling envelope: outer `{"type","data"}` transport frame wrapping an inner serde-tagged signal message | `apps/agent/src/signal.rs:22-29`, `:233-237` |
| C2 | The agent must answer WebRTC offers with H.264 at the PT negotiated by SDP, `packetization-mode=1`. The `profile-level-id` is **the browser's** (the agent cannot choose it — §3.3), and it must be **compatible** with what the encoder emits, not equal to it. The Rust agent's `profile-level-id=42001f` is **wrong on both bytes** and must not be copied (§3.3). | `apps/agent/src/rtc.rs:202-209`; `docs/spikes/2026-10-11-hardware-encode-h265.md:167` (real SPS `42 c0 1f`) |
| C3 | The agent's video payload is **Annex-B** H.264 NAL units; the RTP packetization (single-NAL / STAP-A / FU-A) happens above it | `apps/agent/src/desktop.rs:1852-1871`; `webrtc-0.21.0/src/media_stream/track_local/static_sample.rs:164` |
| C4 | The PT must be the **H.264** one, never `codecs.first()` — Chrome offers VP8 (PT 96) before H.264 (PT 102) and the wrong PT renders a black frame | `apps/agent/src/rtc.rs:277-303` (the bug is documented in-place) |
| C5 | The WS2 identity proof is signed over the exact bytes of `canonicalProofMessage` | `apps/agent/src/identity.rs:78-90` ≡ `packages/shared/src/types/identity-proof.ts:22-29` |
| C6 | The WS1 E2EE frame is `[12-byte IV][ct ‖ 16-byte tag]`, ECDH P-256 → HKDF-SHA256 → AES-256-GCM, empty AAD, `info = "ponter-ws1-terminal-v1"`, `salt = session_id` | `apps/agent/src/e2ee.rs:14-17,42-44,149-173,220`; `packages/crypto/src/encrypt.ts:104-121` |
| C7 | The agent identity is an Ed25519 **PKCS#8** file, mode `0o600`, public key base64 | `apps/agent/src/identity.rs:21-76` |
| C8 | `AGENT_ALLOW_INPUT` is an **agent-local** opt-in; a remote peer cannot enable input injection | `apps/agent/src/main.rs:83-93`; `apps/agent/src/lib.rs` session setup |
| C9 | The shell allowlist is `/bin/sh` floor ∪ `/etc/shells`, canonicalized, absolute-path-only | `apps/agent/src/shell_policy.rs:19-20,47-99` |
| C10 | The files binary frame is `[1B type][16B transfer_id][8B BE chunk_index][payload]`, 32 KiB chunks | `apps/agent/src/files.rs:75-104` |
| C11 | Files path containment is proven by `canonicalize` + component-wise prefix check, not by string prefix | `apps/agent/src/files.rs:760-800` |
| C12 | The terminal output is standard base64 of raw PTY bytes, 16 KiB chunks | `apps/agent/src/pty.rs:22,392,397` — the constant, the read-buffer allocation, and the hand-off of `buf[..n]`. The bound is the read buffer's; `:141-143` is the framer and is length-agnostic |
| C13 | The reconnect ladder is 200 ms × 1.5 capped at 2000 ms; close codes 4401/4409 are terminal | `apps/agent/src/signal.rs:104-121,297-301` |

### 2.2 Constraints discovered during the feasibility survey

| ID | Constraint | Evidence | Impact |
|---|---|---|---|
| D1 | **werift 0.24.4 has no RTP payloader of any kind.** `grep -rn 'class.*Payloader' lib/` → 0 matches. It ships `H264RtpPayload` (a *de*payloader) only. | `node_modules/.pnpm/werift@0.24.4_…/lib/rtp/src/codec/h264.js` | The RFC 6184 packetization (Annex-B → NAL(A)/FU-A) must be written by us, or moved into the native addon. **This is the single largest piece of new code in the port.** |
| D2 | werift's send path is `MediaStreamTrack.writeRtp(rtp: RtpPacket \| Buffer)` and `RTPSender.sendRtp(...)`; `sendRtp` rewrites `ssrc`, `payloadType`, `timestamp`, `sequenceNumber` before `dtlsTransport.sendRtp`. | `werift/lib/webrtc/src/media/track.d.ts:28`, `rtpSender.d.ts:100`, `rtpSender.js:538-549` | We can hand werift a raw `Buffer` of a complete RTP packet, or an `RtpPacket` with a header we fill. Both work. |
| D3 | werift offers `pc.addTrack(track)` and `pc.getSenders()`. | `werift/lib/webrtc/src/peerConnection.d.ts:194,110` | The TS agent can be the WebRTC **sender** through werift directly. |
| D4 | **The existing E2E suite proves werift-as-RECEIVER only.** `desktop.e2e.test.ts:114-137` has werift as the recvonly offerer and the Rust agent as the sender. | `packages/webrtc-core/test/e2e/desktop.e2e.test.ts:114-137` | The rewrite inverts the role: werift becomes the **sender**. **No test in the repository currently proves werift can send H.264 to a browser.** This is the highest-risk unknown in the port. |
| **D4a** | **werift's default peer config has NO H.264.** `generateDefaultPeerConfig()` sets `video: [useVP8()]`. H.264 exists only as an opt-in codec helper (`useH264()` → `video/h264`, clock 90000, `packetization-mode=1`, `profile-level-id=42e01f`) and must be passed explicitly as `codecs: { video: [useH264()] }`. | `werift/lib/webrtc/src/peerConnection.js:1082`; `werift/lib/webrtc/src/media/codec.js:6-12` | The new agent **must** construct its `RTCPeerConnection` with an explicit H.264 codec list. Without it, the answerer negotiates no H.264 at all and the desktop offer is refused. The existing e2e harness already does this (`desktop.e2e.test.ts:115` passes `codecs: { video: [useH264()] }`) — the port must carry that forward. (Note that werift's `42e01f` already differs from the Rust agent's `42001f`; §3.5.4 explains what that difference costs and how R-S3 restores the guarantee.) |
| **D4b** | **werift picks the sender payload type as `codecs[0]`, and `codecs` is the OFFER's ordering — but only among the codecs the local list also offers.** `RTPSender.prepareSend` does `this.codec = params.codecs[0]`; `RTPSender.sendRtp` then **overwrites** `header.payloadType = this.codec.payloadType`; `MediaStreamTrack.writeRtp` does the same with `this.codec?.payloadType`. `transceiver.codecs` is assigned from the *remote* (offer) codec list, filtered against the local list — so it keeps the browser's ordering. | `werift/lib/webrtc/src/media/rtpSender.js:408`, `:545`; `werift/lib/webrtc/src/media/track.js:132-134`; `werift/lib/webrtc/src/transceiverManager.js:244` | **This is C4's bug reproduced inside werift — but only conditionally.** Measured against a real Chrome SDP offer (VP8 pt96, H.264 pt102, rtx pt103): with the local list `[useH264()]` the negotiated list is `H264/pt102` alone and `sender.codec` is **H.264 pt102** — correct. With the local list `[useVP8(), useH264()]` the negotiated list keeps the browser's order and `sender.codec` is **VP8 pt96** — the black-video bug. **R-S1's H.264-only local list is what closes D4b**; the port must not "helpfully" add VP8 to the agent's codec list. The residual risk after R-S1 is not the payload type but the codec *parameters* (D4d). |
| **D4c** | **`RTPSender.sendRtp` silently no-ops when the codec is unset** (`if (this.dtlsTransport.state !== "connected" \|\| !this.codec) { return; }`). | `werift/lib/webrtc/src/media/rtpSender.js:539` | A misconfigured sender drops every frame with **no error** — the connection stays healthy and the browser shows black. The port needs an explicit assertion that the negotiated sender codec is H.264, and a loud failure otherwise, not a silent drop. |
| **D4d** | **werift matches codecs by mime type ONLY — it never inspects `parameters`.** `findCodecByMimeType` compares `mimeType.toLowerCase()` and ignores `fmtp` entirely. The negotiated codec's `parameters` are the **browser's**, echoed verbatim into the answer; werift's local `useH264()` `parameters` string is never consulted. **The Rust agent's stack did the opposite**: `webrtc-rs` matches H.264 by `packetization-mode` **and** `profile-level-id` (RFC 6184 §8.2.2), so the port is *losing* a guarantee the Rust agent had. | `werift/lib/webrtc/src/peerConnection.js:1074` (`findCodecByMimeType`); `werift/lib/webrtc/src/transceiverManager.js:244-259`; `werift/lib/webrtc/src/media/codec.js:6-12`; `werift/lib/webrtc/src/sdpManager.js:90-97` (the answer's codec list *is* the negotiated list); `rtc-0.21.0/src/rtp_transceiver/fmtp/h264/mod.rs:52-81` (`match_fmtp`) | **This is the residual, real failure mode after D4b is closed.** A Chrome offer carries two H.264 entries — pt102 `packetization-mode=1` and pt104 `packetization-mode=0` — and a browser whose *first* H.264 entry is mode 0 makes werift negotiate `packetization-mode=0`. The TS packetizer implements RFC 6184 **mode 1** (single-NAL / STAP-A / FU-A); a mode-0 PT carrying mode-1 packets is decoded by the browser's mode-0 depacketizer as one NAL per packet → broken frames. Symmetrically, the negotiated `profile-level-id` is the browser's, so the answer may promise a profile the encoder does not produce. **The agent must assert the negotiated `packetization-mode=1` and the profile it can encode, and fail loudly otherwise.** The agent cannot *edit* the negotiated `fmtp` through a supported API — but it does not have to: **choosing the payload type the browser offered with `packetization-mode=1` is the whole fix** (§3.5.3, R-S3), and it leaves the `fmtp` byte-identical to the offer, which is what RFC 3264 asks for. **R-S3 restores what webrtc-rs gave the Rust agent for free** — see §3.5.4. |
| **D4e** | **The transceiver must exist BEFORE `setRemoteDescription`.** Adding it afterwards produces a *second* transceiver, an `a=inactive` m-line, and `sender.codec === undefined` — which D4c then turns into a silent no-op. | `werift/lib/webrtc/src/peerConnection.js:819-878` (`setRemoteDescription` → `setRemoteRTP` per m-line); measured | The Rust agent already carries this as ADR-15 (`rtc.rs:190-194`, behaviour B12). The port preserves it — but the **werift-specific symptom is new**: an inactive m-line plus an undefined codec, which is indistinguishable from a healthy-but-idle stream unless the agent asserts the negotiated codec. |
| D5 | No pure-TypeScript H.264 encoder exists on npm. `openh264` and `node-openh264` are 404; `ffmpeg-static` is GPL-3.0; `@ffmpeg-installer/ffmpeg` is LGPL-2.1. | npm registry probes | The encoder must be a native addon. `openh264` 0.9.8 is Cisco **BSD-2-Clause** (91 `.cpp` files, vendored in the cargo registry) — permissive, and already vendored in this repo's dependency tree today. |
| D6 | `node-pty` 1.1.0 is MIT and N-API-based (`node-addon-api ^7.1.0`), but has **no musl prebuilt** and installs `node scripts/prebuild.js \|\| node-gyp rebuild`. | npm registry | Moot under the desktop-only model (§6.2): the addon is compiled against Electron's Node, not a musl target. |
| D7 | Electron 35.7.5 embeds **Node 22**, while the repo targets **Node 24** (`@types/node: 24.19.0`). N-API module ABI is tied to the Node major. | `node_modules/.pnpm/electron@35.7.5_…/package.json`; `apps/desktop/package.json:39` | A native addon must be built against **Electron's** headers (`electron-rebuild` / `node-gyp --target=<electron version>`), not stock Node headers. This is a build-matrix fact, not a design obstacle. |
| D8 | `packages/crypto` persists keys in **IndexedDB**, which does not exist in Node. | `packages/crypto/src/index.ts:216-277` | The agent needs a *file-backed* key store, not the browser's. `@ponter/crypto`'s `EncryptionManager` (pure Web Crypto, no IndexedDB) is reusable as-is; its `savePrivateKey`/`loadPrivateKey` are not. §4.5 splits the package. |
| D9 | The repo currently contains **zero** hand-written C/C++ files and **zero** N-API scaffolding. | repo-wide search | The addon is greenfield: `binding.gyp`, `node-addon-api`, `allowBuilds` entry, CI build step. |
| D10 | `apps/desktop` already depends on `@ponter/webrtc-core` at runtime and inlines it into the main bundle (`WORKSPACE_PACKAGES` in `electron.vite.config.ts`). | `apps/desktop/package.json:26`; `apps/desktop/electron.vite.config.ts:15-33` | The TS core is bundleable into the desktop main process without new packaging plumbing. |
| D11 | `werift` is a **devDependency** of `@ponter/webrtc-core` today, not a runtime dependency. | `packages/webrtc-core/package.json:29` | If the agent ships inside Electron, `werift` must be promoted to a runtime dependency of whatever package the desktop bundles it from. |
| D12 | `apps/desktop/src/main/__tests__/desktop-profile-parity.test.ts` reads `../agent/src/lib.rs` **as text** and regex-extracts the `StreamProfile` literals to compare against `DESKTOP_PROFILES`. | `apps/desktop/src/main/__tests__/desktop-profile-parity.test.ts` | A cross-language test. It **breaks** on the rewrite and must be replaced by a same-language import — the parity guarantee survives, the mechanism changes. |
| D13 | The `build-agent.yml` API-access guard greps Rust source for `details`, `reqwest::`/`hyper::Client`/`ureq::`, and literal `http(s)://`/`ws(s)://` URLs outside `src/main.rs`/`src/api.rs`. | `.github/workflows/build-agent.yml:88-118` | The guard's *intent* (one shared API module, no ad-hoc HTTP clients, no literal URLs) must survive, re-expressed for TypeScript. |

### 2.3 Constraints the desktop-only decision dissolves

| ID | Dissolved constraint | Why it no longer binds |
|---|---|---|
| X1 | Cross-compilation matrix (linux-gnu, linux-musl, aarch64-gnu, windows-msvc) | No standalone binary is published |
| X2 | GitHub Release with per-platform tarballs/zip + SHA256SUMS | No agent release |
| X3 | Static musl build; `node-pty` has no musl prebuilt | The addon is built per-platform against Electron |
| X4 | Users needing a Node runtime installed | Electron bundles Node |
| X5 | `docs/guides/agent-setup.md` — the CLI install guide + systemd unit | No CLI to install |
| X6 | `apps/web/src/components/agent/RegisterAgentDialog.vue:72` — the CLI invocation string `./ponter-agent --agent-id … --server … --credential …` | No CLI to register; the desktop app registers itself |
| X7 | `packages/webrtc-core/test/e2e/harness.ts:56-63` `AGENT_BIN` pointing at `apps/agent/target/debug/ponter-agent` | The harness spawns the new agent entry point instead |

---

## 3. Architecture

### 3.1 Shape

```
┌──────────────────────── Electron desktop app (apps/desktop) ────────────────────────┐
│                                                                                    │
│  main process                                                                       │
│  ┌──────────────────┐   ┌──────────────────────────────────────────────────────┐     │
│  │ AgentSupervisor  │   │  @ponter/agent-node (TypeScript core)                │     │
│  │ (existing)       │──▶│  signalling · rtc · e2ee · identity · pty · files   │     │
│  │ spawn / backoff  │   │  · input decode · desktop session orchestration      │     │
│  │ SIGTERM→SIGKILL  │   │  · RFC 6184 packetization (in TS — §3.3)            │     │
│  └──────────────────┘   └───────────────┬──────────────────────────────────────┘     │
│                                          │ napi                                          │
│                                          ▼                                              │
│                            ┌──────────────────────────────────────┐                   │
│                            │  @ponter/agent-native (N-API addon)  │                   │
│                            │  · screen capture (Win / Linux)      │                   │
│                            │  · H.264 encode (openh264)          │                   │
│                            │    → Annex-B bytes out               │                   │
│                            │  · input injection (SendInput /      │                   │
│                            │    xdg-desktop-portal)               │                   │
│                            └──────────────────────────────────────┘                   │
│                                                                                    │
│  renderer (Vue 3) ── unchanged, speaks the same wire protocol                      │
└────────────────────────────────────────────────────────────────────────────────────┘
```

### 3.2 The three-layer split

| Layer | Language | Responsibility | Why this split |
|---|---|---|---|
| **Core** | TypeScript | Signalling, WebRTC session orchestration, E2EE, identity, PTY lifecycle, file transfer, input decoding, profile/ladder policy, **RFC 6184 packetization** | All of this is protocol logic the repo already implements in TypeScript elsewhere. Porting it to Rust duplicated `packages/shared` and `packages/crypto`. The packetizer is pure byte-array logic (§3.3). |
| **Native** | C/C++ behind N-API | Screen capture, H.264 encode, OS input injection | These need OS APIs and a SIMD/native codec. No pure-TS library provides them at acceptable latency. The boundary is *frames in, Annex-B H.264 out* — the addon does not packetize. |
| **Host** | Electron | Process supervision, IPC, packaging | Already exists (ADR-85/86). |

### 3.3 Where the RFC 6184 packetization lives

D1 establishes that werift has no payloader. There are two places the RFC 6184
packetization could live:

- **In TypeScript** (pure, in the core): a `h264-rtp-packetizer` module that
  takes Annex-B bytes and emits complete RTP packets. ~400 lines. Testable with
  vectors. The native layer returns Annex-B, the core packetizes, the core
  hands `RtpPacket`s to werift.
- **In the native addon**: the encoder returns Annex-B, the addon packetizes and
  returns complete RTP packets, the core hands them straight to werift.

**Decision: the packetizer lives in TypeScript.** Rationale:

1. It is pure logic over byte arrays — no OS API, no FFI benefit.
2. RFC 6184 packetization is exactly the kind of thing that needs
   table-driven unit tests with hand-computed expected packets. Tests in
   TypeScript are cheap; tests through a native addon are not.
3. Keeping it in the core means the encode path can be swapped (a future
   hardware encoder) without touching the packetizer.
4. The addon boundary stays narrow: *frames in, encoded NALs out*.

The addon therefore exposes **Annex-B H.264 output**, matching the Rust
agent's `DesktopEncoder::encode` return shape exactly (C3) — so the TS core's
packetizer and the Rust-era `TrackLocalStaticSample` see identical input.

**The packetizer emits `packetization-mode=1` framing** — single-NAL, STAP-A
and FU-A — matching the Rust agent's intent
(`level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f`,
`apps/agent/src/rtc.rs:208`; the `profile-level-id` half of that string is
wrong — see below — but the `packetization-mode=1` half is the contract the
Rust agent meant to express). This is not a free choice: the negotiated
`packetization-mode` is whatever the **browser** offered (D4d), and werift
never checks it. Mode 0 is not "mode 1 without the aggregation" — it is a
different framing contract, and a mode-1 packet stream sent under a mode-0
payload type is depacketized as one NAL per packet. R-S3 turns this from an
implicit assumption into an asserted precondition.

**A note on the encoder's profile.** The `profile-level-id` in the answer is
the **browser's** (D4d) — werift never inspects `fmtp` — so the browser's
expectation is that the encoder produces that profile. What openh264
actually produces was read out of the vendored source, and it is **not** the
string the Rust agent advertised:

- **Profile**: the Rust agent never sets a profile, so `uiProfileIdc` stays
  `PRO_UNKNOWN` and openh264 resolves it from the entropy-coding mode
  (`codec/encoder/core/src/encoder_ext.cpp:660-666`): `FillDefault` sets
  `iEntropyCodingModeFlag = 0`, so the resolution lands on `PRO_BASELINE`
  (66). The SPS is then written with `profile_idc = 66`,
  `constraint_set0_flag = 1` (because the profile *is* baseline) and
  `constraint_set1_flag = 1` (because 66 ≤ 77 = `PRO_MAIN`)
  (`codec/encoder/core/src/au_set.cpp:515-520`).

- **The constraint byte is `0xC0`, not `0x00` and not `0xE0`.** The four
  constraint flags are written as four consecutive bits followed by four
  reserved zero bits (`codec/encoder/core/src/au_set.cpp:269-275`), so
  `constraint_set0=1, constraint_set1=1, constraint_set2=0, constraint_set3=0`
  gives `1100 0000` = **`0xC0`**. The real bitstream confirms it: the
  vendor's own hexdump of the agent's Annex-B output starts
  `00 00 00 01 67 42 c0 1f …` — SPS NAL type `0x67`, then
  `42` (profile 66), **`c0`** (constraint byte), `1f` (level 31 = 3.1)
  (`docs/spikes/2026-10-11-hardware-encode-h265.md:167`).

- **The level is computed, not pinned.** openh264 derives the level from
  the frame size, the frame rate and the target bitrate
  (`WelsGetLevelIdc`, `codec/encoder/core/src/au_set.cpp:187-193`, against
  the `g_ksLevelLimits` table at `codec/common/src/common_tables.cpp:345+` —
  all **17** levels, 1.0 through 5.2) and writes it into the SPS
  (`codec/encoder/core/src/au_set.cpp:526-537`). Recomputing that table for
  the four shipped `StreamProfile` presets
  (`apps/agent/src/lib.rs:445-490`) gives:

  | Preset | Computed level | SPS `profile-level-id` |
  |---|---|---|
  | 1080p30 @ 6 Mbps | 4.0 | `42c028` |
  | 720p30 @ 4 Mbps | 3.1 | `42c01f` |
  | 1080p60 @ 8 Mbps | 4.2 | `42c02a` |
  | 720p60 @ 5 Mbps | 3.2 | `42c020` |

  The result is **insensitive to the reference-frame count**: the DPB check
  (`codec/encoder/core/src/au_set.cpp:66`,
  `uiMaxDPBMbs < uiNumRefFrames * uiPicInMBs`) never binds
  for these presets at any `iNumRefFrames` from 1 to 4, so the levels above
  hold regardless of how the encoder is configured for reference frames.
  The 720p30 value `42c01f` is independently corroborated by the vendor's
  own hexdump of the agent's Annex-B output
  (`docs/spikes/2026-10-11-hardware-encode-h265.md:167`), which reads
  `00 00 00 01 67 42 c0 1f …` — SPS NAL type `0x67`, profile `0x42`,
  constraint `0xc0`, level `0x1f`.

  So the Rust agent's hard-coded `profile-level-id=42001f`
  (`apps/agent/src/rtc.rs:208`) is wrong in **two** ways: its constraint byte
  is `0x00` where the encoder writes `0xC0`, and its level byte claims 3.1
  where the encoder writes 4.0 / 3.2 / 4.2 for three of the four presets.
  It went unnoticed because the mismatch never broke a test — and that is
  worth stating precisely: **the existing E2E suite does not decode pixels.**
  `desktop.e2e.test.ts:260-308` asserts that a real H.264 track arrives, that
  every packet carries the negotiated PT, and that at least one packet
  contains an IDR NAL. It never hands the stream to a decoder. So the
  mismatch's real-world tolerance is **unproven by the repository** — the
  only evidence that Chrome accepts it is that the product shipped.

  The port must **not** copy that string, and must **not** pin a constant
  either. The addon has to expose the `profile_idc` and `level_idc` the
  encoder actually chose, and the TS core has to assert that the encoder's
  output is decodable under the negotiated `profile-level-id`.

**What the port can and cannot control here.** The `fmtp` in the answer is
the browser's, and werift offers no API to replace it — the answer's codec
list is built straight from the negotiated list
(`sdpManager.js:90-97`), whose `parameters` came from the offer
(`transceiverManager.js:244-259`). The only lever the agent has is **which
payload type the sender uses**, not what that payload type's `fmtp` says.
§3.5.3's mitigation therefore keeps the browser's `fmtp` verbatim and picks
the entry the browser offered with `packetization-mode=1`, which is also
the RFC 3264-correct answer: the answer's `fmtp` for a payload type is
echoed from the offer unchanged.

**Why this matters beyond correctness.** This is the concrete instance of
D4d: the negotiation is not under the agent's control, but the *encoder* is,
and the two have to agree. A spec that pins a constant `profile-level-id`
reproduces the Rust agent's bug in a new place. P0's A3 assertion (the
browser decodes) is what catches it — a `profile-level-id`/level mismatch
produces a connection that negotiates fine and displays nothing.

### 3.4 Reuse map

| Existing package | What the agent takes | Change required |
|---|---|---|
| `@ponter/shared` | `SignalMessage`, `IceServerConfig`, `DataChannelMessage`, `TerminalDataMessage`, `FilesErrorCode`, `canonicalProofMessage`, `normalizeFingerprint`, `parseSdpFingerprint`, `AgentErrorCode`, `BrowserErrorCode` | None — the Rust agent's types are hand-copies of these. The port deletes the copies. |
| `@ponter/crypto` | `EncryptionManager`, `deriveSharedSecret`, `hkdfSha256`, `importAesGcmKey`, `aesGcmEncrypt/Decrypt` | None for the E2EE session key. The IndexedDB-backed `savePrivateKey`/`loadPrivateKey` are **not** used; the agent keeps its own Ed25519 PKCS#8 file (C7). |
| `@ponter/webrtc-core` | `PeerConnection`, `RTCPeerConnectionLike`, `DataChannelManager`, `toWsUrl`, `stripTrailingSlashes`, `ReconnectBackoff` | `WeriftAdapter` must **gain** sender support. Today it has **no `addTrack` at all** — only `addTransceiver` and `onTrack`, both receive-only (`packages/webrtc-core/src/adapters/werift.ts:201`, `:208`; `packages/webrtc-core/src/types.ts:20-52`). The port adds `addTrack` to **both** `RTCPeerConnectionLike` and `WeriftAdapter`, plus a way to reach werift's `MediaStreamTrack.writeRtp` (D3, D4). |
| `@ponter/api-client` | `createApiClient` | The agent has no HTTP surface today — `api.rs`'s `ApiError`/`from_response`/`network`/`is_auth_fatal` are dead code with no caller outside that file (see R3, §4.7). Not used at first; available if a future agent API is needed. |
| `@ponter/shared` (crypto side) | `e2ee-vectors.json` (`packages/crypto/test/vectors/`) | The agent's E2EE tests consume these vectors — the Rust agent already does (`apps/agent/src/e2ee.rs:246-254`). The port keeps that. |

### 3.5 The `PeerConnection` inversion

The Rust agent is the WebRTC **answerer** and the **sender**. The TS agent
must be both, and `packages/webrtc-core`'s `PeerConnection` already handles
the `case 'offer'` → `createAnswer` path (`packages/webrtc-core/src/connection.ts:312-332`).

The gap is that `WeriftAdapter` currently exposes **no way at all to send
media**. It has no `addTrack`; werift's own `RTCPeerConnection` does
(`peerConnection.d.ts:194`), but the adapter never forwards it. The port
adds a sender surface to **both** the interface and the adapter:

```ts
// packages/webrtc-core/src/types.ts — the interface gains an optional sender seam,
// mirroring how `addTransceiver` / `onTrack` / `getVideoReceiver` are optional today.
export interface RTCRtpSenderLike {
  /** The negotiated codec, read back after `setRemoteDescription` + `createAnswer`. */
  readonly codec?: { mimeType: string; payloadType: number; parameters?: string };
  /** Push one outbound RTP packet. The adapter stamps SSRC / PT / seq / timestamp. */
  writeRtp(packet: Uint8Array): void;
}

export interface RTCPeerConnectionLike {
  // …existing members unchanged…
  addTrack?(track: MediaStreamTrackLike, stream?: MediaStreamLike): RTCRtpSenderLike;
}
```

and `WeriftAdapter` implements it by holding the werift `MediaStreamTrack`
it created and forwarding `writeRtp` to it. The browser adapter implements
the same method with the browser's `RTCRtpSender`.

**`RTCRtpSenderLike` does not exist today.** It is introduced by this spec
and must be defined — a grep across `packages/webrtc-core/src/` returns zero
matches today. `MediaStreamTrackLike` (`types.ts:12`) currently carries only
`kind`, so it must also grow the fields the sender path needs
(`id`, `ssrc`, and a way to reach the codec).

**Why the interface method is optional.** Every existing adapter and mock
implements `RTCPeerConnectionLike`; making `addTrack` required would break
them all. The existing optional-media-seam pattern (`addTransceiver?`,
`onTrack?`, `getVideoReceiver?`) is the precedent — a caller that requests
`media.video` and finds no `addTrack` gets a descriptive error, exactly as
`addTransceiver` does today.

**This is D4's mitigation, and it is the first thing the plan must prove.**
The port cannot be considered viable until a test demonstrates werift sending
H.264 to a browser peer. §9.3 makes that a gate, not a task.

#### 3.5.1 Four sender requirements werift does not satisfy for free

D4a–D4e together mean the werift sender path needs four explicit measures.
Each one is a place where the port can silently produce a black video stream
with a healthy connection — the failure mode the Rust agent already had to
fight.

| # | Requirement | Why | Where it lives |
|---|---|---|---|
| **R-S1** | **Explicit H.264-only codec list.** The agent's `RTCPeerConnection` is constructed with `codecs: { video: [useH264()] }` (plus the audio codecs it will not use) — and **nothing else**. | D4a — the default list is VP8-only, so without this the agent negotiates no H.264 and refuses the desktop offer. **D4b — the H.264-only list is what keeps VP8 out of the negotiated list**, because werift filters the offer's codecs against the local list by mime type. Measured: with `[useH264()]` the negotiated sender is H.264 pt102; with `[useVP8(), useH264()]` it is VP8 pt96 — the black-video bug. **What R-S1 does *not* do is pick between two H.264 entries** — both survive the filter, in the browser's order. That is R-S3's job. | The agent's peer factory. The e2e harness already does this at `desktop.e2e.test.ts:115`; the port carries it forward **and must not add VP8 back for "browser compatibility"**. |
| **R-S2** | **The negotiated codec is read back, never assumed, and asserted.** After `setRemoteDescription` + `createAnswer`, the agent reads the transceiver's negotiated codec list and **fails loudly** unless the sender's codec is H.264. | D4b — werift picks `codecs[0]` of the *negotiated* list, so the local list is the only lever on *whether* H.264 is there. D4c — a codec-less sender drops frames silently. D4e — a transceiver added too late leaves `sender.codec` undefined. | The agent's session setup, mirroring the Rust `select_h264_payload_type` (`apps/agent/src/rtc.rs:293-303`) but reading the **negotiated** list, not the offer list, and **failing** rather than returning `None`. |
| **R-S3** | **The sender is pointed at the payload type the browser offered with `packetization-mode=1` — not at whatever `codecs[0]` happens to be — and the choice is asserted.** After negotiation the agent picks the H.264 entry whose `parameters` contain `packetization-mode=1`, re-points `sender.codec` at it, and **fails loudly** if no such entry exists. | **D4d** — werift matches codecs by mime type only and never inspects `fmtp`, so the negotiated `parameters` are the **browser's**, echoed verbatim. A Chrome offer's *first* H.264 entry can be `packetization-mode=0`; werift would then negotiate mode 0, and mode-1 packets (single-NAL / STAP-A / FU-A) sent under a mode-0 PT are depacketized as one NAL per packet → broken frames. | The agent's session setup, next to the R-S2 assertion. `transceiver.codecs` and `sender.codec` are both public, writable werift API (`rtpTransceiver.d.ts:23-25`; `rtpSender.d.ts:77`), so no internals are touched. The Rust agent pinned `packetization-mode=1` in its `sdp_fmtp_line` (`rtc.rs:208`) for the same reason — but by *declaring* it, not by *selecting* it, which is why the browser could still override it. |
| **R-S4** | **The transceiver is created before `setRemoteDescription`.** | **D4e** — a transceiver added afterwards yields a second, `a=inactive` m-line with `sender.codec === undefined`; D4c then converts that into a silent no-op. | The agent's offer handler, preserving ADR-15 / B12. |

**R-S2 and R-S3 are the two most dangerous items in the port.** Both are
invisible in a unit test that only checks "a packet was sent" — the packet is
sent, it just carries the wrong payload type or the wrong packetization
contract. Both are invisible in a connection-health check. They are only
visible when a browser **decodes pixels**. P0 must assert decoded pixels, not
packet arrival.

**What R-S1 + R-S2 + R-S3 do *not* cover.** They fix the *negotiation*. They
do not fix the *encoder*: whatever openh264 is configured to emit (its
profile, its level, its Annex-B framing) must match the
`profile-level-id` the answer advertised, and the agent's packetizer must
emit mode-1 framing. That cross-check is the P0 gate's third assertion (A3),
and it is the one that catches a mismatch between the addon and the
negotiation.

#### 3.5.2 The P0 spike, precisely

P0 answers one question: **can werift, configured as the answerer and sender,
deliver H.264 that a browser decodes into visible frames?**

The spike's steps, in order — each step has an observable that fails loudly:

1. Construct a werift peer with `codecs: { video: [useH264()] }` and a local
   H.264 fixture (a pre-encoded Annex-B IDR frame).
2. Answer a synthetic offer whose video m-line lists **VP8 first, then
   H.264** — the Chrome ordering. Add the transceiver **before**
   `setRemoteDescription` (D4e). This is the case that reproduces C4/D4b.
3. After the answer is set, read back the negotiated sender codec **and its
   `parameters`**. **Observe which payload type werift selected and which
   `packetization-mode` it negotiated.** With the R-S1 list this is
   `H264/pt102` + `packetization-mode=1`; anything else is a finding that
   changes the design. Then apply R-S3: re-point the sender at the
   `packetization-mode=1` entry and assert the answer's `fmtp` for that PT
   is **byte-identical to the offer's**.
4. Packetize the fixture with the new TS packetizer, push it through the
   sender, and capture what the remote peer receives. **Assert the payload
   type on the wire is the negotiated H.264 PT** — not "a packet arrived".
5. In a browser, assert the frame **decodes** — via `HTMLVideoElement` +
   `requestVideoFrameCallback`, or by decoding the received RTP with the
   browser's own H.264 decoder and comparing against the fixture.

Step 5 is the gate. Steps 1–4 passing is not sufficient: they can all pass
while every packet carries the wrong payload type, or while the negotiated
`packetization-mode` disagrees with the packetizer's output.

**The spike must also run the negative cases.** Step 3 is run three times:
once with the R-S1 list (`[useH264()]`), once with a deliberately VP8-first
local list (`[useVP8(), useH264()]`), and once with a **mode-0-first offer**
(pt104 `packetization-mode=0` before pt102 `packetization-mode=1`).

- The VP8-first run is expected to select VP8 pt96 and is the **regression
  test for D4b** — it proves the failure mode is real and that R-S1 is what
  prevents it.
- The mode-0-first run is the **regression test for D4d**: without R-S3
  werift picks the mode-0 entry and the browser depacketizes mode-1 packets
  wrongly; with R-S3 the sender lands on the mode-1 entry.

A spike that only exercises the happy path cannot tell "R-S1 fixed it" from
"the bug never existed".

If step 3 or step 5 shows no acceptable configuration, P0 fails and the
architecture is revisited **before** any other work. The documented
fallbacks, in preference order:

| Fallback | Cost |
|---|---|
| **(a)** Configure the peer so the negotiated sender codec is H.264 | Low — a config change. **Measured to work** with the H.264-only local list; the residual problem after this is the `fmtp` (D4d), not the payload type. |
| **(b)** Re-point `sender.codec` at the browser's `packetization-mode=1` entry after negotiation | Low — `transceiver.codecs` and `sender.codec` are **public, writable** werift API (`rtpTransceiver.d.ts:23-25`; `rtpSender.d.ts:77`), so this touches no internals. **Measured to work**, and it leaves the answer's `fmtp` byte-identical to the offer. This is R-S3's mechanism. |
| **(c)** Write RTP directly to the DTLS transport, bypassing `sendRtp` | High — reimplements the sender's SSRC/PT/sequence/timestamp rewriting and RTCP feedback handling |
| **(d)** A different WebRTC stack | Highest — the whole `@ponter/webrtc-core` adapter layer is rewritten |

**RK1's "decided at P0" is a real decision point, not a deferral**: the table
above is the concrete list of options, each with its cost, and P0 produces the
evidence that selects among them.

### 3.5.3 What is already settled, and what P0 must still prove

The negotiation half of the werift-as-sender risk has been **measured**
against werift 0.24.4, not assumed. The measurements:

| Question | Measured answer | How it was measured |
|---|---|---|
| Does a Chrome-style VP8-first offer make werift pick VP8? | **Only if the local list also offers VP8.** With `[useH264()]` → `sender.codec = H264/pt102`; with `[useVP8(), useH264()]` → `sender.codec = VP8/pt96`. | A werift answerer fed a real Chrome SDP offer, then `getTransceivers()[0].sender.codec` read back. |
| Which of Chrome's **two** H.264 entries does werift pick? | **The first one, whatever its mode.** Chrome offers pt102 `packetization-mode=1` and pt104 `packetization-mode=0`. Offer pt102 first → `sender.codec = pt102` (mode 1). Offer pt104 first → `sender.codec = pt104` (**mode 0**). The local list cannot reorder the remote list. | Two offers with the same two H.264 entries in opposite orders; `sender.codec` read back each time. |
| Where does the negotiated codec's `fmtp` come from? | **The browser's, verbatim.** werift's local `useH264().parameters` is never consulted. | Four offers with different `fmtp` strings; each was echoed unchanged into the answer. |
| Can the agent **edit** the negotiated `fmtp`? | **Yes, by mutating the codec object in place** — `transceiver.codecs[0].parameters = …` changes both the answer's `a=fmtp:` line and `sender.codec.parameters`, because `sender.codec` and the answer's codec list are the *same object*. **But replacing the object instead of mutating it breaks werift**: `{...codec}` drops the `name` getter (a prototype accessor, `parameters.js:54-56`), and `sdpManager.js:107` then throws `TypeError: Cannot read properties of undefined (reading 'toLowerCase')`. | Mutation applied to a live werift answerer; the generated answer's `a=fmtp:` lines and `sender.codec` read back. The object-replacement variant was tried too and crashed. |
| Can the agent choose a **different payload type** to fix a mode-0 negotiation? | **Yes — and this is the better fix.** `transceiver.codecs` (public getter/setter) and `sender.codec` (public, writable) let the agent re-point the sender at the browser's `packetization-mode=1` entry. The answer's `fmtp` for that PT then stays **byte-identical to the offer's**, which is what RFC 3264 asks for; the re-pointed PT also leads the answer's m-line. | Two offers (mode-0-first and mode-1-first). In both, re-pointing `sender.codec` at the mode-1 entry produced an answer whose `fmtp` matched the offer exactly. With a mode-0-only offer the agent has no valid choice and must fail loudly. |
| Does the transceiver order matter? | **Yes.** Added after `setRemoteDescription` → a second transceiver, `a=inactive` m-line, `sender.codec === undefined`. Added before → `a=sendonly`, `sender.codec = H264/pt102`. | Both orders, same offer. |
| Does `MediaStreamTrack.writeRtp` overwrite the payload type? | **Yes** — `packet.header.payloadType = this.codec?.payloadType ?? …`. And `RTPSender.sendRtp` overwrites SSRC, PT, timestamp and sequence number. | Source read at `track.js:132-134`, `rtpSender.js:539-552`. |

**What P0 must still prove** (none of it is settled by the measurements
above):

1. That a browser **decodes** the resulting stream (A3) — the measurements
   are about SDP and payload types, not pixels.
2. That the **addon's** openh264 output is **compatible with** the
   negotiated `profile-level-id` (D4d) — the negotiation half is understood;
   the encoder half is not. The concrete bar: the addon's SPS must carry the
   profile the browser's `profile-level-id` names, and a level the browser
   can decode. The Rust agent advertised `42001f` while emitting `42c0XX`
   (§3.3); the product shipped, but no test decodes the pixels, so the
   tolerance is unproven. P0 must show whether it still holds, or whether the
   answer has to echo a `profile-level-id` the encoder actually matches.
3. That the **DTLS/SRTP transport** carries the packets — the measurements
   never opened a connection.
4. That **RTCP feedback** (PLI, REMB) reaches the addon, so a keyframe
   request produces a keyframe. A sender that cannot be asked for a
   keyframe is a stream that never recovers from a dropped IDR.

#### 3.5.4 The guarantee the port would otherwise lose

This is the single most important thing to carry across the port, and it is
easy to miss because the failure is silent.

`webrtc-rs` — the Rust agent's stack — **matches H.264 codecs by their
`fmtp`**, not just by mime type. `H264Fmtp::match_fmtp`
(`rtc-0.21.0/src/rtp_transceiver/fmtp/h264/mod.rs:52-81`) requires:

1. both sides to carry a `packetization-mode`, and
2. both `packetization-mode` values to be **equal**, and
3. `profile_level_id_matches(hplid, cplid)` to hold — which compares the
   **first two bytes only** (`profile_idc` and the constraint byte) and
   deliberately **ignores the level byte**, because RFC 6184 §8.2.2 says the
   level "does not apply" to the symmetric-use requirement.

So the Rust agent's negotiation was: *the browser's H.264 entry must agree
with the local one on packetization-mode, and on the profile + constraint
bytes.* A browser offering mode 0 was **never** silently accepted, because
`match_fmtp` would return false and the codec would be dropped from the
answer.

**werift has no such check.** `findCodecByMimeType` compares mime types and
ignores `fmtp` entirely (D4d), so on werift a mode-0 entry is negotiated
happily. The port would therefore **lose** a guarantee the Rust agent had —
and would lose it silently, because the connection stays healthy and only the
pixels are wrong.

**R-S3 is how the port restores it.** The agent's own check — *find the H.264
entry the browser offered with `packetization-mode=1`, point the sender at
it, and fail loudly if there is none* — reproduces the guarantee webrtc-rs
gave for free, using only public werift API. §3.5.2's mode-0-first offer
is the regression test.

**One more thing the port must copy: the `profile-level-id` values
themselves.** `webrtc-rs`'s default `MediaEngine` registers H.264 at five
payload types with **five different** `fmtp` strings
(`rtc-0.21.0/src/peer_connection/configuration/media_engine.rs:466-540`):
pt102 `packetization-mode=1;profile-level-id=42001f`, pt127 mode 0
`42001f`, pt125 mode 1 `42e01f`, pt108 mode 0 `42e01f`, pt123 mode 1
`640032`. werift's `useH264()` ships **one** — `42e01f`
(`werift/lib/webrtc/src/media/codec.js:6-12`) — and the port inherits that
narrowness.

The `profile-level-id` in the *answer* is the browser's (D4d), so the local
value mostly does not reach the wire; but it does decide **which** of the
browser's entries the agent can accept, and therefore whether the agent
negotiates at all. The port's local list should carry **the same spread** the
Rust agent had — at minimum one mode-1 entry per distinct
`profile-level-id` the browser is likely to offer — so that a browser
offering `42001f` is matched, not filtered out.

---

## 4. Behaviour inventory — what must be preserved

This is the G4 checklist. Each row is a Rust behaviour with its source
citation and its port target. **No row may be silently dropped.**

### 4.1 Signalling and session lifecycle

| # | Behaviour | Rust source | Port target |
|---|---|---|---|
| B1 | Two-level message envelope (outer transport `type` + inner tagged signal) | `signal.rs:22-29,233-237` | `@ponter/shared` types + the TS agent's codec |
| B2 | Bearer auth in the WS upgrade header, never in the query string | `api.rs:132-137` | `@ponter/api-client`'s URL helper + the agent's WS client |
| B3 | Reconnect ladder 200 ms × 1.5 → 2000 ms cap | `signal.rs:104-121` | `@ponter/webrtc-core`'s `ReconnectBackoff` |
| B4 | Terminal close codes 4401 (credential) / 4409 (replaced) | `signal.rs:297-301` | The agent's close classifier |
| B5 | Ping every 30 s, idle timeout 90 s | `signal.rs:104-105` | The agent's WS client |
| B6 | Inbound frame cap 256 KiB (signalling), 64 KiB (data channel) | `signal.rs:226`; `pty.rs:22,26` | The agent's WS/DC readers |
| B7 | Server pushes `ice-servers` then `identity-challenge`, in that order | server `ws.ts:836-841` (ICE push), `:850-855` (identity challenge), `:846-847` (the comment that fixes the ordering) | The agent's WS client |
| B8 | Answer proof: sign the canonical message over role/sessionId/sdpSha256/fingerprint | `rtc.rs:829-842`; `identity.rs:78-90` | `canonicalProofMessage` from `@ponter/shared` |
| B9 | DTLS fingerprint normalised to uppercase colon-hex, fail-closed on malformed | `identity.rs:128-138` | `normalizeFingerprint` (already shared) |
| B10 | ICE: mDNS disabled, bind `0.0.0.0:0` and `127.0.0.1:0`, TURN/TCP filtered out, server ICE wins over `--stun` | `rtc.rs:380-382,444,493-511` | The agent's `RTCPeerConnection` config |
| B11 | Short ICE timeouts when media-only (3 s disconnected / 5 s failed / 1 s check) | `rtc.rs:484-490` | The agent's peer config |
| B12 | The desktop track is attached **before** `setRemoteDescription` | `rtc.rs:191-194` | The agent's offer handler (a documented ADR-15 constraint) |
| B13 | Only the expected data-channel label is accepted; others closed immediately | `rtc.rs:663-689` | The agent's DC dispatcher |

### 4.2 Desktop capture → encode → transport

| # | Behaviour | Rust source | Port target |
|---|---|---|---|
| B14 | Capture → downscale → encode → RTP pipeline | `desktop.rs` | Core orchestration + native capture/encode |
| B15 | Even-dimension crop before encode | `desktop.rs:312` (`crop_to_even`) | The core's resize step |
| B16 | SIMD box-filter downscale | `desktop.rs:216-266` | The native addon's resize (it is where the pixels are) |
| B17 | H.264 encoder config: `ScreenContentRealTime`, `Bitrate` rate control, `Complexity::Low`, `adaptive_quantization(false)`, `background_detection(false)`, `VuiConfig::bt709()` | `desktop.rs:1827-1852` | The native addon's encoder config (same constants) |
| B18 | Dynamic GOP = `(fps × 2).round().max(1)` frames | `desktop.rs:1821-1825` | The core's profile module (shared with the desktop) |
| B19 | Bitrate retarget: raise sets `ENCODER_OPTION_MAX_BITRATE` on `SPATIAL_LAYER_0` first, then `ENCODER_OPTION_BITRATE` on `SPATIAL_LAYER_ALL`; lower needs only the latter | `desktop.rs:1893-1922` | The native addon's `applyBitrate` |
| B20 | Bitrate clamp `[250 kbps, 20 Mbps]` (`ABR_MIN_BPS` / `ABR_MAX_BPS`) | `rtc.rs:90,92` | The core's clamp |
| B21 | Stream profiles `1080p30` (1920×1080 @ 30, 6 Mbps) / `720p30` (1280×720 @ 30, 4 Mbps) / `1080p60` (1920×1080 @ 60, 8 Mbps) / `720p60` (1280×720 @ 60, 5 Mbps) | `lib.rs:445-491` (`StreamProfile` constants); names parsed at `lib.rs:494-507` | A **shared** module in `@ponter/shared` (fixes D12) |
| B22 | Static-frame skip: 4-lane FNV-1a hash, 1 s keepalive cap, reset on bitrate/source/profile change | `desktop.rs:1293-1308` (`frame_signature`), `:1316-1350` (`StaticFrameSkip`, `should_skip`) | The core |
| B23 | Sustain ladder: monotonic degradation by pixels/sec, `QualityDowngraded` status | `desktop.rs:1285` (`SUSTAIN_FRAMES_BEFORE_FALLBACK`), `:1379-1390` (`downgrade_for`), `:1395-1460` (`SustainMonitor`) | The core |
| B24 | Frame timing ring: median capture latency + median encode ms | `desktop.rs:58-180` | The core |
| B25 | Annex-B output with SPS/PPS/IDR first | `desktop.rs:1852-1871,2469-2475` | The native addon's encoder |
| B26 | RFC 6184 packetization (single-NAL / STAP-A / FU-A) | `webrtc-0.21` `static_sample.rs:164` | **New** TS packetizer (§3.3) |
| B27 | The negotiated H.264 payload type, never `codecs.first()` | `rtc.rs:277-303` | The core's PT selection (must be a unit-tested pure function) |

### 4.3 Input injection

| # | Behaviour | Rust source | Port target |
|---|---|---|---|
| B28 | Input JSON on the `control` DC, `kind` ∈ {pointer-move, pointer-button, wheel, key, text} | `input.rs:73-107` | The core's decoder |
| B29 | Coordinates normalised 0..1, NaN → 0.0, clamped | `input.rs:155-161` | The core |
| B30 | Rate cap 120 Hz over a fixed 1 s window, over-limit frames **dropped** | `input.rs:114-153` | The core |
| B31 | Linux: Wayland `org.freedesktop.portal.RemoteDesktop` D-Bus calls (motion-absolute, button, axis, keycode, keysym) | `portal/injector.rs:110-160` | The native addon |
| B32 | `KeyboardEvent.code` → evdev keycode map | `input.rs:444-538`; `portal/evdev_map.rs` | The native addon (Linux) |
| B33 | Windows: `enigo`-equivalent input (pointer absolute, key map, text) | `input.rs:337-347,353-567` | The native addon (Windows) |
| B34 | `AGENT_ALLOW_INPUT` is agent-local; a peer cannot turn it on | `main.rs:83-93` | The core's admission check |
| B35 | Coordinate → absolute-pixel mapping clamped to the display bounds | `input.rs:267-333` | The native addon |

### 4.4 Terminal, PTY, files

| # | Behaviour | Rust source | Port target |
|---|---|---|---|
| B36 | Shell allowlist: `/bin/sh` floor ∪ `/etc/shells`; absolute path; canonicalize; executable bit | `shell_policy.rs:19-20,47-99` | The core |
| B37 | `--shell`/`AGENT_SHELL` is always allowed (operator-trusted) | `shell_policy.rs:30-38` | The core |
| B38 | Windows shell detection: `pwsh` → `powershell` → `cmd.exe` | `main.rs:185-222` | The core |
| B39 | PTY env: `TERM=xterm-256color`, `LANG=C.UTF-8` | `pty.rs:347-348` | The core |
| B40 | PTY output: standard base64, 16 KiB chunks, slave end held for correct EOF | `pty.rs:22,392,397,351-353` | The core + `node-pty`. The 16 KiB bound is a *read-buffer* bound in the Rust (`:392` allocates the buffer, `:397` hands on `buf[..n]`), so a port whose input source is not buffer-bounded — `node-pty` delivers events over 16 KiB — must apply it at its framer |
| B41 | Terminal message set: create / resize / close / exit / error | `pty.rs:263-292` | `@ponter/shared` terminal types |
| B42 | Files binary frame layout `[1B type][16B id][8B BE index][payload]`, 32 KiB | `files.rs:75-104` | The core |
| B43 | Files JSON message set (12 inbound, 11 outbound) | `files.rs:489-550` (`FilesInbound` at `:489`, `Outbound` at `:512`) | `@ponter/shared` files types |
| B44 | Path sandbox: reject absolute, NUL, backslash, empty/`.` components; `..` allowed but containment proven by canonicalize + component prefix | `files.rs:760-800` | The core |
| B45 | Single in-flight transfer per direction; 64-chunk window; 30 s idle timeout; ack every 16 chunks / 20 ms | `files.rs:36-38,1083-1085,1185-1245` | The core |
| B46 | Upload temp suffix `.ponter-part`, removed on discard; resume requires exact `.part` length | `files.rs:65,1009-1036,1126-1128` | The core |

### 4.5 Identity, E2EE, API, logging

| # | Behaviour | Rust source | Port target |
|---|---|---|---|
| B47 | Ed25519 PKCS#8 identity file, mode 0600, base64 public key | `identity.rs:21-76` | The core + a Node file store |
| B48 | Canonical proof bytes ≡ `canonicalProofMessage` | `identity.rs:78-90` | `@ponter/shared` (already identical — delete the Rust copy) |
| B49 | E2EE: ECDH P-256 → HKDF-SHA256 → AES-256-GCM; `info="ponter-ws1-terminal-v1"`, `salt=session_id`, empty AAD | `e2ee.rs:14-17,42-44,149-173,220` | `@ponter/crypto`'s `EncryptionManager` |
| B50 | E2EE frame `[12B IV][ct ‖ 16B tag]` | `e2ee.rs:149-160` (build) and `:161-173` (parse) | `@ponter/crypto` (already identical) |
| B51 | E2EE test vectors shared with the browser | `e2ee.rs:246-301` | `packages/crypto/test/vectors/e2ee-vectors.json` |
| B52 | E2EE hello/ack handshake, each side signs its key binding | `e2ee.rs:204-229` | The core |
| B53 | API error envelope `{status?, code, message, details?}`; auth-fatal iff 401 or `UNAUTHORIZED` | `api.rs:53-64,112-114` | `@ponter/api-client` (the Rust `api.rs` HTTP layer is dead code and is retired) |
| B54 | `RUST_LOG` env var, default `info`, noise filters for known-benign subsystems | `logging.rs:167-185` (the `RUST_LOG` policy — `init()`), `:26-98` (the `NOISE` array of `(target, message-substring)` pairs), `:102-134` (the `QuietNoise` struct, `is_noise`, and the `Filter` impl) | A TS logger with the same env var name and the same filters |
| B55 | The `e2ee` capability is advertised iff the offer proposed it | `rtc.rs:266-275` | The core |

### 4.6 Desktop enumeration, cursor, DPI, telemetry, and the capture fallback

These behaviours exist in the Rust tree and are **not** covered by §4.1–§4.5.
They are inventoried here so the behavioural-parity gate (§9.4) can cover them.
Every row is a behaviour the Rust agent performs today, so every row is a
behaviour the port must perform tomorrow.

| # | Behaviour | Rust source | Port target |
|---|---|---|---|
| B56 | **Cursor polling** — sample the pointer position and shape on a timer, emit a `desktop-cursor` control frame **only when the position or the shape changed**; the shape is a base64 PNG capped in size | `cursor.rs:1-735` (the whole module); `desktop.rs:2093-2104` (`frame_desktop_cursor`) | The core (ADR-45). The X11 XFixes sampling is a native concern on Linux; the change-detection and the wire frame are the core's. |
| B57 | **DPI awareness** (Windows) — `SetProcessDpiAwarenessContext(-4)`, falling back to `SetProcessDpiAwareness(2)` then `SetProcessDPIAware()`. Without it the capture returns wrong scale factors and input coordinates are wrong. | `lib.rs:39-75`; `main.rs:269` | The native addon (Windows only) — it must run **before** any capture or input call. |
| B58 | **Desktop source enumeration** — `SourceKind::Monitor` vs `SourceKind::Window`, `DesktopSourceInfo` with the `inputEnabled` / `cursorInFrame` flags, and the `desktop-sources` control frame | `desktop.rs:843-911` (`SourceKind`, `DesktopSourceInfo`, `enumerate_sources`); `desktop.rs:2062-2086` (`frame_desktop_sources`) | The native addon enumerates; the core frames and sends. |
| B59 | **Source selection** — `AGENT_DESKTOP_DEFAULT_SOURCE` picks the default source; `source_for` resolves a requested id against the enumerated list | `desktop.rs:1004-1028` (`default_source_id`), `:922-977` (`source_for`) | The core |
| B60 | **`capture_image` polling fallback** — when no hardware video recorder is available, fall back to a polling loop that grabs single frames. The interval comes from `AGENT_DESKTOP_POLL_INTERVAL_MS`, and **defaults to the profile's frame budget** (16.7 ms at 60 FPS); `GDI_DEFAULT_POLL_INTERVAL = 33 ms` (`:557`) is a *fallback constant* for the Windows GDI path, not the loop's default | `desktop.rs:553-650` (`ImageCapturer` trait, `run_capture_image_poll_loop`, the poll-interval constants), `:559-582` (`AGENT_DESKTOP_POLL_INTERVAL_MS` parsing and the frame-budget default) | The native addon's capture path |
| B61 | **`desktop-stats` telemetry** — periodic control frames carrying the encoded-frame count, dimensions, the current profile, and the quality-downgraded status | `desktop.rs:1700-1720` (the emission site: the `encoded % fps_period` check at `:1710`, the `send_stats` call at `:1717`), `:1535-1537` (`encoded_size` init — the dimensions the frame reports), `:1738-1746` (`QualityDowngraded` emission); `DesktopStats` at `:2106`; `frame_desktop_stats` at `:2147` | The core |
| B62 | **The desktop control state machine** — `DesktopSelectMessage` (the browser's source-select request), the `StreamControl` enum with its `SetBitrate` and `SourceSwap` variants, and the `StatsStatusKind::QualityDowngraded` status | `desktop.rs:1986` (`DesktopSelectMessage`), `:1938-1944` (`StreamControl` enum), `:2136` (`StatsStatusKind::QualityDowngraded` — a *status* kind, not a `StreamControl` variant) | The core |

**B56, B61 and B62 are easy to lose** because they are *side channels*:
the cursor frame, the stats frame, and the control frames travel beside the
video, not inside it, so a port that only wires up the video path drops
them silently. The behavioural-parity gate must assert each of them
explicitly.

### 4.7 Explicit retirements (each with a rationale)

| # | Retired | Rationale |
|---|---|---|
| R1 | The standalone CLI binary and its `clap` argument parser | Desktop-only (§6.2). The `AgentSupervisor` already passes configuration via environment variables, so no CLI surface is needed. |
| R2 | The musl / terminal-only build variant | No cross-compilation (§6.2). |
| R3 | `api.rs`'s `ApiError::from_response` / `network` / `is_auth_fatal` — the HTTP error-mapping layer, **and only that** | Dead code — no caller outside `api.rs` itself; the agent has no HTTP client. `packages/api-client` owns this concern in TS. **This row retires 7 of `api.rs`'s 20 tests, not 20.** The other 13 cover two live helpers that must be re-homed, not deleted: `to_ws_url` (11 tests, called from `lib.rs:730`) and `with_bearer` (2 tests, called from `signal.rs:353`). See the note beneath this table. |
| R4 | `apps/agent/vendor/xcap` (the Rust fork with the PipeWire lifetime fix) | Superseded by the native addon's capture implementation. The fork's `PATCH.md` rationale must be carried into the addon's capture code as a comment. |
| R5 | The `QuietNoise` filter's Rust-crate-specific target names | Replaced by equivalent TS filter names (§4.5 B54). |
| R6 | `build-agent.yml` and the agent GitHub Release | Desktop-only (§6.2). |

**R3 does not retire `api.rs` as a file.** The module holds three things and only the first is dead:

| Item | Tests | Caller | Disposition |
|---|---|---|---|
| `ApiError::from_response`, `network`, `is_auth_fatal` | 7 | none outside `api.rs` | **Retired** (R3) |
| `to_ws_url` | 11 | `lib.rs:730`, before the signalling connect | **Re-homed** — see below |
| `with_bearer` | 2 | `signal.rs:353`, on the WS upgrade request | **Re-homed** — see below |

Deleting `api.rs` as a unit on R3's authority would take thirteen covered behaviours with it and the §8.1 accounting would silently drop them. Plan 3's Rust removal must keep `to_ws_url` and `with_bearer` alive in TypeScript before it deletes the module.

**Where the 13 land.** `@ponter/webrtc-core/src/url.ts` already exports `toWsUrl` and `stripTrailingSlashes` (§3.4), so the URL half *looks* like a **reuse** rather than a port. It is not. **The TS helper behaves like the pre-G3-W1 Rust implementation — adopting it as-is reintroduces a defect Rust found and fixed.**

Rust splits the query/fragment suffix off **before** trimming path slashes, then reattaches it byte-for-byte (`api.rs:28-40`), and the comment at `:32-34` records why:

> `// Split off any query/fragment suffix *before* trimming path-ending slashes`
> `// (URL-3/4 + G3-W1: a query value such as `?next=/` must survive byte-for-byte).`

The comment also records that the earlier implementation "ran over the whole URL and dropped the trailing slash in the value". TS's `toWsUrl` calls `stripTrailingSlashes` on the **whole string** — that is that earlier behaviour, reached independently rather than by copying. Verified by running both:

| Input | Rust `to_ws_url` | TS `toWsUrl` |
|---|---|---|
| `http://h/a/?next=/` | `ws://h/a?next=/` | `ws://h/a/?next=` |

**The TS test suite cannot tell you this.** `packages/webrtc-core/test/url.test.ts` has 8 `toWsUrl` assertions and **not one** contains a query or a fragment, let alone one with a slash in its value. A Plan 2 step that "runs the existing url tests and finds them green" proves nothing about this case. The check must add it.

So Plan 2 has two honest options and must pick one explicitly: keep the Rust semantics at the agent's call site, or fix `toWsUrl` (and give it the three missing cases). It is a decision, not a refactor, because it changes which `AGENT_SERVER` values are accepted. Whichever it picks, `preserves_a_ws_query_value_ending_in_slash`, `trims_a_path_slash_before_the_query_without_altering_it` and `preserves_a_fragment_suffix_unchanged` must have TS equivalents. `with_bearer` has no TS equivalent and is a small, direct port.

**Three callers compose a WS URL by appending a path to `toWsUrl`'s output. Rust appends nothing.** This is not one collision waiting to happen but three:

| Caller | Composition |
|---|---|
| `apps/desktop/src/main/agent-supervisor.ts:131` | `${toWsUrl(config.serverUrl)}/api/ws/agent` |
| `apps/desktop/src/main/fleet.ts:103` | `${toWsUrl(this.baseUrl)}/api/ws/fleet?ticket=…` |
| `packages/webrtc-core/src/ws-ticket.ts:4` | `${toWsUrl(baseUrl)}/api/ws/browser?ticket=…` |

This is **already documented and was not carried into this spec.** `docs/notes/2026-10-14-subproject-g-api-standard-be-input.md:161-180` (G3-F3) states it plainly: "Note the desktop's three copies each append a *different* path on top of the common scheme rewrite… **Only the scheme rewrite is the shareable unit; the per-caller path stays with the caller.**" The same note gives the reason the Rust side appends nothing: `--server` defaults to a complete WS URL (`main.rs:29`), so appending would double `/api/ws/agent`.

Today this is stable because `agent-supervisor.ts` is the only producer of `AGENT_SERVER`. When the agent moves in-process (§5), two composers yield `/api/ws/agent/api/ws/agent`, and the symptom is a 404 on the upgrade that reads like an auth failure. Plan 2 must enumerate all three, say which are in scope for the agent, state who owns composition, and add the test that pins it. The fleet and browser composers are desktop/web-side and may never touch the agent path — but "may never" is the assumption that needs writing down, not a discovery to be made later.

**Correction note.** An earlier draft of this row cited a "wire report §5.4", and §3.4's `@ponter/api-client` row cited the same. No such document was ever committed — it was a session scratch file. The claim those rows make is independently true (verified: no caller outside `api.rs` references `ApiError`, `from_response`, `network`, or `is_auth_fatal`), so the citation is replaced rather than the claim retracted. This row also narrows the scope, which the earlier wording overstated.

---

## 5. In-process vs sidecar

ADR-86 chose the **sidecar**: the Electron main process spawns and supervises
the `ponter-agent` binary. The owner decision to drop CLI distribution reopens
this, because a sidecar that is "a Node script the desktop app spawns" is
strictly worse than in-process: it adds a process boundary, a spawn, a
supervisor, a stderr pipe, and a respawn policy, in exchange for isolating
something that is now the same codebase.

### 5.1 Options considered

| Option | Description | Verdict |
|---|---|---|
| **A. In-process, TypeScript core** | The agent's TS core runs in the Electron main process; the N-API addon is loaded via `require`/`import` in the same process | **Selected** |
| B. In-process, N-API addon only | The addon carries the whole agent in C++ | Rejected — contradicts the owner's architecture-A choice, and re-creates the Rust problem in C++ |
| C. Sidecar, Node child process | `AgentSupervisor` spawns `node apps/agent/dist/main.js` | Rejected — see §5.3 |
| D. Sidecar, Rust binary | The status quo | Rejected — the owner ruled out Rust |

### 5.2 Why A wins

1. **The "one runtime" property.** The agent and the desktop app share the
   `@ponter/shared` types, `@ponter/crypto`'s E2EE, `@ponter/webrtc-core`'s
   `PeerConnection`, and `@ponter/api-client`. In-process, these are the *same
   module instances* — one `Buffer`, one `CryptoKey`, one `PeerConnection`
   class. In a sidecar they are duplicated across a process boundary and must
   be serialised at every hop.
2. **The process boundary bought less than it cost.** ADR-86's stated rationale
   was that the sidecar "keeps a process boundary that isolates a capture/PTY
   crash from the UI." Concretely, the benefit was: the Rust binary was a
   **separate process**, so when it died the `AgentSupervisor` saw an `exit`
   event and respawned it — the Electron app and the UI survived untouched.
   **In-process that path is gone.** A native-addon segfault is not catchable
   from JS (N-API runs at the V8 native boundary; Electron does not sandbox
   its main process), so there is no process to respawn and the whole app
   must restart.

   The two failure modes are also categorically different, which the "ADR-86's
   benefit disappears" framing understates:

   | | Rust sidecar | N-API addon, in-process |
   |---|---|---|
   | A logic error | A Rust `panic` unwinds, is catchable in Rust, and — with `panic = "abort"` in the release profile — aborts the process | A C++ exception must not cross the FFI boundary at all; a violation is undefined behaviour |
   | A memory-safety error | Rust's type system makes it structurally hard; a bug is a panic, not a corruption | A buffer overrun is a **segfault** — unrecoverable, and it takes the app with it |
   | A crash's blast radius | The agent's process; the app and UI survive and the supervisor respawns | The Electron main process; **the app dies** |

   So the sidecar was isolating the agent from the *app*, and an in-process
   addon gives that isolation up. The mitigation is not "defensive C++ is
   sufficient" — it is that the addon must be written so that a fault is
   **impossible to originate**, not merely unlikely: no unchecked buffer
   writes, no C++ exceptions across the boundary, every OS return checked
   (§9.2 makes that a test, not a promise). The honest statement of the
   trade is: **the port gives up crash isolation, and buys back the ability
   to write the crashy part in a language with no memory-safety guarantees
   at all.** Whether that trade is right depends on the addon being small
   and mechanical — which is exactly why §6.3 keeps the addon's surface to
   *frames in, Annex-B out* and pushes everything else into TypeScript.
3. **One installer.** The addon is compiled into the Electron app's resources
   (or into a per-platform `@ponter/agent-native` prebuild), not shipped as a
   separate downloadable binary. The user installs one thing.
4. **The `AgentSupervisor` becomes a lifecycle manager, not a process manager.**
   Its health-watch, `STARTUP_GRACE_MS` verification, stderr tail, and bounded
   backoff all still make sense for an in-process runtime — they become
   "restart the runtime after a recoverable error" rather than "respawn the
   process". The `AgentControlService` contract (`start`/`stop`/`getStatus`/
   `getLastError`) is unchanged, so the IPC surface and the renderer are
   untouched.
5. **ADR-50's precedent.** The agent has always been "a library plus a thin
   CLI" (ADR-50) so a desktop backend could embed it in-process. The rewrite
   restores exactly that shape — the library *is* the agent.
6. **ADR-86's rejected alternative is re-adopted, and this is the amendment.**
   ADR-86's *Alternatives Rejected* list ends with:

   > *Node native addon wrapping the Rust lib:* Rejected — heavier build
   > (N-API) and it re-introduces in-process coupling that the sidecar
   > removes.

   That bullet is **exactly the architecture this spec adopts**, so ADR-86
   cannot be left standing unmodified — it would contradict the decision
   inside the ADR it claims to amend. The reversal is deliberate and its
   reasons are (2) and (3) above plus §5.4:

   - The N-API build is now scoped to a **two-operation surface** (capture,
     encode) rather than the whole agent, so the "heavier build" cost falls
     by orders of magnitude compared with wrapping a 20,858-line Rust
     library.
   - The "in-process coupling" the sidecar removed is **given up
     explicitly**, not accidentally: §5.4 states what a native-addon fault
     now costs (the app dies), and §9.2 makes fault-containment a test
     rather than a promise. The owner accepts that trade in exchange for
     one runtime and one installer.
   - The "process boundary" the sidecar bought was only ever *partial*
     isolation, as the failure-mode table above shows — and the crash it
     protected the app from now lives in a much smaller, much more
     mechanically auditable piece of code (§6.3).

### 5.3 Why C (sidecar, Node) is rejected

| Cost | Detail |
|---|---|
| Double supervision | `AgentSupervisor` gains a "did the child exit" path, and the Electron app gains a "the child is the agent" path. Two failure domains for one feature. |
| IPC tax | Every agent→desktop signal (desktop stats, quality-downgraded notices) becomes a pipe message instead of an in-process event. |
| Startup latency | Electron must spawn a Node process; `node` startup + TS module loading adds to the 2000 ms startup grace. |
| Orphan risk | A crash-looping child survives an Electron quit unless the supervisor is killed first — the exact class of bug `AgentSupervisor`'s `before-quit` handler exists to prevent. |
| No isolation benefit | Same as (5.2)(2): a native-addon fault kills the app either way. |

### 5.4 What in-process costs, and how it is mitigated

| Cost | Mitigation |
|---|---|
| A native-addon segfault kills the app | The addon must be written defensively: every OS call checked, every buffer bounds-checked, no unwinding across the FFI boundary. A capture/encode fault is caught in C++ and returned as an error code, not propagated as a crash. §9.2 makes addon fault-containment a test. |
| The main process now runs a 60 FPS encode loop | The encode is in the native addon (its own threads, not the Node event loop). The TS core's per-frame work is small (hash, packetize, send). The capture/encode loop is scheduled on a `worker_threads` thread with the addon's own encoder thread. **But the main process is already load-bearing** — it runs the agent supervisor, the agent control service, the IPC handlers, the renderer process management, the auto-updater, the tray icon, the system-preferences bridge, and the crash reporter. A 60 FPS feed loop is *additional* CPU on top of all of that. The `worker_threads` isolation is necessary but not sufficient: the worker must hand frames back with a `MessageChannel` (or `SharedArrayBuffer` + `Atomics`), never by polling the event loop, or the 60 Hz wakeups themselves become the contention. The ADR-47 frame-timing ring is extended to record main-process event-loop delay alongside encode latency, so a regression is visible before it is felt. |
| Signal handling | The Rust agent installed process-level `SIGINT`/`SIGTERM` handlers. In-process, the agent must **not** install them — Electron owns the process lifecycle. The agent gets a `stop()` method instead. |
| The main process's stdout is shared | The agent's logs go through the TS logger to the same sink, tagged with a component name, and the `AgentSupervisor`'s stderr tail becomes an in-memory log ring the UI reads. |

### 5.5 What is *not* changing

- The `AgentSupervisor` / `AgentControlService` public contract and its tests
  stay valid; only the implementation of "spawn" changes to "start the runtime".
- The renderer is untouched: it still sees `desktop:runtime-status`,
  `desktop:start-agent`, `desktop:stop-agent`.
- ADR-86 is **amended**, not deleted: the supervisor concept survives; the
  process boundary does not. The §8 trail records the amendment. Two things
  in ADR-86 are specifically reversed: its *Rationale* sentence *"Spawning
  the CLI preserves every behavior … and keeps a process boundary that
  isolates a capture/PTY crash from the UI"* (§5.2(2) argues against it), and
  its *Alternatives Rejected* bullet *"Node native addon wrapping the Rust
  lib: Rejected — heavier build (N-API) and it re-introduces in-process
  coupling that the sidecar removes"* (§5.2(6) re-adopts it, with the
  narrower addon surface and the explicit isolation trade).
- ADR-89 is **amended**, not deleted: the shared-API-access rule and its
  automated boundary gate survive; the Rust half does not. ADR-89's decision
  is explicit that *"For Rust (`apps/agent`, Sub-project G3), [it]
  establishes `ponter_agent::api` as the single shared module … guarded by
  an automated CI boundary gate in `.github/workflows/build-agent.yml`"*
  (`docs/ARCHITECTURE.md:1055`). The rewrite retires that module (R3) and
  that workflow (R6), so the ADR must be amended to say what now governs
  the agent: the TypeScript `api-access-gate` (`packages/api-client/test/
  api-access-gate.test.ts`), which enforces the same rule — no raw `fetch(`
  or `axios` outside the sanctioned allow-list — over the TypeScript agent
  instead of over `src/main.rs`. The rule is unchanged; only the language it
  is enforced in is. The §8 trail records the amendment.

---

## 6. Distribution, build, and CI

### 6.1 The new package layout

```
apps/agent/                       (rewritten in place — same workspace path)
  package.json                    @ponter/agent-node, workspace:*, type: module
  src/
    index.ts                      public surface: createAgentRuntime(...)
    runtime.ts                    the lifecycle: start / stop / status
    config.ts                     env-var config resolution (replaces clap)
    signalling/
      client.ts                   WS client, envelope codec, backoff, close codes
      messages.ts                 the signal message types (from @ponter/shared)
    session/
      peer.ts                     werift peer wiring (answer path, ICE, PT select)
      packetizer.ts               RFC 6184 Annex-B → RTP  (NEW)
      data-channels.ts            label gate, dispatch
    e2ee/
      manager.ts                  ECDH/HKDF/AES-GCM handshake (uses @ponter/crypto)
    identity/
      store.ts                    Ed25519 PKCS#8 file (mode 0600)
    terminal/
      pty.ts                      node-pty wrapper, base64 chunking
      shell-policy.ts             allowlist
    files/
      session.ts                  transfer state machine
      sandbox.ts                  path containment
    input/
      decode.ts                   input JSON decode, clamp, rate limit
    desktop/
      profiles.ts                 the shared stream-profile table
      session.ts                  capture → encode → packetize → send
      static-skip.ts              FNV-1a frame signature
      sustain.ts                  quality ladder
    logging/
      index.ts                    RUST_LOG-compatible logger
  test/                           vitest suites
  native/                         the N-API addon
    binding.gyp
    src/*.cc, *.h
```

The Rust tree (`apps/agent/src/*.rs`, `apps/agent/vendor/`, `Cargo.toml`,
`Cargo.lock`) is deleted in the final phase of the port.

### 6.2 CI changes

| Workflow | Change |
|---|---|
| `.github/workflows/build-agent.yml` | **Deleted** (R6). Its API-access guard is re-expressed as a Vitest source-scan gate, modelled on `packages/api-client`'s existing `api-access-gate.test.ts` (C13/D13). |
| `.github/workflows/ci-node.yml` | The `--filter='!@ponter/agent'` exclusions are **removed** — the agent is now a Node package and must be linted, type-checked, and tested by the standard gate. The `paths:` filter gains `apps/agent/**`. |
| `.github/workflows/build-desktop.yml` | The Rust toolchain setup, the cargo cache, the "Build Rust agent binary" step, and the "Run agent tests" cargo step are **removed**. In their place: build the N-API addon against Electron's headers and run the agent's vitest suite. The addon build must run **before** `electron-vite build` so the `.node` file is inlined. |
| `.github/workflows/ci-e2e.yml` | The agent-binary dependency is replaced by the in-process agent. |
| `pnpm-workspace.yaml` | `allowBuilds` gains the addon package so pnpm does not skip its install script (D9). |
| `turbo.json` | No change needed once the agent is a normal Node package. |

### 6.3 The native addon build

| Aspect | Decision |
|---|---|
| Binding | `node-addon-api` (the same N-API version `node-pty` uses: `^7.1.0`) |
| Build tool | `node-gyp` via `binding.gyp` |
| Target | Electron's headers, via `electron-rebuild` (or `node-gyp --target=<electron version>`) — required by D7 |
| Encoder | `openh264` 0.9.8, vendored into `apps/agent/native/vendor/openh264/` (91 `.cpp` files). **BSD-2-Clause, Cisco** — the copyright notice and the licence text must ship with the addon and be referenced in the repo's third-party notices. |
| Capture | Windows: `Windows.Graphics.Capture` (WGC) → DXGI Output Duplication → GDI, the existing 3-tier fallback (PR #79) with the `0x80070057` fix. Linux: `org.freedesktop.portal.ScreenCast` over D-Bus, with the PipeWire session-lifetime fix from `apps/agent/vendor/xcap/PATCH.md` carried over. |
| Input | Windows: `SendInput`. Linux: `org.freedesktop.portal.RemoteDesktop` D-Bus calls (the exact method set in B31). |
| Threading | Capture and encode run on the addon's own threads; the TS core receives frames via an N-API async callback or a `SharedArrayBuffer` ring. |

### 6.4 The Electron packaging consequence

`electron-builder.yml` currently ships `files: [out/**/*, package.json]` and
`extraResources: [{from: resources, to: .}]`. Under in-process:

- The addon's `.node` binary must be present in the packaged app. Two options:
  (a) as a per-platform optional dependency installed by `electron-builder
  install-app-deps` (the existing `postinstall` script) and inlined by
  `electron-vite`; or (b) in `extraResources`, loaded by absolute path at
  runtime. **(a) is preferred** — it keeps the loader uniform between dev and
  packaged.
- `AgentSupervisor.resolveBinaryPath()` (`apps/desktop/src/main/agent-supervisor.ts:89-120`)
  is replaced by an addon resolution helper.

---

## 7. The `AgentSupervisor` change

The supervisor's contract is unchanged; its implementation is not.

| Today (sidecar) | After (in-process) |
|---|---|
| `spawnFn(binaryPath, [], {env, stdio})` | `agentRuntime.start(config)` |
| `child.on('exit')` → respawn with backoff | Runtime reports a fatal error → restart the runtime with backoff |
| `child.kill('SIGTERM')` → 5 s → `SIGKILL` | `await agentRuntime.stop()` with a 5 s timeout, then force-stop |
| `captureStderr` (20-line ring) | An in-memory log ring the runtime writes to (the same 20-line depth, the same `getLastError()` accessor) |
| `env` assembly: `AGENT_ID`, `AGENT_SERVER`, `AGENT_CREDENTIAL`, `STUN_SERVER`, `AGENT_ALLOW_INPUT`, `AGENT_FILES_ROOT`, `AGENT_IDENTITY_PATH`, `AGENT_DESKTOP_PROFILE` | The same names become a `RuntimeConfig` object. **The env-var names stay** — they are the desktop↔agent contract and other tooling (guides, CI) references them. |
| `stdio: ['ignore','ignore','pipe']` (ADR-13: no credential in `ps`) | N/A — there is no process list to leak into. The ADR-13 concern is satisfied a fortiori. |

`STARTUP_GRACE_MS = 2000` in `agent-control.ts:22` and the "read the last error
and report it" path (`agent-control.ts:107-114`) are preserved verbatim.

---

## 8. Migration phases

Each phase is a separate PR with the full review chain (implementer →
independent reviewer → QA binding sign-off → BA docs audit → PM cross-check)
and 100% green CI.

| Phase | Deliverable | Gate |
|---|---|---|
| **P0 — Spike** | Prove werift can **send** H.264 to a browser peer. A minimal script: encode a synthetic frame with the native addon (or, initially, a pre-encoded Annex-B fixture), packetize it, push it through werift to a browser, and confirm the browser decodes it. The spike runs the five ordered steps of §3.5.2 against a **VP8-first** synthetic offer **and its two negative cases** (a VP8-first *local* list, a mode-0-first *offer*), and the spike script carries the four measures of §3.5.1 (R-S1/R-S2/R-S3/R-S4) as working code — not as future work. | **Viability gate.** Assertions A1 + A2 + A3 of §9.3 must all hold simultaneously, A4 must be *detected and reported*, **and the negative cases must fail as predicted**. If werift-as-sender cannot carry H.264 to a browser, the whole architecture is revisited before any further work. |
| **P1 — Shared foundations** | Move the stream-profile table to `@ponter/shared`; replace the cross-language parity test with a same-language import (D12); add the TS API-access gate. | D12 closed; the parity guarantee survives |
| **P2 — Native addon** | The N-API addon: capture, encode (openh264), input injection. Unit-tested at the C++ level and through a TS smoke test. | Fault-containment test (§9.2) |
| **P3 — Core: signalling + identity + E2EE** | The WS client, the identity store, the E2EE handshake. Consumes `@ponter/shared`, `@ponter/crypto`. | The wire contract (C1, C5, C6, C7, C13) proven by conformance tests |
| **P4 — Core: terminal + files** | `node-pty` + the shell policy; the files state machine + the sandbox. | B36–B46 proven |
| **P5 — Core: desktop session + packetizer** | The RFC 6184 packetizer (table-driven tests), the desktop session, the static skip, the sustain ladder. | B14–B27 proven; the P0 spike's technique generalised |
| **P6 — Desktop integration** | `AgentSupervisor` → in-process; the packaging of the addon; the CI changes. | The desktop's 308 tests stay green; the packaged-app smoke test passes |
| **P7 — Rust removal + docs** | Delete the Rust tree, `build-agent.yml`, `agent-setup.md`, the CLI string in `RegisterAgentDialog.vue` and its test (`apps/web/src/__tests__/RegisterAgentDialog.test.ts`); update the **eight** living docs listed below; amend ADR-86 and ADR-89. | No **agent**-related `Rust` reference remains in the living docs — see the scope note below |

#### 8.0 P7's living-document blast radius

The rewrite does not touch the historical-record files. Per the repo's
convention (`docs/superpowers/plans/2026-10-13-drop-macos-support.md:18`),
`docs/superpowers/{specs,plans}/*`, `docs/demos/*`, `docs/spikes/*`,
`docs/notes/*` and `docs/security/*` **stay as written** — the rewrite may
*cite* them, never *edit* them. That includes the ADR-89 spec
(`docs/superpowers/specs/2026-10-14-unified-api-access-standard-design.md`),
whose `apps/agent/**` citations will dangle once the tree is gone. That is
acceptable for a historical record; the ADR-89 *amendment* (§5.5) is what
carries the current truth, and it lives in `docs/ARCHITECTURE.md` §8.

Eight **living** documents must change:

| # | File | What changes |
|---|---|---|
| 1 | `docs/ARCHITECTURE.md` | §4.4 "Desktop Agent (Rust)" → "Desktop Agent (Node/TypeScript core + N-API addon)"; the **fabricated `Cargo.toml` sample** at `:469-494` is deleted, not corrected (it lists `webrtc = "0.13"`, `tokio-tungstenite = "0.26"`, `tokio = "1.0"`, `clap = "4.0"`, `futures-util = "0.7"` — the real manifest had `webrtc = "0.21"`, `tokio = "1.53.1"`, `tokio-tungstenite = "0.30"`, and omitted `rtc`, `ring`, `bytes`, `anyhow`, `async-trait` and every `[target.*]`/`[profile.*]` section); plus `:51`, `:131`, `:209`, `:305` (the `build-agent.yml` "6 targets" line — the matrix is 4), `:310`, `:312`, `:827`, `:942`, `:961`, `:1007`, `:1089-1090`, `:1103-1110`, `:1147-1148`, `:1176-1180`. |
| 2 | `docs/ARCHITECTURE.md` §8 trail | A new entry in the repo's existing format, recording the ADR-86 **and** ADR-89 amendments and the retirement of `ponter_agent::api` and `build-agent.yml`. |
| 3 | `README.md` (root) | `:10` Rust badge; `:23`, `:39` the agent-daemon lines; `:66` the tech-stack row (`Rust (edition 2021), tokio, webrtc-rs, portable-pty, serde_json`); `:70`, `:71` the test/lint rows; `:85` the toolchain floor; `:93-94`, `:109`, `:139-140`, `:147`, `:151` the `cargo` commands; `:214` the `agent-setup.md` link. |
| 4 | `docs/README.md` | `:21` the "native Rust daemon" line; `:32`, `:34` the desktop-shell and agent-daemon lines. |
| 5 | `docs/guides/development.md` | `:15`, `:24` the Rust/Cargo prerequisites; `:38-39`, `:51`, `:106`, `:132-133`, `:145-146`, `:155-156`, `:271`, `:311` the `cargo` commands; `:161` the "spawns the native Rust agent binary" sentence. |
| 6 | `docs/guides/handshake-connection-flow.md` | `:3` "the **Rust agent**"; `:14` the answerer row listing `apps/agent/src/{lib,rtc,pty}.rs`; `:56` the `--credential` sentence; `:253` the "Rust Agent (answerer)" label. |
| 7 | `docs/guides/terminal-protocol.md` | `:172` "**Agent side:** the Rust agent now produces and consumes these frames". |
| 8 | `docs/guides/agent-setup.md` | Deleted — the CLI install guide for a CLI that is no longer distributed. |

> **Scope of P7's gate.** The gate is *"no **agent**-related `Rust` reference
> remains in the living docs"*, not *"no `Rust` reference remains"*. The
> unqualified form is **already red before P7 starts**, for reasons that
> have nothing to do with the agent: `docs/guides/self-hosting.md` still
> references `apps/desktop/Cargo.toml` (`:28`, `:44`, `:109`) and
> `apps/desktop/src/core/updater.rs` (`:86`, `:100`, `:102-103`), both of
> which PR #135 deleted when the desktop migrated to Electron. That is
> **pre-existing drift** and it belongs in its own docs cycle, not in this
> rewrite's scope. A separate issue must file it.
>
> The same pre-existing drift explains why `README.md:37` and
> `docs/README.md:32` already describe a "native Rust egui/eframe desktop
> shell" that stopped existing at PR #135. Those lines are corrected in P7
> because P7 rewrites the surrounding text anyway — but they are not
> rewrite-caused, and the §8 trail should not attribute them to the rewrite.

### 8.1 Test-strategy requirements (TEST-INTEGRITY)

The Rust agent carries **362 anchored `#[test]`/`#[tokio::test]` attributes**
across 19 files. (An earlier draft of this section said 359. That number was a
grep artifact, not a measurement: an un-anchored `#\[(tokio::)?test\]` pattern
counted one prose line as a test — `pty.rs:578`, `// … and a #[tokio::test]
body is one.` — and missed all four
`#[tokio::test(flavor = "multi_thread", worker_threads = 2)]` in
`desktop.rs:3253,3278,3303,3332`. 358 + 4 = 362. Both halves were re-derived
from the tree and confirmed against `cargo`.)

**The baseline has three numbers, and a delta must name which one it means:**

| Number | Value | What it counts |
|---|---|---|
| Anchored attributes | **362** | Every `#[test]`/`#[tokio::test]` in `apps/agent/src`. **This is the baseline TEST-INTEGRITY is measured against**, because it does not vary by target. |
| Compilable on Linux | **361** | `cargo test --lib -- --list` = 355, `cargo test --bin ponter-agent -- --list` = 6. The one attribute that does not compile on Linux is `main.rs:384` `windows_prefers_powershell_7_over_legacy_powershell`. |
| Runnable on Linux | **357** | 351 lib after the four `#[ignore]`d tests, plus 6 bin. |

**A delta comparison is only meaningful on the same target.** Many tests are
`cfg`-gated, so a runnable count depends on what was built — `#[cfg(unix)]` ×4
in `shell_policy.rs`, `#[cfg(not(target_env = "musl"))]` ×5 across `rtc.rs` (4)
and `lib.rs` (1), and `#[cfg(all(target_os = "linux", not(target_env =
"musl")))]` ×2 in `portal/remote_desktop.rs`. Comparing a Linux GNU runnable
count against a Windows one produces a phantom "lost test". Use the anchored
attribute count (362) for accounting, and a like-for-like target for any
behavioural claim.

The port must carry an equivalent suite, not a smaller one. Each Rust test that
is retired must be accounted for by a TS test or by an explicit R-entry
(§4.7) — **never by deletion or skip**. The plan must publish a
before→after count for `it()`/`expect()` per suite, with a rationale, per the
standing TEST-INTEGRITY rule.

---

## 9. Verification and gates

### 9.1 The wire-contract conformance gate

The port is not done until a test suite proves the new agent is
indistinguishable from the old one at the wire boundary:

| Check | Method |
|---|---|
| Envelope shape | Golden JSON fixtures, byte-compared |
| Identity proof bytes | The same input to `canonicalProofMessage` produces the same bytes as the Rust `canonical_proof_message` (a recorded fixture set) |
| E2EE frames | The existing `packages/crypto/test/vectors/e2ee-vectors.json` |
| H.264 RTP packets | Table-driven expected packets for single-NAL, STAP-A, FU-A boundary sizes, and the MTU split |
| Files binary frames | Byte-exact fixtures for the 25-byte header layout |
| Terminal output | Base64 of known PTY bytes |
| End-to-end | The existing `packages/webrtc-core/test/e2e/*` suites (terminal, terminal-e2ee, files, files-advanced, desktop, identity, session-hardening) re-pointed at the new agent, staying green |

### 9.2 The addon fault-containment gate

A native fault must not take down the app. The addon must:

- Check every return value from every OS and codec call.
- Never let a C++ exception cross the FFI boundary.
- Bounds-check every buffer before it is handed to JS.
- Return errors as JS exceptions with a stable code, never as a crash.

The gate: a test that deliberately corrupts the addon's input (a frame with an
invalid stride, a zero-size buffer, a null handle) and asserts the JS side
receives a typed error and the process survives.

### 9.3 The werift-as-sender gate (P0)

D4 is the reason P0 exists. The current test suite proves werift as a
**receiver**; the rewrite makes it a **sender**. The gate is a browser-side
E2E that asserts the browser receives and decodes a moving H.264 stream from
the werift peer — not merely that the connection is healthy, but that pixels
arrive.

The gate is the five-step spike of §3.5.2, and it has three assertions, each
of which must hold **simultaneously**:

| Assertion | Fails when |
|---|---|
| **A1 — the negotiated sender codec is H.264** | The agent negotiated VP8 (D4a/D4b). R-S1's H.264-only list prevents it; R-S2 turns the failure into a loud error instead of a black stream. |
| **A2 — the payload type on the wire is the negotiated H.264 PT, and the negotiated `packetization-mode` is 1** | werift's `sender.codec` is not the H.264 entry, so `sendRtp` overwrites the stamped PT (D4b) — or the browser's `fmtp` negotiated mode 0 while the packetizer emits mode 1 (D4d). This is R-S2 + R-S3. |
| **A3 — the browser decodes visible frames** | The bytes are not decodable H.264, the packetization mode is wrong, the `profile-level-id` does not match what the encoder produced, or a keyframe never arrived. This is the only assertion that catches A1 and A2's failures end-to-end. |
| **A4 — the encoder's `profile_idc`/`level_idc` are compatible with the negotiated `profile-level-id`** | The addon's SPS says `42c0XX` while the answer's `profile-level-id` is the browser's (`42e01f` from werift's helper, `42001f` from Chrome — measured). A mismatch is not necessarily fatal, but it must be **detected and logged**, not assumed away — the repository has never decoded the pixels, so its harmlessness is unproven (§3.3). | RK1d. The addon exposes the encoder's real `profile_idc` and `level_idc`; the agent compares them against the negotiated `fmtp` and logs loudly on mismatch. This is a **detection** assertion, not a pass/fail one — failing the whole gate on a mismatch would reject a stream the product ships today. |

**A3 alone is not sufficient and A1/A2 alone are not sufficient.** A1 + A2
can both pass while the browser still shows nothing (the encoder's profile
does not match the advertised `profile-level-id`; a missing IDR; a decoder
that needs a keyframe request answered). A3 can pass by accident on a
fixture that happens to decode. The gate requires all three.

The spike's synthetic offer must list **VP8 first, then H.264** — the Chrome
ordering. An offer that lists only H.264 would not exercise D4b at all, and
a green run against such an offer would prove nothing about the real browser
peer. The spike must also run the **negative case** (a VP8-first *local*
codec list) and the **mode-0-first offer**, both expected to fail without
R-S1/R-S3 — see §3.5.2.

**The gate also covers RTCP.** A sender that cannot answer a PLI is a
stream that never recovers from a dropped IDR. The P0 harness must observe
a PLI arriving at the sender and the encoder responding with a keyframe.

### 9.4 The behavioural-parity gate

Every row of §4 — **all 62 of them, B1 through B62** — plus the **six**
retirements of §4.7 (R1 through R6) — must be covered by at
least one test in the ported suite. The plan carries a coverage matrix
mapping each B-number to its test.

Three rows carry extra weight because they are the ones a partial port
silently drops: **B56** (the cursor frame), **B61** (the `desktop-stats`
telemetry) and **B62** (the desktop control state machine) are *side
channels* — they travel beside the video, not inside it, so a port that only
wires up the video path loses them without a single failing test. The
coverage matrix must mark them explicitly, and the gate must assert each
one's presence on the wire.

---

## 10. Risks

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| RK1 | werift cannot send H.264 to a browser (D4) | Medium | **Fatal** — the architecture collapses | P0 spike is a gate, before any other work. If it fails, fall back to writing the RTP/DTLS/SRTP path by hand or to a different WebRTC stack — decided at P0, not after P5. The four fallbacks and their costs are enumerated in §3.5.2; P0 produces the evidence that selects among them |
| RK1a | werift stamps the wrong payload type on H.264 packets (D4b) | **Medium** — it is werift's behaviour *whenever the local codec list also offers VP8*. Measured: an H.264-only local list selects H.264 pt102 (§3.5.3) | **Fatal** — black video on a healthy connection; identical to the C4 bug the Rust agent already had | R-S1 (H.264-only local list) prevents it; R-S2 fails loudly at negotiation. The P0 gate asserts A1 + A2 + A3 together (§9.3) and runs the **negative case** (a VP8-first local list, expected to fail), so this cannot pass silently |
| RK1b | The negotiated `fmtp` is the browser's, and werift never checks it (D4d) — a browser whose first H.264 entry is `packetization-mode=0` makes the agent negotiate mode 0 while the packetizer emits mode 1 | **Medium** — depends on the browser's codec ordering; Chrome's default puts mode 1 first, but this is not guaranteed | **Fatal** — broken frames; the connection is healthy and the PT is right, so no other check catches it | R-S3 re-points `sender.codec` at the browser's `packetization-mode=1` entry (measured to work, §3.5.3) and fails loudly when no such entry exists. The answer's `fmtp` for the chosen PT stays byte-identical to the offer's. The residual risk is the **profile-level-id** half, which the agent cannot edit — see RK1d |
| RK1c | A transceiver added after `setRemoteDescription` yields an inactive m-line and an undefined codec (D4e) | **Low** — the Rust agent already carries ADR-15 and the port copies the ordering | High — an inactive m-line looks like a healthy idle stream; D4c turns it into a silent no-op | R-S4 preserves the ordering, and R-S2's loud assertion catches a missing codec |
| RK1d | The answer's `profile-level-id` is the **browser's**, and the agent cannot edit it through a supported API (D4d, §3.3) — so the answer may promise a profile or level the encoder does not produce | **Medium** — Chrome's `profile-level-id` is `42001f` (measured, `docs/spikes/2026-10-11-hardware-encode-h265.md:279`), while the agent's own SPS is `42c0XX` with a level that varies by profile (4.0 / 3.1 / 4.2 / 3.2 — §3.3) | High — the mismatch is **unproven to be harmless**: the Rust agent shipped with it, but no test in the repository decodes the pixels, so the tolerance was never verified (§3.3). A stricter peer would refuse the stream | P0's A3 assertion (the browser decodes pixels) is the only thing that catches this. The addon must expose the encoder's real `profile_idc`/`level_idc`, and the agent must **log the mismatch loudly** rather than assume tolerance. If a strict peer refuses, the mitigation is to mutate the negotiated codec's `parameters` in place (measured to work, §3.5.3) — a documented fallback, not the default |
| RK2 | The N-API addon's ABI mismatch with Electron's Node (D7) | Medium | High — the addon will not load | Build against Electron headers from day one; add a packaged-app boot smoke test that asserts the addon loads |
| RK3 | A native fault takes down the desktop app (§5.4) | Medium | High | Fault-containment gate (§9.2); defensive C++ |
| RK4 | 60 FPS in the Electron main process starves the UI | Low | High | Encode on the addon's own thread; the TS core's per-frame work is small; measure with the existing ADR-47 frame-timing ring |
| RK5 | The port silently drops a Rust behaviour | Medium | High | The §4 inventory with B-numbers, each mapped to a test in the plan's coverage matrix |
| RK6 | The addon build breaks CI (no C++ toolchain on the runner) | Medium | Medium | The Linux runner already installs a C/C++ toolchain for the desktop build; the Windows runner needs the MSVC build tools, which `windows-latest` provides |
| RK7 | `packages/webrtc-core` changes ripple into the web client | Low | High | The `WeriftAdapter` change is additive (`addTrack`); the browser adapter gains the same method. The web client is not a werift consumer |
| RK8 | The scope is too large for one cycle | High | Medium | The phase decomposition (§8) makes each phase independently reviewable and mergeable; the P0 gate keeps the risk front-loaded |

---

## 11. Open items for the owner

These are the decisions the spec made on the owner's behalf, listed so they
can be overturned. The **Made by** column says who actually owns the call:
`Owner` for a decision the owner has made and that the spec merely records,
`PM` for an engineering judgement the spec made in the owner's name.

| # | Decision made | Made by | Alternative |
|---|---|---|---|
| O1 | In-process, not sidecar (§5) | **Owner** — it follows from owner decision (c) ("N-API addon folded into Node"); listed for confirmation, not as an open question | A Node sidecar (§5.3) |
| O2 | The RFC 6184 packetizer lives in TypeScript, not the addon (§3.3) | **PM** | Packetize in the addon |
| O3 | `openh264` is vendored into the addon (BSD-2-Clause) (§6.3) | **PM** — near-forced: ffmpeg is GPL-3.0 | A different encoder, or ffmpeg (GPL-3.0 — not acceptable) |
| O4 | The environment-variable contract (`AGENT_ID`, `AGENT_SERVER`, …) is kept even though it is now an in-process config (§7) | **PM** — and it follows from owner decision (e) | Renaming the variables |
| O5 | The Rust tree is deleted in P7, not incrementally | **PM** — a sequencing call; owner decision (d) fixes the *fact* of deletion, not its phase | Keeping a Rust build alongside during the port |
| O6 | The addon is packaged as a per-platform dependency via `electron-builder install-app-deps` (§6.4) | **PM** | `extraResources` with an absolute-path loader |
| O7 | **A `profile-level-id` that does not match the encoder is tolerated and logged, not fatal** (§3.3). The Rust agent shipped the same mismatch — advertising `42001f` while emitting `42c0XX` — and the product worked, so changing it to a hard failure would be a behaviour regression on a path that works today. | **Owner** — see the note below | Refuse the session on a mismatch (strict, but breaks today's working agent) / mutate the negotiated `fmtp` in place to match the encoder (measured to work, but edits a value the browser sent) |

> **O7 is the one decision that needs an explicit yes or no before P0
> starts.** It is a product-behaviour trade, and the spec's own evidence
> cuts *against* the default it selected: the repository has never decoded
> the pixels (§3.3), so the "Chrome tolerates the mismatch" claim rests on
> the product having shipped, not on any test. "Tolerate" is also the
> quietest of the three options and therefore the one most able to hide a
> real problem. "Refuse" is safe but is **P0-level** if Chrome offers
> `42001f` while openh264 emits `42c0XX` — the agent would refuse every
> browser session. "Mutate" is safe but makes the answer's `fmtp` differ
> from the offer's, which RFC 3264 does not ask for. The owner should pick
> with the unverified status in front of them, not with "the Rust agent
> shipped it" as the only input.

### 11.1 Open technical questions the plan must answer

These are **not** owner decisions — they are engineering questions a competent
implementer would have to answer before writing code, and the spec does not
pretend to answer them. Each is listed with what the plan must settle. They
are the plan's work, not the spec's.

| # | Question | What the plan must settle |
|---|---|---|
| Q1 | **The werift sender API surface.** What exactly does `WeriftAdapter.addTrack` return, and how does the core reach `MediaStreamTrack.writeRtp`? | The concrete method set on `RTCRtpSenderLike` (§3.5) and the adapter's internal wiring. |
| Q2 | **The DTLS/SRTP boundary.** Does werift handle DTLS and SRTP internally for a sender, so the addon only produces RTP packets? | Whether the fallback in §3.5.2(c) — writing directly to the DTLS transport — is even reachable, and what API exposes it. (The same question governs whether §3.5.2(c) is a real option at all, so the answer should be written so the plan can drop the fallback if it is unreachable.) |
| Q3 | **The openh264 linkage and output format.** How is openh264 linked into the addon (vendored source, `cc`, a system package)? Does the raw C API emit **Annex-B** (with start codes) or AVCC? | The `binding.gyp` linkage, and the confirmation that the bytes reaching the TS packetizer are Annex-B — the Rust agent's `bitstream.to_vec()` is Annex-B, and the packetizer is specified against Annex-B. |
| Q4 | **The capture source selection on the addon side.** How does the addon enumerate monitors and windows, and how does `AGENT_DESKTOP_DEFAULT_SOURCE` map onto them? | The native API for `SourceKind` / `DesktopSourceInfo` (B58) and the resolution of the default source (B59). |
| Q5 | **The `capture_image` fallback detection.** When is the polling fallback used instead of the hardware recorder, and what happens on a headless Linux container with neither PipeWire nor X11? | The detection rule and the failure mode, for B60. |
| Q6 | **The `desktop-stats` wire shape.** What are the exact fields of `DesktopStats`, and which channel carries the frame? | The full field list, for B61. |
| Q7 | **The cursor frame's rate and encoding.** How often is the cursor polled, and what encodes the shape PNG and caps its size? | The poll cadence, the PNG encoder dependency, and the cap, for B56. |
| Q8 | **The Electron packaging mechanics.** Is the `.node` binary built at install time (`postinstall` / `install-app-deps`) or copied into `resources/` at build time? Does `electron-builder` need `extraFiles`? | The exact build and packaging steps, and where the `.node` file lives in the packaged app, for §6.4. |
| Q9 | **What the Rust removal actually deletes.** Does `apps/agent/vendor/` contain anything besides `xcap`? Are the shared E2EE vectors (`packages/crypto/test/vectors/e2ee-vectors.json`) extracted before the tree is removed? | The P7 deletion list, so nothing needed by the TS suite is deleted with it. |
| Q10 | **Where the `profile-level-id` mismatch check lives and what it logs.** The *policy* — tolerate, mutate, or refuse — is **O7** and belongs to the owner; it is not re-opened here. What the plan must settle is the implementation: at which point in the session setup is the encoder's reported `profile_idc`/`level_idc` compared against the negotiated `fmtp`, what is the log line's shape, and what is its severity (warn vs error)? | The check's location, the comparison inputs (the addon's reported profile from Q11 vs `sender.codec.parameters`), and the log format. |
| Q11 | **The addon's profile/level reporting surface.** How does the addon expose the encoder's chosen `profile_idc` and `level_idc` — per-frame, per-encoder, or at construction? Does openh264's C API expose them without parsing the SPS? | The N-API shape for A4's detection, so the agent can compare the encoder's output against the negotiated `fmtp` without re-parsing Annex-B in TypeScript. |

---

## 12. Appendix — the Rust source inventory

`apps/agent/src/` — 20,858 lines across 20 files, plus `apps/agent/vendor/xcap`
(7,528 lines across 45 `.rs` files — 50 files including `Cargo.toml` and
`PATCH.md`) and 362 anchored test attributes (355 lib + 6 bin compilable on
Linux; see §8.1 for the three-number baseline).

| File | Lines | Primary port target |
|---|---|---|
| `lib.rs` | 3,879 | `runtime.ts` + `session/` |
| `desktop.rs` | 4,104 | `desktop/` + the native encoder |
| `files.rs` | 3,856 | `files/` |
| `rtc.rs` | 1,228 | `session/peer.ts` |
| `desktop/warm_capture.rs` | 1,219 | The native capture path |
| `pty.rs` | 690 | `terminal/` |
| `input.rs` | 916 | `input/` + the native injector |
| `signal.rs` | 768 | `signalling/` |
| `cursor.rs` | 735 | `input/` |
| `logging.rs` | 388 | `logging/` |
| `e2ee.rs` | 438 | `e2ee/` (mostly `@ponter/crypto`) |
| `main.rs` | 449 | `config.ts` (the CLI → env conversion) |
| `api.rs` | 322 | **Retired** (R3) — `@ponter/api-client` owns it |
| `shell_policy.rs` | 263 | `terminal/shell-policy.ts` |
| `identity.rs` | 225 | `identity/store.ts` |
| `portal/injector.rs` | 298 | The native addon (Linux) |
| `portal/evdev_map.rs` | 235 | The native addon (Linux) |
| `portal/remote_desktop.rs` | 595 | The native addon (Linux) |
| `portal/token_store.rs` | 234 | The native addon (Linux) |
| `portal.rs` | 16 | Module glue |
