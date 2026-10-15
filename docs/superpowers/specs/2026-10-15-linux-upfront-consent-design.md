# Linux Upfront Consent & Warm Capture Architecture — Design Spec

- **Status:** Approved (Owner approved; BE technical input integrated; ready for implementation planning)
- **Phase:** Native Platform & Streaming Optimization (Linux Wayland & X11)
- **Date:** 2026-10-15
- **Owner directive:** "Implement Linux Upfront Consent & Warm Capture Architecture (ADR-90) in two phases: (1) Warm Capture Session in `apps/agent` to retain PipeWire capture stream throughout agent lifetime; (2) Persistent Permission (`persist_mode: 2`, `restore_token`) + Unified ScreenCast & RemoteDesktop portal" (owner approval, 2026-10-15).
- **Technical RFC Source:** `docs/notes/2026-10-15-linux-screen-capture-remote-desktop-adr90-be-input.md` (BE Technical Input)
- **ADR:** ADR-90 (Linux Upfront Consent & Warm Capture Architecture)
- **Related ADRs:**
  - ADR-22 (Desktop Streaming Architecture — FrameSource abstraction & capture pipeline)
  - ADR-27 / ADR-28 (Input Forwarding & Injection — enigo, key codes, and Wayland limitations)
  - ADR-47 (Desktop Latency & Echo — seq tracking and round-trip telemetry)
  - ADR-53 (Setup Wizard & Probes — live capture readiness checks)
  - ADR-78 (Drop macOS Platform Support — repository focus on Linux and Windows)
  - ADR-79 (Windows Monitor Capture 3-Tier Fallback — WGC → DXGI → GDI)
  - ADR-89 (Unified API Access Standard — shared client access across components)
- **Related Files:**
  - `apps/agent/src/desktop.rs` (FrameSource, ScreenSource, capture worker thread, and PipeWire integration)
  - `apps/agent/src/lib.rs` (run_desktop_session, supervise_sessions, run_with_reconnect)
  - `apps/agent/src/input.rs` (InputInjector, enigo injection, coordinate scaling)
  - `apps/agent/vendor/xcap/**` (vendored xcap 0.9.8 Linux Wayland ScreenCast session)
  - `apps/agent/Cargo.toml` (Linux dependencies: zbus, pipewire, enigo)

---

## 1. Context & Problem Statement

On Linux running modern Wayland compositors (GNOME Shell/Mutter 45+, KDE Plasma 6+), application access to display capture and synthetic input injection is strictly mediated by the Freedesktop Desktop Portal (`xdg-desktop-portal`). Unlike X11 where any client can capture the root window and inject events via the XTEST extension without OS prompts, Wayland enforces security boundaries requiring user consent.

While these boundaries protect user privacy, the current implementation in `apps/agent` suffers from three architectural flaws:

### Flaw 1: Session Teardown on Client Disconnect (The "Dialog Storm")
In `apps/agent/src/lib.rs:1920-1932`, `desktop::source_for(&default_id, ...)` constructs a new capture source (`xcap::Monitor::video_recorder()`) exclusively upon receiving a WebRTC `offer` during `run_desktop_session`. When the client disconnects, `run_desktop_session` terminates, dropping the `FrameSource` (`ScreenSource`).
On Wayland, dropping `ScreenSource` terminates the `ScreenCast` portal session and destroys the underlying PipeWire stream node (`apps/agent/vendor/xcap/PATCH.md`). Consequently, when the remote user reconnects 10 seconds later, or if the network temporarily drops, the agent must initialize a brand-new portal session, forcing the host user to click through another modal system consent dialog ("Share your screen?"). For unattended access or recurring remote maintenance, this behavior is a critical usability failure.

### Flaw 2: Fragmented Consent & Broken Wayland Input
Currently, screen capture uses `xcap` (invoking `org.freedesktop.portal.ScreenCast`), while input injection is handled by `enigo` (`apps/agent/src/input.rs:335`). In `enigo` 0.6.1 on Linux, the backend is strictly `x11rb`-only. Under Wayland, native Wayland windows refuse synthetic X11 input events due to compositor security boundaries (`week9-input-known-limitations.md`). The agent receives input frames over the data channel, logs success, but the mouse/keyboard actions do not affect native Wayland windows.
Even if remote input were added via an independent portal request, the host user would be confronted with **two disjoint OS consent dialogs**: one for viewing the screen (`ScreenCast`) and a separate one for controlling inputs (`RemoteDesktop`).

### Flaw 3: Ephemeral Authorization on Process Restart
When the agent process restarts (e.g. system reboot, daemon upgrade, or configuration reload), standard portal requests are treated as fresh sessions. Without requesting persistent permissions (`persist_mode: 2`) and persisting a `restore_token`, the agent cannot resume streaming headlessly without physical human presence at the host machine.

---

## 2. Goals & Non-Goals

### Goals
- **G1: Lifetime Capture Retention (Warm Session).** Maintain the PipeWire capture stream alive continuously throughout the entire lifetime of `apps/agent`. Reconnecting clients attach instantaneously to the warm capture pipeline without triggering OS dialogs.
- **G2: Single Unified OS Consent Dialog.** Unify display capture (`ScreenCast`) and remote input control (`RemoteDesktop`) into a single portal session request on Wayland, presenting the user with exactly **one** authorization dialog.
- **G3: Persistent Headless Reconnects.** Leverage `xdg-desktop-portal` `persist_mode: 2` with `restore_token` caching to allow `apps/agent` to restart and resume capture and control without prompting the user.
- **G4: Zero-Overhead Idle Mode.** When no WebRTC client is connected, the warm capture session must idle gracefully: call `stream.set_active(false)` on PipeWire to halt frame generation, suspend video encoding, and consume strictly 0.0% CPU/GPU overhead.
- **G5: Native Wayland Input Injection.** Implement a dedicated `PortalInputInjector` communicating directly with `org.freedesktop.portal.RemoteDesktop` over D-Bus (`zbus 5`), resolving the Wayland input limitation without dynamic C library dependencies (`libei`).
- **G6: Seamless Backward Compatibility & Fallbacks.** Maintain existing behavior on X11 (where XTEST and direct capture operate without portals), Windows, and compositors lacking `RemoteDesktop` portal support (e.g. wlroots/Sway).

### Non-Goals
- **NG1: Client-Side Portal Integration.** This spec applies strictly to `apps/agent` (the controlled host). The client viewing application (Web UI, Electron/native desktop) is unaffected.
- **NG2: Virtual Display Creation (Headless Dummy Monitored Output).** Creating virtual outputs without a physical display is outside the scope of ADR-90 (handled via existing dummy plug or DRM/KMS headless drivers).
- **NG3: macOS Support.** Per ADR-78, macOS is completely dropped; all architecture decisions target Linux and Windows only.

---

## 3. Phased Implementation Roadmap

To deliver immediate user value while managing architectural complexity and minimizing regression risk, the feature is structured into two sequential delivery phases across two independent PRs:

```
+-----------------------------------------------------------------------------------+
| PHASE 1: Warm Capture Session in apps/agent (PR1)                                 |
|                                                                                   |
| - Introduce WarmCaptureManager wrapping existing vendored xcap::VideoRecorder    |
| - Hoist ScreenSource / PipeWire capture lifetime to Agent process scope           |
| - State Machine: UNINITIALIZED -> INITIALIZING -> IDLE_PAUSED <-> ACTIVE_STREAMING|
| - Low-overhead idle loop (pw_stream_set_active(false), 0.0% CPU/GPU overhead)     |
| - Instant first-frame delivery on client offer (< 10 ms vs 5000 ms timeout)       |
| - Zero dialogs on client reconnect during agent process lifetime                  |
| - Zero new dependencies, zero crate additions                                     |
+-----------------------------------------------------------------------------------+
                                          │
                                          ▼
+-----------------------------------------------------------------------------------+
| PHASE 2: Persistent Authorization & Unified RemoteDesktop Portal (PR2)            |
|                                                                                   |
| - Drive org.freedesktop.portal.RemoteDesktop (v2) with ScreenCast via zbus 5      |
| - Single OS consent prompt for both display viewing + mouse/keyboard control      |
| - Persistent permission via persist_mode: 2 & restore_token file storage          |
| - Native Wayland input injection via RemoteDesktop D-Bus Notify* APIs             |
| - Headless agent restarts without OS prompts                                      |
| - Deprecate no-op X11 enigo path on Wayland                                       |
+-----------------------------------------------------------------------------------+
```

---

## 4. Phase 1 Detailed Design: Warm Capture Session in `apps/agent`

### 4.1 Architecture & Lifetime Management

In Phase 1, capture ownership is decoupled from the transient `run_desktop_session` lifetime and hoisted to `supervise_sessions` or the top-level agent runtime in `apps/agent/src/lib.rs`.

```
                         apps/agent Process Lifecycle
+-----------------------------------------------------------------------------------+
|                                                                                   |
|  [Agent Startup]                                                                  |
|         │                                                                         |
|         ▼                                                                         |
|  ┌───────────────────────┐                                                        |
|  |  WarmCaptureManager   | ──► [OS Portal Dialog] (Prompted ONCE on agent start)  |
|  |  - xcap::VideoRecorder| ──► [PipeWire Stream Connected: StreamRc]              |
|  └──────────┬────────────┘                                                        |
|             │                                                                     |
|             ▼                                                                     |
|   (IDLE_PAUSED State: stream.set_active(false), 0.0% CPU/GPU, stream retained)    |
|             │                                                                     |
|             ├─────► Client Session 1 Connects ──► stream.set_active(true)         |
|             │                                      │ (ACTIVE_STREAMING)           |
|             │                                      ▼                              |
|             ├─────► Client Session 1 Disconnects ◄─┘                              |
|             │       (stream.set_active(false); IDLE_PAUSED; ZERO prompt)          |
|             │                                                                     |
|             ├─────► Client Session 2 Connects ──► stream.set_active(true)         |
|             │       (First frame immediate; ZERO prompt)                          |
|             │                                                                     |
|             ▼                                                                     |
|  [Agent SIGINT/SIGTERM] ──► Graceful Teardown of PipeWire & Portal Session         |
+-----------------------------------------------------------------------------------+
```

### 4.2 Warm Capture State Machine

The capture manager transitions across five defined states:

| State | PipeWire Stream | ScreenCast D-Bus | WebRTC Peer | CPU / GPU Overhead | Action on Offer |
|---|---|---|---|---|---|
| `UNINITIALIZED` | Not connected | None | None | 0% | Trigger warmup or refuse |
| `INITIALIZING` | Connecting | Requesting prompt | Waiting | Negligible | Queue offer until warm |
| `IDLE_PAUSED` | `set_active(false)` | Alive & Connected | None (no active offer) | **0.0%** (buffers flushed) | Instant track attachment |
| `ACTIVE_STREAMING`| `set_active(true)` | Alive & Connected | Connected (encoding RTP) | Normal encode (~3-5% CPU) | Route frames to WebRTC |
| `SHUTDOWN` | Disconnected | Cleanly closed | Closed | 0% | N/A |

### 4.3 Resource Management & Zero-Overhead Idle Guarantee

In `apps/agent/vendor/xcap/src/linux/wayland_video_recorder.rs`:
```rust
// PipeWire stream pause hook:
active_receiver.attach(main_loop.loop_(), move |active| {
    if let Err(e) = stream.set_active(active) {
        log::error!("Failed to set stream active={active}: {e:?}");
    }
    if !active && let Err(e) = stream.flush(true) {}
});
```

* **Compositor Stall Verification ([BE-INPUT-2]):**
  - Mutter and KWin do **not** require continuous buffer dequeueing when the stream is paused via `stream.set_active(false)` (invoking PipeWire's `pw_stream_set_active`).
  - In the paused state, PipeWire transitions the node state to `PAUSED`. The compositor halts frame production and stops pushing buffers into the shared memory queue.
  - PipeWire does **not** stall or disconnect; the D-Bus portal session remains fully active.
  - Calling `stream.flush(true)` on transition to idle drains any remaining frames in the ring buffer.
* **Overhead Guarantee:**
  - CPU/GPU consumption during `IDLE_PAUSED` state is strictly **0.0%**. No frames are encoded, scaled, or transmitted.
  - When a WebRTC client reconnects, calling `stream.set_active(true)` immediately triggers frame production from the next compositor vsync tick without user interaction.

### 4.4 Integration Points in `apps/agent`
1. `apps/agent/src/desktop.rs`:
   - Introduce `WarmCaptureManager`:
     ```rust
     pub struct WarmCaptureManager {
         inner: Arc<Mutex<Option<WarmCaptureState>>>,
     }
     ```
   - Introduce `WarmScreenSource: FrameSource` implementing `next_frame()` and `stop()`. Calling `stop()` does not destroy the underlying recorder; it decrements the active lease count and pauses the stream when leases reach zero.
2. `apps/agent/src/lib.rs`:
   - Store `WarmCaptureManager` inside `AgentRuntime`.
   - On agent startup (or on first desktop offer), initialize the warm capture session.
   - On agent shutdown (`SIGINT` / `SIGTERM`), cleanly shut down `WarmCaptureManager`.

---

## 5. Phase 2 Detailed Design: Persistent Permission & Unified RemoteDesktop Portal

### 5.1 Unified Portal Request Flow (Single Dialog UX)

Phase 2 replaces standalone `ScreenCast` portal negotiation with unified `org.freedesktop.portal.RemoteDesktop` (v2) communicating directly via `zbus 5`:

```
                 Agent (Client)                      xdg-desktop-portal / Mutter / KWin
                       │                                              │
 1. CreateSession      │ ───── CreateSession(options) ──────────────► │
                       │ ◄──── session_handle ─────────────────────── │
                       │                                              │
 2. SelectDevices      │ ───── SelectDevices(session, types: 3) ────► │ (1: Keyboard, 2: Pointer)
                       │ ◄──── Response ───────────────────────────── │
                       │                                              │
 3. SelectSources      │ ───── SelectSources(session,                 │
                       │         types: 1, multiple: false,           │
                       │         cursor_mode: 2, persist_mode: 2,     │
                       │         restore_token: "cached_token") ────► │
                       │ ◄──── Response ───────────────────────────── │
                       │                                              │
 4. Start              │ ───── Start(session, parent_window,          │
                       │         restore_token: "cached_token") ────► │
                       │                                              │ [If restore_token valid: SILENT]
                       │                                              │ [If token absent/invalid: 1 MODAL]
                       │ ◄──── Response(streams, devices,             │
                       │                new_restore_token) ────────── │
                       │                                              │
 5. OpenPipeWireRemote │ ───── OpenPipeWireRemote(session) ─────────► │
                       │ ◄──── OwnedFd ────────────────────────────── │
```

* **Single Combined Prompt User Experience:**
  On GNOME 45+ and KDE Plasma 6+, invoking `SelectDevices` followed by `SelectSources` on the same session causes the portal to aggregate the requests into a single dialog:
  > **"Allow Ponter to view and control your desktop?"**
  > - Screen: *Entire Display (Monitor 1)*
  > - Permissions: *Control mouse and keyboard*
  > - [x] *Remember this decision* (granted via `persist_mode: 2`)
  The user clicks "Allow" **once**. Both screen capture and remote input control are authorized simultaneously.

### 5.2 Persistence & `restore_token` Management

* **Portal Specification:**
  - `persist_mode: 0` = Do not persist (default).
  - `persist_mode: 1` = Persist while the application is running.
  - `persist_mode: 2` = Persist until explicitly revoked by the user in system settings.
* **Token Storage Contract:**
  - Storage Location: `$XDG_CONFIG_HOME/ponter/remote-desktop.token` (fallback: `~/.config/ponter/remote-desktop.token`).
  - File Permissions: Strictly `0600` (`S_IRUSR | S_IWUSR`), readable only by the agent user.
  - File Contents:
    ```json
    {
      "version": 1,
      "restore_token": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      "granted_at": 1776234567,
      "device_mask": 3,
      "session_type": "wayland"
    }
    ```
* **Reconnection / Boot Sequence:**
  1. Agent boots, reads `remote-desktop.token`.
  2. If token exists, pass `restore_token` in `SelectSources` and `Start`.
  3. Compositor validates token against internal permission store (e.g. `permission-store` in Flatpak/Portal DB).
  4. If valid: portal returns `Response::Success` with stream node IDs **without displaying any UI**.
  5. If invalid or revoked (error returned or dialog cancelled):
     - Delete stale token file.
     - Retry with interactive prompt (clean `persist_mode: 2` without token).
     - Upon user grant, store the newly minted `restore_token`.

### 5.3 Native Wayland Input Injection Implementation

When operating under an active `RemoteDesktop` portal session, the agent does not use `enigo`. Instead, it provides an implementation of `InputInjector` (`PortalInputInjector`) backed by `zbus 5`:

```rust
pub struct PortalInputInjector {
    session: OwnedObjectPath,
    stream_id: u32,
    proxy: RemoteDesktopProxy<'static>,
}

impl InputInjector for PortalInputInjector {
    fn pointer_move(&mut self, x: i32, y: i32) -> Result<()> {
        // NotifyPointerMotionAbsolute: stream coordinates (0..width, 0..height)
        self.proxy.notify_pointer_motion_absolute(
            &self.session,
            &options,
            self.stream_id,
            x as f64,
            y as f64,
        )?;
        Ok(())
    }

    fn pointer_button(&mut self, button: Button, pressed: bool) -> Result<()> {
        // Linux evdev button mapping: BTN_LEFT=0x110, BTN_RIGHT=0x111, BTN_MIDDLE=0x112
        let btn_code = match button {
            Button::Left => 0x110,
            Button::Right => 0x111,
            Button::Middle => 0x112,
        };
        let state = if pressed { 1 } else { 0 };
        self.proxy.notify_pointer_button(&self.session, &options, btn_code, state)?;
        Ok(())
    }

    fn wheel(&mut self, dx: i32, dy: i32) -> Result<()> {
        // NotifyPointerAxis: dx (horizontal), dy (vertical)
        if dy != 0 {
            self.proxy.notify_pointer_axis(&self.session, &options, dy as f64, 0 /* vertical */)?;
        }
        if dx != 0 {
            self.proxy.notify_pointer_axis(&self.session, &options, dx as f64, 1 /* horizontal */)?;
        }
        Ok(())
    }

    fn key(&mut self, code: &str, pressed: bool, _mods: &KeyModifiers) -> Result<()> {
        // Translate KeyboardEvent.code to Linux evdev keycode (e.g., "KeyA" -> 30)
        let Some(evdev_code) = map_code_to_evdev(code) else {
            return Ok(());
        };
        let state = if pressed { 1 } else { 0 };
        self.proxy.notify_keyboard_keycode(&self.session, &options, evdev_code, state)?;
        Ok(())
    }

    fn text(&mut self, text: &str) -> Result<()> {
        // NotifyKeyboardKeysym for unicode text insertion
        for ch in text.chars() {
            let keysym = char_to_keysym(ch);
            self.proxy.notify_keyboard_keysym(&self.session, &options, keysym, 1)?;
            self.proxy.notify_keyboard_keysym(&self.session, &options, keysym, 0)?;
        }
        Ok(())
    }
}
```

---

## 6. Comprehensive Compatibility & Fallback Matrix

The agent must run consistently across Wayland, X11, Windows, and CI:

| Environment | Detection | Capture Engine | Input Engine | Authorization UX |
|---|---|---|---|---|
| **Linux Wayland (Full Portal)** | `WAYLAND_DISPLAY` set AND `RemoteDesktop` available (GNOME 45+, KDE 6+) | PipeWire via `RemoteDesktop` + `ScreenCast` | `PortalInputInjector` via D-Bus `Notify*` | Single prompt on first run; zero prompts thereafter (`restore_token`) |
| **Linux Wayland (ScreenCast only)** | `WAYLAND_DISPLAY` set, `RemoteDesktop` missing (wlroots, Sway, Hyprland) | PipeWire via `ScreenCast` (Warm session) | Log warning; fallback to `enigo` (no-op on Wayland) or `uinput` if root | Single prompt per agent run (Warm); input disabled warning logged |
| **Linux X11** | `DISPLAY` set, `WAYLAND_DISPLAY` absent | `xcap` XSHM / XGetImage | `enigo` via `x11rb` / `XTest` | Zero prompts (X11 security model does not gate capture/input) |
| **Windows** | `target_os = "windows"` | 3-tier fallback: WGC → DXGI → GDI (ADR-79) | `enigo` via Win32 `SendInput` | Zero prompts (OS-level user session permissions) |
| **Headless / CI** | `--desktop-source test` OR no display server | `TestPatternSource` (synthetic 720p30 frames) | `MockInputInjector` | Zero prompts; completely headless and deterministic |

---

## 7. Security, Privacy & Safety Considerations

1. **Explicit Initial User Consent:** The initial permission prompt can never be bypassed. The user must physically interact with the OS dialog to approve the screen cast and input injection.
2. **Revocation & Expiration:** Users retain full control via desktop settings:
   - On GNOME: *Settings -> Privacy & Security -> Remote Desktop / Screen Sharing*.
   - On KDE: *System Settings -> Screen Casting / Remote Access*.
   If the user revokes Ponter's permission in system settings, the stored `restore_token` becomes invalid. The agent detects the D-Bus error code, deletes the local token file, and gracefully prompts again when next needed.
3. **Token File Security:** The `remote-desktop.token` file is stored with mode `0600` under the user's config directory. It contains no credentials, passwords, or keys—it is an opaque identifier that only the local desktop compositor can resolve for that specific binary/app ID.
4. **Visual OS Indicators:** Both GNOME and KDE display a native recording/sharing indicator in the top panel (e.g., orange/red screen icon in GNOME top bar) whenever PipeWire stream is connected, maintaining user transparency.

---

## 8. Technical Architecture Decisions (Definitive Resolutions of [BE-INPUT-1..4])

### 8.1 [BE-INPUT-1]: D-Bus & Portal Library Strategy
- **Evaluation:**
  - `ashpd 0.13` separates `RemoteDesktop` and `ScreenCast` into distinct structs, creating abstraction impedance when attempting to multiplex `SelectDevices` and `ScreenCast.SelectSources` on the *exact same session handle*.
  - `zbus 5.19.0` is already linked transitively in `apps/agent`. Writing lightweight D-Bus proxy calls (~150 LOC) grants full, fine-grained control over dictionary options, session handle tokens, and unix file descriptor passing.
  - `apps/agent/vendor/xcap` already implements functional `ScreenCast` portal negotiation and PipeWire stream lifecycle.
- **Decision:**
  - **Phase 1:** Wrap the existing `xcap::VideoRecorder` in `WarmCaptureManager`. Requires zero new dependencies, zero crate additions, and zero risk to existing build pipelines.
  - **Phase 2:** Adopt `zbus 5` direct D-Bus communication with `org.freedesktop.portal.RemoteDesktop` and `org.freedesktop.portal.ScreenCast` on the unified session.

### 8.2 [BE-INPUT-2]: PipeWire Stream Idle Behavior
- **Mechanism:**
  - Mutter and KWin do **not** require continuous buffer dequeueing when the stream is paused via `stream.set_active(false)` (invoking PipeWire's `pw_stream_set_active`).
  - In the paused state, PipeWire transitions the node state to `PAUSED`. The compositor halts frame production and stops pushing buffers into the shared memory queue.
  - Calling `stream.flush(true)` on transition to idle drains any remaining frames in the ring buffer.
- **Performance Guarantee:** CPU/GPU consumption during `IDLE_PAUSED` state is strictly **0.0%**. When a client reconnects, calling `stream.set_active(true)` immediately triggers frame production from the next compositor vsync tick without user interaction.

### 8.3 [BE-INPUT-3]: D-Bus Signatures & Parameter Mappings
- **`CreateSession` (`options: a{sv}`)**:
  - `"handle_token"`: `s` (client-generated token, e.g. `"ponter_rd_h1"`)
  - `"session_handle_token"`: `s` (client-generated session token, e.g. `"ponter_rd_s1"`)
- **`SelectDevices` (`session_handle: o`, `options: a{sv}`)**:
  - `"handle_token"`: `s`
  - `"types"`: `u` = `3u32` (bitmask: `1` Keyboard | `2` Pointer = `3`)
  - `"persist_mode"`: `u` = `2u32` (persistent across restarts until revoked)
  - `"restore_token"`: `s` = cached token string (omitted on initial run)
- **`ScreenCast.SelectSources` (`session_handle: o`, `options: a{sv}`)**:
  - `"handle_token"`: `s`
  - `"types"`: `u` = `1u32` (bitmask: `1` Monitor / Full display)
  - `"multiple"`: `b` = `false`
  - `"cursor_mode"`: `u` = `2u32` (Embedded in video frame)
  - `"persist_mode"`: `u` = `2u32`
  - `"restore_token"`: `s` = cached token string (omitted on initial run)
- **`Start` (`session_handle: o`, `parent_window: s`, `options: a{sv}`)**:
  - `parent_window`: `""`
  - `"handle_token"`: `s`
- **Response Payload (`org.freedesktop.portal.Request.Response`)**:
  - `"devices"`: `u` (granted device mask)
  - `"streams"`: `a(ua{sv})` (array of `(pipewire_stream_node_id, properties)`)
  - `"restore_token"`: `s` (persisted opaque string for subsequent launches)

### 8.4 [BE-INPUT-4]: Input Injection Driver Specification
- **Coordinates:** Desktop inputs arrive as normalized ratios `(nx, ny) ∈ [0.0, 1.0]`, mapped to `(x, y) = (nx * width, ny * height)` and injected via `NotifyPointerMotionAbsolute(session_handle, options, stream, x, y)` where `stream` is the PipeWire stream node id.
- **Buttons:** Injected via `NotifyPointerButton` with Linux evdev codes (`0x110` BTN_LEFT, `0x111` BTN_RIGHT, `0x112` BTN_MIDDLE).
- **Scroll:** Injected via `NotifyPointerAxis(session_handle, options, dx, dy)`.
- **Keyboard:** Injected via `NotifyKeyboardKeycode` translating W3C `KeyboardEvent.code` to Linux evdev keycodes (e.g. `KEY_A = 30`, `KEY_ENTER = 28`, `KEY_LEFTSHIFT = 42`).
- **Text:** Injected via `NotifyKeyboardKeysym` using standard XKB keysym values.
- **libei vs D-Bus Direct:** Direct D-Bus calls provide universal support on all GNOME 45+ and KDE 6+ compositors with zero external dynamic C library dependencies (`libei`), ensuring flawless cross-compilation on both gnu and musl targets.

---

## 9. Implementation Staging & PR Breakdown

### PR1: Phase 1 Warm Capture Session (Low risk, zero dependency changes)
1. **`WarmCaptureManager` in `apps/agent`:**
   - Create `apps/agent/src/desktop/warm_capture.rs`.
   - Wrap `xcap::VideoRecorder` in an `Arc<Mutex<...>>` state machine handling `acquire_lease()` and `release_lease()`.
   - Keep PipeWire stream paused (`stream.set_active(false)`) when active leases == 0.
2. **Wire Warm Session into `AgentRuntime`:**
   - In `apps/agent/src/lib.rs`, initialize `WarmCaptureManager` on agent startup.
   - In `source_for`, return a `WarmScreenSource` referencing the persistent recorder.
   - On session teardown, release lease instead of dropping recorder.
3. **Tests:**
   - Unit tests for lease count transitions (0 -> 1 -> 0 -> 1) and pause/resume signal toggles.
   - Headless CI regression tests (`--desktop-source test`).

### PR2: Phase 2 Persistent Authorization & Unified RemoteDesktop Portal
1. **D-Bus `RemoteDesktop` Client:**
   - Implement `portal::remote_desktop` module in `apps/agent` using `zbus 5`.
   - Combined session creation (`CreateSession` -> `SelectDevices` -> `SelectSources` -> `Start`).
2. **`restore_token` Storage Engine:**
   - Secure token storage with `0600` permissions under `$XDG_CONFIG_HOME/ponter/`.
   - Token load, save, and revocation detection with automatic fallback.
3. **`PortalInputInjector`:**
   - Implement `InputInjector` over D-Bus `Notify*` methods with evdev keycode lookup.
4. **Validation:**
   - Live testing on GNOME 45+ and KDE Plasma 6+; verify X11 and Windows fallbacks.

---

## 10. ADR-90 Formal Decision Record

### Title
**ADR-90: Linux Upfront Consent & Warm Capture Architecture**

### Context
Modern Linux desktop environments on Wayland restrict screen capture and synthetic input injection behind portal permissions. Re-prompting for permission on every client connection degrades user experience and blocks headless reconnects. Furthermore, `enigo` cannot inject input on Wayland, leaving input forwarding broken.

### Decision
1. **Adopt a Two-Phase Implementation:**
   - **Phase 1 (PR1):** Implement a Warm Capture Session in `apps/agent` wrapping the existing vendored `xcap::VideoRecorder`, retaining the PipeWire stream across multiple WebRTC client connections throughout the agent process lifetime, pausing stream activity during idle (0.0% CPU/GPU).
   - **Phase 2 (PR2):** Implement a unified `org.freedesktop.portal.RemoteDesktop` session combining `ScreenCast` and input devices via `zbus 5`, using `persist_mode: 2` and caching `restore_token` for persistent, headless authorization, and injecting input via D-Bus `Notify*` methods.
2. **Preserve Compatibility:** Fall back gracefully to ScreenCast-only on compositors lacking RemoteDesktop (wlroots/Sway) and native XTEST/x11rb on X11.

### Consequences
- **Positive:**
  - Zero OS dialog spam on client reconnects during agent uptime (Phase 1).
  - Single unified consent dialog covering both screen sharing and remote control (Phase 2).
  - Unattended/headless agent restarts enabled via persistent `restore_token` (Phase 2).
  - Working remote input forwarding on modern GNOME and KDE Wayland desktops (Phase 2).
  - Zero dynamic C library dependencies (`libei`), compiling cleanly on gnu and musl.
- **Negative / Costs:**
  - Additional lifecycle management in agent runtime (managing warm capture state independent of connection state).
  - Wayland input behavior varies across desktop environments; compositors lacking RemoteDesktop portals will remain read-only or require fallback mechanisms.

### Status
**Approved (Owner approved 2026-10-15; BE technical input integrated; ready for SDD implementation planning).**
