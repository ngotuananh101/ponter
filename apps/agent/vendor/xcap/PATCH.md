# Vendored `xcap` 0.9.8

This is upstream `xcap` 0.9.8 (Apache-2.0), vendored so we can carry a single
one-line-behaviour fix that is not yet released upstream.

## Why

On GNOME/Wayland, `Monitor::video_recorder()` connected to PipeWire
successfully but never delivered a frame — the desktop stream stayed black
while ICE/DTLS were connected and the browser had already fired `ontrack`.

Root cause: `WaylandVideoRecorder::new()` created the portal `ScreenCast`
session and then let it fall out of scope when `new()` returned. The session's
D-Bus connection is owned by that `ScreenCast`; dropping it tears the portal
session down, mutter destroys the `gnome-shell` PipeWire source node, and the
capture stream — which connects to the stream id returned by `Start()` — finds
no target:

```
pw.core  core_event_error() res:-2 (No such file or directory) msg:"no target node available"
```

`dequeue_buffer()` then always returns `None`, so zero frames are ever sent.

Verified with a direct xcap probe: 0 frames and no `gnome-shell` node during the
run; keeping the session alive (the patch below) yields frames at ~120 ms
(`frame #1 1920x1080`). Using the portal's `OpenPipeWireRemote` fd instead did
**not** fix it — the fd is not the problem; the session lifetime is.

## The patch

`src/linux/wayland_video_recorder.rs` — store the `ScreenCast` session on the
recorder struct so it lives as long as the capture:

```rust
pub struct WaylandVideoRecorder {
    ...
    screen_cast: Arc<ScreenCast<'static>>,   // added
    ...
}
```

and in `new()`:

```rust
let recorder = Self {
    monitor,
    screen_cast: Arc::new(screen_cast),      // added
    ...
};
```

`Arc` is used because the struct derives `Clone`. No other behaviour changes.

## WGC → DXGI / GDI fallback (Windows)

When the `wgc` feature is enabled, `ImplVideoRecorder::new()` now tries
`WgcVideoRecorder` (Windows.Graphics.Capture) first. On hybrid-GPU laptops,
WGC can fail because the `ID3D11Device` it creates on the default adapter may
not own the monitor's output, causing `DuplicateOutput` to return
`E_INVALIDARG` (upstream xcap#264). When that happens, the recorder falls back
to `dxgi_video_recorder::ImplVideoRecorder` (DXGI Output Duplication), which
enumerates adapters to find the one matching the monitor's output and works
on any GPU configuration.

`dxgi_video_recorder` is now always compiled on Windows (previously gated to
`not(feature = "wgc")`), and `impl_video_recorder.rs` wraps both implementations
behind a single `ImplVideoRecorder` enum so the rest of the crate is unchanged.

Furthermore, `gdi` is now always compiled on Windows (`mod gdi;`), and
`capture_monitor` / `capture_window` in `src/windows/capture.rs` automatically fall
back to GDI (`gdi::capture_monitor` / `gdi::capture_window`) whenever WGC
`wgc::capture_monitor` or `wgc::capture_window` fails with an error (e.g.
`0x80070057` on hybrid-GPU laptops or when Direct3D11 interop is blocked).

## Removing this vendor directory

Upstream `master` has rewritten this path on top of `ashpd`, which manages the
session lifetime differently, but no release with that rewrite exists yet
(0.9.8 is the latest published version). When a release ships the fix, drop
`[patch.crates-io]` from `apps/agent/Cargo.toml`, delete this directory, and
re-check `Monitor::video_recorder()` on GNOME/Wayland.
