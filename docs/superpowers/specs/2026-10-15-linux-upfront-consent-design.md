# Linux Upfront Consent & Warm Capture Architecture — Design Spec

- **Status:** Draft (Framework established by BA; pending BE technical input integration)
- **Phase:** Native Platform & Streaming Optimization (Linux Wayland & X11)
- **Date:** 2026-10-15
- **Owner directive:** "Implement Linux Upfront Consent & Warm Capture Architecture (ADR-90) in two phases: (1) Warm Capture Session in `apps/agent` to retain PipeWire capture stream throughout agent lifetime; (2) Persistent Permission (`persist_mode: 2`, `restore_token`) + Unified ScreenCast & RemoteDesktop portal" (owner approval, 2026-10-15).
- **ADR:** ADR-90 (Linux Upfront Consent & Warm Capture Architecture)
- **Related ADRs:**
  - ADR-22 (Desktop Streaming Architecture — FrameSource abstraction & capture pipeline)
  - ADR-27 / ADR-28 (Input Forwarding & Injection — enigo, key codes, and Wayland limitations)
  - ADR-47 (Desktop Latency & Echo — seq tracking and round-trip telemetry)
  - ADR-53 (Setup Wizard & Probes — live capture readiness checks)
  - ADR-78 (Drop macOS Platform Support — repository focus on Linux and Windows)
  - ADR-89 (Unified API Access Standard — shared client access across components)
- **Related Files:**
  - `apps/agent/src/desktop.rs` (FrameSource, ScreenSource, capture worker thread, and PipeWire integration)
  - `apps/agent/src/lib.rs` (run_desktop_session, supervise_sessions, run_with_reconnect)
  - `apps/agent/src/input.rs` (InputInjector, enigo injection, coordinate scaling)
  - `apps/agent/vendor/xcap/**` (vendored xcap 0.9.8 Linux Wayland ScreenCast session)
  - `apps/agent/Cargo.toml` (Linux dependencies: ashpd, zbus, pipewire, enigo)

---

## 1. Context & Problem Statement

On Linux running modern Wayland compositors (GNOME Shell/Mutter 45+, KDE Plasma 6+), application access to display capture and synthetic input injection is strictly mediated by the Freedesktop Desktop Portal (`xdg-desktop-portal`). Unlike X11 where any client can capture the root window and inject events via the XTEST extension without OS prompts, Wayland enforces security boundaries requiring user consent.

While these boundaries protect user privacy, the current implementation in `apps/agent` suffers from three architectural flaws:

### Flaw 1: Session Teardown on Client Disconnect (The "Dialog Storm")
In `apps/agent/src/lib.rs:1920-1932`, `desktop::source_for(&default_id, ...)` constructs a `ScreenSource` exclusively upon receiving a WebRTC `offer` during `run_desktop_session`. When the client disconnects, `run_desktop_session` terminates, dropping the `FrameSource` (`ScreenSource`).
On Wayland, dropping `ScreenSource` terminates the `ScreenCast` portal session and destroys the underlying PipeWire stream node (`apps/agent/vendor/xcap/PATCH.md`). Consequently, when the remote user reconnects 10 seconds later, or if the network temporarily drops, the agent must initialize a brand-new portal session, forcing the host user to click through another modal system consent dialog ("Share your screen?"). For unattended access or recurring remote maintenance, this behavior is a critical usability failure.

### Flaw 2: Fragmented Consent & Broken Wayland Input
Currently, screen capture uses `xcap` (invoking `org.freedesktop.portal.ScreenCast`), while input injection is handled by `enigo` (`apps/agent/src/input.rs:335`). In `enigo` 0.6.1 on Linux, the backend is strictly `x11rb`-only. On Wayland sessions, `enigo` is a silent no-op (`week9-input-known-limitations.md`).
Even if remote input were added via an independent portal request, the host user would be confronted with **two disjoint OS consent dialogs**: one for viewing the screen (`ScreenCast`) and a separate one for controlling inputs (`RemoteDesktop`).

### Flaw 3: Ephemeral Authorization on Process Restart
When the agent process restarts (e.g. system reboot, daemon upgrade, or configuration reload), standard portal requests are treated as fresh sessions. Without requesting persistent permissions (`persist_mode: 2`) and persisting a `restore_token`, the agent cannot resume streaming headlessly without physical human presence at the host machine.

---

## 2. Goals & Non-Goals

### Goals
- **G1: Lifetime Capture Retention (Warm Session).** Maintain the PipeWire capture stream alive throughout the entire lifetime of `apps/agent`. Reconnecting clients attach instantaneously to the warm capture pipeline without triggering OS dialogs.
- **G2: Single Unified OS Consent Dialog.** Unify display capture (`ScreenCast`) and remote input control (`RemoteDesktop`) into a single portal session request on Wayland, presenting the user with exactly **one** authorization dialog.
- **G3: Persistent Headless Reconnects.** Leverage `xdg-desktop-portal` `persist_mode: 2` with `restore_token` caching to allow `apps/agent` to restart and resume capture and control without prompting the user.
- **G4: Negligible Idle Overhead.** When no WebRTC client is connected, the warm capture session must idle gracefully (suspend encoding, pause or throttle PipeWire buffer processing, and consume minimal CPU/GPU memory).
- **G5: Seamless Backward Compatibility & Fallbacks.** Maintain existing behavior on X11 (where XTEST and direct capture operate without portals) and compositors lacking `RemoteDesktop` portal support (e.g. wlroots/Sway).

### Non-Goals
- **NG1: Client-Side Portal Integration.** This spec applies strictly to `apps/agent` (the controlled host). The client viewing application (Web UI, Electron/native desktop) is unaffected.
- **NG2: Virtual Display Creation (Headless Dummy Monitored Output).** Creating virtual outputs without a physical display is outside the scope of ADR-90 (handled via existing dummy plug or DRM/KMS headless drivers).
- **NG3: macOS Support.** Per ADR-78, macOS is completely dropped; all architecture decisions target Linux and Windows only.

---

## 3. Phased Implementation Roadmap

To deliver immediate user value while managing architectural complexity, the feature is structured into two sequential phases:

```
+-------------------------------------------------------------------------------+
| PHASE 1: Warm Capture Session in apps/agent                                   |
|                                                                               |
| - Hoist ScreenSource / PipeWire capture lifetime to Agent process scope       |
| - State Machine: Uninitialized -> Warming -> WarmIdle <-> ActiveStreaming     |
| - Low-overhead idle loop (pause frame processing & encode when no peer)       |
| - Instant first-frame delivery on client offer (< 10 ms vs 5000 ms timeout)   |
| - Zero dialogs on client reconnect during agent process lifetime              |
+-------------------------------------------------------------------------------+
                                      |
                                      v
+-------------------------------------------------------------------------------+
| PHASE 2: Persistent Authorization & Unified Portal (ScreenCast + RemoteDesktop)|
|                                                                               |
| - Drive org.freedesktop.portal.RemoteDesktop (v2) with ScreenCast options     |
| - Single OS consent prompt for both display viewing + mouse/keyboard control  |
| - Persistent permission via persist_mode: 2 & restore_token storage           |
| - Wayland input forwarding via RemoteDesktop D-Bus Notify* or EIS / libei     |
| - Headless agent restarts without OS prompts                                  |
+-------------------------------------------------------------------------------+
```

---

## 4. Phase 1 Detailed Design: Warm Capture Session

### 4.1 Architecture & Lifetime Management

In Phase 1, capture ownership is decoupled from the transient `run_desktop_session` lifetime and hoisted to `supervise_sessions` or the top-level agent runtime in `apps/agent/src/lib.rs`.

```
                         apps/agent Process Lifecycle
+----------------------------------------------------------------------------+
|                                                                            |
|  [Agent Startup]                                                           |
|         │                                                                  |
|         ▼                                                                  |
|  ┌──────────────┐                                                          |
|  │ WarmCapture  │ ──► [OS Portal Dialog] (Prompted ONCE on agent start)    |
|  │ Manager      │ ──► [PipeWire Stream Connected]                          |
|  └──────┬───────┘                                                          |
|         │                                                                  |
|         ▼                                                                  |
|   (WarmIdle State: PipeWire source retained, frame dispatch dormant)       |
|         │                                                                  |
|         ├───► Client Session 1 Connects ──► Attach Track ──► ActiveStreaming
|         │                                                          │       |
|         │                                                          ▼       |
|         ├───► Client Session 1 Disconnects ◄───────────────────────┘       |
|         │     (Detaches track; Stream remains WarmIdle; ZERO prompt)       |
|         │                                                                  |
|         ├───► Client Session 2 Connects ──► Attach Track ──► ActiveStreaming
|         │     (First frame immediate; ZERO prompt)                         |
|         │                                                                  |
|         ▼                                                                  |
|  [Agent SIGINT/SIGTERM] ──► Graceful Teardown of PipeWire & Portal Session  |
+----------------------------------------------------------------------------+
```

### 4.2 Warm Capture State Machine

The capture manager transitions across four defined states:

| State | PipeWire Session | Capture Thread | WebRTC Encoding | Action on Offer |
|---|---|---|---|---|
| `Uninitialized` | Closed | Dormant | None | Trigger warmup or refuse |
| `Warming` | Connecting / Awaiting First Frame | Spawning | None | Queue offer until warm |
| `WarmIdle` | Active & Retained | Polling throttled / buffers drained | Paused | Instant track attachment |
| `ActiveStreaming`| Active & Retained | Full rate (30/60 FPS) | Active | Route frames to WebRTC |
| `Faulted` | Disconnected / Stale Node | Stopped | Error | Trigger reconnect / re-warm |

### 4.3 Low-Overhead Idle Mode (`WarmIdle`)
When transitioning from `ActiveStreaming` to `WarmIdle`:
1. The WebRTC desktop track stops consuming frames.
2. The software encoder (OpenH264 / VP8 / VP9) is suspended, eliminating CPU encoding overhead.
3. The capture thread drains incoming PipeWire buffers with zero-copy drop or signals PipeWire stream pause (to be refined in [BE-INPUT-2]), preventing buffer starvation in Mutter/KWin.

---

## 5. Phase 2 Detailed Design: Persistent Permission & Unified Portal

### 5.1 Unified Portal Request Flow (Single Dialog)

Phase 2 replaces separate portal interactions with a unified `org.freedesktop.portal.RemoteDesktop` (v2) session that embeds `ScreenCast` options in a single D-Bus transaction.

```
apps/agent                                                xdg-desktop-portal
    │                                                             │
    │ 1. CreateSession(session_handle_token)                      │
    ├────────────────────────────────────────────────────────────►│
    │ ◄── session_handle ─────────────────────────────────────────┤
    │                                                             │
    │ 2. SelectDevices(session_handle, types: Pointer|Keyboard,   │
    │                  persist_mode: 2, restore_token)            │
    ├────────────────────────────────────────────────────────────►│
    │ ◄── Response(Ok) ───────────────────────────────────────────┤
    │                                                             │
    │ 3. ScreenCast.SelectSources(session_handle, types: Monitor, │
    │                             persist_mode: 2, restore_token) │
    ├────────────────────────────────────────────────────────────►│
    │ ◄── Response(Ok) ───────────────────────────────────────────┤
    │                                                             │
    │ 4. Start(session_handle, parent_window: "")                 │
    ├────────────────────────────────────────────────────────────►│
    │                                                             │
    │    [OS displays ONE unified prompt: "Allow Ponter to view   │
    │     and control your screen & devices? [Remember]"]         │
    │                                                             │
    │ ◄── Response(streams, devices, restore_token) ──────────────┤
    │                                                             │
    │ 5. OpenPipeWireRemote(session_handle)                       │
    ├────────────────────────────────────────────────────────────►│
    │ ◄── PipeWire fd ────────────────────────────────────────────┤
```

### 5.2 Persistence & `restore_token` Management

1. **Persistence Mode:** Passing `persist_mode: 2` instructs the compositor to remember this grant until explicitly revoked by the user in system settings (e.g. GNOME Settings -> Sharing -> Remote Desktop).
2. **Token Storage:** The agent securely saves the returned `restore_token` to disk:
   - Path: `~/.config/ponter/agent/portal_token` (Linux standard, permissions `0600`).
3. **Headless Warmup:** On subsequent process launches, `apps/agent` reads `portal_token` and supplies it during steps 2 and 3. The portal skips the modal UI entirely and returns active handles immediately.
4. **Revocation & Invalidation Recovery:** If the user revokes access in OS settings or the token expires, the portal returns `Response.Cancelled` or `Error.InvalidToken`. The agent must purge the stored token, transition to explicit authorization mode, and prompt cleanly on the next session.

### 5.3 Wayland Remote Input Injection
Once the `RemoteDesktop` session is established, input forwarded over the WebRTC data channel (`desktop-input`) is injected via:
- Primary: `org.freedesktop.portal.RemoteDesktop` D-Bus methods:
  - `NotifyPointerMotion(session_handle, options, dx, dy)` / `NotifyPointerMotionAbsolute(session_handle, options, stream, x, y)`
  - `NotifyPointerButton(session_handle, options, button, state)`
  - `NotifyPointerAxis(session_handle, options, dx, dy)`
  - `NotifyKeyboardKeycode(session_handle, options, keycode, state)` / `NotifyKeyboardKeysym(...)`
- Alternative / Future: Emulated Input Server (EIS / `libei`) if preferred by compositor (details in [BE-INPUT-4]).

---

## 6. Compositor Compatibility Matrix & Fallback Strategies

| Platform / Compositor | Phase 1 Warm Capture | Phase 2 Unified Portal | Phase 2 Persistence (`persist_mode: 2`) | Input Mechanism |
|---|---|---|---|---|
| **GNOME 45+ (Wayland)** | Supported (PipeWire) | Supported (`RemoteDesktop` v2) | Supported (`restore_token`) | Portal Notify / libei |
| **KDE Plasma 6+ (Wayland)** | Supported (PipeWire) | Supported (`RemoteDesktop` v2) | Supported (`restore_token`) | Portal Notify |
| **wlroots / Sway / Hyprland** | Supported (`xdg-desktop-portal-wlr`) | Not Supported (ScreenCast only) | Varies by portal backend | Fallback: `uinput` or read-only view |
| **Linux X11** | Supported (Warm X11 capture) | Not Applicable (No portal) | Not Applicable | Native `x11rb` / `enigo` (no prompt) |
| **Windows** | Supported (Existing WGC/DXGI) | Not Applicable | Not Applicable | Win32 SendInput |

---

## 7. Security & Sandboxing Considerations

- **Explicit User Consent:** Security boundaries remain intact. The initial grant always requires explicit user confirmation in the native OS dialog.
- **Revocability:** Persisted tokens are revocable at any time via the host OS desktop settings or by deleting the token file.
- **Token Protection:** The `portal_token` file is stored with strict user-only read/write permissions (`0600`). It is never transmitted across the network or included in logging outputs.
- **Fail-Safe Refusal:** If a portal session cannot be warmed or is denied, the agent sends a clean WebRTC refusal (`approved: false`) rather than hanging or streaming a black frame.

---

## 8. Technical Input Integration Points (BE Input Placeholders)

The following sections are designated for concrete technical parameters and implementation details to be populated from Backend Engineering (BE) input:

### [BE-INPUT-1]: D-Bus & Portal Library Strategy
- Evaluation of Rust portal crates for `apps/agent`:
  - Option A: `ashpd` (high-level, type-safe Freedesktop portal bindings). Version, feature flags, async runtime compatibility (`tokio`), and binary footprint.
  - Option B: `zbus` (direct low-level D-Bus calls). Minimal dependencies, fine-grained control over handles and fds.
  - Option C: Upgrading / extending vendored `xcap`.

### [BE-INPUT-2]: PipeWire Stream Idle Behavior
- Exact mechanism for `WarmIdle` stream management:
  - Does Mutter / KWin require continuous buffer dequeueing to avoid PipeWire pipeline stall?
  - Recommended idle frame rate vs `pw_stream_set_active(false)` vs zero-copy discard in the worker thread.

### [BE-INPUT-3]: D-Bus Signatures & Parameter Mappings
- Exact dictionary keys and variant signatures for:
  - `SelectDevices`: device bitmask (`1 = Keyboard`, `2 = Pointer`, `4 = Touchscreen`).
  - `ScreenCast.SelectSources`: source types (`1 = Monitor`, `2 = Window`), cursor mode (`2 = Embedded`, `4 = Metadata`).
  - `persist_mode`: numeric value confirmation (`1 = transient`, `2 = persistent`).

### [BE-INPUT-4]: Input Injection Driver Specification
- Mapping `desktop-input` WebRTC frames to Wayland injection:
  - D-Bus `NotifyPointerMotionAbsolute` coordinate space mapping (`stream` index vs global surface coordinates).
  - Linux evdev keycode mapping vs XKB keysym mapping for `NotifyKeyboardKeycode`.
  - libei / EIS socket integration vs D-Bus direct calls.

---

## 9. ADR-90 Formal Decision Record

### Title
**ADR-90: Linux Upfront Consent & Warm Capture Architecture**

### Context
Modern Linux desktop environments on Wayland restrict screen capture and synthetic input injection behind portal permissions. Re-prompting for permission on every client connection degrades user experience and blocks headless reconnects. Furthermore, `enigo` cannot inject input on Wayland, leaving input forwarding broken.

### Decision
1. **Adopt a Two-Phase Implementation:**
   - **Phase 1:** Implement a Warm Capture Session in `apps/agent`, retaining the PipeWire stream across multiple WebRTC client connections throughout the agent process lifetime.
   - **Phase 2:** Implement a unified `org.freedesktop.portal.RemoteDesktop` session combining `ScreenCast` and input devices, using `persist_mode: 2` and caching `restore_token` for persistent, headless authorization.
2. **Preserve Compatibility:** Fall back gracefully to ScreenCast-only or native X11 paths on environments without full unified portal support.

### Consequences
- **Positive:**
  - Zero OS dialog spam on client reconnects during agent uptime (Phase 1).
  - Single unified consent dialog covering both screen sharing and remote control (Phase 2).
  - Unattended/headless agent restarts enabled via persistent `restore_token` (Phase 2).
  - Working remote input forwarding on modern GNOME and KDE Wayland desktops (Phase 2).
- **Negative / Costs:**
  - Additional complexity in agent lifecycle management (managing capture state independent of connection state).
  - Added dependency footprint for D-Bus / portal integration (`ashpd` or `zbus`).
  - Wayland input behavior varies across desktop environments; compositors lacking RemoteDesktop portals will remain read-only or require fallback mechanisms.

### Status
**Draft — Approved in principle by Owner (2026-10-15); Design Spec skeleton prepared by BA; awaiting BE technical input integration.**
