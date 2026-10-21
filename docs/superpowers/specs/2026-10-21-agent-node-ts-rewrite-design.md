# Node/TypeScript Agent Rewrite — Design Spec

**Date:** 2026-10-21
**Status:** Draft for owner review
**Branch:** `feat/agent-node-ts-rewrite` (off `main` @ `1515c36`)
**ADRs proposed:** ADR-93 (Node/TypeScript agent runtime), ADR-94 (in-process N-API native addon), ADR-95 (desktop-only distribution model)

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
| C2 | The agent must answer WebRTC offers with H.264 at PT negotiated by SDP, `packetization-mode=1`, `profile-level-id=42001f` | `apps/agent/src/rtc.rs:202-209` |
| C3 | The agent's video payload is **Annex-B** H.264 NAL units; the RTP packetization (single-NAL / STAP-A / FU-A) happens above it | `apps/agent/src/desktop.rs:1852-1871`; `webrtc-0.21.0/src/media_stream/track_local/static_sample.rs:164` |
| C4 | The PT must be the **H.264** one, never `codecs.first()` — Chrome offers VP8 (PT 96) before H.264 (PT 102) and the wrong PT renders a black frame | `apps/agent/src/rtc.rs:277-303` (the bug is documented in-place) |
| C5 | The WS2 identity proof is signed over the exact bytes of `canonicalProofMessage` | `apps/agent/src/identity.rs:78-90` ≡ `packages/shared/src/types/identity-proof.ts:22-29` |
| C6 | The WS1 E2EE frame is `[12-byte IV][ct ‖ 16-byte tag]`, ECDH P-256 → HKDF-SHA256 → AES-256-GCM, empty AAD, `info = "ponter-ws1-terminal-v1"`, `salt = session_id` | `apps/agent/src/e2ee.rs:14-17,42-44,149-173,220`; `packages/crypto/src/encrypt.ts:104-121` |
| C7 | The agent identity is an Ed25519 **PKCS#8** file, mode `0o600`, public key base64 | `apps/agent/src/identity.rs:21-76` |
| C8 | `AGENT_ALLOW_INPUT` is an **agent-local** opt-in; a remote peer cannot enable input injection | `apps/agent/src/main.rs:83-93`; `apps/agent/src/lib.rs` session setup |
| C9 | The shell allowlist is `/bin/sh` floor ∪ `/etc/shells`, canonicalized, absolute-path-only | `apps/agent/src/shell_policy.rs:19-20,47-99` |
| C10 | The files binary frame is `[1B type][16B transfer_id][8B BE chunk_index][payload]`, 32 KiB chunks | `apps/agent/src/files.rs:75-104` |
| C11 | Files path containment is proven by `canonicalize` + component-wise prefix check, not by string prefix | `apps/agent/src/files.rs:760-800` |
| C12 | The terminal output is standard base64 of raw PTY bytes, 16 KiB chunks | `apps/agent/src/pty.rs:22,123-143` |
| C13 | The reconnect ladder is 200 ms × 1.5 capped at 2000 ms; close codes 4401/4409 are terminal | `apps/agent/src/signal.rs:104-121,297-301` |

### 2.2 Constraints discovered during the feasibility survey

| ID | Constraint | Evidence | Impact |
|---|---|---|---|
| D1 | **werift 0.24.4 has no RTP payloader of any kind.** `grep -rn 'class.*Payloader' lib/` → 0 matches. It ships `H264RtpPayload` (a *de*payloader) only. | `node_modules/.pnpm/werift@0.24.4_…/lib/rtp/src/codec/h264.js` | The RFC 6184 packetization (Annex-B → NAL(A)/FU-A) must be written by us, or moved into the native addon. **This is the single largest piece of new code in the port.** |
| D2 | werift's send path is `MediaStreamTrack.writeRtp(rtp: RtpPacket \| Buffer)` and `RTPSender.sendRtp(...)`; `sendRtp` rewrites `ssrc`, `payloadType`, `timestamp`, `sequenceNumber` before `dtlsTransport.sendRtp`. | `werift/lib/webrtc/src/media/track.d.ts:28`, `rtpSender.d.ts:100`, `rtpSender.js:538-549` | We can hand werift a raw `Buffer` of a complete RTP packet, or an `RtpPacket` with a header we fill. Both work. |
| D3 | werift offers `pc.addTrack(track)` and `pc.getSenders()`. | `werift/lib/webrtc/src/peerConnection.d.ts:194,110` | The TS agent can be the WebRTC **sender** through werift directly. |
| D4 | **The existing E2E suite proves werift-as-RECEIVER only.** `desktop.e2e.test.ts:114-137` has werift as the recvonly offerer and the Rust agent as the sender. | `packages/webrtc-core/test/e2e/desktop.e2e.test.ts:114-137` | The rewrite inverts the role: werift becomes the **sender**. **No test in the repository currently proves werift can send H.264 to a browser.** This is the highest-risk unknown in the port. |
| **D4a** | **werift's default peer config has NO H.264.** `generateDefaultPeerConfig()` sets `video: [useVP8()]`. H.264 exists only as an opt-in codec helper (`useH264()` → `video/h264`, clock 90000, `packetization-mode=1`, `profile-level-id=42e01f`) and must be passed explicitly as `codecs: { video: [useH264()] }`. | `werift/lib/webrtc/src/peerConnection.js:1082`; `werift/lib/webrtc/src/media/codec.js:6-12` | The new agent **must** construct its `RTCPeerConnection` with an explicit H.264 codec list. Without it, the answerer negotiates no H.264 at all and the desktop offer is refused. The existing e2e harness already does this (`desktop.e2e.test.ts:123` passes `codecs: { video: [useH264()] }`) — the port must carry that forward. |
| **D4b** | **werift picks the sender payload type as `codecs[0]`, and `codecs` is the OFFER's ordering — but only among the codecs the local list also offers.** `RTPSender.prepareSend` does `this.codec = params.codecs[0]`; `RTPSender.sendRtp` then **overwrites** `header.payloadType = this.codec.payloadType`; `MediaStreamTrack.writeRtp` does the same with `this.codec?.payloadType`. `transceiver.codecs` is assigned from the *remote* (offer) codec list, filtered against the local list — so it keeps the browser's ordering. | `werift/lib/webrtc/src/media/rtpSender.js:408`, `:545`; `werift/lib/webrtc/src/media/track.js:132-134`; `werift/lib/webrtc/src/transceiverManager.js:244` | **This is C4's bug reproduced inside werift — but only conditionally.** Measured against a real Chrome SDP offer (VP8 pt96, H.264 pt102, rtx pt103): with the local list `[useH264()]` the negotiated list is `H264/pt102` alone and `sender.codec` is **H.264 pt102** — correct. With the local list `[useVP8(), useH264()]` the negotiated list keeps the browser's order and `sender.codec` is **VP8 pt96** — the black-video bug. **R-S1's H.264-only local list is what closes D4b**; the port must not "helpfully" add VP8 to the agent's codec list. The residual risk after R-S1 is not the payload type but the codec *parameters* (D4d). |
| **D4c** | **`RTPSender.sendRtp` silently no-ops when the codec is unset** (`if (this.dtlsTransport.state !== "connected" \|\| !this.codec) { return; }`). | `werift/lib/webrtc/src/media/rtpSender.js:539` | A misconfigured sender drops every frame with **no error** — the connection stays healthy and the browser shows black. The port needs an explicit assertion that the negotiated sender codec is H.264, and a loud failure otherwise, not a silent drop. |
| **D4d** | **werift matches codecs by mime type ONLY — it never inspects `parameters`.** `findCodecByMimeType` compares `mimeType.toLowerCase()` and ignores `fmtp` entirely. The negotiated codec's `parameters` are the **browser's**, echoed verbatim into the answer; werift's local `useH264()` `parameters` string is never consulted. | `werift/lib/webrtc/src/peerConnection.js:1074` (`findCodecByMimeType`); `werift/lib/webrtc/src/transceiverManager.js:244-259`; `werift/lib/webrtc/src/media/codec.js:6-12` | **This is the residual, real failure mode after D4b is closed.** A Chrome offer carries two H.264 entries — pt102 `packetization-mode=1` and pt104 `packetization-mode=0` — and a browser whose *first* H.264 entry is mode 0 makes werift negotiate `packetization-mode=0`. The TS packetizer implements RFC 6184 **mode 1** (single-NAL / STAP-A / FU-A); a mode-0 PT carrying mode-1 packets is decoded by the browser's mode-0 depacketizer as one NAL per packet → broken frames. Symmetrically, the negotiated `profile-level-id` is the browser's, so the answer may promise a profile the encoder does not produce. **The agent must assert the negotiated `packetization-mode=1` and the profile it can encode, and fail loudly otherwise.** |
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
and FU-A — matching the Rust agent's advertised fmtp
(`level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f`,
`apps/agent/src/rtc.rs:208`). This is not a free choice: the negotiated
`packetization-mode` is whatever the **browser** offered (D4d), and werift
never checks it. Mode 0 is not "mode 1 without the aggregation" — it is a
different framing contract, and a mode-1 packet stream sent under a mode-0
payload type is depacketized as one NAL per packet. R-S3 turns this from an
implicit assumption into an asserted precondition.

**A note on the encoder's profile.** The `profile-level-id` the answer
advertises is the browser's, and the browser's expectation is that the
encoder produces that profile. openh264's default output profile is
**Constrained Baseline** (`42e01f`) — which is what the Rust agent advertised.
The port must configure the addon to emit the same profile it advertises, and
P0 must verify the two agree. A `profile-level-id` of `42e01f` means
"Constrained Baseline, level 3.1", so the `e0` byte is not a typo in the
Rust source and must not be "corrected" to `42e01f` in the TS port.

### 3.4 Reuse map

| Existing package | What the agent takes | Change required |
|---|---|---|
| `@ponter/shared` | `SignalMessage`, `IceServerEntry`, `DataChannelMessage`, `TerminalDataMessage`, `FilesErrorCode`, `canonicalProofMessage`, `normalizeFingerprint`, `parseSdpFingerprint`, `AgentErrorCode`, `BrowserErrorCode` | None — the Rust agent's types are hand-copies of these. The port deletes the copies. |
| `@ponter/crypto` | `EncryptionManager`, `deriveSharedSecret`, `hkdfSha256`, `importAesGcmKey`, `aesGcmEncrypt/Decrypt` | None for the E2EE session key. The IndexedDB-backed `savePrivateKey`/`loadPrivateKey` are **not** used; the agent keeps its own Ed25519 PKCS#8 file (C7). |
| `@ponter/webrtc-core` | `PeerConnection`, `RTCPeerConnectionLike`, `DataChannelManager`, `toWsUrl`, `stripTrailingSlashes`, `ReconnectBackoff` | `WeriftAdapter` must **gain** sender support. Today it has **no `addTrack` at all** — only `addTransceiver` and `onTrack`, both receive-only (`packages/webrtc-core/src/adapters/werift.ts:201`, `:208`; `packages/webrtc-core/src/types.ts:20-53`). The port adds `addTrack` to **both** `RTCPeerConnectionLike` and `WeriftAdapter`, plus a way to reach werift's `MediaStreamTrack.writeRtp` (D3, D4). |
| `@ponter/api-client` | `createApiClient` | The agent has no HTTP surface today (its `api.rs` HTTP layer is dead code — the wire report §5.4). Not used at first; available if a future agent API is needed. |
| `@ponter/shared` (crypto side) | `e2ee-vectors.json` (`packages/crypto/test/vectors/`) | The agent's E2EE tests consume these vectors — the Rust agent already does (`apps/agent/src/e2ee.rs:269-301`). The port keeps that. |

### 3.5 The `PeerConnection` inversion

The Rust agent is the WebRTC **answerer** and the **sender**. The TS agent
must be both, and `packages/webrtc-core`'s `PeerConnection` already handles
the `case 'offer'` → `createAnswer` path (`packages/webrtc-core/src/connection.ts:312-331`).

The gap is that `WeriftAdapter` currently exposes **no way at all to send
media**. It has no `addTrack`; werift's own `RTCPeerConnection` does
(`peerConnection.d.ts:193`), but the adapter never forwards it. The port
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
| **R-S1** | **Explicit H.264-only codec list.** The agent's `RTCPeerConnection` is constructed with `codecs: { video: [useH264()] }` (plus the audio codecs it will not use) — and **nothing else**. | D4a — the default list is VP8-only, so without this the agent negotiates no H.264 and refuses the desktop offer. **D4b — the H.264-only list is also what prevents werift from selecting the browser's first codec.** Measured: with `[useH264()]` the negotiated sender is H.264 pt102; with `[useVP8(), useH264()]` it is VP8 pt96 — the black-video bug. | The agent's peer factory. The e2e harness already does this at `desktop.e2e.test.ts:123`; the port carries it forward **and must not add VP8 back for "browser compatibility"**. |
| **R-S2** | **The negotiated codec is read back, never assumed, and asserted.** After `setRemoteDescription` + `createAnswer`, the agent reads the transceiver's negotiated codec list and **fails loudly** unless the sender's codec is H.264. | D4b — werift picks `codecs[0]` of the *negotiated* list, so the local list is the only lever. D4c — a codec-less sender drops frames silently. D4e — a transceiver added too late leaves `sender.codec` undefined. | The agent's session setup, mirroring the Rust `select_h264_payload_type` (`apps/agent/src/rtc.rs:293-303`) but reading the **negotiated** list, not the offer list, and **failing** rather than returning `None`. |
| **R-S3** | **The negotiated `packetization-mode` is asserted to be 1, and the profile-level-id is checked against what the encoder produces.** | **D4d** — werift matches codecs by mime type only and never inspects `fmtp`, so the negotiated `parameters` are the **browser's**, echoed verbatim. A Chrome offer's *first* H.264 entry can be `packetization-mode=0`; werift would then negotiate mode 0, and mode-1 packets (single-NAL / STAP-A / FU-A) sent under a mode-0 PT are depacketized as one NAL per packet → broken frames. | The agent's session setup, next to the R-S2 assertion. The Rust agent pinned `packetization-mode=1` in its `sdp_fmtp_line` (`rtc.rs:208`) for the same reason. |
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
   changes the design.
4. Packetize the fixture with the new TS packetizer, push it through the
   sender, and capture what the remote peer receives. **Assert the payload
   type on the wire is the negotiated H.264 PT** — not "a packet arrived".
5. In a browser, assert the frame **decodes** — via `HTMLVideoElement` +
   `requestVideoFrameCallback`, or by decoding the received RTP with the
   browser's own H.264 decoder and comparing against the fixture.

Step 5 is the gate. Steps 1–4 passing is not sufficient: they can all pass
while every packet carries the wrong payload type, or while the negotiated
`packetization-mode` disagrees with the packetizer's output.

**The spike must also run the negative case.** Step 3 is run twice: once
with the R-S1 list (`[useH264()]`) and once with a deliberately VP8-first
local list (`[useVP8(), useH264()]`). The second run is expected to select
VP8 pt96 and is the **regression test for D4b** — it proves the failure mode
is real and that R-S1 is what prevents it. A spike that only exercises the
happy path cannot tell "R-S1 fixed it" from "the bug never existed".

If step 3 or step 5 shows no acceptable configuration, P0 fails and the
architecture is revisited **before** any other work. The documented
fallbacks, in preference order:

| Fallback | Cost |
|---|---|
| **(a)** Configure the peer so the negotiated sender codec is H.264 | Low — a config change. **Measured to work** with the H.264-only local list; the residual problem after this is the `fmtp` (D4d), not the payload type. |
| **(b)** Set `sender.codec` explicitly after negotiation | Medium — reaches into werift's internals; a version bump could break it. Also does not fix D4d: `parameters` still comes from the browser. |
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
| Does the transceiver order matter? | **Yes.** Added after `setRemoteDescription` → a second transceiver, `a=inactive` m-line, `sender.codec === undefined`. Added before → `a=sendonly`, `sender.codec = H264/pt102`. | Both orders, same offer. |
| Does `MediaStreamTrack.writeRtp` overwrite the payload type? | **Yes** — `packet.header.payloadType = this.codec?.payloadType ?? …`. And `RTPSender.sendRtp` overwrites SSRC, PT, timestamp and sequence number. | Source read at `track.js:132-134`, `rtpSender.js:539-552`. |

**What P0 must still prove** (none of it is settled by the measurements
above):

1. That a browser **decodes** the resulting stream (A3) — the measurements
   are about SDP and payload types, not pixels.
2. That the **addon's** openh264 output matches the negotiated
   `profile-level-id` and mode-1 framing (D4d). The negotiation half is
   understood; the encoder half is not.
3. That the **DTLS/SRTP transport** carries the packets — the measurements
   never opened a connection.
4. That **RTCP feedback** (PLI, REMB) reaches the addon, so a keyframe
   request produces a keyframe. A sender that cannot be asked for a
   keyframe is a stream that never recovers from a dropped IDR.

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
| B7 | Server pushes `ice-servers` then `identity-challenge`, in that order | server `ws.ts:172-186` | The agent's WS client |
| B8 | Answer proof: sign the canonical message over role/sessionId/sdpSha256/fingerprint | `rtc.rs:829-842`; `identity.rs:78-90` | `canonicalProofMessage` from `@ponter/shared` |
| B9 | DTLS fingerprint normalised to uppercase colon-hex, fail-closed on malformed | `identity.rs:128-138` | `normalizeFingerprint` (already shared) |
| B10 | ICE: mDNS disabled, bind `0.0.0.0:0` and `127.0.0.1:0`, TURN/TCP filtered out, server ICE wins over `--stun` | `rtc.rs:380-382,403-404,444,493-511` | The agent's `RTCPeerConnection` config |
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
| B22 | Static-frame skip: 4-lane FNV-1a hash, 1 s keepalive cap, reset on bitrate/source/profile change | `desktop.rs:1287-1300` (`frame_signature`), `:1316-1350` (`StaticFrameSkip`, `should_skip`) | The core |
| B23 | Sustain ladder: monotonic degradation by pixels/sec, `QualityDowngraded` status | `desktop.rs:1284` (`SUSTAIN_FRAMES_BEFORE_FALLBACK`), `:1379-1390` (`downgrade_for`), `:1395-1460` (`SustainMonitor`) | The core |
| B24 | Frame timing ring: median capture latency + median encode ms | `desktop.rs:58-180` | The core |
| B25 | Annex-B output with SPS/PPS/IDR first | `desktop.rs:1852-1871,2469-2473` | The native addon's encoder |
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
| B40 | PTY output: standard base64, 16 KiB chunks, slave end held for correct EOF | `pty.rs:22,123-143,351-353` | The core + `node-pty` |
| B41 | Terminal message set: create / resize / close / exit / error | `pty.rs:263-292` | `@ponter/shared` terminal types |
| B42 | Files binary frame layout `[1B type][16B id][8B BE index][payload]`, 32 KiB | `files.rs:75-104` | The core |
| B43 | Files JSON message set (12 inbound, 8 outbound) | `files.rs:296-570` | `@ponter/shared` files types |
| B44 | Path sandbox: reject absolute, NUL, backslash, empty/`.` components; `..` allowed but containment proven by canonicalize + component prefix | `files.rs:760-800` | The core |
| B45 | Single in-flight transfer per direction; 64-chunk window; 30 s idle timeout; ack every 16 chunks / 20 ms | `files.rs:36-38,1083-1085,1185-1245` | The core |
| B46 | Upload temp suffix `.ponter-part`, removed on discard; resume requires exact `.part` length | `files.rs:65,1009-1036,1126-1128` | The core |

### 4.5 Identity, E2EE, API, logging

| # | Behaviour | Rust source | Port target |
|---|---|---|---|
| B47 | Ed25519 PKCS#8 identity file, mode 0600, base64 public key | `identity.rs:21-76` | The core + a Node file store |
| B48 | Canonical proof bytes ≡ `canonicalProofMessage` | `identity.rs:78-90` | `@ponter/shared` (already identical — delete the Rust copy) |
| B49 | E2EE: ECDH P-256 → HKDF-SHA256 → AES-256-GCM; `info="ponter-ws1-terminal-v1"`, `salt=session_id`, empty AAD | `e2ee.rs:14-17,42-44,149-173,220` | `@ponter/crypto`'s `EncryptionManager` |
| B50 | E2EE frame `[12B IV][ct ‖ 16B tag]` | `e2ee.rs:161-173` | `@ponter/crypto` (already identical) |
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
| B59 | **Source selection** — `AGENT_DESKTOP_DEFAULT_SOURCE` picks the default source; `source_for` resolves a requested id against the enumerated list | `desktop.rs:1004-1020`, `:1188-1225` | The core |
| B60 | **`capture_image` polling fallback** — when no hardware video recorder is available, fall back to a ~33 ms (≈30 Hz) polling loop that grabs single frames | `desktop.rs:553-650` (`ImageCapturer` trait, `run_capture_image_poll_loop`, the poll-interval constants) | The native addon's capture path |
| B61 | **`desktop-stats` telemetry** — periodic control frames carrying the encoded-frame count, dimensions, the current profile, and the quality-downgraded status | `desktop.rs:1356`, `:1525`, `:1535`, `:2092`; `DesktopStats` at `:2106`; `frame_desktop_stats` at `:2147` | The core |
| B62 | **The desktop control state machine** — `DesktopSelect`, `SetBitrate`, `QualityDowngraded`, and the `StreamControl` enum that carries them | `desktop.rs:1893-1922`, `:2092-2143` | The core |

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
| R3 | `apps/agent/src/api.rs`'s HTTP error-mapping layer | Dead code — the agent has no HTTP client (wire report §5.4). `packages/api-client` owns this concern in TS. |
| R4 | `apps/agent/vendor/xcap` (the Rust fork with the PipeWire lifetime fix) | Superseded by the native addon's capture implementation. The fork's `PATCH.md` rationale must be carried into the addon's capture code as a comment. |
| R5 | The `QuietNoise` filter's Rust-crate-specific target names | Replaced by equivalent TS filter names (§4.5 B54). |
| R6 | `build-agent.yml` and the agent GitHub Release | Desktop-only (§6.2). |

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
  process boundary does not. The §8 trail records the amendment.

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
and report it" path (`agent-control.ts:125-130`) are preserved verbatim.

---

## 8. Migration phases

Each phase is a separate PR with the full review chain (implementer →
independent reviewer → QA binding sign-off → BA docs audit → PM cross-check)
and 100% green CI.

| Phase | Deliverable | Gate |
|---|---|---|
| **P0 — Spike** | Prove werift can **send** H.264 to a browser peer. A minimal script: encode a synthetic frame with the native addon (or, initially, a pre-encoded Annex-B fixture), packetize it, push it through werift to a browser, and confirm the browser decodes it. The spike runs the five ordered steps of §3.5.2 against a **VP8-first** synthetic offer **and its negative case**, and the spike script carries the four measures of §3.5.1 (R-S1/R-S2/R-S3/R-S4) as working code — not as future work. | **Viability gate.** Assertions A1 + A2 + A3 of §9.3 must all hold simultaneously, **and the negative case must fail as predicted**. If werift-as-sender cannot carry H.264 to a browser, the whole architecture is revisited before any further work. |
| **P1 — Shared foundations** | Move the stream-profile table to `@ponter/shared`; replace the cross-language parity test with a same-language import (D12); add the TS API-access gate. | D12 closed; the parity guarantee survives |
| **P2 — Native addon** | The N-API addon: capture, encode (openh264), input injection. Unit-tested at the C++ level and through a TS smoke test. | Fault-containment test (§9.2) |
| **P3 — Core: signalling + identity + E2EE** | The WS client, the identity store, the E2EE handshake. Consumes `@ponter/shared`, `@ponter/crypto`. | The wire contract (C1, C5, C6, C7, C13) proven by conformance tests |
| **P4 — Core: terminal + files** | `node-pty` + the shell policy; the files state machine + the sandbox. | B36–B46 proven |
| **P5 — Core: desktop session + packetizer** | The RFC 6184 packetizer (table-driven tests), the desktop session, the static skip, the sustain ladder. | B14–B27 proven; the P0 spike's technique generalised |
| **P6 — Desktop integration** | `AgentSupervisor` → in-process; the packaging of the addon; the CI changes. | The desktop's 308 tests stay green; the packaged-app smoke test passes |
| **P7 — Rust removal + docs** | Delete the Rust tree, `build-agent.yml`, `agent-setup.md`, the CLI string in `RegisterAgentDialog.vue`; update `ARCHITECTURE.md` §4.4 and the §8 trail; amend ADR-86. | No `Rust` reference remains in the living docs |

### 8.1 Test-strategy requirements (TEST-INTEGRITY)

The Rust agent carries **359 `#[test]`/`#[tokio::test]` functions**. The port
must carry an equivalent suite, not a smaller one. Each Rust test that is
retired must be accounted for by a TS test or by an explicit R-entry
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

**A3 alone is not sufficient and A1/A2 alone are not sufficient.** A1 + A2
can both pass while the browser still shows nothing (the encoder's profile
does not match the advertised `profile-level-id`; a missing IDR; a decoder
that needs a keyframe request answered). A3 can pass by accident on a
fixture that happens to decode. The gate requires all three.

The spike's synthetic offer must list **VP8 first, then H.264** — the Chrome
ordering. An offer that lists only H.264 would not exercise D4b at all, and
a green run against such an offer would prove nothing about the real browser
peer. The spike must also run the **negative case** (a VP8-first *local*
codec list), which is expected to fail — see §3.5.2.

**The gate also covers RTCP.** A sender that cannot answer a PLI is a
stream that never recovers from a dropped IDR. The P0 harness must observe
a PLI arriving at the sender and the encoder responding with a keyframe.

### 9.4 The behavioural-parity gate

Every row of §4 — **all 62 of them, B1 through B62** — must be covered by at
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
| RK1b | The negotiated `fmtp` is the browser's, and werift never checks it (D4d) — a browser whose first H.264 entry is `packetization-mode=0` makes the agent negotiate mode 0 while the packetizer emits mode 1 | **Medium** — depends on the browser's codec ordering; Chrome's default puts mode 1 first, but this is not guaranteed | **Fatal** — broken frames; the connection is healthy and the PT is right, so no other check catches it | R-S3 asserts `packetization-mode=1` and the encoder's profile, and fails loudly otherwise. The agent may also **narrow the negotiated list** to the H.264 entry whose `parameters` it can actually satisfy, before `createAnswer` |
| RK1c | A transceiver added after `setRemoteDescription` yields an inactive m-line and an undefined codec (D4e) | **Low** — the Rust agent already carries ADR-15 and the port copies the ordering | High — an inactive m-line looks like a healthy idle stream; D4c turns it into a silent no-op | R-S4 preserves the ordering, and R-S2's loud assertion catches a missing codec |
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
can be overturned:

| # | Decision made | Alternative |
|---|---|---|
| O1 | In-process, not sidecar (§5) | A Node sidecar (§5.3) |
| O2 | The RFC 6184 packetizer lives in TypeScript, not the addon (§3.3) | Packetize in the addon |
| O3 | `openh264` is vendored into the addon (BSD-2-Clause) (§6.3) | A different encoder, or ffmpeg (GPL-3.0 — not acceptable) |
| O4 | The environment-variable contract (`AGENT_ID`, `AGENT_SERVER`, …) is kept even though it is now an in-process config (§7) | Renaming the variables |
| O5 | The Rust tree is deleted in P7, not incrementally | Keeping a Rust build alongside during the port |
| O6 | The addon is packaged as a per-platform dependency via `electron-builder install-app-deps` (§6.4) | `extraResources` with an absolute-path loader |

### 11.1 Open technical questions the plan must answer

These are **not** owner decisions — they are engineering questions a competent
implementer would have to answer before writing code, and the spec does not
pretend to answer them. Each is listed with what the plan must settle. They
are the plan's work, not the spec's.

| # | Question | What the plan must settle |
|---|---|---|
| Q1 | **The werift sender API surface.** What exactly does `WeriftAdapter.addTrack` return, and how does the core reach `MediaStreamTrack.writeRtp`? | The concrete method set on `RTCRtpSenderLike` (§3.5) and the adapter's internal wiring. |
| Q2 | **The DTLS/SRTP boundary.** Does werift handle DTLS and SRTP internally for a sender, so the addon only produces RTP packets? | Whether the fallback in §3.5.2(c) — writing directly to the DTLS transport — is even reachable, and what API exposes it. |
| Q3 | **The openh264 linkage and output format.** How is openh264 linked into the addon (vendored source, `cc`, a system package)? Does the raw C API emit **Annex-B** (with start codes) or AVCC? | The `binding.gyp` linkage, and the confirmation that the bytes reaching the TS packetizer are Annex-B — the Rust agent's `bitstream.to_vec()` is Annex-B, and the packetizer is specified against Annex-B. |
| Q4 | **The capture source selection on the addon side.** How does the addon enumerate monitors and windows, and how does `AGENT_DESKTOP_DEFAULT_SOURCE` map onto them? | The native API for `SourceKind` / `DesktopSourceInfo` (B58) and the resolution of the default source (B59). |
| Q5 | **The `capture_image` fallback detection.** When is the polling fallback used instead of the hardware recorder, and what happens on a headless Linux container with neither PipeWire nor X11? | The detection rule and the failure mode, for B60. |
| Q6 | **The `desktop-stats` wire shape.** What are the exact fields of `DesktopStats`, and which channel carries the frame? | The full field list, for B61. |
| Q7 | **The cursor frame's rate and encoding.** How often is the cursor polled, and what encodes the shape PNG and caps its size? | The poll cadence, the PNG encoder dependency, and the cap, for B56. |
| Q8 | **The Electron packaging mechanics.** Is the `.node` binary built at install time (`postinstall` / `install-app-deps`) or copied into `resources/` at build time? Does `electron-builder` need `extraFiles`? | The exact build and packaging steps, and where the `.node` file lives in the packaged app, for §6.4. |
| Q9 | **What the Rust removal actually deletes.** Does `apps/agent/vendor/` contain anything besides `xcap`? Are the shared E2EE vectors (`packages/crypto/test/vectors/e2ee-vectors.json`) extracted before the tree is removed? | The P7 deletion list, so nothing needed by the TS suite is deleted with it. |

---

## 12. Appendix — the Rust source inventory

`apps/agent/src/` — 20,858 lines across 20 files, plus `apps/agent/vendor/xcap`
(7,528 lines, 50 files) and 359 test functions.

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
