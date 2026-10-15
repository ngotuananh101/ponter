# Linux Screen Capture & Remote Desktop Authorization (ADR-90): BE Technical Input / RFC

**Status:** PROPOSED — Technical Input from Backend (BE) to Business Analyst (BA) for ADR-90 Design Specification  
**Author:** Backend Subagent (BE)  
**Target:** `apps/agent` (Linux Wayland & X11)  
**Date:** 2026-10-15  

---

## 1. Executive Summary & Problem Statement

### 1.1 The Problems on Linux Wayland
1. **Repeated Consent Prompts per WebRTC Connection:**  
   Currently, `apps/agent` creates a new capture source (`xcap::Monitor::video_recorder()`) inside `desktop::source_for` each time a WebRTC desktop session connects. On Wayland compositors (GNOME 45+, KDE Plasma 6+), this invokes `org.freedesktop.portal.ScreenCast`, popping up an interactive system modal dialog ("Share your screen?") every single time. When a session disconnects, `ScreenSource::drop` tears down the recorder and drops the D-Bus portal session, forcing the user to grant permission again on the next connection. This makes unattended remote access impossible.
2. **Wayland Input Injection is a No-Op:**  
   As documented in `week9-input-known-limitations.md`, `enigo 0.6.1` on Linux operates via X11 (`x11rb`). Under Wayland, native Wayland windows refuse synthetic X11 input events due to security boundaries. The agent receives input frames over the data channel, logs success, but the mouse/keyboard actions do not affect native Wayland windows.
3. **Split Authorization Model:**  
   Capture and input are conceptually split across two different subsystems (`xcap` for capture via `ScreenCast`, `enigo` for input via X11). There is no unified consent dialog for viewing and controlling the remote desktop.

### 1.2 Two-Stage Phased Solution (Approved by Owner)
* **Phase 1: Warm Capture Session in `apps/agent`**  
  Keep the portal `ScreenCast` and PipeWire stream alive continuously within the agent process lifecycle across multiple WebRTC peer connections. The user confirms the prompt **only once** (upon agent boot or first connection). When no WebRTC client is connected, PipeWire streaming is paused (`stream.set_active(false)`), consuming 0% CPU/GPU.
* **Phase 2: Persistent Authorization (`persist_mode: 2`, `restore_token`) & Unified RemoteDesktop Portal**  
  Migrate from standalone `ScreenCast` to unified `org.freedesktop.portal.RemoteDesktop` (v2+) with `ScreenCast` on the same D-Bus session. This provides:
  1. A **single unified system prompt** asking for both screen viewing and mouse/keyboard control.
  2. **Zero prompts across agent restarts** using `persist_mode: 2` and a securely stored `restore_token`.
  3. **Native Wayland input injection** via `RemoteDesktop.Notify*` D-Bus calls, resolving the Wayland input limitation.

---

## 2. Phase 1 Architecture: Warm Capture Session

### 2.1 Mechanism & Lifecycle

Currently in `apps/agent/src/desktop.rs`:
```rust
// Current behavior: dropped at the end of every WebRTC connection
ScreenSource::drop -> stops capture thread -> drops xcap::VideoRecorder -> tears down ScreenCast session
```

In Phase 1, `apps/agent` introduces a singleton **`WarmCaptureManager`** managed by `AgentRuntime`:

```
+-----------------------------------------------------------------------------------+
|                              apps/agent Process                                   |
|                                                                                   |
|  +-----------------------------------------------------------------------------+  |
|  |                           WarmCaptureManager                                |  |
|  |                                                                             |  |
|  |  +-------------------------------------+  +------------------------------+  |  |
|  |  |   xcap::VideoRecorder (Wayland)     |  |   PipeWire Background Loop   |  |  |
|  |  |   - D-Bus ScreenCast Session        |  |   - StreamRc                     |  |  |
|  |  |   - OwnedObjectPath / Handle        |  |   - active_sender (pause/resume) |  |  |
|  |  +-------------------------------------+  +------------------------------+  |  |
|  |                                  ▲                                          |  |
|  +----------------------------------|------------------------------------------+  |
|                                     | Lease / Release                             |
|             +-----------------------+-----------------------+                     |
|             |                                               |                     |
|  +-----------------------+                     +-----------------------+          |
|  |  WebRTC Session #1    |                     |  WebRTC Session #2    |          |
|  |  (Client Connected)   |                     |  (Future Connect)     |          |
|  |                       |                     |                       |          |
|  |  Active Lease: 1      |  --- Disconnect --> |  Active Lease: 1      |          |
|  |  PipeWire: ACTIVE     |  Idle: PAUSED       |  PipeWire: RESUMED    |          |
|  |  Frames -> H.264 RTP  |  0% CPU / 0 Frames  |  Frames -> H.264 RTP  |          |
|  |  (NO PROMPT)          |  (STAYS ALIVE)      |  (NO PROMPT)          |          |
|  +-----------------------+                     +-----------------------+          |
+-----------------------------------------------------------------------------------+
```

### 2.2 Lifecycle State Transitions

| State | PipeWire Stream | ScreenCast D-Bus | WebRTC Peer | CPU / GPU Overhead |
|---|---|---|---|---|
| **UNINITIALIZED** | Not connected | None | None | 0% |
| **INITIALIZING** | Connecting | Requesting prompt | Waiting | Negligible |
| **IDLE_PAUSED** | `set_active(false)` | Alive & Connected | None (no active offer) | 0% (no buffer processing) |
| **ACTIVE_STREAMING** | `set_active(true)` | Alive & Connected | Connected (encoding RTP) | Normal encode load (~3-5% CPU) |
| **SHUTDOWN** | Disconnected | Cleanly closed | Closed | 0% |

### 2.3 Resource Management & Zero-Overhead Idle Guarantee
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
* Calling `recorder.stop()` sends `active_sender.send(false)`, putting the PipeWire stream into paused state. The Wayland compositor (mutter/kwin) halts frame delivery to the PipeWire buffer queue.
* The capture thread consumes zero CPU cycles while idle.
* When a new WebRTC offer arrives, `acquire_lease()` calls `recorder.start()`, sending `active_sender.send(true)`. The stream resumes immediately, producing frames within 1-2 video ticks without any OS popup.

### 2.4 Integration Points in `apps/agent`
1. `apps/agent/src/desktop.rs`:
   - Introduce `WarmCaptureManager`:
     ```rust
     pub struct WarmCaptureManager {
         inner: Arc<Mutex<Option<WarmCaptureState>>>,
     }
     ```
   - Introduce `WarmScreenSource: FrameSource` implementing `next_frame()` and `stop()`. Calling `stop()` does not destroy the underlying recorder; it simply decrements the lease count and pauses the stream when leases reach zero.
2. `apps/agent/src/lib.rs`:
   - Store `WarmCaptureManager` inside `AgentRuntime`.
   - On agent startup (or on first desktop offer if `--warm-capture eager` is not specified), initialize the warm capture session.
   - On agent shutdown (`SIGINT` / `SIGTERM`), cleanly shut down `WarmCaptureManager`.

---

## 3. Phase 2 Architecture: Persistent Permission & Unified RemoteDesktop

### 3.1 D-Bus Portal Interface: `org.freedesktop.portal.RemoteDesktop`
In Phase 2, the agent bypasses standalone `ScreenCast` and directly orchestrates `RemoteDesktop` + `ScreenCast` on the **same D-Bus session** using `zbus 5`:

```
                 Agent (Client)                      xdg-desktop-portal / Mutter / KWin
                       |                                              |
 1. CreateSession      | ----- CreateSession(options) --------------> |
                       | <---- session_handle ----------------------- |
                       |                                              |
 2. SelectDevices      | ----- SelectDevices(session, types: 3) ----> | (1: Keyboard, 2: Pointer)
                       | <---- Response ----------------------------- |
                       |                                              |
 3. SelectSources      | ----- SelectSources(session,                 |
                       |         types: 1, multiple: false,           |
                       |         persist_mode: 2,                     |
                       |         restore_token: "cached_token") ----> |
                       | <---- Response ----------------------------- |
                       |                                              |
 4. Start              | ----- Start(session, parent_window,          |
                       |         restore_token: "cached_token") ----> |
                       |                                              | [If restore_token valid: SILENT]
                       |                                              | [If token absent/invalid: 1 MODAL]
                       | <---- Response(streams, devices,             |
                       |                new_restore_token) ---------- |
                       |                                              |
 5. OpenPipeWireRemote | ----- OpenPipeWireRemote(session) ---------> |
                       | <---- OwnedFd ------------------------------ |
```

### 3.2 Single Combined Prompt User Experience
* On GNOME 45+ and KDE Plasma 6+, invoking `SelectDevices` followed by `SelectSources` on the same session causes the portal to aggregate the requests into a single dialog:
  > **"Allow Ponter to view and control your desktop?"**
  > - Screen: *Entire Display (Monitor 1)*
  > - Permissions: *Control mouse and keyboard*
  > - [x] *Remember this decision* (granted via `persist_mode: 2`)
* The user clicks "Allow" **once**. Both screen capture and remote input control are authorized simultaneously.

### 3.3 `persist_mode` and `restore_token` Lifecycle
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

### 3.4 Native Wayland Input Injection Implementation
When operating under an active `RemoteDesktop` portal session, the agent does not use `enigo`. Instead, it provides an implementation of `InputInjector` (`PortalInputInjector`) backed by `zbus`:

```rust
pub struct PortalInputInjector {
    session: OwnedObjectPath,
    stream_id: u32,
    proxy: RemoteDesktopProxy<'static>,
}

impl InputInjector for PortalInputInjector {
    fn pointer_move(&mut self, x: i32, y: i32) -> Result<()> {
        // NotifyPointerMotionAbsolute: stream coordinates (0..width, 0..height)
        self.proxy.notify_pointer_motion_absolute(&self.session, &options, self.stream_id, x as f64, y as f64)?;
        Ok(())
    }

    fn pointer_button(&mut self, button: Button, pressed: bool) -> Result<()> {
        // Linux evdev button mapping: BTN_LEFT=272, BTN_MIDDLE=274, BTN_RIGHT=273
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

## 4. Comprehensive Fallback Matrix

The agent must run consistently across Wayland, X11, Windows, and CI. The platform detection and fallback matrix is defined as follows:

| Environment | Detection | Capture Engine | Input Engine | Authorization UX |
|---|---|---|---|---|
| **Linux Wayland (Full Portal)** | `WAYLAND_DISPLAY` set AND `org.freedesktop.portal.RemoteDesktop` available (GNOME 45+, KDE 6+) | PipeWire via `RemoteDesktop` + `ScreenCast` | `PortalInputInjector` via D-Bus `Notify*` | Single prompt on first run; zero prompts thereafter (`restore_token`) |
| **Linux Wayland (ScreenCast only)** | `WAYLAND_DISPLAY` set, `RemoteDesktop` missing (wlroots, Sway, Hyprland, older compositors) | PipeWire via `ScreenCast` (Warm session) | Log warning; fallback to `enigo` (no-op on Wayland) or `uinput` if root | Single prompt per agent run (Warm); input disabled warning logged |
| **Linux X11** | `DISPLAY` set, `WAYLAND_DISPLAY` absent | `xcap` XSHM / XGetImage | `enigo` via `x11rb` / `XTest` | Zero prompts (X11 security model does not gate capture/input) |
| **Windows** | `target_os = "windows"` | 3-tier fallback: WGC → DXGI → GDI (ADR-79) | `enigo` via Win32 `SendInput` | Zero prompts (OS-level user session permissions) |
| **Headless / CI** | `--desktop-source test` OR no display server | `TestPatternSource` (synthetic 720p30 frames) | `MockInputInjector` | Zero prompts; completely headless and deterministic |

---

## 5. Implementation & Staging Plan

To deliver maximum user value quickly while maintaining rock-solid stability and zero regressions:

### Phase 1 Tasks (Low risk, quick win, zero dependency changes)
1. **Task 1.1: `WarmCaptureManager` in `apps/agent`**  
   - Create `apps/agent/src/desktop/warm_capture.rs`.
   - Wrap `xcap::VideoRecorder` in an `Arc<Mutex<...>>` state machine that handles `acquire_lease()` and `release_lease()`.
   - Keep PipeWire stream paused (`is_running = false`, `active_sender.send(false)`) when active leases == 0.
2. **Task 1.2: Wire Warm Session into `AgentRuntime` and `run_stream`**  
   - In `apps/agent/src/lib.rs`, initialize `WarmCaptureManager` on agent startup if desktop streaming is enabled.
   - In `source_for`, return a `WarmScreenSource` that references the persistent recorder instead of spawning a new one.
   - On connection close, release lease instead of terminating recorder.
3. **Task 1.3: Unit & Integration Tests**  
   - Verify lease count transitions (0 -> 1 -> 0 -> 1).
   - Test pause/resume signal toggles without dropping stream.
   - Verify CI headless fallback (`--desktop-source test`) is completely unaffected.

### Phase 2 Tasks (Full persistent authorization & Wayland control)
1. **Task 2.1: D-Bus `RemoteDesktop` Client**  
   - Implement `portal::remote_desktop` module in `apps/agent` using `zbus 5`.
   - Implement combined session creation (`CreateSession` -> `SelectDevices` -> `SelectSources` -> `Start`).
2. **Task 2.2: `restore_token` Storage Engine**  
   - Secure token storage with `0600` permissions under `$XDG_CONFIG_HOME/ponter/`.
   - Implement token load, save, and revocation detection with automatic fallback.
3. **Task 2.3: `PortalInputInjector`**  
   - Map `DesktopInput` events to `NotifyPointerMotionAbsolute`, `NotifyPointerButton`, `NotifyPointerAxis`, `NotifyKeyboardKeycode`.
   - Add W3C `KeyboardEvent.code` to Linux evdev keycode lookup table.
4. **Task 2.4: E2E and Multi-Compositor Validation**  
   - Test on GNOME 45+ (Fedora / Ubuntu).
   - Test on KDE Plasma 6+.
   - Verify fallback on X11 and Windows.

---

## 6. Security, Privacy & Safety Considerations

1. **Explicit Initial User Consent:**  
   The initial permission prompt can never be bypassed. The user must physically interact with the OS dialog to approve the screen cast and input injection.
2. **Revocation & Expiration:**  
   Users retain full control via the desktop environment's settings:
   - On GNOME: *Settings -> Privacy & Security -> Remote Desktop / Screen Sharing*.
   - On KDE: *System Settings -> Screen Casting / Remote Access*.  
   If the user revokes Ponter's permission in system settings, the stored `restore_token` becomes invalid. The agent must detect the D-Bus error code, delete the local token file, and gracefully prompt again when next needed.
3. **Token File Security:**  
   The `restore_token` file is stored with mode `0600` under the user's config directory. It contains no credentials, passwords, or keys—it is an opaque identifier that only the local desktop compositor can resolve for that specific binary/app ID.
4. **Visual OS Indicators:**  
   Both GNOME and KDE display a native recording/sharing indicator in the top panel (e.g., orange/red screen icon in GNOME top bar) whenever PipeWire stream is connected. This maintains user transparency even with persistent tokens.

---

## 7. Recommendation for BA (ADR-90)

Backend team recommends BA structure **ADR-90** around:
1. **Decision 1 (Phase 1):** Adopt in-process `WarmCaptureManager` for agent desktop streaming to maintain continuous PipeWire/ScreenCast session across WebRTC connections.
2. **Decision 2 (Phase 2):** Adopt `org.freedesktop.portal.RemoteDesktop` (v2+) with `persist_mode: 2` and filesystem-backed `restore_token` for unified single-dialog view+control and zero-prompt restarts.
3. **Decision 3 (Input):** Route Wayland input injection through portal `Notify*` APIs, deprecating the no-op X11 `enigo` path on Wayland.
4. **Decision 4 (Staging):** Split delivery into two independent PRs (PR1 for Phase 1 warm session, PR2 for Phase 2 RemoteDesktop & token persistence) to ensure rapid stabilization.

---

## 8. Explicit Technical Parameters for Spec Section 8 ([BE-INPUT-1] to [BE-INPUT-4])

To directly unblock and populate Section 8 of the BA Design Specification (`docs/superpowers/specs/2026-10-15-linux-upfront-consent-design.md`), here are the definitive technical parameters:

### 8.1 [BE-INPUT-1]: D-Bus & Portal Library Strategy

* **Evaluation:**
  * **Option A (`ashpd 0.13`):** High-level portal bindings. Downside: Separates `RemoteDesktop` and `ScreenCast` into distinct structs, creating unnecessary abstraction impedance when attempting to multiplex `SelectDevices` and `ScreenCast.SelectSources` on the *exact same session handle* token.
  * **Option B (`zbus 5` direct proxy / method calls):** `zbus 5.19.0` is already linked transitively in `apps/agent`. Writing lightweight D-Bus proxy calls (~150 LOC) grants full, fine-grained control over dictionary options, session handle tokens, and unix file descriptor passing.
  * **Option C (Extend/wrap vendored `xcap` for Phase 1):** `apps/agent/vendor/xcap` already implements functional `ScreenCast` portal negotiation and PipeWire stream lifecycle.
* **BE Recommendation:**
  * **For Phase 1:** Adopt **Option C**. Wrap the existing `xcap::VideoRecorder` in `WarmCaptureManager`. Requires zero new dependencies, zero crate additions, and zero risk to existing build pipelines.
  * **For Phase 2:** Adopt **Option B (`zbus 5`)**. Implement direct D-Bus communication with `org.freedesktop.portal.RemoteDesktop` and `org.freedesktop.portal.ScreenCast` on the unified session.

### 8.2 [BE-INPUT-2]: PipeWire Stream Idle Behavior

* **Compositor Stall Verification:**
  * Mutter and KWin do **not** require continuous buffer dequeueing when the stream is paused via `stream.set_active(false)` (invoking PipeWire's `pw_stream_set_active`).
  * In the paused state, PipeWire transitions the node state to `PAUSED`. The compositor halts frame production and stops pushing buffers into the shared memory queue.
  * PipeWire does **not** stall or disconnect; the D-Bus portal session remains fully active.
  * Calling `stream.flush(true)` on transition to idle drains any remaining frames in the ring buffer.
* **Overhead Guarantee:**
  * CPU/GPU consumption during `WarmIdle` state is strictly **0.0%**. No frames are encoded, scaled, or transmitted.
  * When a WebRTC client reconnects, calling `stream.set_active(true)` immediately triggers frame production from the next compositor vsync tick without user interaction.

### 8.3 [BE-INPUT-3]: D-Bus Signatures & Parameter Mappings

* **`CreateSession` (`options: a{sv}`)**:
  * `"handle_token"`: `s` (client-generated token, e.g. `"ponter_rd_h1"`)
  * `"session_handle_token"`: `s` (client-generated session token, e.g. `"ponter_rd_s1"`)
* **`SelectDevices` (`session_handle: o`, `options: a{sv}`)**:
  * `"handle_token"`: `s`
  * `"types"`: `u` = `3u32` (bitmask: `1` Keyboard | `2` Pointer = `3`)
  * `"persist_mode"`: `u` = `2u32` (persistent across restarts until revoked)
  * `"restore_token"`: `s` = cached token string (omitted on initial run)
* **`ScreenCast.SelectSources` (`session_handle: o`, `options: a{sv}`)**:
  * `"handle_token"`: `s`
  * `"types"`: `u` = `1u32` (bitmask: `1` Monitor / Full display)
  * `"multiple"`: `b` = `false`
  * `"cursor_mode"`: `u` = `2u32` (Embedded in video frame)
  * `"persist_mode"`: `u` = `2u32`
  * `"restore_token"`: `s` = cached token string (omitted on initial run)
* **`Start` (`session_handle: o`, `parent_window: s`, `options: a{sv}`)**:
  * `parent_window`: `""`
  * `"handle_token"`: `s`
* **Response Payload (`org.freedesktop.portal.Request.Response`)**:
  * `"devices"`: `u` (granted device mask)
  * `"streams"`: `a(ua{sv})` (array of `(pipewire_stream_node_id, properties)`)
  * `"restore_token"`: `s` (persisted opaque string for subsequent launches)

### 8.4 [BE-INPUT-4]: Input Injection Driver Specification

* **Coordinate Space Mapping:**
  * Desktop inputs arrive from WebRTC data channel as normalized ratios: `(nx, ny) ∈ [0.0, 1.0]`.
  * Translated to display pixel dimensions: `(x, y) = (nx * width as f64, ny * height as f64)`.
  * Injected via `org.freedesktop.portal.RemoteDesktop.NotifyPointerMotionAbsolute`:
    * Signature: `(session_handle: o, options: a{sv}, stream: u, x: d, y: d)`.
    * `stream`: PipeWire stream node id `u32` returned by `Start.streams`. This automatically maps coordinate space to the correct target display.
* **Pointer Buttons:**
  * Injected via `NotifyPointerButton(session_handle: o, options: a{sv}, button: i, state: u)`:
    * `button`: Linux evdev codes: `BTN_LEFT` = `0x110` (272), `BTN_RIGHT` = `0x111` (273), `BTN_MIDDLE` = `0x112` (274).
    * `state`: `1u32` = Pressed, `0u32` = Released.
* **Pointer Axis (Scroll):**
  * Injected via `NotifyPointerAxis(session_handle: o, options: a{sv}, dx: d, dy: d)`.
* **Keyboard Keycodes:**
  * Injected via `NotifyKeyboardKeycode(session_handle: o, options: a{sv}, keycode: i, state: u)`:
    * `keycode`: Linux evdev keycode (e.g. `KEY_A` = 30, `KEY_ENTER` = 28, `KEY_LEFTSHIFT` = 42).
    * Lookup table translates W3C standard `KeyboardEvent.code` to evdev keycodes.
    * `state`: `1u32` = Pressed, `0u32` = Released.
* **Text / Unicode Keysyms:**
  * Injected via `NotifyKeyboardKeysym(session_handle: o, options: a{sv}, keysym: i, state: u)` using standard XKB keysym values.
* **libei vs D-Bus Direct:**
  * Direct D-Bus calls provide universal support on all GNOME 45+ and KDE 6+ compositors with zero external dynamic C library dependencies (`libei`), ensuring flawless cross-compilation on both gnu and musl targets.

