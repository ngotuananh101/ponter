# Phase 3 Week 9 — Desktop Input Forwarding (Pointer & Keyboard) Design Specification

**Status:** Draft — Ready for review
**Date:** 2026-10-03
**Author:** Ngo Tuan Anh & Claude
**Target:** Phase 3 Week 9 of `docs/ARCHITECTURE.md` (Section 8, "Weeks 8-9: Quality & Interaction"). Week 9 adds **input forwarding** (mouse + keyboard) on top of the Week 8 desktop stream. It **supersedes ADR-18** ("View-only desktop in Week 7") but ships the feature **gated off by default** — see §9 and ADR-29.

---

## 1. Overview & Objectives

Week 8 turned the Week 7 thin slice into a usable stream: a resolved quality profile, a source picker, and a control channel (`['control']`) carrying `desktop-sources` / `desktop-select` / `desktop-bitrate` / `desktop-stats`. Week 9 makes that stream **interactive**: the browser forwards pointer and keyboard events over the same control channel, and the agent injects them into the operating system of the machine it is streaming.

The roadmap item is "Mouse & keyboard control (input forwarding) — currently view-only (ADR-18)" (`ARCHITECTURE.md:951`). This spec delivers the wire, the injection, and the tests — **but behind a hard gate that keeps input inert in production** (ADR-29).

One constraint shapes the whole design:

- **Input injection is a fundamentally higher-risk surface than watching, and the agent's trust model is not ready for it.** The E2EE audit's **H3** (`docs/security/2026-10-01-e2ee-zero-trust-audit.md:163`) is explicit: the agent has *no peer identity verification* — it approves a session on the attacker-controlled `desktop` capability label alone (the audit cites `apps/agent/src/rtc.rs:186`; that line has since drifted, but the behaviour is current: `classify_offer` decides the mode from capability strings, `apps/agent/src/main.rs:358-366`, and the desktop answer hardcodes `approved: true`, `apps/agent/src/rtc.rs:224-237`). A remote-input feature on top of an unverified peer is a remote-code-execution-shaped risk: whatever the agent injects, the peer chose. The audit's **H2** (the `approved` refusal flag is recorded but never enforced) compounds it. **Week 9 therefore ships the mechanism, not the capability** — the feature is gated off and does not become usable until the identity/consent workstream (WS2/WS3) lands. This is the user's decision (§9), recorded as ADR-29.

### 1.1 Core Goals

1. **A `desktop-input` frame on the existing control channel.** No new data channel: Week 8 already opened `['control']`. The browser sends structured, **normalized** input events (pointer position as 0..1 within the source, physical key codes, unicode text) and the agent maps them to the operating system (ADR-28). The wire reuses the `decode_pty_input` guard shape (`apps/agent/src/pty.rs:124`) — a size cap checked **before** parsing, then a strict channel/type match (ADR-26).
2. **OS injection behind a trait.** A new `apps/agent/src/input.rs` defines an `InputInjector` trait and one platform implementation. The trait is what makes the gate and the tests possible without a display (ADR-27).
3. **Coordinate mapping that survives `object-contain`.** The `<video>` letterboxes the stream; the browser maps a pointer event to normalized source coordinates by removing the letterbox, and the agent maps normalized → absolute source pixels using the geometry the picker already carries (`DesktopSourceInfo.x/y/width/height`, §2.2 of the Week 8 spec). ADR-30 records the mapping and its device-pixel-ratio caveat.
4. **An explicit, remote-proof gate.** Input is **OFF by default**. The agent drops every `desktop-input` frame unless the operator opted in (`--allow-input` / `AGENT_ALLOW_INPUT=1`) — a flag a **remote peer cannot set** (ADR-29). When the gate is closed the agent logs the drop and continues; it never injects and never fails the session.
5. **A timeboxed injection-library spike.** A half-day investigation of `enigo` (cross-platform) versus per-platform injection (Windows `SendInput`, macOS `CGEventPost`, Linux XTest/`uinput`). The spike chooses the **dependency**, not the delivery: both branches are written into ADR-27 so a FAIL shrinks nothing in scope.
6. **Automated + manual verification.** Rust unit tests for decode/mapping/gate, TS unit tests for the letterbox math and the client method, E2E coverage of **both** gate states (closed = dropped; open = observable injection under Xvfb), and a manual demo on a real display.

### 1.2 Non-Goals (Explicitly Deferred)

- **Usable remote input in production.** This is the headline non-goal (ADR-29): the artifact ships with input **off**. "Input works end-to-end for a real user" is **not** an acceptance criterion (§10.2). It becomes a goal only after WS2/WS3 (§9).
- **Input on the musl artifact.** musl has no desktop module; a desktop offer is already refused there (`apps/agent/src/main.rs:1449`, ADR-15), so no desktop session exists to inject into. The `--allow-input` flag is accepted on all targets for CLI-shape consistency but is inert on musl (mirrors `--desktop-source`).
- **Input when there is no desktop session.** The frame lives on the `control` channel, which only a desktop session opens. A terminal session never sees it; a `desktop-input` on any other channel is dropped (§2.4).
- **Clipboard, drag-and-drop, file transfer.** File transfer is Phase 4 (`ARCHITECTURE.md:953-955`); clipboard is not scheduled.
- **Touch, pen, gamepad.** Pointer and keyboard only.
- **Pointer lock / relative-motion capture.** A first cut maps *absolute* pointer position within the video rect. FPS-style pointer lock is deferred.
- **Full IME composition.** A `text` frame carries committed unicode (basic IME commit / `beforeinput`); managing an in-progress composition buffer (preedit) is deferred.
- **Automatic input focus.** The browser does not grab OS-level focus or force the video into focus on connect; the user enables input explicitly (ADR-29).
- **macOS/Windows runtime injection verification.** Those targets must compile and pass unit tests; runtime injection stays unverified (no CI hardware), exactly as Week 7/8 left runtime *capture* unverified.
- **Application-layer E2EE for input.** Input frames are base64/JSON-free but still plaintext at the application layer over DTLS — the audit's **M7** (`:340`) and **M8** (`:349`). Fixing that is WS1 (Phase 5), not Week 9; §9 states it rather than hiding it.

---

## 2. Wire Protocol & Contract Specifications

### 2.1 The control channel is reused — no new channel

Week 8's desktop offer already opens `channelLabels: ['control']` with `capabilities: ['desktop']` and `media: { video: true }` (Week 8 spec §2.1). Week 9 adds **one frame type** to that channel; the offer, the media track, and the terminal flow are unchanged.

| Flow | `channelLabels` | `capabilities` | `media` |
|---|---|---|---|
| Terminal (existing) | `['terminal']` | omitted → falls back to `channelLabels` | omitted |
| Desktop (Week 8) | `['control']` | `['desktop']` | `{ video: true }` |
| Desktop (Week 9) | `['control']` | `['desktop']` | `{ video: true }` |

The agent's desktop branch continues to accept exactly one inbound data channel labeled `'control'` and rejects any other label (Week 8 spec §2.1). `capabilities` remains attacker-controlled and is still compared by exact string equality only — which is precisely why the input gate is an **agent-local flag**, not a capability (ADR-29).

### 2.2 Control-channel frames (Week 9 addition)

Frames reuse the envelope `DataChannelMessage<T>` (`packages/shared/src/types/webrtc.ts:9-14`): `{ type: string, channel: 'control', payload: T, timestamp: number }`. Week 9 adds one browser→agent type to the Week 8 vocabulary.

| `type` | Direction | `payload` | Purpose |
|---|---|---|---|
| `desktop-input` | browser → agent | `DesktopInput` (a union on `kind`, below) | Forward one pointer/keyboard event |

Week 9 also makes **one additive change** to the Week 8 `desktop-sources` payload: it gains `inputEnabled: boolean` so the browser knows whether the agent's gate is open (§7.2). A Week 8 client that ignores the extra field is unaffected.

```typescript
/** One forwarded input event. The `kind` tag selects the fields. */
export type DesktopInput =
  | { kind: 'pointer-move'; x: number; y: number }              // normalized 0..1
  | { kind: 'pointer-button'; button: 'left' | 'middle' | 'right'; pressed: boolean; x: number; y: number }
  | { kind: 'wheel'; dx: number; dy: number; x: number; y: number }
  | { kind: 'key'; code: string; pressed: boolean; modifiers: KeyModifiers }  // code = KeyboardEvent.code
  | { kind: 'text'; text: string };                             // committed unicode

export interface KeyModifiers {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
}

export interface DesktopSourcesPayload {
  sources: DesktopSourceInfo[];   // Week 8
  /** Week 9 additive: true iff the agent's input gate is open (ADR-29). */
  inputEnabled: boolean;
}
```

- **`pointer-move` / `pointer-button` / `wheel` carry normalized `x`/`y` (0..1)** measured within the *streamed source*, not the video element. The browser removes the `object-contain` letterbox before sending (§7.1, ADR-30); the agent multiplies by the current source's `width`/`height` and offsets by `x`/`y`.
- **`key` carries the physical `code`** (`"KeyA"`, `"ShiftLeft"`, `"ArrowLeft"`) plus modifier state, so the mapping is layout-independent. Text that depends on the layout/IME arrives as `text`.
- **`text` carries committed unicode** — the browser sends it for printable input the OS should type literally.

### 2.3 The gate (ADR-29) — what the agent does with `desktop-input`

The gate is enforced in the control dispatcher (§6.3), before any injection:

- **Gate closed (default).** The agent receives the frame, logs it at `debug` (`"dropping desktop-input: input disabled"`), and **continues**. No injection, no error frame, no effect on the session. This is the shipped production behaviour.
- **Gate open (`--allow-input`).** The agent decodes the event and calls the injector (§6.4). A decode error or an injector error is logged and dropped — it never ends the session.
- **Either way**, a `desktop-input` frame whose `channel != "control"` or `type != "desktop-input"` is dropped and logged (the `decode_pty_input` guard shape, `apps/agent/src/pty.rs:132`), and a frame larger than `MAX_FRAME_BYTES` is rejected **before** parsing (`apps/agent/src/pty.rs:125`).
- **Input is fire-and-forget — there is no ack.** The agent sends **no** response for a `desktop-input` frame, on any path: a dropped frame (gate closed, malformed, wrong channel/type) and an injected frame are indistinguishable to the browser. This is deliberate and consistent with Week 8's "no error frame" rule (§2.2 of the Week 8 spec): input is **best-effort**, and the browser cannot know whether a given event was injected. A future implementer must not add an ack or expect one — the only feedback loop is the visible effect on the streamed screen.

### 2.4 Terminal flow — unchanged

Terminal sessions keep the Week 6/7/8 contract byte-for-byte: `channelLabels: ['terminal']`, one `'terminal'` channel, `terminal-*` frames. The `desktop-input` type is desktop-only and `control`-only; the terminal dispatcher ignores any `control` frame and the desktop dispatcher ignores any non-`control` frame.

---

## 3. Verified Findings

All facts below were verified against repository state or vendor documentation — not from memory. Where a claim could not be verified from this repository, it is in §3.5 rather than asserted.

### 3.1 No input-injection crate exists in the repository or the build cache

- A repository-wide grep and a scan of the cargo registry cache found **no** input-injection crate: `apps/agent/Cargo.lock` contains **0** occurrences of `enigo`, and the registry cache holds no `enigo` / `rdev` / `inputbot` / `uinput` source. The only vendored crate is `apps/agent/vendor/xcap` (capture, not injection).
- The agent's dependency set (`apps/agent/Cargo.toml:7-25`) is base64/clap/rtc/webrtc/tokio/portable-pty plus the desktop-only `bytes`/`openh264`/`xcap` (`:41-42`, `:48`). Nothing injects input today.
- **Consequence.** Week 9 introduces the **first** input dependency. Like `xcap`/`openh264`, it must be gated `cfg(not(target_env = "musl"))` (`Cargo.toml:40`) so the musl artifact stays terminal-only, and it will need the same vendoring/offline consideration `xcap` got (`apps/agent/vendor/xcap/PATCH.md`). The candidate set is recorded in ADR-27.

### 3.2 Wayland is a first-class risk for injection (not a footnote)

- On X11 the mature path is the XTEST extension (what `xdotool` uses). On **Wayland there is no XTEST**: a client cannot inject into another client's surface. The viable paths are `uinput` (needs write access to `/dev/uinput`, i.e. root/`udev` rule) or the `xdg-desktop-portal` **RemoteDesktop** interface (a user-consent portal).
- This project has **already** been bitten by Wayland in the capture direction: the vendored `xcap` carries a one-line fix for a GNOME/Wayland PipeWire session-lifetime bug that produced a black stream (`apps/agent/vendor/xcap/PATCH.md`). Injection faces the *mirror* problem — capture was read-only, injection writes to the seat.
- **Consequence.** The ADR-27 spike must test on the target session type (X11 *and* Wayland), and the spec must not promise a single cross-platform code path until it does. §3.5 records that real Wayland injection is unverified.

### 3.3 Injection is independent of the capture source

- The capture source (`--desktop-source screen|test`) decides what is **streamed**; injection decides what the OS **receives**. They are orthogonal: the agent can inject into display `:N` while streaming the deterministic test pattern (`apps/agent/src/desktop.rs:140-192`).
- **Consequence.** E2E can exercise real injection under a headless **Xvfb** display while using `--desktop-source test` for a stable, display-free stream — the two concerns do not collide (§8.3). This is what makes the gate-open E2E test (§9 requirement 2) possible without a physical monitor.

### 3.4 Coordinate space: normalized → absolute, and the DPR caveat

- `DesktopSourceInfo` already carries `x`, `y`, `width`, `height`, `scaleFactor` and `rotation` (Week 8 spec §2.2; projected from `xcap`'s `Monitor`/`Window` accessors, `apps/agent/src/desktop.rs:478-519`).
- **Watch item (honest).** `xcap` reports geometry in the platform's native unit; injection libraries variously expect **logical** or **physical** pixels. On a scaled display (`scaleFactor != 1`) a normalized coordinate multiplied by `width` may land at the wrong physical point. The spike/implementation must confirm the unit `xcap` returns matches the unit the injector consumes, and convert via `scaleFactor` if not. This spec does **not** settle it — it flags it so the implementer does not discover it in a demo.

### 3.5 What cannot be verified from this repository

- **Which injection library is viable** — no crate is present (§3.1); the ADR-27 spike decides.
- **Real Wayland injection** — no Wayland session in CI; manual demo only (§3.2).
- **The DPR unit question** (§3.4) — needs a scaled-display probe.
- **macOS/Windows runtime injection** — compile + unit tests only, as with capture.
- **Whether the gate-open E2E can drive a real seat on CI** — depends on Xvfb + XTest availability; the E2E job already installs the capture stack (§8.3). If XTest is unavailable under CI's Xvfb, the gate-open test falls back to asserting the **injector call** via a mock seam (§8.3, "Fallback") — stated rather than assumed.

---

## 4. Architectural Decision Records

### ADR-26: Desktop becomes interactive — input rides the existing control channel

**Context.** ADR-18 (Week 7 spec) made the desktop view-only: the `<video>` has no controls and the agent's desktop branch registers no inbound frame handling. Its Consequence says "a future week adds an input channel and the corresponding ADR." Week 8 has since opened a `control` channel; a separate input channel would be a second inbound surface to authorize and bound.

**Decision.** Week 9 **supersedes ADR-18**. Input arrives as a `desktop-input` frame on the **existing** `control` channel (no new channel), decoded with the `decode_pty_input` guard shape (`apps/agent/src/pty.rs:124`): a size cap before parsing, then a strict `channel == "control" && type == "desktop-input"` match. Media and the terminal flow are untouched. The agent's control dispatcher (§6.3) owns the new frame.

**Rationale.** Reusing `control` means one authorized inbound surface, one channel-liveness story, and the single-channel rule Week 8 already established — instead of a second channel with its own refusal and timeout semantics. The terminal path stays byte-for-byte identical.

**Consequence.** ADR-18 is marked superseded in the Week 7 spec and in `ARCHITECTURE.md` (§11). The `<video>` gains input listeners, but only when the gate is open (ADR-29) — so the "no input handling" property ADR-18 protected is now conditional on a flag, not on the absence of code.

### ADR-27: Injection library is chosen by a half-day spike; both branches ship as written

**Context.** No input crate is present (§3.1). The realistic choices are a cross-platform library (`enigo`) versus per-platform injection (Windows `SendInput`, macOS `CGEventPost`, Linux XTest/`uinput`). Each carries platform and Wayland risk (§3.2) that cannot be settled from this repository.

**Decision.** A **half-day spike, before any dependency is committed**, evaluates `enigo` against per-platform injection on the criteria: (a) builds under the agent's toolchain on Linux/macOS/Windows; (b) injects pointer + keyboard on X11; (c) has a credible Wayland path (`uinput` or portal) or an explicit statement that it does not; (d) licensing and maintenance. The spike chooses the **dependency**; it does not gate delivery.

- **Spike PASS (enigo viable)** → depend on `enigo` (one crate, `cfg(not(target_env = "musl"))`), wrapped behind the `InputInjector` trait.
- **Spike FAIL (enigo inadequate)** → per-platform modules behind the same trait: `SendInput` on Windows, `CGEventPost` on macOS, XTest on Linux/X11 with a documented Wayland limitation. The trait boundary (§6.1) is what keeps the two branches swappable.

**Rationale.** The dependency is an implementation detail behind `InputInjector`; making acceptance depend on an unrun experiment would let an unknown silently change scope (the same reasoning as ADR-23/ADR-25 in Week 8). Writing both branches here means a FAIL shrinks nothing.

**Consequence.** §10.2 acceptance criteria do **not** reference the spike. The trait is defined in §6.1 so the choice is a one-module swap. The musl gate (`cfg(not(target_env = "musl"))`) and the offline/vendor consideration (§3.1) apply to whichever branch is taken.

**Finding (2026-10-03, half-day spike, Fedora + X11):** PASS — `enigo` 0.6.1 (MIT) builds with default features and injects pointer+keyboard on X11 via XTest; `Enigo` is `Send`, so it fits `InputInjector` behind a `Box<dyn>` with no wrapper. Wayland: the default build is a silent no-op on GNOME (returns `Ok`, nothing moves); the `wayland` feature is wlroots-only and is NOT enabled — Wayland stays the §8.4-step-5 recorded limitation, with libei/portal as follow-up. macOS: set `Settings::open_prompt_to_get_permissions = false` (default `true` would pop a GUI prompt). ~14 new lockfile crates on Linux; pure Rust, so **no vendoring** (unlike xcap) and it even builds on musl — the musl cfg-gate is policy, not a build constraint. Chosen branch: **enigo**. The per-platform branch stays documented above as the fallback.

### ADR-28: Input is structured and normalized; the browser sends intent, the agent maps to the OS

**Context.** The browser and the agent run on different machines, potentially different OSes, with different screen geometries and keyboard layouts. Two designs are possible: (a) the browser sends raw device-level events and the agent replays them, or (b) the browser sends **normalized intent** (pointer position as a fraction of the source, physical key codes, committed text) and the agent maps to the OS.

**Decision.** Design (b). `desktop-input` carries a discriminated union (§2.2): pointer coordinates are normalized `0..1` within the streamed source; keys carry the physical `KeyboardEvent.code` plus a modifier object; printable input arrives as `text`. The agent converts normalized → absolute source pixels using `DesktopSourceInfo` (ADR-30) and calls the `InputInjector`.

**Rationale.** Normalized intent is resolution-, scale-, and platform-independent: the same frame is meaningful whether the source is a 4K monitor or a window, and the agent — which knows the source geometry and the OS — is the only party that can map it correctly. It also keeps the browser free of OS-specific logic, which is where the DOM-free `desktop-core` boundary already sits.

**Consequence.** The agent owns coordinate conversion and key-code translation; a new OS backend only implements the `InputInjector` trait. The trade-off is that a future relative-motion mode (pointer lock) needs a *second* intent kind, which is why pointer lock is a Non-Goal (§1.2), not an oversight.

### ADR-29: Input ships gated OFF by default, behind an agent-local opt-in the peer cannot set

**Context.** The E2EE audit's **H3** (`:163`) finds the agent has **no peer identity verification**: it approves a session on the attacker-controlled `desktop` capability label (`apps/agent/src/main.rs:358-366`; the audit's `rtc.rs:186` cite has since drifted). **H2** (`:149`) finds the `approved` flag is recorded but never enforced. Remote input on an unverified peer means a compromised signaling server can drive the machine it can reach — a materially worse outcome than watching it. The user's decision (§9) is to ship the mechanism now and gate the capability.

**Decision.** Input is **inert by default**. The agent drops every `desktop-input` frame unless the operator opted in with `--allow-input` (env `AGENT_ALLOW_INPUT=1`), resolved once into `SessionConfig`. The gate is **one mechanism** — an agent-local flag, not a capability negotiation:

- A **capability** (`capabilities: ['desktop-input']`) would be attacker-controlled, which is exactly the H3 defect; it cannot gate anything.
- The **flag** is set on the agent's own command line / environment. **A remote peer cannot set it.** For the H3 threat model (a malicious signaling server or remote peer), the flag is a hard gate: the input code path is unreachable from the network.

When the gate is closed the agent logs the drop and continues — no injection, no error frame, no session effect (§2.3). The browser hides its input toggle unless the agent reports `inputEnabled: true` (§7.2), so the feature is invisible in the default build.

**Rationale.** The gate must be enforced at the only point the network cannot reach: the agent process's own configuration. Making it a capability would repeat the H3 mistake; making it a compile-time feature would force E2E to test a non-production artifact (§9, trade-off). A runtime flag is testable against the *same* binary production ships.

**Consequence.** §10.2 acceptance criteria state the mechanism and its tests, **not** a usable feature. The gate is a **policy** gate, not a **capability** gate: the shipped binary contains the injection code and can inject if the flag is set — the residual risk is a **local** actor who already has shell/CLI access to the machine (who could inject directly regardless). The gate fully covers the **remote** threat (H3). ADR-29 is not the end of the identity work: it is a holding pattern until WS2/WS3 close H3/H2 (§9, §11).

### ADR-30: Coordinate mapping removes the `object-contain` letterbox, then applies source geometry

**Context.** The `<video>` uses `object-contain` (`apps/web/src/components/desktop/DesktopView.vue:77`), so the stream is letterboxed (or pillarboxed) within the element. A naive `clientX / rect.width` maps a click on the black bars to a wrong source point. The source may also be offset on a multi-monitor desktop and scaled.

**Decision.** The browser computes the **content box** inside the element (the largest rect with the video's aspect ratio, centered), maps `(clientX, clientY)` to normalized `(nx, ny)` within that box, and clamps to `0..1` (§7.1). The agent maps `nx, ny` to absolute pixels with `abs = source.x + round(n * source.dimension)`, using the **currently streamed** source's geometry from `DesktopSourceInfo`.

**Rationale.** Doing the letterbox math in one place (the browser, which knows `videoWidth`/`videoHeight` and the element rect) keeps the agent's job a pure multiplication, and normalizing before the wire means a resolution change on the agent side needs no browser change.

**Consequence.** The `scaleFactor`/device-pixel-ratio caveat (§3.4) is a recorded watch item: if `xcap`'s unit and the injector's unit differ on a scaled display, the conversion is applied in the agent (which holds `scaleFactor`), not the browser. The mapping is unit-tested with a letterbox, a pillarbox, and an offset source (§8).

---

## 5. Package Design: `packages/webrtc-core` & `packages/desktop-core`

### 5.1 `packages/shared/src/types/desktop.ts` (extended)

Week 9 extends the Week 8 module with the input union of §2.2, re-exported from `types/index.ts`:

```typescript
export interface KeyModifiers {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
}

export type DesktopInput =
  | { kind: 'pointer-move'; x: number; y: number }
  | { kind: 'pointer-button'; button: 'left' | 'middle' | 'right'; pressed: boolean; x: number; y: number }
  | { kind: 'wheel'; dx: number; dy: number; x: number; y: number }
  | { kind: 'key'; code: string; pressed: boolean; modifiers: KeyModifiers }
  | { kind: 'text'; text: string };

/** Week 9 additive field on the Week 8 `desktop-sources` payload. */
export interface DesktopSourcesPayload {
  sources: DesktopSourceInfo[];
  inputEnabled: boolean;
}
```

No change to `WebRTCChannelType` (`'control'` already exists, `packages/shared/src/types/webrtc.ts:7`) and no new frame envelope.

### 5.2 `packages/webrtc-core` — no new seam

As in Week 8, the control channel needs **no new code in `webrtc-core`**: `PeerConnection` pre-creates the `'control'` channel and `DataChannelManager` exposes `sendJson(label, type, payload)` (`packages/webrtc-core/src/data-channel.ts:74-88`). Week 9 sends `desktop-input` through the same `sendJson`.

### 5.3 `packages/desktop-core` — `DesktopClient` gains `sendInput`

`DesktopClient` still never *creates* a channel (Week 8 spec §5.3); it *uses* the control channel it already subscribes to. It gains one method and one option:

```typescript
export interface DesktopClientOptions {
  trackTimeoutMs?: number;     // Week 8
  controlTimeoutMs?: number;   // Week 8
  /** Max input frames per second the client will forward. Default 60. */
  inputRateLimitHz?: number;
}

export class DesktopClient {
  // ...unchanged Week 8 surface: onSources, onStats, selectSource, setBitrate...
  /** Forward one input event. No-op (warn) if the control channel is not open. */
  sendInput(event: DesktopInput): void;
}
```

Semantics:

1. `sendInput` calls `peer.dataChannels.sendJson('control', 'desktop-input', event)`. Because `sendJson` **throws** when the label is not registered (`data-channel.ts:75-77`), it is guarded: if the channel is not open it logs a warning and returns (the UI only forwards input after `onSources` reports `inputEnabled`, §7.2).
2. **Rate limiting.** `sendInput` coalesces `pointer-move` to at most `inputRateLimitHz` (default 60): the newest position wins and stale intermediate moves are dropped. Discrete events (`pointer-button`, `wheel`, `key`, `text`) are never coalesced — dropping a click would be a correctness bug.
3. `onSources` now yields `DesktopSourcesPayload` (sources + `inputEnabled`); the client exposes the flag so the UI can gate its toggle.

### 5.4 Unit tests (`packages/desktop-core/test/client.test.ts`)

- `sendInput` sends `{ type: 'desktop-input', channel: 'control', payload: event }` when the channel is open; when absent it warns and does **not** throw.
- `pointer-move` frames are coalesced to the configured rate; `pointer-button`/`key`/`text` are forwarded on every call (not coalesced).
- `onSources` surfaces `inputEnabled` from the payload.

---

## 6. Application Design: Rust Desktop Agent (`apps/agent`)

### 6.1 `apps/agent/src/input.rs` (new) — the injector trait and the decoder

```rust
/// One decoded input event, mirroring `DesktopInput` (§5.1).
#[derive(Debug, Clone, PartialEq)]
pub enum DesktopInput {
    PointerMove { x: f64, y: f64 },
    PointerButton { button: Button, pressed: bool, x: f64, y: f64 },
    Wheel { dx: f64, dy: f64, x: f64, y: f64 },
    Key { code: String, pressed: bool, modifiers: KeyModifiers },
    Text { text: String },
}

/// The seam that makes the gate and the tests possible (ADR-27, ADR-29).
pub trait InputInjector: Send {
    fn pointer_move(&mut self, x: i32, y: i32) -> Result<()>;
    fn pointer_button(&mut self, button: Button, pressed: bool) -> Result<()>;
    fn wheel(&mut self, dx: i32, dy: i32) -> Result<()>;
    fn key(&mut self, code: &str, pressed: bool, mods: &KeyModifiers) -> Result<()>;
    fn text(&mut self, text: &str) -> Result<()>;
}

/// Decode an inbound `desktop-input` frame.
///
/// Same guard shape as `decode_pty_input` (apps/agent/src/pty.rs:124): a size
/// cap checked BEFORE parsing, then a strict channel/type match. Returns
/// `Ok(None)` for any frame that is not a `desktop-input` on the `control`
/// channel; `Err` when it is but cannot be decoded.
pub fn decode_desktop_input(raw: &str) -> Result<Option<DesktopInput>>;
```

- The decoder reuses `MAX_FRAME_BYTES` (`apps/agent/src/pty.rs:26`) as the pre-parse cap and the `DataChannelMessage<T>` envelope (`apps/agent/src/pty.rs:40`). Unlike the terminal path, the payload is **JSON, not base64** — input is structured, so there is no byte string to decode; the reuse is the guard *shape*, and the spec says so rather than implying a base64 step.
- Coordinates are clamped to `0..=1` at decode time so a hostile frame cannot produce an out-of-range absolute point.
- **The musl boundary is at the dependency, not the module.** `mod input` is **not** `cfg`-gated: it holds only serde types, the `decode_desktop_input` function, `to_absolute`, and the `InputInjector` trait — no heavy dependency — so it compiles on every target, exactly as `pty.rs` does. Only the **concrete injector** (enigo or per-platform, ADR-27) is gated `cfg(not(target_env = "musl"))`, and the injection dependency goes in `[target.'cfg(not(target_env = "musl"))'.dependencies]` alongside `bytes`/`openh264`/`xcap` (`apps/agent/Cargo.toml:40`). On musl the concrete type is simply never constructed — no desktop session exists to inject into (the dispatcher branch lives inside the non-musl `run_desktop_session`, itself `#[cfg(not(target_env = "musl"))]`, `apps/agent/src/main.rs:1100-1102`) — so no stub is required.

### 6.2 Normalized → absolute mapping (ADR-30)

```rust
/// Map a normalized (0..1) point to absolute source pixels.
///
/// `source` is the currently streamed `DesktopSourceInfo`. `scaleFactor` is
/// applied here if the injector's unit differs from xcap's (§3.4, watch item).
pub fn to_absolute(nx: f64, ny: f64, source: &DesktopSourceInfo) -> (i32, i32);
```

Pure and unit-tested: a normalized point maps to `source.x + round(nx * source.width)` / `source.y + round(ny * source.height)`, clamped to the source rect.

### 6.3 The control dispatcher gains an input branch

Week 8's control dispatcher (Week 8 spec §6.3) already decodes `desktop-select`/`desktop-bitrate` and forwards them to `run_stream`. Week 9 adds:

1. **Publish `inputEnabled`.** When the agent sends `desktop-sources` on channel open, it includes `inputEnabled: cfg.allow_input` (§2.2, §7.2).
2. **Handle `desktop-input`.** On the frame:
   - **Gate closed** (`!cfg.allow_input`): `tracing::debug!("dropping desktop-input: input disabled")`, continue. No injector is consulted.
   - **Gate open**: `decode_desktop_input` → on `Ok(Some(ev))` map and call the injector; on `Ok(None)` or `Err`, log and continue. The injector is created lazily on first use (a host with no display should not fail the stream merely because input is enabled).
3. The input path is **fail-soft**: no error from decode, mapping, or injection ever ends the session. The stream and the control channel keep running.

### 6.4 `SessionConfig` and CLI

- `SessionConfig` gains `allow_input: bool`.
- `Cli` gains `#[arg(long, env = "AGENT_ALLOW_INPUT", default_value_t = false)] allow_input: bool` — the same flag/env pattern as `desktop_source` (`apps/agent/src/main.rs:77-78`). Defined on every target so the CLI shape is uniform; inert on musl (no desktop session, ADR-15).

### 6.5 Rust unit tests

| Test | Asserts |
|---|---|
| `decode_desktop_input` valid | each `kind` decodes to the right variant; coordinates clamp to `0..=1` |
| `decode_desktop_input` invalid | wrong channel → `Ok(None)`; wrong type → `Ok(None)`; oversize → `Err` (before parsing); malformed JSON → `Err` |
| `to_absolute` | letterbox/pillarbox offsets and a non-zero source origin map correctly; clamped to the source rect |
| gate closed | with `allow_input = false`, a `desktop-input` frame does **not** call the injector (a `CountingInjector` records zero calls) |
| gate open | with `allow_input = true`, a pointer-move calls `pointer_move` once with the mapped point |
| injector error is fail-soft | an injector returning `Err` is logged and does not end the dispatcher |

A `CountingInjector` (test double implementing `InputInjector`) is how the gate and mapping are tested **without a display** — this is the seam ADR-29 relies on for the CI-safe half of §8.3.

---

## 7. Application Design: Web (`apps/web`)

### 7.1 Letterbox mapping helper (ADR-30)

A pure function, unit-tested, in the desktop store or a small `apps/web/src/lib/` module:

```typescript
/** Map a pointer position within a `object-contain` <video> to normalized (0..1) source coords. */
export function toNormalized(
  clientX: number, clientY: number,
  rect: DOMRect,
  videoWidth: number, videoHeight: number,
): { x: number; y: number };
```

It computes the content box (aspect-fit, centered), maps, and clamps to `0..1`. Unit tests cover a letterbox (wide element), a pillarbox (tall element), and a click on the black bar (clamps to an edge).

### 7.2 `components/desktop/DesktopView.vue` — input toggle + listeners

- An **Input toggle** in the overlay, **default OFF**, rendered only when `tab.desktopInputEnabled === true` (i.e. the agent reported `inputEnabled`). When the gate is closed (production default) the toggle never appears and **no listeners are attached** — the element captures nothing.
- When the toggle is ON, the component attaches `pointermove` / `pointerdown` / `pointerup` / `wheel` / `keydown` / `keyup` listeners to the `<video>` (which gets `tabindex` and focus on enable) and calls `store.sendDesktopInput(tab.id, event)`, translating DOM events to `DesktopInput` via `toNormalized`.
- The `<video>` keeps **no `controls`**; the existing `DesktopView.test.ts` assertion (no `controls`) stays green.
- Removing the "view-only" comment (`:71`) and the WorkspaceView footer text (§7.4) reflects that the view is *conditionally* interactive now.

### 7.3 Store changes — `stores/terminal.ts`

- **`openDesktopTab`** (`:491`): `channelLabels: []` → `channelLabels: ['control']` (`:539`) — the Week 8 change, carried here as the baseline this spec builds on.
- `TabItem` gains `desktopInputEnabled?: boolean` (set from `onSources`).
- New action `sendDesktopInput(tabId, event)` → `desktopConnections.get(agentId).client.sendInput(event)`, guarded so a closed tab is a no-op.
- `onSources` handler additionally sets `tab.desktopInputEnabled = payload.inputEnabled`.

### 7.4 `WorkspaceView.vue` footer

The Week 8 line `Media: H.264 · <stats or "connecting">` (`:337`) is unchanged for the media half; Week 9 appends an input indicator only when input is available: `· input on` / `· input off`. When the gate is closed (default) the footer shows the media line alone — the feature is not advertised.

### 7.5 Web tests

- `toNormalized`: letterbox, pillarbox, black-bar clamp.
- `terminal-store`: `openDesktopTab` passes `channelLabels: ['control']`; `onSources` sets `desktopInputEnabled`; `sendDesktopInput` calls the client; a closed tab is a no-op.
- `DesktopView.test.ts`: the toggle renders **only** when `desktopInputEnabled`; listeners attach only when the toggle is on; the `<video>` still has **no `controls`**.

---

## 8. Testing & QA Plan

### 8.1 Layer 1 — Rust unit tests

Per §6.5, run by `cargo test --locked` (Linux). The gate tests use a `CountingInjector`, so they need **no display** and run in the normal suite.

### 8.2 Layer 2 — TypeScript unit tests

Per §5.4 and §7.5, run by `pnpm test`.

### 8.3 Layer 3 — cross-language E2E

The existing `desktop.e2e.test.ts` (Week 7/8) is **extended, not replaced**, and must keep passing. Two new tests pin the gate (Linux only, `describe.skipIf(!isLinux)`):

- **Gate closed (default) — the production contract.** Spawn the agent **without** `--allow-input` (the default). Send a `desktop-input` pointer-move frame; assert: (a) the agent logs the drop; (b) RTP keeps flowing (the session is unharmed); (c) `desktop-sources.inputEnabled === false`. This is the test that protects the shipped behaviour — the feature is inert unless the operator opts in.
  - **The log assert needs a harness change.** The drop is logged at `debug` (§6.3), but `spawnAgent` hardcodes `RUST_LOG=info` (`packages/webrtc-core/test/e2e/harness.ts:426`) with no env parameter, so a `debug` line is filtered out. `spawnAgent` therefore gains an optional env override — `spawnAgent(agentId, credential, extraArgs, env?)` — merged over its fixed `{ RUST_LOG: 'info' }`, and this test passes `{ RUST_LOG: 'debug' }` and asserts `agent.output().includes('dropping desktop-input')`. **The assert is kept, not dropped:** without it the test would still pass if the frame were never delivered at all (a broken wire), so (a) is what distinguishes "received and dropped" from "never arrived". §8.5 is updated to match.
- **Gate open (test-only opt-in) — the injection path.** Spawn the agent **with** `--allow-input` under an **Xvfb** display (`DISPLAY=:99`), using `--desktop-source test` for the stream (§3.3). Send a pointer-move to a known normalized point; assert the OS pointer moved, via `xdotool getmouselocation` (XTest under Xvfb). `desktop-sources.inputEnabled === true`.
  - **Fallback if XTest is unavailable under CI's Xvfb** (§3.5): assert the *injector call* through the `CountingInjector` seam exposed behind a test-only flag, and record that real-seat injection is covered by the manual demo instead. This is stated up front so the fallback is a known, bounded trade-off — not a surprise.

The gate-open test spawns the **production binary** with the flag on; only the harness sets it. No separate test artifact exists (§9).

### 8.4 Manual demo (recorded) — real display, real input

1. Fedora dev machine (X11 *and* Wayland sessions, both recorded); build the agent.
2. Run `AGENT_CREDENTIAL=… ponter-agent --desktop-source screen --allow-input`.
3. `pnpm --filter @ponter/server dev` + `pnpm --filter @ponter/web dev`; open a desktop tab; confirm the Input toggle appears (`inputEnabled: true`).
4. Move the pointer over the video → the remote cursor moves to the matching source point; click, scroll, and type into a text field on the remote screen.
5. Repeat step 4 on a **Wayland** session and record the outcome honestly (XTest/`uinput`/portal) — this is the ADR-27 risk made visible.
6. On a **scaled** display (`scaleFactor != 1`), check the pointer lands where clicked — this exercises the §3.4 caveat.
7. Run once **without** `--allow-input` and confirm the toggle does **not** appear and input does nothing (the gate).

### 8.5 CI changes

No new workflow beyond Week 7/8's apt steps. The gate-closed test needs no new **CI system** dependency, but it does need the `spawnAgent` env-override described in §8.3 (a test-harness change, not a workflow change) so its `debug` log assert is observable. The gate-open test needs `xvfb` and `xdotool` in the E2E job's system-dependency step (the job already installs the capture stack); if adding them is undesirable, the §8.3 fallback applies and is recorded.

### 8.6 What is verified where

| Claim | Verified by |
|---|---|
| Gate closed ⇒ frame received, logged as dropped, session unharmed | E2E (§8.3, default; `RUST_LOG=debug` assert) |
| Gate open ⇒ injection reaches the OS | E2E under Xvfb (§8.3) or manual demo (§8.4) |
| Decode guard (channel/type/size) | Rust unit (§6.5) |
| Normalized → absolute mapping | Rust unit (§6.5) |
| Letterbox mapping | TS unit (§7.1) |
| Gate logic without a display | Rust unit via `CountingInjector` (§6.5) |
| Wayland / scaled-display behaviour | Manual demo (§8.4) |
| macOS/Windows compile | `Build Agent / macOS/x64`, `Build Agent / macOS/arm64`, `Build Agent / Windows/x64-msvc` |

---

## 9. Security & Error Handling

This is the heaviest section of Week 9, because input forwarding turns a read-only surface into a write surface.

### 9.1 The gate (decided: option **b** — a separate gate; input OFF by default)

The user's decision, recorded as ADR-29, is the **separate-gate** option: Week 9 ships the wire and the injection, but input is **inert by default** and stays inert until the identity/consent workstream (WS2/WS3) is green. The two options weighed were:

- **(a) In scope for Week 9** — implement peer-identity verification and explicit consent *this week*, then enable input. **Rejected:** it pulls an unsolved design (agent keypair, out-of-band fingerprint verification, H6/H5) into a week sized for input, and the input week would block on it. Higher risk, larger scope, and it would couple two large workstreams.
- **(b) A separate gate** — ship the mechanism now, gated off, and open it only when WS2/WS3 close. **Chosen:** it keeps Week 9's scope to input, keeps the dangerous surface closed by default, and makes the dependency explicit rather than implicit.

### 9.2 The gate mechanism (explicit, not vague)

- **One mechanism: an agent-local opt-in flag.** `--allow-input` (env `AGENT_ALLOW_INPUT`), default **false**, resolved into `SessionConfig` (§6.4).
- **Enforcement point:** the agent's control dispatcher, which **drops every `desktop-input` frame when the flag is false** (§6.3). Not a capability — `capabilities` is attacker-controlled (H3), so it can gate nothing.
- **Why this is a *hard* gate for the remote threat:** a remote peer or a compromised signaling server **cannot set** the agent's command-line flag or environment. With the flag false, the injection code path is unreachable from the network. The residual risk is a **local** actor who already has shell/CLI access to the machine — who could inject directly without this feature — so the gate does not widen the *local* surface.
- **Behaviour when closed:** the agent logs the drop and continues — **no injection, no error frame, no session effect** (§2.3). The browser hides its toggle because `desktop-sources.inputEnabled` is false (§7.2).
- **Honest limitation:** this is a **policy** gate, not a **capability** gate. The shipped binary *contains* the injection code and will inject if the flag is set. A capability gate (compile-time feature) would mean the shipped binary literally cannot inject — but then E2E would test a **non-production artifact**. The trade-off is stated so it is a known choice: **test fidelity versus capability gating**. Option (b) as decided keeps the *remote* path closed and tests the *same* binary.

### 9.3 The unresolved blockers this gate stands in for

The gate is a holding pattern, not a fix. The audit findings behind it:

- **H3 — no peer identity verification** (`:163`). Approval is granted on the `desktop` label alone (`apps/agent/src/main.rs:358-366`; the audit's `rtc.rs:186` cite has since drifted); the agent never verifies the client's key or DTLS fingerprint. This is *the* reason input cannot be enabled: on an unverified peer, injected input is remote control by an unauthenticated party. Closed by **WS2**.
- **H2 — `approved` flag never enforced** (`:149`). The agent's refusal flag is recorded but not checked server- or client-side. A hostile signaling server can deliver an answer the browser honours despite a refusal. Closed by **WS3**.
- **M7 — browser terminal input: base64 + JSON only, no crypto** (`:340`). Input is serialization, not encryption: keystrokes (including passwords) are plaintext at the application layer. The `desktop-input` frames inherit this; E2EE for input is **WS1** (Phase 5), not Week 9.
- **M8 — agent PTY output: base64 only; no crypto crates** (`:349`). The agent has no crypto dependency to decrypt an E2EE payload. Same WS1 dependency.

**Status:** all four remain **open** after Week 9 merges. The gate keeps the *consequence* (usable remote input) from shipping, but the *findings* are untouched — §11 records this explicitly.

### 9.4 Input validation and resource bounds

- **Decode guard.** Size cap before parsing (`MAX_FRAME_BYTES`, `apps/agent/src/pty.rs:26`); strict `channel == "control" && type == "desktop-input"`; coordinates clamped to `0..=1`; unknown `kind` rejected. A malformed or hostile frame is logged and dropped, never acted on.
- **Fail-soft injection.** A decode, mapping, or injector error is logged and dropped; the session and the stream keep running (§6.3). Input can never DoS the session.
- **Rate limiting is browser-side only — the agent does *not* rate-limit.** The browser coalesces `pointer-move` to `inputRateLimitHz` (default 60, §5.3) so a *well-behaved* client does not amplify. The agent, however, injects every `desktop-input` frame it decodes: it has **no** agent-side cap, so when the gate is open a hostile peer that floods frames produces unbounded injector calls. This is stated rather than hidden: because the gate is closed by default and only an operator can open it (ADR-29), the operator is **accepting input from any peer, verified or not, for the duration the gate is open**. That is a light availability risk, not an escalation — the peer still cannot reach anything the gate did not already open — and resistance to a hostile peer is exactly what **WS2/WS3** (peer identity + consent) exist to provide. A future hardening may add an agent-side coalescing cap; Week 9 deliberately does not, so the spec does not read as if both ends are rate-limited.
- **No new authorization, and that is stated, not hidden.** As in Week 7/8, the server never sees data-channel bytes (it relays only SDP/ICE), so the **agent** is the only enforcement point — which is why the gate lives there.
- **No new secrets.** TURN credentials continue to come from the existing server push.

---

## 10. Deliverables & Acceptance Criteria

### 10.1 Deliverables

| # | Artifact | Type |
|---|---|---|
| D1 | `packages/shared`: `types/desktop.ts` input union + `DesktopSourcesPayload` + re-export | Code |
| D2 | `packages/desktop-core`: `DesktopClient.sendInput` + rate limiting + tests | Code |
| D3 | `apps/agent`: `input.rs` (`InputInjector`, `decode_desktop_input`, `to_absolute`), control-dispatcher input branch, `SessionConfig.allow_input`, CLI `--allow-input`, musl gating | Code |
| D4 | `apps/web`: `toNormalized` helper, `DesktopView` input toggle + listeners, store action, footer indicator | Code |
| D5 | `packages/webrtc-core/test/e2e/desktop.e2e.test.ts` extensions (gate closed + gate open) | Test |
| D6 | Injection-library spike finding (enigo vs per-platform), recorded in ADR-27 | Artifact |
| D7 | Recorded manual Chrome demo (X11 + Wayland + scaled display) | Artifact |
| D8 | `docs/ARCHITECTURE.md` reconciliation + ADR-18 superseded note (§11) | Docs |

### 10.2 Acceptance criteria

1. `cargo test --locked` passes with the new unit tests on Linux — the `Build Agent / Verify` gate; the musl target still builds with no input dependency — the `Build Agent / Linux/x64-musl` gate.
2. `pnpm lint && pnpm typecheck && pnpm test` pass across the workspace including the new test surfaces — the `CI (Node) / Lint, Typecheck, Format & Node Tests` gate.
3. E2E `desktop.e2e.test.ts` passes: **with the gate closed (default)**, a `desktop-input` frame is received and logged as dropped (`RUST_LOG=debug` assert, §8.3), the session keeps streaming, and `desktop-sources.inputEnabled === false`; **with `--allow-input`**, a pointer-move produces an observable injection (or the recorded §8.3 fallback) and `inputEnabled === true` — the `CI (E2E) / Cross-language terminal E2E` gate.
4. The existing terminal and Week 7/8 desktop E2E suites still pass unchanged.
5. The recorded manual demo shows input working **only** with `--allow-input` (toggle appears, pointer/click/type land correctly) and **inert without it** (no toggle, no effect) — on X11, with the Wayland and scaled-display outcomes recorded honestly.
6. `ARCHITECTURE.md` records the Week 9 scope, marks ADR-18 superseded, and states that input ships gated off (§11).

**Explicitly NOT acceptance criteria** (so the AC cannot imply a usable feature):

- **"Input works end-to-end for a real user in production."** It does **not** — the gate is closed by default (ADR-29, §9). The AC above verifies the *mechanism* and the *gate*, not a usable capability.
- The ADR-27 injection-library spike (a goal that chooses a dependency, not a gate).
- Closing H3/H2/M7/M8 — those are WS2/WS3/WS1 and remain open (§9.3, §11).

### 10.3 Delivery sequence (single PR, `feat/phase3-week9-input-forwarding`)

1. Injection-library spike (ADR-27) → record the finding.
2. `packages/shared` input types.
3. `packages/desktop-core` `sendInput` + tests.
4. Agent `input.rs` + control-dispatcher input branch + CLI/gate + Rust tests.
5. Web `toNormalized` + `DesktopView` toggle/listeners + store + tests.
6. E2E gate-closed + gate-open (or the recorded fallback).
7. ARCHITECTURE.md reconciliation + ADR-18 superseded note + demo recording.
8. PR to `main`.

### 10.4 Review focus

- **The gate is the point.** Every path that could inject must sit behind `cfg.allow_input`; the gate-closed E2E test is the contract that proves the default build is inert (§8.3, ADR-29).
- **No new channel.** Input rides the Week 8 `control` channel; the terminal flow is untouched (ADR-26).
- **Fail-soft.** No decode/mapping/injection error can end the session (§6.3, §9.4).
- **Coordinate honesty.** The `scaleFactor`/DPR caveat (§3.4) is a recorded watch item, not silently assumed correct.
- **AC honesty.** §10.2 does not claim a usable feature; §9.3 states H3/H2 remain open.
- **musl.** The injection dependency is `cfg(not(target_env = "musl"))`; the musl artifact stays terminal-only.

---

## 11. Documentation Reconciliation (`docs/ARCHITECTURE.md`)

Reconciled in the same PR (D8):

1. **Roadmap §8** (`ARCHITECTURE.md:941-951`): the "Weeks 8-9" list's input item — "Mouse & keyboard control (input forwarding) — currently view-only (ADR-18)" — is annotated **partial**: the wire and injection land, but **input is gated off (ADR-29)** and is not usable until WS2/WS3. The item is **not** ticked as done. The `(ADR-18)` reference becomes `(ADR-18 superseded by ADR-26; gated by ADR-29)`.
2. **ADR-18 superseded.** The Week 7 spec's ADR-18 gains a superseded note pointing at ADR-26 (Week 9 spec), matching the roadmap annotation. The `<video>` is no longer unconditionally view-only — it is view-only *unless the gate is open*.
3. **Perf table** (`ARCHITECTURE.md:1087-1088`): Week 8's **D8** correction **has landed** — PR #27 (`82fa821`) replaced the false `Desktop stream (Phase 3 target) | 60fps | Hardware H.265` row with a Week 8 software row (`Desktop stream (Week 8) | 1080p30 (baseline 720p30) | Software H.264 (openh264)`) and a spike-gated hardware row (`Desktop stream (hardware, future) | 60fps | H.264 hardware / AV1 — spike ADR-25, unconfirmed`). No H.265 row remains, so no correction is pending here. (This spec originally recorded the row as "still present and still wrong" — that was true when the Week 8 spec merged (PR #24, spec-only) but the Week 8 *implementation* PR has since fixed it.) Week 9's D8 needs no perf-table edit.
4. **Security status.** The roadmap's Phase 5 workstream list (`ARCHITECTURE.md:961+`) already tracks WS1-WS5. Week 9 adds no new workstream; §9.3 records that **H3, H2, M7, M8 remain open** after the Week 9 merge, and that the gate is a holding pattern — the input feature is closed until **WS2** (peer identity, closes H3) and **WS3** (enforce `approved`, closes H2) land.

Phase 4's stub (`ARCHITECTURE.md:953-955`) is **not** touched (out of scope; §1.2).
