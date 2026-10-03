//! Desktop streaming: capture → downscale → H.264 encode → RTP samples.
//!
//! `run_stream` is the only entry point the session loop uses; everything else
//! here exists to be unit-tested without a peer connection or a live display.

use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use bytes::Bytes;
use openh264::encoder::{
    BitRate, Complexity, Encoder, EncoderConfig, FrameRate, IntraFramePeriod, RateControlMode,
    UsageType, VuiConfig,
};
use openh264::formats::{RgbaSliceU8, YUVBuffer};
use openh264::OpenH264API;
use openh264_sys2::{
    SBitrateInfo, ENCODER_OPTION_BITRATE, ENCODER_OPTION_MAX_BITRATE, SPATIAL_LAYER_0,
    SPATIAL_LAYER_ALL,
};
use rtc::media::Sample;
use rtc::rtp_transceiver::{PayloadType, SSRC};
use std::os::raw::c_int;
use std::ptr::addr_of_mut;
use tokio::sync::{oneshot, watch};
use webrtc::media_stream::track_local::static_sample::TrackLocalStaticSample;

// The whole module is compiled only on non-musl targets (see main.rs), so the
// xcap-only imports below need no cfg of their own.
use std::sync::mpsc::{Receiver, RecvTimeoutError};

// `StreamProfile` is pure data and lives in `main.rs` (unconditional) so that
// `SessionConfig` — which is also unconditional — can name it on musl.
use crate::StreamProfile;

/// One frame, RGBA8, `width * height * 4` bytes.
#[derive(Clone)]
pub struct RawFrame {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

/// A source of frames the streaming loop can pull from.
///
/// `Send` is required: the loop runs inside a `tokio::spawn`ed task.
pub trait FrameSource: Send {
    /// The newest frame, or `None` when nothing new arrived since the last
    /// call (the caller skips that tick rather than re-encoding).
    fn next_frame(&mut self) -> Result<Option<RawFrame>>;
    /// Stops capture and releases the platform resources. Idempotent.
    fn stop(&mut self);
}

/// Box-filter downscale to fit `(max_w, max_h)`, preserving aspect ratio.
///
/// A frame that already fits is returned untouched — this never upscales, so
/// an 800×600 screen stays 800×600. Scaled output is floored to even
/// dimensions, which `RgbaSliceU8::new` requires (it panics on odd sizes).
fn downscale(frame: &RawFrame, max_w: u32, max_h: u32) -> RawFrame {
    if frame.width <= max_w && frame.height <= max_h {
        return frame.clone();
    }

    let scale = f64::min(
        max_w as f64 / frame.width as f64,
        max_h as f64 / frame.height as f64,
    );
    let dst_w = (((frame.width as f64 * scale) as u32) & !1).max(2);
    let dst_h = (((frame.height as f64 * scale) as u32) & !1).max(2);

    let mut rgba = vec![0u8; (dst_w * dst_h * 4) as usize];
    for dy in 0..dst_h {
        let sy0 = (dy as u64 * frame.height as u64 / dst_h as u64) as u32;
        let sy1 = (((dy + 1) as u64 * frame.height as u64 / dst_h as u64) as u32).max(sy0 + 1);
        for dx in 0..dst_w {
            let sx0 = (dx as u64 * frame.width as u64 / dst_w as u64) as u32;
            let sx1 = (((dx + 1) as u64 * frame.width as u64 / dst_w as u64) as u32).max(sx0 + 1);

            let mut sums = [0u32; 4];
            let mut count = 0u32;
            for sy in sy0..sy1 {
                for sx in sx0..sx1 {
                    let i = ((sy * frame.width + sx) * 4) as usize;
                    for (c, sum) in sums.iter_mut().enumerate() {
                        *sum += frame.rgba[i + c] as u32;
                    }
                    count += 1;
                }
            }

            let o = ((dy * dst_w + dx) * 4) as usize;
            for (c, &sum) in sums.iter().enumerate() {
                rgba[o + c] = (sum / count) as u8;
            }
        }
    }

    RawFrame {
        width: dst_w,
        height: dst_h,
        rgba,
    }
}

/// Crops the right/bottom pixel off odd dimensions.
///
/// The encoder's `RgbaSliceU8` panics on odd width/height or a byte length that
/// does not match `w * h * 4`; cropping by one pixel is the cheapest guarantee
/// that neither can happen, and a single lost row/column is invisible at 720p.
fn crop_to_even(frame: RawFrame) -> RawFrame {
    let width = frame.width & !1;
    let height = frame.height & !1;
    if width == frame.width && height == frame.height {
        return frame;
    }

    let mut rgba = Vec::with_capacity((width * height * 4) as usize);
    for y in 0..height {
        let start = (y * frame.width * 4) as usize;
        rgba.extend_from_slice(&frame.rgba[start..start + (width * 4) as usize]);
    }
    RawFrame {
        width,
        height,
        rgba,
    }
}

/// Writes a `size`×`size` square of `color` at `(x0, y0)`, clamped to bounds.
fn fill_square(rgba: &mut [u8], w: u32, h: u32, x0: u32, y0: u32, size: u32, color: [u8; 4]) {
    for y in y0..(y0 + size).min(h) {
        for x in x0..(x0 + size).min(w) {
            let i = ((y * w + x) * 4) as usize;
            rgba[i..i + 4].copy_from_slice(&color);
        }
    }
}

/// A deterministic synthetic screen: dark background, four corner markers, and
/// a green bar whose position is a pure function of the frame counter.
///
/// Determinism is the point — the E2E (ADR-17) runs the agent with
/// `--desktop-source test` and asserts on the frames it produces, so the same
/// counter must render the same bytes on every platform.
pub struct TestPatternSource {
    width: u32,
    height: u32,
    counter: u64,
}

impl TestPatternSource {
    pub fn new(width: u32, height: u32) -> Self {
        Self {
            width,
            height,
            counter: 0,
        }
    }

    fn render(&self, n: u64) -> RawFrame {
        let (w, h) = (self.width, self.height);
        let mut rgba = vec![0u8; (w * h * 4) as usize];
        for px in rgba.chunks_exact_mut(4) {
            px.copy_from_slice(&[9, 13, 22, 255]);
        }

        let marker = [255, 255, 255, 255];
        let margin = 8u32;
        for (x0, y0) in [
            (0, 0),
            (w.saturating_sub(margin), 0),
            (0, h.saturating_sub(margin)),
            (w.saturating_sub(margin), h.saturating_sub(margin)),
        ] {
            fill_square(&mut rgba, w, h, x0, y0, margin, marker);
        }

        let bar = [0, 220, 120, 255];
        let bar_x = ((n * 8) % w as u64) as u32;
        for dx in 0..16u32 {
            let x = (bar_x + dx) % w;
            for y in 0..h {
                let i = ((y * w + x) * 4) as usize;
                rgba[i..i + 4].copy_from_slice(&bar);
            }
        }

        RawFrame {
            width: w,
            height: h,
            rgba,
        }
    }
}

impl FrameSource for TestPatternSource {
    fn next_frame(&mut self) -> Result<Option<RawFrame>> {
        let frame = self.render(self.counter);
        self.counter += 1;
        Ok(Some(frame))
    }

    fn stop(&mut self) {}
}

/// Live screen capture.
///
/// **Why a dedicated thread.** `xcap`'s capture objects are not `Send` on every
/// platform — verified by compiling `is_send::<xcap::VideoRecorder>()` for
/// `x86_64-apple-darwin` (fails: `Retained<AVCaptureSession>` is not `Send`)
/// and `is_send::<xcap::Monitor>()` for `x86_64-pc-windows-msvc` (fails:
/// `HMONITOR` wraps a raw pointer) — while `supervise_sessions` runs in a
/// `tokio::spawn` and everything in `run_one_session` must be `Send`. So the
/// thread below creates, owns and drops the monitor/recorder/`Receiver`, and
/// only the channel (probe-verified `Send` on all three platforms) crosses the
/// boundary. The same design works everywhere, which beats three cfg-gated
/// shapes.
///
/// **Failure is reported, not lost.** The thread sends its setup outcome over
/// a `oneshot` before the frame loop, so `new()` returns the real error
/// (no display, missing portal, no permission) instead of a stream that never
/// produces a frame. Crucially, "the recorder started" is *not* treated as
/// success: the thread waits for the first frame before reporting `Ok`, so a
/// ScreenCast request that the portal accepted but never feeds (denied
/// permission, compositor never associated the stream) surfaces as an error the
/// caller can refuse on — not a black video element that streams nothing.
pub struct ScreenSource {
    frames: Option<Receiver<xcap::Frame>>,
    stop: Option<std::sync::mpsc::Sender<()>>,
    thread: Option<std::thread::JoinHandle<()>>,
}

/// How long `ScreenSource::new` waits for the recorder's first frame before
/// concluding the capture is not actually delivering.
///
/// A granted ScreenCast stream emits an initial frame within ~100 ms of
/// `start()` — the compositor pushes it as soon as the stream goes live — so
/// anything on the order of seconds means the portal request was denied or the
/// compositor never associated the stream. `start()` itself still returns `Ok`
/// in that case, which is exactly how a denied capture used to become a silent
/// black stream instead of a refusal. This ceiling is well under the browser's
/// 20 s track timeout so the refusal reaches the user first.
const FIRST_FRAME_TIMEOUT: Duration = Duration::from_secs(5);

/// Waits for the first frame from a freshly started recorder.
///
/// Returns the frame by forwarding it to `frame_tx` (so the streaming loop
/// still sees it) and `Ok(())`; returns `Err` when no frame arrives within
/// `timeout`, which is the signal that capture is not actually permitted.
/// Split out from the capture thread so both branches are unit-testable
/// without a live display or a real portal.
fn await_first_frame(
    frames: &Receiver<xcap::Frame>,
    frame_tx: &std::sync::mpsc::Sender<xcap::Frame>,
    timeout: Duration,
) -> std::result::Result<(), String> {
    match frames.recv_timeout(timeout) {
        Ok(frame) => {
            let _ = frame_tx.send(frame);
            Ok(())
        }
        Err(RecvTimeoutError::Timeout) => Err(format!(
            "capture started but produced no frames within {timeout:?}; the \
             ScreenCast portal permission was probably denied"
        )),
        Err(RecvTimeoutError::Disconnected) => {
            Err("the capture stream ended before its first frame".to_string())
        }
    }
}

/// The two lifecycle calls `run_capture` makes on a recorder.
///
/// Exists so the capture loop's *behaviour* — refuse when the recorder starts
/// but never feeds, stream once it does, always stop — can be tested with a
/// fake, because `xcap::VideoRecorder` is a concrete type with no seam.
trait CaptureRecorder {
    fn start(&self) -> std::result::Result<(), String>;
    fn stop(&self) -> std::result::Result<(), String>;
}

impl CaptureRecorder for xcap::VideoRecorder {
    fn start(&self) -> std::result::Result<(), String> {
        xcap::VideoRecorder::start(self).map_err(|e| e.to_string())
    }
    fn stop(&self) -> std::result::Result<(), String> {
        xcap::VideoRecorder::stop(self).map_err(|e| e.to_string())
    }
}

/// The body of the capture thread: start the recorder, prove it actually
/// produces frames, then forward them until stopped.
///
/// Split out of `ScreenSource::new`'s closure so it can be driven directly by a
/// test with a fake recorder. Returns nothing — the outcome travels over
/// `ready_tx` (setup) and `frame_tx` (frames), exactly as the real thread wires
/// them, so the test exercises the production control flow, not a copy of it.
fn run_capture<R: CaptureRecorder>(
    recorder: R,
    frames: Receiver<xcap::Frame>,
    ready_tx: oneshot::Sender<std::result::Result<(), String>>,
    frame_tx: std::sync::mpsc::Sender<xcap::Frame>,
    stop_rx: std::sync::mpsc::Receiver<()>,
    first_frame_timeout: Duration,
) {
    if let Err(e) = recorder.start() {
        let _ = ready_tx.send(Err(format!("starting capture: {e}")));
        return;
    }

    // `start()` returning Ok only means the portal accepted the request — on
    // Wayland it says nothing about whether frames will ever arrive. Wait for
    // the first one before reporting success, so a denied/never-fed ScreenCast
    // becomes a clean refusal instead of a stream that silently produces no RTP.
    if let Err(message) = await_first_frame(&frames, &frame_tx, first_frame_timeout) {
        let _ = ready_tx.send(Err(message));
        if let Err(e) = recorder.stop() {
            tracing::warn!(error = %e, "stopping the screen recorder failed");
        }
        return;
    }
    let _ = ready_tx.send(Ok(()));

    // Forward frames until stopped. `recv_timeout` keeps the loop responsive to
    // the stop signal while the recorder is idle.
    loop {
        match frames.recv_timeout(Duration::from_millis(100)) {
            Ok(frame) => {
                if frame_tx.send(frame).is_err() {
                    break; // ScreenSource dropped
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }
        if stop_rx.try_recv().is_ok() {
            break;
        }
    }

    if let Err(e) = recorder.stop() {
        tracing::warn!(error = %e, "stopping the screen recorder failed");
    }
}

impl ScreenSource {
    /// Starts capture of a specific monitor by id (ADR-22 source selection).
    ///
    /// The monitor is looked up and the recorder created inside the same
    /// capture thread as Week 7, so no non-`Send` capture object crosses the
    /// thread boundary (spec §6.2). The lookup must happen *inside* the thread,
    /// not before it: `xcap`'s Windows `ImplMonitor` carries no
    /// `unsafe impl Send`, so an `xcap::Monitor` captured by the `move` closure
    /// is a compile error on `x86_64-pc-windows-msvc` (E0277). Only the `u32`
    /// id is moved in; the monitor is built and used where it is used.
    ///
    /// An id absent from the live enumeration is reported as `unknown source
    /// id`, the same refusal `source_for` gives for a bad scheme — a hostile
    /// `desktop-select` can never name a source the agent did not offer (§9).
    pub async fn for_monitor(monitor_id: u32) -> Result<Self> {
        let (ready_tx, ready_rx) = oneshot::channel::<std::result::Result<(), String>>();
        let (stop_tx, stop_rx) = std::sync::mpsc::channel::<()>();
        let (frame_tx, frame_rx) = std::sync::mpsc::channel::<xcap::Frame>();

        let thread = std::thread::Builder::new()
            .name("desktop-capture".into())
            .spawn(move || {
                let monitor = match find_monitor(monitor_id) {
                    Ok(monitor) => monitor,
                    Err(e) => {
                        let _ = ready_tx.send(Err(format!("{e:#}")));
                        return;
                    }
                };
                let recorder = match monitor.video_recorder() {
                    Ok(recorder) => recorder,
                    Err(e) => {
                        let _ = ready_tx.send(Err(e.to_string()));
                        return;
                    }
                };
                let (recorder, frames) = recorder;
                run_capture(
                    recorder,
                    frames,
                    ready_tx,
                    frame_tx,
                    stop_rx,
                    FIRST_FRAME_TIMEOUT,
                );
            })
            .context("spawning the desktop capture thread")?;

        match ready_rx.await {
            Ok(Ok(())) => Ok(Self {
                frames: Some(frame_rx),
                stop: Some(stop_tx),
                thread: Some(thread),
            }),
            Ok(Err(message)) => {
                let _ = thread.join();
                bail!("screen capture unavailable: {message}");
            }
            Err(_) => {
                let _ = thread.join();
                bail!("the desktop capture thread died during setup");
            }
        }
    }

    /// Test seam: wraps an already-open frame channel.
    #[cfg(test)]
    fn from_parts_for_test(frames: Receiver<xcap::Frame>) -> Self {
        Self {
            frames: Some(frames),
            stop: None,
            thread: None,
        }
    }
}

impl FrameSource for ScreenSource {
    fn next_frame(&mut self) -> Result<Option<RawFrame>> {
        let Some(frames) = self.frames.as_ref() else {
            return Ok(None);
        };
        Ok(drain_latest(frames).map(|frame| RawFrame {
            width: frame.width,
            height: frame.height,
            rgba: frame.raw,
        }))
    }

    fn stop(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        // Bounded join: the capture thread checks the stop flag every 100 ms
        // and the recorder's `stop()` runs its own shutdown path.
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

/// A capture source's kind. Serialises as the wire string (§5.1).
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SourceKind {
    Monitor,
    Window,
}

/// One capture source the agent can stream (spec §5.1).
#[derive(Clone, Debug, serde::Serialize)]
pub struct DesktopSourceInfo {
    pub id: String,
    pub kind: SourceKind,
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub x: i32,
    pub y: i32,
    #[serde(rename = "scaleFactor")]
    pub scale_factor: f32,
    pub rotation: f32,
    #[serde(rename = "isPrimary")]
    pub is_primary: bool,
    pub default: bool,
}

/// Enumerate every monitor and window the agent could stream (spec §6.2).
///
/// A source whose accessor fails is skipped rather than failing the whole
/// enumeration: one window that vanished between listing and reading its
/// geometry must not cost the picker every other entry.
pub fn enumerate_sources() -> Result<Vec<DesktopSourceInfo>> {
    let mut sources = Vec::new();
    for monitor in xcap::Monitor::all().context("listing monitors")? {
        let Ok(id) = monitor.id() else { continue };
        sources.push(DesktopSourceInfo {
            id: format!("monitor:{id}"),
            kind: SourceKind::Monitor,
            name: monitor
                .friendly_name()
                .or_else(|_| monitor.name())
                .unwrap_or_else(|_| format!("Monitor {id}")),
            width: monitor.width().unwrap_or(0),
            height: monitor.height().unwrap_or(0),
            x: monitor.x().unwrap_or(0),
            y: monitor.y().unwrap_or(0),
            scale_factor: monitor.scale_factor().unwrap_or(1.0),
            rotation: monitor.rotation().unwrap_or(0.0),
            is_primary: monitor.is_primary().unwrap_or(false),
            default: false,
        });
    }
    for window in xcap::Window::all().context("listing windows")? {
        let Ok(id) = window.id() else { continue };
        if window.is_minimized().unwrap_or(false) {
            continue;
        }
        sources.push(DesktopSourceInfo {
            id: format!("window:{id}"),
            kind: SourceKind::Window,
            name: window.title().unwrap_or_else(|_| format!("Window {id}")),
            width: window.width().unwrap_or(0),
            height: window.height().unwrap_or(0),
            x: window.x().unwrap_or(0),
            y: window.y().unwrap_or(0),
            scale_factor: 1.0,
            rotation: 0.0,
            is_primary: false,
            default: false,
        });
    }
    Ok(sources)
}

/// Build the `FrameSource` for an enumerated id (spec §6.2).
///
/// Async because the monitor arm awaits `ScreenSource::for_monitor`'s
/// first-frame handshake — a monitor source that is not actually delivering is
/// an error the caller can refuse on, not a black stream (the Week 7 invariant).
/// The id is validated by *lookup against the enumeration*, never parsed into a
/// platform handle directly: an unknown id is an error, so a hostile
/// `desktop-select` can never name a source the agent did not offer (§9).
pub async fn source_for(id: &str, _profile: StreamProfile) -> Result<Box<dyn FrameSource>> {
    let (kind, raw) = id
        .split_once(':')
        .ok_or_else(|| anyhow::anyhow!("unknown source id {id:?}"))?;
    match kind {
        "monitor" => {
            let wanted: u32 = raw
                .parse()
                .map_err(|_| anyhow::anyhow!("unknown source id {id:?}"))?;
            // Validation (the lookup against the enumeration) happens inside
            // the capture thread, so no `xcap::Monitor` is ever captured by a
            // `move` closure — see `ScreenSource::for_monitor` and
            // `find_monitor`. An id absent from the enumeration still fails
            // with `unknown source`, just reported from the thread.
            Ok(Box::new(ScreenSource::for_monitor(wanted).await?))
        }
        "window" => {
            let wanted: u32 = raw
                .parse()
                .map_err(|_| anyhow::anyhow!("unknown source id {id:?}"))?;
            let window = xcap::Window::all()
                .context("listing windows")?
                .into_iter()
                .find(|w| w.id().map(|wid| wid == wanted).unwrap_or(false))
                .ok_or_else(|| anyhow::anyhow!("unknown source id {id:?}"))?;
            Ok(Box::new(WindowSource::new(window)?))
        }
        // The synthetic pattern (spec §2.3): the only source that exists under
        // `--desktop-source test`, and the id `default_source_id` returns there.
        // It is built here, not in a caller-side match, so the pre-answer
        // source, a swap, and the E2E path all go through one factory.
        "test" => Ok(Box::new(TestPatternSource::new(1280, 720))),
        _ => bail!("unknown source id {id:?}"),
    }
}

/// The live monitor whose id matches `wanted`, or an `unknown source id`
/// error. Enumerates and drops the non-matching monitors here, so only the
/// matched one — the sole non-`Send` capture object — is returned to the
/// caller.
///
/// Called by the capture thread (see `ScreenSource::for_monitor`): `xcap`'s
/// Windows `ImplMonitor` holds a raw `HMONITOR` and carries no
/// `unsafe impl Send`, so an `xcap::Monitor` must never be captured by a
/// `move` closure — it is created inside the thread that uses it instead
/// (spec §6.2). Distinct from `primary_monitor`, which resolves the *default*
/// source by preference order rather than by id.
fn find_monitor(wanted: u32) -> Result<xcap::Monitor> {
    xcap::Monitor::all()
        .context("listing monitors")?
        .into_iter()
        .find(|m| m.id().map(|mid| mid == wanted).unwrap_or(false))
        .ok_or_else(|| anyhow::anyhow!("unknown source id \"monitor:{wanted}\""))
}

/// The monitor at the origin, else the explicitly primary one, else any
/// (Week 7's `primary_recorder` preference order, split out so both the default
/// source and `source_for` pick the same monitor).
fn primary_monitor() -> Result<xcap::Monitor> {
    if let Ok(monitor) = xcap::Monitor::from_point(0, 0) {
        return Ok(monitor);
    }
    let monitors = xcap::Monitor::all().context("listing monitors")?;
    monitors
        .iter()
        .find(|m| m.is_primary().unwrap_or(false))
        .or_else(|| monitors.first())
        .cloned()
        .ok_or_else(|| anyhow::anyhow!("no monitors found"))
}

/// The id of the source streamed before any selection (ADR-22).
///
/// Under `--desktop-source test` the default is the synthetic pattern; on a
/// real host it is the source `preference` names (spec §6.1's
/// `DESKTOP_DEFAULT_SOURCE`), so the enumeration's `default: true` entry and the
/// live stream always agree.
///
/// `preference` is `"primary"` (the shipped default) or an explicit source id.
/// An explicit id is validated against the live enumeration, so a typo is a
/// startup error rather than a black stream; `"primary"` resolves through the
/// same `primary_recorder` logic Week 7 used (`primary_monitor`).
pub fn default_source_id(test: bool, preference: &str) -> Result<String> {
    if test {
        return Ok("test:0".to_string());
    }
    if preference == "primary" {
        let monitor = primary_monitor()?;
        let id = monitor.id().context("reading the primary monitor id")?;
        return Ok(format!("monitor:{id}"));
    }
    // An explicit id must name a source the agent can actually stream.
    let known = enumerate_sources()?;
    if known.iter().any(|source| source.id == preference) {
        Ok(preference.to_string())
    } else {
        bail!(
            "AGENT_DESKTOP_DEFAULT_SOURCE={preference:?} is not an enumerated source; \
             use \"primary\" or one of: {}",
            known
                .iter()
                .map(|source| source.id.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        )
    }
}

/// A window's pixels, captured on demand (spec §6.2).
///
/// Window capture may include occluding windows depending on the platform
/// backend; the picker labels window entries accordingly (spec §6.2). Unlike
/// `ScreenSource` there is no recorder: the thread captures a fresh image per
/// request, so the drop-oldest policy is "keep the latest request".
pub struct WindowSource {
    // The window lives on a dedicated thread (it is not `Send` on every
    // platform — the same reason `ScreenSource` has one). A request channel
    // asks for a frame; a reply channel carries it back.
    request: Option<std::sync::mpsc::Sender<()>>,
    frames: Option<Receiver<xcap::Frame>>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl WindowSource {
    /// Starts a window-capture thread (spec §6.2).
    ///
    /// Sync, unlike `ScreenSource::for_monitor`: a window has no recorder to
    /// open and no first-frame handshake, so "started" is just "the thread is
    /// running". A window that fails to capture logs per tick and simply yields
    /// no frame — the caller keeps streaming the previous one (ADR-22).
    pub fn new(window: xcap::Window) -> Result<Self> {
        let (request_tx, request_rx) = std::sync::mpsc::channel::<()>();
        let (frame_tx, frame_rx) = std::sync::mpsc::channel::<xcap::Frame>();

        let thread = std::thread::Builder::new()
            .name("window-capture".into())
            .spawn(move || {
                loop {
                    if request_rx.recv().is_err() {
                        break; // WindowSource dropped
                    }
                    match window.capture_image() {
                        Ok(image) => {
                            let frame =
                                xcap::Frame::new(image.width(), image.height(), image.into_raw());
                            if frame_tx.send(frame).is_err() {
                                break;
                            }
                        }
                        Err(e) => {
                            tracing::debug!(error = %e, "window capture failed; skipping this tick")
                        }
                    }
                }
            })
            .context("spawning the window capture thread")?;

        Ok(Self {
            request: Some(request_tx),
            frames: Some(frame_rx),
            thread: Some(thread),
        })
    }

    /// Test seam: wires an already-built request sender, frame channel, and
    /// responder thread, so `next_frame`/`stop` can be exercised without a
    /// window. Mirrors `ScreenSource::from_parts_for_test` — the capture thread
    /// is the only platform-specific part of the type.
    #[cfg(test)]
    fn from_parts_for_test(
        request: std::sync::mpsc::Sender<()>,
        frames: Receiver<xcap::Frame>,
        thread: std::thread::JoinHandle<()>,
    ) -> Self {
        Self {
            request: Some(request),
            frames: Some(frames),
            thread: Some(thread),
        }
    }
}

impl FrameSource for WindowSource {
    fn next_frame(&mut self) -> Result<Option<RawFrame>> {
        let (Some(request), Some(frames)) = (self.request.as_ref(), self.frames.as_ref()) else {
            return Ok(None);
        };
        // Ask for one capture, then take the newest frame it produced: a tick
        // that ran late may have queued more than one, and the stream only ever
        // wants the latest (drop-oldest, mirroring `drain_latest`).
        if request.send(()).is_err() {
            return Ok(None);
        }
        Ok(drain_latest(frames).map(|frame| RawFrame {
            width: frame.width,
            height: frame.height,
            rgba: frame.raw,
        }))
    }

    fn stop(&mut self) {
        // Dropping the request sender makes `request_rx.recv()` return `Err`,
        // which breaks the thread loop; the join is bounded by the in-flight
        // capture finishing (exactly as `ScreenSource::stop`).
        self.request.take();
        self.frames.take();
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

/// Returns the share of pixels that are not near-black and the per-channel
/// means, as a diagnostic for the black-video hunt.
///
/// A frame that reaches the encoder almost entirely black means the *capture*
/// is delivering blank pixels (the RDP/WGC path); a frame with real content but
/// a zero-length bitstream means the *encoder* skipped it. The two need very
/// different fixes, so the log line has to tell them apart.
fn frame_content(frame: &RawFrame) -> (f64, [f64; 3]) {
    let mut sum = [0u64; 3];
    let mut nonblack = 0u64;
    let mut px = 0u64;
    for c in frame.rgba.chunks_exact(4) {
        px += 1;
        let mut is_black = true;
        for i in 0..3 {
            let v = c[i];
            sum[i] += v as u64;
            if v > 8 {
                is_black = false;
            }
        }
        if !is_black {
            nonblack += 1;
        }
    }
    let px = px.max(1) as f64;
    (
        100.0 * nonblack as f64 / px,
        [sum[0] as f64 / px, sum[1] as f64 / px, sum[2] as f64 / px],
    )
}

/// How long a requested source switch may take before the agent gives up and
/// keeps the current source (ADR-22; env `AGENT_DESKTOP_SELECT_TIMEOUT_MS`).
///
/// The CLI default in `main.rs` is the same 5000 ms, spelled as a literal
/// because this module is compiled out on musl and so cannot be its source.
/// The constant is the value the swap tests drive `swap_source` with; the
/// non-test build passes the resolved `cfg.desktop_select_timeout` instead.
#[allow(dead_code)]
pub const DEFAULT_SELECT_TIMEOUT: Duration = Duration::from_secs(5);

/// The two source-factory operations a swap needs, behind a seam.
///
/// `enumerate_sources`/`source_for` touch a live display, so a unit test cannot
/// drive the real swap. This trait lets the test inject a fake enumeration and
/// a fake factory while `swap_source` — the ordering, the bound, the leak
/// discipline — stays the production code path.
///
/// `build` is async (it awaits `source_for`'s first-frame handshake), so the
/// trait carries `#[async_trait::async_trait]` — the same pattern `rtc.rs` uses
/// for `PeerConnectionEventHandler`. A bare `async fn` in a public trait would
/// also trip the warn-by-default `async_fn_in_trait` lint under `-D warnings`.
#[async_trait::async_trait]
pub trait SwapSource {
    /// The ids the agent is willing to switch to. A requested id not in this
    /// list is refused (spec §9).
    fn source_ids(&self) -> Vec<String>;
    /// Build the source for an id already validated by `source_ids`.
    async fn build(&self, id: &str) -> Result<Box<dyn FrameSource>>;
}

/// The production `SwapSource`: `xcap` enumeration on a real host, the single
/// synthetic entry under `--desktop-source test` (so a swap in test mode can
/// only ever re-select the test pattern).
pub struct LiveSources {
    pub test: bool,
}

#[async_trait::async_trait]
impl SwapSource for LiveSources {
    fn source_ids(&self) -> Vec<String> {
        if self.test {
            return vec![test_source_info().id];
        }
        enumerate_sources()
            .map(|sources| sources.into_iter().map(|s| s.id).collect())
            .unwrap_or_default()
    }

    async fn build(&self, id: &str) -> Result<Box<dyn FrameSource>> {
        // One factory for every path: `source_for` already handles the `test:`
        // scheme, so the test branch needs no special case here. `source_ids`
        // gates what can reach this, so in test mode `id` is always `test:0`.
        source_for(id, StreamProfile::DEFAULT_1080P30).await
    }
}

/// Build a replacement source + encoder, or fail without disturbing the live
/// one (ADR-22, spec §6.4).
///
/// Takes the current source by `&mut` and returns the new encoder; the current
/// source is stopped (and left in place) only when the new one is fully built,
/// so a failure here is a no-op on the running stream. The id is validated
/// against `sources.source_ids()` **before** `build`, so the factory never sees
/// an unenumerated id.
///
/// Returning the encoder (rather than both sources) is what lets the caller's
/// `Err` arm keep streaming on the current source: the caller owns `current`
/// and never moved it into this call.
async fn swap_source<S: SwapSource>(
    current: &mut Box<dyn FrameSource>,
    sources: &S,
    id: &str,
    profile: StreamProfile,
    timeout: Duration,
) -> Result<DesktopEncoder> {
    if !sources.source_ids().iter().any(|known| known == id) {
        bail!("unknown source id {id:?}");
    }

    // The build is the only part that can hang (a portal that never answers), so
    // it is the part that is bounded. On timeout the half-built source — if any
    // — is dropped inside the future, and `current` is still the live one.
    let built = tokio::time::timeout(timeout, async {
        let source = sources.build(id).await?;
        let encoder = DesktopEncoder::new(profile)?;
        Ok::<_, anyhow::Error>((source, encoder))
    })
    .await
    .map_err(|_| anyhow::anyhow!("source {id:?} did not start within {timeout:?}"))??;

    // Success: the new source is live, so the old one is stopped now — never
    // before, so a failed swap leaks nothing and kills nothing. `stop` is
    // explicit because `FrameSource`'s contract is a method, not `Drop`
    // (`ScreenSource`/`WindowSource` do not implement `Drop`).
    current.stop();
    let (new_source, encoder) = built;
    *current = new_source;
    Ok(encoder)
}

/// How many consecutive over-budget frames before the agent falls back to
/// 720p30. 30 frames is ~1 s at 30 fps — long enough to ride out a transient
/// stall (a GC pause, a scheduler hiccup), short enough that a host which truly
/// cannot sustain 1080p30 drops within a second (ADR-24).
pub const SUSTAIN_FRAMES_BEFORE_FALLBACK: u32 = 30;

/// What the sustain check wants to do next.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SustainAction {
    /// Stay on the current profile.
    Continue,
    /// Rebuild at `SAFE_720P30` — a resolution change, so an encoder rebuild.
    Downgrade,
}

/// The ADR-24 fallback decision, as a pure state machine.
///
/// `run_stream` feeds it one `Duration` per encoded frame; the test feeds it
/// synthetic durations. Keeping the decision out of the encode loop is what
/// makes "downgrade once, never oscillate" unit-testable without a real encoder
/// or a slow host.
pub struct SustainMonitor {
    /// The per-frame budget of the profile currently being encoded.
    budget: Duration,
    /// Consecutive over-budget frames seen so far.
    consecutive_over: u32,
    /// Set once a downgrade is requested (or immediately, at the floor) so the
    /// monitor can never ask twice — ADR-24's anti-oscillation hysteresis.
    latched: bool,
}

impl SustainMonitor {
    pub fn new(profile: StreamProfile) -> Self {
        Self {
            budget: profile.frame_budget(),
            // At the floor there is nowhere to fall back to, so the latch starts
            // closed and `observe` can never return `Downgrade`.
            latched: profile == StreamProfile::SAFE_720P30,
            consecutive_over: 0,
        }
    }

    /// One encoded frame took `encode_time`; decide whether to keep going.
    pub fn observe(&mut self, encode_time: Duration) -> SustainAction {
        if self.latched {
            return SustainAction::Continue;
        }
        if encode_time > self.budget {
            self.consecutive_over += 1;
        } else {
            // A single on-budget frame proves the stall was transient; the
            // streak resets so a jittery-but-sustainable host is never demoted.
            self.consecutive_over = 0;
        }
        if self.consecutive_over >= SUSTAIN_FRAMES_BEFORE_FALLBACK {
            self.latched = true;
            return SustainAction::Downgrade;
        }
        SustainAction::Continue
    }

    /// A manual bitrate change is the user asking for a fresh evaluation, so the
    /// latch re-opens — but only while there is a lower rung to fall to. At the
    /// floor, re-opening would only re-select the same profile, so it stays
    /// closed (ADR-24's "no oscillation").
    pub fn note_manual_bitrate(&mut self, current: StreamProfile) {
        if current != StreamProfile::SAFE_720P30 {
            self.latched = false;
            self.consecutive_over = 0;
        }
    }
}

/// Encodes frames as they arrive and writes each as one media sample.
///
/// Runs until `stop` flips to `true` (checked before the first tick and after
/// every change), the source errors, or a `write_sample` fails — the last one
/// matters because the track is only writable once the peer connection has
/// bound it, and a bound-then-closed transport must end the task rather than
/// spin.
///
/// `ssrc`/`payload_type` are resolved by the caller from the negotiated sender
/// (§6.3) and are never hardcoded.
// Ten parameters: source, track, ssrc, payload type, profile, whether the
// session runs the test source, the swap timeout, the control receiver, the
// events sender, and the stop signal. They are the loop's whole input surface;
// bundling them into a struct would only move the same fields behind one more
// name. `run_desktop_session` carries the same allow.
#[allow(clippy::too_many_arguments)]
pub async fn run_stream(
    mut source: Box<dyn FrameSource>,
    track: Arc<TrackLocalStaticSample>,
    ssrc: SSRC,
    payload_type: PayloadType,
    mut profile: StreamProfile,
    source_is_test: bool,
    select_timeout: Duration,
    mut control: tokio::sync::mpsc::Receiver<StreamControl>,
    events: tokio::sync::mpsc::Sender<StreamEvent>,
    mut stop: watch::Receiver<bool>,
) -> Result<()> {
    // `changed()` only resolves on the *next* send, so a signal that is
    // already set would be missed until the caller sends again. Check first.
    if *stop.borrow() {
        source.stop();
        return Ok(());
    }

    let mut encoder = DesktopEncoder::new(profile)?;
    let mut sustain = SustainMonitor::new(profile);
    let mut ticker = tokio::time::interval(profile.frame_budget());
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    let mut skipped: u64 = 0;
    let mut encoded: u64 = 0;
    // The last encoded frame's dimensions — what `desktop-stats` reports, so
    // the UI's "1920×1080" reflects what is actually on the wire.
    let mut encoded_size = (profile.max_width, profile.max_height);
    // A retarget/swap/downgrade cannot know the *next* frame's real size (the
    // source may be smaller than the profile box, and `downscale` never
    // upscales), so it defers its stats frame to the next encode — where the
    // true size is known. `None` = nothing pending; `Some(status)` = emit on
    // the next frame with that status (`None` status = a plain retarget ack).
    let mut pending_stats: Option<Option<StatsStatus>> = None;
    // Set once the control sender is gone, so the `select!` arm is disabled and
    // the loop cannot spin on a closed channel (a `continue` on `None` would).
    let mut control_closed = false;
    // Best-effort: a full events channel must never stall the stream.
    let send_stats = |events: &tokio::sync::mpsc::Sender<StreamEvent>,
                      size: (u32, u32),
                      profile: StreamProfile,
                      status: Option<StatsStatus>| {
        let stats = DesktopStats {
            width: size.0,
            height: size.1,
            fps: profile.fps,
            target_bitrate_bps: profile.bitrate_bps,
            status,
        };
        let _ = events.try_send(StreamEvent::Stats(stats));
    };
    loop {
        tokio::select! {
            _ = stop.changed() => {
                if *stop.borrow() {
                    break;
                }
            }
            command = control.recv(), if !control_closed => {
                match command {
                    Some(StreamControl::SetBitrate(bps)) => {
                        match encoder.apply_bitrate(bps) {
                            Ok(()) => {
                                profile.bitrate_bps = bps;
                                // A manual change is a fresh evaluation request
                                // (re-arms only above the floor; ADR-24).
                                sustain.note_manual_bitrate(profile);
                                // Reflect the effective value to the UI (spec §2.3 step 6).
                                send_stats(&events, encoded_size, profile, None);
                            }
                            Err(e) => {
                                tracing::warn!(error = %e, bps, "desktop: bitrate retarget failed");
                            }
                        }
                    }
                    Some(StreamControl::SourceSwap(id)) => {
                        match swap_source(
                            &mut source,
                            &LiveSources { test: source_is_test },
                            &id,
                            profile,
                            select_timeout,
                        )
                        .await
                        {
                            Ok(new_encoder) => {
                                encoder = new_encoder;
                                // The new source may be a different size, and
                                // `downscale` never upscales — defer the stats
                                // frame to the next encode, where the real size
                                // is known (spec §6.4).
                                pending_stats = Some(None);
                            }
                            Err(e) => {
                                // The stream keeps running on the current source
                                // (ADR-22). Tell the UI, per spec §2.2.
                                tracing::warn!(source_id = %id, error = %e, "desktop: source swap refused");
                                send_stats(
                                    &events,
                                    encoded_size,
                                    profile,
                                    Some(StatsStatus {
                                        kind: StatsStatusKind::SelectRefused,
                                        detail: format!("could not switch source: {e}"),
                                    }),
                                );
                            }
                        }
                    }
                    None => control_closed = true,
                }
            }
            _ = ticker.tick() => {
                let Some(frame) = source.next_frame()? else {
                    skipped += 1;
                    if skipped % 150 == 1 {
                        tracing::debug!(skipped, "desktop: no new frame this tick");
                    }
                    continue;
                };
                let frame = crop_to_even(downscale(&frame, profile.max_width, profile.max_height));
                let encode_start = Instant::now();
                let data = encoder.encode(&frame)?;
                let encode_time = encode_start.elapsed();

                encoded += 1;
                encoded_size = (frame.width, frame.height);
                // The UI gets one stats frame as soon as the stream is live
                // (spec §2.3 step 6), then one per retarget/swap/downgrade —
                // emitted here, where `encoded_size` is the real frame size. A
                // swap's pending frame is consumed on this tick; a downgrade
                // *below* defers its own to the next tick, because this tick's
                // frame was encoded at the pre-downgrade size.
                if encoded == 1 || pending_stats.is_some() {
                    let status = pending_stats.take().flatten();
                    send_stats(&events, encoded_size, profile, status);
                }

                if sustain.observe(encode_time) == SustainAction::Downgrade {
                    // ADR-24: the host cannot sustain the current profile's
                    // budget, so drop to the guaranteed floor. One rebuild, one
                    // IDR blip, and the monitor's latch is closed by construction
                    // (`SustainMonitor::new(SAFE_720P30)` starts latched).
                    tracing::warn!(
                        from = ?(profile.max_width, profile.max_height),
                        encode_ms = encode_time.as_secs_f64() * 1000.0,
                        "desktop: cannot sustain the profile; falling back to 720p30"
                    );
                    profile = StreamProfile::SAFE_720P30;
                    encoder = DesktopEncoder::new(profile)?;
                    sustain = SustainMonitor::new(profile);
                    // The stats frame carries the *real* next-frame size, so it
                    // is deferred one tick (§6.4) rather than reporting the box.
                    pending_stats = Some(Some(StatsStatus {
                        kind: StatsStatusKind::QualityDowngraded,
                        detail: "720p30 (quality downgraded)".to_string(),
                    }));
                }
                // Diagnostic for the black-video hunt: distinguishes a blank
                // *capture* (nonblack ~0) from a *skipped* encode (nonblack high
                // but `bytes` 0). Guarded by the level so the per-pixel scan
                // costs nothing unless `RUST_LOG=ponter_agent=debug`.
                if tracing::enabled!(tracing::Level::DEBUG) && (encoded == 1 || encoded % 30 == 0) {
                    let (nonblack_pct, mean) = frame_content(&frame);
                    tracing::debug!(
                        encoded,
                        width = frame.width,
                        height = frame.height,
                        nonblack_pct,
                        mean_r = mean[0],
                        mean_g = mean[1],
                        mean_b = mean[2],
                        bytes = data.len(),
                        "desktop: frame"
                    );
                }
                let sample = Sample {
                    data: Bytes::from(data),
                    duration: profile.frame_budget(),
                    ..Sample::new(Instant::now())
                };
                track
                    .sample_writer(ssrc, payload_type)
                    .write_sample(&sample)
                    .await
                    .context("writing a desktop sample")?;
            }
        }
    }

    source.stop();
    Ok(())
}

/// Drains every queued frame and returns the newest; `None` when the queue is
/// empty.
///
/// This is the drop-oldest policy: superseded frames are discarded at the
/// source, so a lagging encoder can never build a backlog — the loop below can
/// only ever see the freshest frame the recorder produced.
fn drain_latest(receiver: &Receiver<xcap::Frame>) -> Option<xcap::Frame> {
    let mut newest = None;
    while let Ok(frame) = receiver.try_recv() {
        newest = Some(frame);
    }
    newest
}

/// The encoder is CPU-bound and synchronous; `run_stream` calls it inline on
/// the runtime worker, which is fine at 15 fps (the ticker's
/// `MissedTickBehavior::Delay` absorbs a slow frame instead of piling ticks
/// up). Moving it to `spawn_blocking` is a Week 8–9 refinement if 720p
/// encoding ever measurably starves the runtime.
///
/// `openh264`'s `Encoder` is `Send` (probe-verified), which is what lets the
/// streaming task own it; frames are converted RGBA8 → YUV 4:2:0
/// (`YUVBuffer`) before encoding.
pub struct DesktopEncoder {
    encoder: Encoder,
    /// The target the encoder is currently configured for; `apply_bitrate`
    /// compares against it to decide whether the raise path is needed.
    bitrate_bps: u32,
}

impl DesktopEncoder {
    pub fn new(profile: StreamProfile) -> Result<Self> {
        let config = EncoderConfig::new()
            .bitrate(BitRate::from_bps(profile.bitrate_bps))
            .max_frame_rate(FrameRate::from_hz(profile.fps))
            .usage_type(UsageType::ScreenContentRealTime)
            // `ScreenContentRealTime` does not implement adaptive quantization
            // or background detection. `EncoderConfig::new()` turns both on by
            // default, so OpenH264's `ParamValidation` auto-disables them on
            // every encoder construction and prints a `WELS_LOG_WARNING`
            // straight to stderr — bypassing `tracing`, which is why it cannot
            // be filtered downstream. Turning them off here states the intent
            // and silences the warning at its source.
            .adaptive_quantization(false)
            .background_detection(false)
            .rate_control_mode(RateControlMode::Bitrate)
            .complexity(Complexity::Low)
            .intra_frame_period(IntraFramePeriod::from_num_frames(60))
            .vui(VuiConfig::bt709());
        let encoder = Encoder::with_api_config(OpenH264API::from_source(), config)
            .context("creating the H.264 encoder")?;
        Ok(Self {
            encoder,
            bitrate_bps: profile.bitrate_bps,
        })
    }

    /// Encodes one frame to Annex-B bytes (each NAL carries its own start
    /// code — verified against `openh264 0.9.8`, see spec §3.2).
    pub fn encode(&mut self, frame: &RawFrame) -> Result<Vec<u8>> {
        debug_assert!(
            frame.width % 2 == 0 && frame.height % 2 == 0,
            "encode() requires even dimensions; callers must run crop_to_even first \
             (got {}x{})",
            frame.width,
            frame.height
        );
        let yuv = YUVBuffer::from_rgba8_source(RgbaSliceU8::new(
            &frame.rgba,
            (frame.width as usize, frame.height as usize),
        ));
        let bitstream = self
            .encoder
            .encode(&yuv)
            .map_err(|e| anyhow::anyhow!("H.264 encode failed: {e}"))?;
        Ok(bitstream.to_vec())
    }

    /// Retarget the encoder in place (ADR-23, spike §3.7).
    ///
    /// No rebuild, no keyframe blip. **Raising** above the current target needs
    /// `ENCODER_OPTION_MAX_BITRATE` on `SPATIAL_LAYER_0` first — setting the
    /// top-level max alone leaves the per-layer max below the new target and
    /// `WelsBitRateVerification` refuses the next call with `rc = 1`.
    /// **Lowering** needs only the single `ENCODER_OPTION_BITRATE` call.
    pub fn apply_bitrate(&mut self, target_bps: u32) -> Result<()> {
        let target = target_bps as c_int;
        unsafe {
            let raw = self.encoder.raw_api();
            if target > self.bitrate_bps as c_int {
                let mut max = SBitrateInfo {
                    iLayer: SPATIAL_LAYER_0,
                    iBitrate: target,
                };
                let rc = raw.set_option(ENCODER_OPTION_MAX_BITRATE, addr_of_mut!(max).cast());
                if rc != 0 {
                    bail!("set_option(MAX_BITRATE, LAYER_0, {target}) failed with rc = {rc}");
                }
            }
            let mut info = SBitrateInfo {
                iLayer: SPATIAL_LAYER_ALL,
                iBitrate: target,
            };
            let rc = raw.set_option(ENCODER_OPTION_BITRATE, addr_of_mut!(info).cast());
            if rc != 0 {
                bail!("set_option(BITRATE, ALL, {target}) failed with rc = {rc}");
            }
        }
        self.bitrate_bps = target_bps;
        Ok(())
    }

    /// The target the encoder reports for `SPATIAL_LAYER_ALL` (test-only probe).
    #[cfg(test)]
    fn reported_bitrate_bps(&mut self) -> i32 {
        unsafe {
            let mut info = SBitrateInfo {
                iLayer: SPATIAL_LAYER_ALL,
                iBitrate: 0,
            };
            let rc = self
                .encoder
                .raw_api()
                .get_option(ENCODER_OPTION_BITRATE, addr_of_mut!(info).cast());
            if rc == 0 {
                info.iBitrate
            } else {
                -1
            }
        }
    }
}

/// The bitrate range a `desktop-bitrate` frame is clamped into (spec §9).
///
/// A hostile or buggy value must not drive the encoder to a degenerate config
/// (0 bps stalls the stream; a multi-gigabit target makes openh264 refuse the
/// retarget). The clamp happens at the wire boundary, in `decode_control`.
pub const MIN_BITRATE_BPS: u32 = 250_000;
pub const MAX_BITRATE_BPS: u32 = 20_000_000;

/// A command the control dispatcher forwards into `run_stream` (spec §6.3).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StreamControl {
    /// Manual bitrate target, already clamped to `MIN..=MAX_BITRATE_BPS`.
    SetBitrate(u32),
    /// Switch to another enumerated source (ADR-22). The id is validated
    /// against the enumeration inside `run_stream`'s swap path, never here.
    SourceSwap(String),
}

/// Clamp a requested bitrate into the sane range (spec §9).
pub fn clamp_bitrate(bps: u32) -> u32 {
    bps.clamp(MIN_BITRATE_BPS, MAX_BITRATE_BPS)
}

/// The auto-ABR decision (spec §3.3): clamp GCC's estimate and apply a 15%
/// dead-band so the encoder is not retargeted on every wobble. `None` means
/// "leave the encoder alone".
///
/// The estimate is ignored until it has **moved off** `ABR_INITIAL_BPS`, so a
/// path that has not yet reported anything keeps the session profile's target
/// rather than snapping to the seed (spec §2.3 step 2).
pub fn abr_next_target(estimate_bps: f64, current_bps: u32) -> Option<u32> {
    if !estimate_bps.is_finite() || estimate_bps <= 0.0 {
        return None;
    }
    let seed = crate::rtc::ABR_INITIAL_BPS;
    if (estimate_bps - seed).abs() < seed * 0.05 {
        return None;
    }
    let target = estimate_bps
        .round()
        .clamp(MIN_BITRATE_BPS as f64, MAX_BITRATE_BPS as f64) as u32;
    let delta = (target as i64 - current_bps as i64).unsigned_abs();
    if delta * 100 < current_bps as u64 * 15 {
        return None;
    }
    Some(target)
}

/// The `desktop-bitrate` payload (spec §2.2).
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopBitrateMessage {
    bitrate_bps: u32,
}

/// The `desktop-select` payload (spec §2.2).
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopSelectMessage {
    source_id: String,
}

/// Decode one inbound control frame into a `StreamControl`.
///
/// Returns `Ok(None)` for a frame on another channel (ADR-09: the agent ignores
/// any other channel) and for an unknown `type` (forward-compatible, spec §2.2);
/// returns `Err` only for a frame that claims to be `control` but is malformed.
/// Mirrors `pty::decode_pty_input`'s shape.
pub fn decode_control(raw: &str) -> Result<Option<StreamControl>> {
    let envelope: crate::pty::DataChannelMessage<serde_json::Value> =
        serde_json::from_str(raw).context("inbound frame is not a DataChannelMessage")?;

    if envelope.channel != "control" {
        return Ok(None);
    }

    match envelope.r#type.as_str() {
        "desktop-select" => {
            let message: DesktopSelectMessage = serde_json::from_value(envelope.payload)
                .context("payload is not a DesktopSelectMessage")?;
            Ok(Some(StreamControl::SourceSwap(message.source_id)))
        }
        "desktop-bitrate" => {
            let message: DesktopBitrateMessage = serde_json::from_value(envelope.payload)
                .context("payload is not a DesktopBitrateMessage")?;
            Ok(Some(StreamControl::SetBitrate(clamp_bitrate(
                message.bitrate_bps,
            ))))
        }
        // An unknown control type is dropped, never answered (spec §2.2).
        _ => Ok(None),
    }
}

/// The single synthetic entry `--desktop-source test` enumerates (spec §2.3).
///
/// CI is headless, so the test path must not touch `xcap` enumeration at all:
/// it reports exactly one source, flagged `default: true`, so the browser
/// auto-selects it and E2E never blocks on a picker.
pub fn test_source_info() -> DesktopSourceInfo {
    DesktopSourceInfo {
        id: "test:0".to_string(),
        kind: SourceKind::Monitor,
        name: "Test pattern".to_string(),
        width: 1280,
        height: 720,
        x: 0,
        y: 0,
        scale_factor: 1.0,
        rotation: 0.0,
        is_primary: true,
        default: true,
    }
}

/// Frame the enumeration as a `desktop-sources` control message (spec §2.2).
///
/// Pure so the wire shape is unit-testable without a peer connection.
pub fn frame_desktop_sources(sources: &[DesktopSourceInfo], timestamp_ms: i64) -> String {
    let message = crate::pty::DataChannelMessage {
        r#type: "desktop-sources".to_string(),
        channel: "control".to_string(),
        payload: serde_json::json!({ "sources": sources }),
        timestamp: timestamp_ms,
    };
    serde_json::to_string(&message).expect("a frame of plain data cannot fail to serialize")
}

/// Telemetry the agent pushes for the UI (spec §2.2/§5.1).
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopStats {
    pub width: u32,
    pub height: u32,
    pub fps: f32,
    pub target_bitrate_bps: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<StatsStatus>,
}

/// An agent→browser note attached to a stats frame (spec §2.2).
#[derive(Clone, Debug, serde::Serialize)]
pub struct StatsStatus {
    pub kind: StatsStatusKind,
    pub detail: String,
}

/// The two note kinds on the wire (spec §2.2). `kebab-case` matches the
/// TypeScript union exactly.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum StatsStatusKind {
    SelectRefused,
    QualityDowngraded,
}

/// Something `run_stream` needs the dispatcher to put on the wire.
#[derive(Debug, Clone)]
pub enum StreamEvent {
    /// Forward as a `desktop-stats` control frame.
    Stats(DesktopStats),
}

/// Frame telemetry as a `desktop-stats` control message (spec §2.2).
pub fn frame_desktop_stats(stats: &DesktopStats, timestamp_ms: i64) -> String {
    let message = crate::pty::DataChannelMessage {
        r#type: "desktop-stats".to_string(),
        channel: "control".to_string(),
        payload: stats.clone(),
        timestamp: timestamp_ms,
    };
    serde_json::to_string(&message).expect("a stats frame cannot fail to serialize")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A frame with per-pixel-varying bytes, so a wrong crop/downscale cannot
    /// accidentally pass by comparing a solid colour.
    fn solid(width: u32, height: u32) -> RawFrame {
        let mut rgba = vec![0u8; (width * height * 4) as usize];
        for (i, px) in rgba.chunks_exact_mut(4).enumerate() {
            px[0] = (i % 251) as u8;
            px[1] = ((i / 251) % 251) as u8;
            px[2] = 128;
            px[3] = 255;
        }
        RawFrame {
            width,
            height,
            rgba,
        }
    }

    /// Like `solid`, but the green channel sweeps with `seed`, so two frames at
    /// the same size carry a *substantially* different pattern — large enough to
    /// trip openh264's scene-change detector (a small delta does not; measured
    /// threshold is around a 16-level shift, and a swept pattern is well past
    /// it).
    fn patterned(width: u32, height: u32, seed: usize) -> RawFrame {
        let mut rgba = vec![0u8; (width * height * 4) as usize];
        for (i, px) in rgba.chunks_exact_mut(4).enumerate() {
            px[0] = ((i + seed * 37) % 251) as u8;
            px[1] = (((i / 251) + seed * 53) % 251) as u8;
            px[2] = ((i * (seed + 1)) % 251) as u8;
            px[3] = 255;
        }
        RawFrame {
            width,
            height,
            rgba,
        }
    }

    #[test]
    fn downscale_fits_1080p_into_the_720p_box() {
        let frame = downscale(
            &solid(1920, 1080),
            StreamProfile::SAFE_720P30.max_width,
            StreamProfile::SAFE_720P30.max_height,
        );
        assert_eq!((frame.width, frame.height), (1280, 720));
        assert_eq!(frame.rgba.len(), (1280 * 720 * 4) as usize);
    }

    #[test]
    fn downscale_preserves_aspect_for_an_ultrawide() {
        let frame = downscale(
            &solid(2560, 1080),
            StreamProfile::SAFE_720P30.max_width,
            StreamProfile::SAFE_720P30.max_height,
        );
        assert_eq!((frame.width, frame.height), (1280, 540));
        assert_eq!(frame.width % 2, 0);
        assert_eq!(frame.height % 2, 0);
    }

    #[test]
    fn downscale_never_upscales_a_small_screen() {
        let source = solid(800, 600);
        let frame = downscale(
            &source,
            StreamProfile::SAFE_720P30.max_width,
            StreamProfile::SAFE_720P30.max_height,
        );
        assert_eq!((frame.width, frame.height), (800, 600));
        assert_eq!(frame.rgba, source.rgba);
    }

    #[test]
    fn crop_to_even_trims_one_pixel_off_odd_dimensions() {
        let frame = crop_to_even(solid(1281, 721));
        assert_eq!((frame.width, frame.height), (1280, 720));
        assert_eq!(frame.rgba.len(), (1280 * 720 * 4) as usize);
    }

    #[test]
    fn crop_to_even_passes_even_frames_through() {
        let frame = crop_to_even(solid(1280, 720));
        assert_eq!((frame.width, frame.height), (1280, 720));
        assert_eq!(frame.rgba.len(), (1280 * 720 * 4) as usize);
    }

    #[test]
    fn test_pattern_is_deterministic_per_frame_number() {
        let mut a = TestPatternSource::new(64, 48);
        let mut b = TestPatternSource::new(64, 48);
        for _ in 0..3 {
            let fa = a.next_frame().unwrap().unwrap();
            let fb = b.next_frame().unwrap().unwrap();
            assert_eq!(fa.width, fb.width);
            assert_eq!(fa.height, fb.height);
            assert_eq!(
                fa.rgba, fb.rgba,
                "same frame number must render identical bytes"
            );
        }
    }

    #[test]
    fn test_pattern_moves_between_frames() {
        let mut source = TestPatternSource::new(64, 48);
        let first = source.next_frame().unwrap().unwrap();
        let second = source.next_frame().unwrap().unwrap();
        assert_ne!(first.rgba, second.rgba);
    }

    #[test]
    fn drain_latest_keeps_the_newest_frame() {
        let (tx, rx) = std::sync::mpsc::channel();
        for w in [1u32, 2, 3] {
            tx.send(xcap::Frame::new(w, 1, vec![w as u8; 4])).unwrap();
        }
        let newest = drain_latest(&rx).expect("three frames queued");
        assert_eq!(newest.width, 3);
    }

    #[test]
    fn drain_latest_on_an_empty_receiver_is_none() {
        let (_tx, rx) = std::sync::mpsc::channel::<xcap::Frame>();
        assert!(drain_latest(&rx).is_none());
    }

    #[test]
    fn encoder_emits_annex_b_and_an_idr_first() {
        let mut encoder = DesktopEncoder::new(StreamProfile::SAFE_720P30).expect("encoder");
        let frame = solid(320, 240);

        let mut saw_idr = false;
        for round in 0..3 {
            let data = encoder.encode(&frame).expect("encode");
            assert!(!data.is_empty());
            assert_eq!(
                &data[..4],
                &[0, 0, 0, 1],
                "round {round}: output must start with an Annex-B start code"
            );

            // Split on start codes and classify the NAL types present.
            let mut types = Vec::new();
            let mut i = 0;
            while i + 4 <= data.len() {
                if data[i..i + 4] == [0, 0, 0, 1] {
                    if i + 4 < data.len() {
                        types.push(data[i + 4] & 0x1F);
                    }
                    i += 4;
                } else {
                    i += 1;
                }
            }
            assert!(!types.is_empty());
            if round == 0 {
                saw_idr = types.contains(&5);
                assert!(types.contains(&7), "first access unit must carry SPS");
                assert!(types.contains(&8), "first access unit must carry PPS");
            }
        }
        assert!(saw_idr, "the first frame must be an IDR access unit");
    }

    #[test]
    fn screen_source_forwards_frames_from_a_stub_capture_thread() {
        // The capture thread is the only platform-specific part of ScreenSource;
        // the channel plumbing on either side of it is what this test pins.
        let (tx, rx) = std::sync::mpsc::channel::<xcap::Frame>();
        tx.send(xcap::Frame::new(4, 4, vec![7u8; 64])).unwrap();
        let mut source = ScreenSource::from_parts_for_test(rx);
        let frame = source.next_frame().unwrap().expect("one queued frame");
        assert_eq!((frame.width, frame.height), (4, 4));
        assert_eq!(frame.rgba.len(), 64);
        assert!(source.next_frame().unwrap().is_none(), "queue drained");
        source.stop();
    }

    #[test]
    fn await_first_frame_forwards_the_first_frame_and_succeeds() {
        let (tx, rx) = std::sync::mpsc::channel::<xcap::Frame>();
        let (frame_tx, frame_rx) = std::sync::mpsc::channel::<xcap::Frame>();
        tx.send(xcap::Frame::new(8, 6, vec![1u8; 8 * 6 * 4]))
            .unwrap();

        await_first_frame(&rx, &frame_tx, Duration::from_secs(1))
            .expect("a queued frame is an immediate success");

        // The frame must be forwarded, not swallowed: the streaming loop still
        // needs to see it after `new()` reports ready.
        let forwarded = frame_rx.try_recv().expect("the first frame is forwarded");
        assert_eq!((forwarded.width, forwarded.height), (8, 6));
    }

    #[test]
    fn await_first_frame_reports_an_error_when_no_frame_ever_arrives() {
        // The regression this pins: a recorder that `start()`s successfully but
        // never delivers a frame (a denied ScreenCast permission) must be an
        // error, not a silent black stream. Before the wait existed, `new()`
        // returned `Ok` here and the browser timed out 20s later.
        let (_tx, rx) = std::sync::mpsc::channel::<xcap::Frame>();
        let (frame_tx, _frame_rx) = std::sync::mpsc::channel::<xcap::Frame>();

        let err = await_first_frame(&rx, &frame_tx, Duration::from_millis(50))
            .expect_err("no frame within the timeout must be an error");
        assert!(
            err.contains("produced no frames"),
            "the error must name the missing-frame failure, got: {err}"
        );
    }

    #[test]
    fn await_first_frame_reports_an_error_when_the_stream_ends_first() {
        let (tx, rx) = std::sync::mpsc::channel::<xcap::Frame>();
        let (frame_tx, _frame_rx) = std::sync::mpsc::channel::<xcap::Frame>();
        drop(tx);

        let err = await_first_frame(&rx, &frame_tx, Duration::from_secs(1))
            .expect_err("a disconnected stream must be an error");
        assert!(
            err.contains("ended before its first frame"),
            "the error must name the early-end failure, got: {err}"
        );
    }

    /// A recorder whose `start` outcome and stop are fully controlled, so the
    /// "started fine but never produced a frame" case can be reproduced without
    /// a display or a portal.
    struct FakeRecorder {
        start_result: std::result::Result<(), String>,
        stopped: Arc<std::sync::atomic::AtomicBool>,
    }

    impl CaptureRecorder for FakeRecorder {
        fn start(&self) -> std::result::Result<(), String> {
            self.start_result.clone()
        }
        fn stop(&self) -> std::result::Result<(), String> {
            self.stopped
                .store(true, std::sync::atomic::Ordering::SeqCst);
            Ok(())
        }
    }

    /// The regression for the production bug: a recorder that `start()`s
    /// successfully but never feeds a frame (denied ScreenCast permission) must
    /// make `run_capture` report an error, not sit forwarding nothing forever.
    /// Before the first-frame wait, this path reported `Ok(())` and the browser
    /// timed out 20s later.
    #[test]
    fn run_capture_refuses_when_the_recorder_starts_but_never_feeds() {
        let (ready_tx, mut ready_rx) = oneshot::channel();
        let (_frame_in, frames) = std::sync::mpsc::channel::<xcap::Frame>();
        let (frame_tx, _frame_out) = std::sync::mpsc::channel::<xcap::Frame>();
        let (_stop_tx, stop_rx) = std::sync::mpsc::channel::<()>();
        let stopped = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let recorder = FakeRecorder {
            start_result: Ok(()),
            stopped: stopped.clone(),
        };

        run_capture(
            recorder,
            frames,
            ready_tx,
            frame_tx,
            stop_rx,
            Duration::from_millis(50),
        );

        let outcome = ready_rx
            .try_recv()
            .expect("run_capture must report a setup outcome");
        let message = outcome.expect_err("a recorder that never feeds must be refused");
        assert!(
            message.contains("produced no frames"),
            "the refusal must name the missing-frame failure, got: {message}"
        );
        assert!(
            stopped.load(std::sync::atomic::Ordering::SeqCst),
            "the recorder must be stopped on the refusal path"
        );
    }

    /// The happy path: once a first frame arrives the setup reports `Ok`, the
    /// frame reaches the streaming loop, and the recorder is stopped on exit.
    #[test]
    fn run_capture_streams_the_first_frame_then_stops() {
        let (ready_tx, mut ready_rx) = oneshot::channel();
        let (frame_in, frames) = std::sync::mpsc::channel::<xcap::Frame>();
        let (frame_tx, frame_out) = std::sync::mpsc::channel::<xcap::Frame>();
        let (stop_tx, stop_rx) = std::sync::mpsc::channel::<()>();
        let stopped = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let recorder = FakeRecorder {
            start_result: Ok(()),
            stopped: stopped.clone(),
        };

        frame_in
            .send(xcap::Frame::new(4, 4, vec![9u8; 64]))
            .unwrap();
        stop_tx.send(()).unwrap();

        run_capture(
            recorder,
            frames,
            ready_tx,
            frame_tx,
            stop_rx,
            Duration::from_secs(1),
        );

        assert!(
            ready_rx.try_recv().expect("a setup outcome").is_ok(),
            "a feeding recorder must be accepted"
        );
        let forwarded = frame_out
            .try_recv()
            .expect("the first frame must reach the streaming loop");
        assert_eq!((forwarded.width, forwarded.height), (4, 4));
        assert!(
            stopped.load(std::sync::atomic::Ordering::SeqCst),
            "the recorder must be stopped when the loop exits"
        );
    }

    #[test]
    fn run_capture_reports_a_start_failure_without_waiting_for_a_frame() {
        let (ready_tx, mut ready_rx) = oneshot::channel();
        let (_frame_in, frames) = std::sync::mpsc::channel::<xcap::Frame>();
        let (frame_tx, _frame_out) = std::sync::mpsc::channel::<xcap::Frame>();
        let (_stop_tx, stop_rx) = std::sync::mpsc::channel::<()>();
        let stopped = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let recorder = FakeRecorder {
            start_result: Err("no portal".to_string()),
            stopped: stopped.clone(),
        };

        run_capture(
            recorder,
            frames,
            ready_tx,
            frame_tx,
            stop_rx,
            Duration::from_secs(5),
        );

        let message = ready_rx
            .try_recv()
            .expect("a setup outcome")
            .expect_err("a failed start must be reported");
        assert!(
            message.contains("starting capture: no portal"),
            "the error must carry the start failure, got: {message}"
        );
    }

    /// `ScreenSource::new` must not panic or hang on a headless machine; it
    /// either returns a source or a clean error. Needs a live display, so it
    /// is ignored by default and run manually on the dev machine.
    ///
    /// This is the end-to-end regression for the Wayland black-screen bug: a
    /// capture that connects to PipeWire but never delivers a frame used to
    /// pass here vacuously (the old body only asserted *if* a frame arrived).
    /// It now requires a real frame, so the vendored `xcap` lifetime fix —
    /// keeping the portal ScreenCast session alive — is what makes it green.
    #[tokio::test]
    #[ignore = "needs a live display; run manually on the dev machine"]
    async fn screen_source_smoke_on_a_live_display() {
        // The primary monitor via the new factory — the same path `main.rs`
        // takes, so this stays a real end-to-end regression for the Wayland
        // black-screen bug.
        let id = default_source_id(false, "primary").expect("a primary monitor");
        let mut source = source_for(&id, StreamProfile::SAFE_720P30)
            .await
            .expect("live display");
        let frame = source
            .next_frame()
            .unwrap()
            .expect("a live display must deliver at least one frame");
        assert_eq!(frame.rgba.len(), (frame.width * frame.height * 4) as usize);
        assert!(
            frame.width > 0 && frame.height > 0,
            "the delivered frame must have real dimensions"
        );
        source.stop();
    }

    /// A track with an empty coding list: `write_sample` on it fails
    /// deterministically with `Error::CodecNotFound` (verified in the webrtc
    /// 0.21 sources: `codec(ssrc)` finds no coding and returns early before
    /// any packetizing), so these tests need no peer connection and no
    /// runtime driver.
    fn unbound_track() -> Arc<TrackLocalStaticSample> {
        Arc::new(
            TrackLocalStaticSample::new(
                Instant::now(),
                rtc::media_stream::MediaStreamTrack::new(
                    "test-stream".into(),
                    "test-track".into(),
                    // The label value is irrelevant to these tests; Task 4's
                    // `DESKTOP_LABEL` (rtc.rs) carries the same string.
                    "desktop".into(),
                    rtc::rtp_transceiver::rtp_sender::RtpCodecKind::Video,
                    vec![],
                ),
            )
            .expect("track"),
        )
    }

    #[tokio::test]
    async fn run_stream_stops_cleanly_without_a_bound_track() {
        // Before the peer connection binds the track, `write_sample` errors
        // with `CodecNotFound` — the loop must report that as an error instead
        // of spinning, so the session loop can tear down.
        let (stop_tx, stop_rx) = watch::channel(false);
        let source = Box::new(TestPatternSource::new(64, 48));
        let (_control_tx, control_rx) = tokio::sync::mpsc::channel::<StreamControl>(1);
        let (events_tx, _events_rx) = tokio::sync::mpsc::channel::<StreamEvent>(1);

        let result = run_stream(
            source,
            unbound_track(),
            1234,
            96,
            StreamProfile::SAFE_720P30,
            false,
            DEFAULT_SELECT_TIMEOUT,
            control_rx,
            events_tx,
            stop_rx,
        )
        .await;
        let err = result.expect_err("writing to an unbound track must surface an error");
        let chain = format!("{err:#}");
        assert!(
            chain.contains("codec not found"),
            "the error must be the missing-codec failure, got: {chain}"
        );
        drop(stop_tx);
    }

    #[tokio::test]
    async fn run_stream_honours_a_pre_set_stop_signal() {
        // A stop that is already set when the task starts must end it without
        // touching the track at all. `watch::Receiver::changed` only wakes on
        // the *next* send, so `run_stream` checks the current value up front —
        // this test pins that check.
        let (stop_tx, stop_rx) = watch::channel(true);
        let source = Box::new(TestPatternSource::new(64, 48));
        let (_control_tx, control_rx) = tokio::sync::mpsc::channel::<StreamControl>(1);
        let (events_tx, _events_rx) = tokio::sync::mpsc::channel::<StreamEvent>(1);

        let result = tokio::time::timeout(
            Duration::from_secs(1),
            run_stream(
                source,
                unbound_track(),
                1234,
                96,
                StreamProfile::SAFE_720P30,
                false,
                DEFAULT_SELECT_TIMEOUT,
                control_rx,
                events_tx,
                stop_rx,
            ),
        )
        .await
        .expect("run_stream must exit promptly when stop is already set");
        assert!(result.is_ok());
        drop(stop_tx);
    }

    /// An id with an unknown scheme is refused without touching the display, so
    /// this runs in headless CI (unlike the enumeration-miss case below).
    #[tokio::test]
    async fn source_for_rejects_an_unknown_scheme() {
        // `.err()` rather than `.unwrap_err()`: the success type is
        // `Box<dyn FrameSource>`, which is not `Debug`.
        let err = source_for("bogus:1", StreamProfile::SAFE_720P30)
            .await
            .err()
            .expect("an unknown scheme must be refused");
        assert!(format!("{err:#}").contains("unknown source"));
    }

    /// A well-formed id that names no live monitor is refused too. Enumeration
    /// runs first, so this needs a live display; run manually on the dev machine.
    #[tokio::test]
    #[ignore = "needs a live display; run manually on the dev machine"]
    async fn source_for_rejects_an_id_absent_from_the_enumeration() {
        let err = source_for("monitor:999999", StreamProfile::SAFE_720P30)
            .await
            .err()
            .expect("an id absent from the enumeration must be refused");
        assert!(format!("{err:#}").contains("unknown source"));
    }

    #[test]
    fn downscale_uses_the_profile_box() {
        // 1080p passthrough under the 1080p30 profile; boxed under 720p30.
        let frame = downscale(&solid(1920, 1080), 1920, 1080);
        assert_eq!((frame.width, frame.height), (1920, 1080));
        let boxed = downscale(&solid(1920, 1080), 1280, 720);
        assert_eq!((boxed.width, boxed.height), (1280, 720));
    }

    /// `enumerate_sources` needs a live display; run manually on the dev machine.
    #[test]
    #[ignore = "needs a live display; run manually on the dev machine"]
    fn enumerate_sources_lists_at_least_one_monitor() {
        let sources = enumerate_sources().expect("a live display");
        assert!(sources.iter().any(|s| s.kind == SourceKind::Monitor));
        // `id` is stable across two calls (spec §6.5).
        let again = enumerate_sources().expect("a live display");
        let ids: Vec<_> = sources.iter().map(|s| s.id.clone()).collect();
        let ids_again: Vec<_> = again.iter().map(|s| s.id.clone()).collect();
        assert_eq!(ids, ids_again);
    }

    /// `WindowSource` is a `FrameSource` with real teardown, so it needs the same
    /// headless seam `ScreenSource` has (`from_parts_for_test`, line 390): the
    /// capture thread is the only platform-specific part, and the channel
    /// plumbing on either side of it is what this test pins — a queued frame is
    /// returned once, the queue then drains, and `stop` takes the sender so a
    /// subsequent call is a clean `None` (never a panic on a dead thread).
    #[test]
    fn window_source_forwards_frames_and_stops_cleanly() {
        let (request_tx, request_rx) = std::sync::mpsc::channel::<()>();
        let (frame_tx, frame_rx) = std::sync::mpsc::channel::<xcap::Frame>();
        // Pre-queue the frame the capture thread would produce, so `next_frame`'s
        // drain is deterministic: the real thread pushes asynchronously, but the
        // request/reply plumbing is the part this test pins.
        frame_tx
            .send(xcap::Frame::new(4, 4, vec![7u8; 64]))
            .unwrap();
        // A stub responder standing in for the capture thread: it drains requests
        // and ends when `stop` drops the request sender.
        let responder = std::thread::spawn(move || while request_rx.recv().is_ok() {});
        let mut source = WindowSource::from_parts_for_test(request_tx, frame_rx, responder);

        let frame = source.next_frame().unwrap().expect("one queued frame");
        assert_eq!((frame.width, frame.height), (4, 4));
        assert_eq!(frame.rgba.len(), 64);
        assert!(source.next_frame().unwrap().is_none(), "queue drained");

        // `stop` drops the request sender, so the responder's `recv` returns Err
        // and the thread ends; the join in `stop` must complete rather than hang.
        source.stop();
        assert!(
            source.next_frame().unwrap().is_none(),
            "stopped source yields nothing"
        );
    }

    /// Pins what `ScreenContentRealTime` actually does, replacing the plan's
    /// original assertion that it emits an IDR only on the first frame.
    ///
    /// **The watch item FIRED (measured 2026-10-03).** The plan's original
    /// assertion (`0` IDRs after frame 0 under *varying* content) is **disproven**
    /// and is not what this test asserts any more. Measurements against
    /// `DesktopEncoder::new` (`ScreenContentRealTime`): varying content at a
    /// fixed size emits an IDR on every content change (5 IDRs / 5 changed
    /// frames); constant content emits none (0 IDRs); varying *geometry* gives
    /// 2 IDRs across 3 frames. So the usage type emits an IDR on every content
    /// change — near per-frame for real desktop content — which is why ADR-24's
    /// "one IDR on a resolution change" is not a distinct artifact class. Raised
    /// to the PM; **watch item resolved by the PM ruling of 2026-10-03**: keep
    /// `ScreenContentRealTime` unchanged, keep the Task 4d fallback unchanged,
    /// and pin the measured behavior here instead of the disproven assertion.
    #[test]
    fn screen_content_real_time_emits_idrs_on_content_change() {
        // (a) Identical consecutive frames: no IDR after the first access unit.
        let mut steady = DesktopEncoder::new(StreamProfile::SAFE_720P30).expect("encoder");
        let frame = patterned(320, 240, 0);
        let _ = steady.encode(&frame).expect("first");
        let mut idrs = 0;
        for _ in 0..5 {
            let data = steady.encode(&frame).expect("encode");
            idrs += count_idrs(&data);
        }
        assert_eq!(
            idrs, 0,
            "constant content must not emit an IDR after the first access unit"
        );

        // (b) Different content at a fixed size: at least one IDR after frame 0.
        let mut changing = DesktopEncoder::new(StreamProfile::SAFE_720P30).expect("encoder");
        let _ = changing.encode(&patterned(320, 240, 0)).expect("first");
        let mut idrs = 0;
        for seed in 1..=5usize {
            let data = changing.encode(&patterned(320, 240, seed)).expect("encode");
            idrs += count_idrs(&data);
        }
        assert!(
            idrs >= 1,
            "ScreenContentRealTime must emit an IDR on a content change, got {idrs}"
        );
    }

    /// Count IDR NAL units (type 5) in an Annex-B byte stream.
    fn count_idrs(data: &[u8]) -> usize {
        let mut count = 0;
        let mut i = 0;
        while i + 5 <= data.len() {
            if data[i..i + 4] == [0, 0, 0, 1] && (data[i + 4] & 0x1F) == 5 {
                count += 1;
            }
            i += 1;
        }
        count
    }

    #[test]
    fn decode_control_reads_a_desktop_select() {
        let raw = serde_json::json!({
            "type": "desktop-select",
            "channel": "control",
            "payload": { "sourceId": "window:0x4a00007" },
            "timestamp": 1,
        })
        .to_string();
        assert_eq!(
            decode_control(&raw).unwrap(),
            Some(StreamControl::SourceSwap("window:0x4a00007".to_string()))
        );
    }

    #[test]
    fn decode_control_reads_and_clamps_a_desktop_bitrate() {
        let frame = |bps: u32| {
            serde_json::json!({
                "type": "desktop-bitrate",
                "channel": "control",
                "payload": { "bitrateBps": bps },
                "timestamp": 1,
            })
            .to_string()
        };
        assert_eq!(
            decode_control(&frame(3_000_000)).unwrap(),
            Some(StreamControl::SetBitrate(3_000_000))
        );
        assert_eq!(
            decode_control(&frame(1)).unwrap(),
            Some(StreamControl::SetBitrate(MIN_BITRATE_BPS))
        );
        assert_eq!(
            decode_control(&frame(u32::MAX)).unwrap(),
            Some(StreamControl::SetBitrate(MAX_BITRATE_BPS))
        );
    }

    #[test]
    fn decode_control_ignores_another_channel_and_an_unknown_type() {
        let wrong_channel = serde_json::json!({
            "type": "desktop-select",
            "channel": "terminal",
            "payload": { "sourceId": "monitor:1" },
            "timestamp": 1,
        })
        .to_string();
        assert_eq!(decode_control(&wrong_channel).unwrap(), None);

        let unknown = serde_json::json!({
            "type": "desktop-future",
            "channel": "control",
            "payload": {},
            "timestamp": 1,
        })
        .to_string();
        assert_eq!(decode_control(&unknown).unwrap(), None);
    }

    #[test]
    fn decode_control_rejects_a_malformed_select_payload() {
        let raw = serde_json::json!({
            "type": "desktop-select",
            "channel": "control",
            "payload": { "sourceId": 42 },
            "timestamp": 1,
        })
        .to_string();
        assert!(decode_control(&raw).is_err());
    }

    #[test]
    fn frame_desktop_sources_carries_the_envelope_and_the_default_flag() {
        let raw = frame_desktop_sources(&[test_source_info()], 7);
        let value: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(value["type"], "desktop-sources");
        assert_eq!(value["channel"], "control");
        assert_eq!(value["timestamp"], 7);
        assert_eq!(value["payload"]["sources"][0]["id"], "test:0");
        assert_eq!(value["payload"]["sources"][0]["default"], true);
        // The camelCase wire spelling, not the Rust field name.
        assert!(value["payload"]["sources"][0].get("scaleFactor").is_some());
        assert!(value["payload"]["sources"][0].get("scale_factor").is_none());
    }

    #[test]
    fn apply_bitrate_raises_in_place_and_echoes_the_new_target() {
        let mut encoder = DesktopEncoder::new(StreamProfile::SAFE_720P30).expect("encoder");
        // openh264's wrapper initializes the underlying encoder lazily inside
        // the first `encode()`, so `SetOption` before that returns
        // `cmInitExpected` (rc = 4). Production retargets mid-stream (the
        // spike did it at frame 60), so prime one frame first.
        let frame = crop_to_even(solid(320, 240));
        let _ = encoder.encode(&frame).expect("prime");
        // 4 Mbps -> 6 Mbps is a raise, so this is also the ordering guard: with
        // the MAX_BITRATE-on-layer-0 step omitted, the BITRATE call fails with
        // rc = 1 (spike §3.7) and `apply_bitrate` returns Err.
        encoder.apply_bitrate(6_000_000).expect("raise");
        assert_eq!(encoder.reported_bitrate_bps(), 6_000_000);
    }

    #[test]
    fn apply_bitrate_lowers_in_place_with_the_single_call() {
        let mut encoder = DesktopEncoder::new(StreamProfile::DEFAULT_1080P30).expect("encoder");
        let frame = crop_to_even(solid(320, 240));
        let _ = encoder.encode(&frame).expect("prime");
        encoder.apply_bitrate(1_000_000).expect("lower");
        assert_eq!(encoder.reported_bitrate_bps(), 1_000_000);
    }

    #[test]
    fn apply_bitrate_does_not_add_an_idr_to_the_next_frame() {
        // ADR-23's whole point is "no blip". Whether the production usage type
        // emits an IDR per frame is the Task 3 watch item, so this asserts the
        // weaker, always-true property: the retarget does not make an IDR
        // *appear* on a frame that would otherwise have had none.
        let mut encoder = DesktopEncoder::new(StreamProfile::SAFE_720P30).expect("encoder");
        let frame = crop_to_even(solid(320, 240));
        let _ = encoder.encode(&frame).expect("first");
        let before = has_idr(&encoder.encode(&frame).expect("second"));
        encoder.apply_bitrate(6_000_000).expect("raise");
        let after = has_idr(&encoder.encode(&frame).expect("third"));
        assert!(
            before || !after,
            "apply_bitrate introduced an IDR on a frame that had none"
        );
    }

    /// True when the Annex-B byte stream contains an IDR NAL (type 5).
    fn has_idr(data: &[u8]) -> bool {
        let mut i = 0;
        while i + 5 <= data.len() {
            if data[i..i + 4] == [0, 0, 0, 1] && (data[i + 4] & 0x1F) == 5 {
                return true;
            }
            i += 1;
        }
        false
    }

    #[test]
    fn frame_desktop_stats_uses_the_camel_case_wire_shape() {
        let stats = DesktopStats {
            width: 1280,
            height: 720,
            fps: 30.0,
            target_bitrate_bps: 4_000_000,
            status: Some(StatsStatus {
                kind: StatsStatusKind::QualityDowngraded,
                detail: "720p (quality downgraded)".to_string(),
            }),
        };
        let value: serde_json::Value =
            serde_json::from_str(&frame_desktop_stats(&stats, 3)).unwrap();
        assert_eq!(value["type"], "desktop-stats");
        assert_eq!(value["channel"], "control");
        assert_eq!(value["timestamp"], 3);
        assert_eq!(value["payload"]["targetBitrateBps"], 4_000_000);
        assert_eq!(value["payload"]["status"]["kind"], "quality-downgraded");
    }

    #[test]
    fn frame_desktop_stats_omits_an_absent_status() {
        let stats = DesktopStats {
            width: 1920,
            height: 1080,
            fps: 30.0,
            target_bitrate_bps: 6_000_000,
            status: None,
        };
        let value: serde_json::Value =
            serde_json::from_str(&frame_desktop_stats(&stats, 1)).unwrap();
        assert!(value["payload"].get("status").is_none());
    }

    /// A `FrameSource` that records how often it was stopped.
    struct FakeSource {
        stopped: Arc<std::sync::atomic::AtomicUsize>,
    }
    impl FrameSource for FakeSource {
        fn next_frame(&mut self) -> Result<Option<RawFrame>> {
            Ok(None)
        }
        fn stop(&mut self) {
            self.stopped
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        }
    }

    /// A `SwapSource` whose enumeration and factory the test controls.
    struct FakeSources {
        ids: Vec<String>,
        fail: bool,
        hang: bool,
    }
    #[async_trait::async_trait]
    impl SwapSource for FakeSources {
        fn source_ids(&self) -> Vec<String> {
            self.ids.clone()
        }
        async fn build(&self, _id: &str) -> Result<Box<dyn FrameSource>> {
            if self.hang {
                // An async wait, NOT a blocking sleep: `tokio::time::timeout`
                // only fires if the runtime keeps driving the timer, and a
                // blocking sleep inside the polled future would block the very
                // thread the timer needs (a current-thread runtime would
                // deadlock, and the test would hang forever instead of failing).
                // An `await` yields the worker, so the timer fires — exactly the
                // async-friendly hang the bound exists for (a portal that
                // accepts the request and never answers, like `source_for`'s
                // `ready_rx.await`). The plan's `std::thread::sleep` here cannot
                // be preempted; see the ledger ruling.
                tokio::time::sleep(Duration::from_secs(30)).await;
            }
            if self.fail {
                bail!("the fake source refused to start");
            }
            Ok(Box::new(FakeSource {
                stopped: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
            }))
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn swap_source_stops_the_old_source_only_after_the_new_one_is_built() {
        let stopped = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let mut current: Box<dyn FrameSource> = Box::new(FakeSource {
            stopped: stopped.clone(),
        });
        let sources = FakeSources {
            ids: vec!["monitor:1".to_string()],
            fail: false,
            hang: false,
        };

        let _encoder = swap_source(
            &mut current,
            &sources,
            "monitor:1",
            StreamProfile::SAFE_720P30,
            DEFAULT_SELECT_TIMEOUT,
        )
        .await
        .expect("a valid swap");

        assert_eq!(stopped.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn swap_source_refuses_an_unenumerated_id_without_touching_the_current_source() {
        let stopped = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let mut current: Box<dyn FrameSource> = Box::new(FakeSource {
            stopped: stopped.clone(),
        });
        let sources = FakeSources {
            ids: vec!["monitor:1".to_string()],
            fail: false,
            hang: false,
        };

        let result = swap_source(
            &mut current,
            &sources,
            "monitor:999999",
            StreamProfile::SAFE_720P30,
            DEFAULT_SELECT_TIMEOUT,
        )
        .await;

        assert!(result.is_err(), "an unenumerated id must be refused");
        assert_eq!(stopped.load(std::sync::atomic::Ordering::SeqCst), 0);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn swap_source_keeps_the_current_source_when_the_new_one_fails_to_start() {
        let stopped = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let mut current: Box<dyn FrameSource> = Box::new(FakeSource {
            stopped: stopped.clone(),
        });
        let sources = FakeSources {
            ids: vec!["monitor:1".to_string()],
            fail: true,
            hang: false,
        };

        let result = swap_source(
            &mut current,
            &sources,
            "monitor:1",
            StreamProfile::SAFE_720P30,
            DEFAULT_SELECT_TIMEOUT,
        )
        .await;

        assert!(result.is_err());
        assert_eq!(
            stopped.load(std::sync::atomic::Ordering::SeqCst),
            0,
            "a failed swap must not stop the live source"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn swap_source_gives_up_on_a_slow_build_within_the_bound() {
        let stopped = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let mut current: Box<dyn FrameSource> = Box::new(FakeSource {
            stopped: stopped.clone(),
        });
        let sources = FakeSources {
            ids: vec!["monitor:1".to_string()],
            fail: false,
            hang: true,
        };

        let started = std::time::Instant::now();
        let result = swap_source(
            &mut current,
            &sources,
            "monitor:1",
            StreamProfile::SAFE_720P30,
            Duration::from_millis(200),
        )
        .await;

        assert!(result.is_err());
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "the swap must be bounded by the timeout, not the build"
        );
        assert_eq!(stopped.load(std::sync::atomic::Ordering::SeqCst), 0);
    }

    #[test]
    fn sustain_monitor_downgrades_once_and_never_oscillates() {
        let mut monitor = SustainMonitor::new(StreamProfile::DEFAULT_1080P30);
        let slow = Duration::from_millis(50); // > the 33.3 ms 1080p30 budget

        for _ in 0..SUSTAIN_FRAMES_BEFORE_FALLBACK - 1 {
            assert_eq!(monitor.observe(slow), SustainAction::Continue);
        }
        assert_eq!(
            monitor.observe(slow),
            SustainAction::Downgrade,
            "the 30th consecutive slow frame trips the fallback"
        );
        for _ in 0..200 {
            assert_eq!(
                monitor.observe(slow),
                SustainAction::Continue,
                "a downgraded monitor must never ask again"
            );
        }
    }

    #[test]
    fn sustain_monitor_resets_the_streak_on_an_on_budget_frame() {
        let mut monitor = SustainMonitor::new(StreamProfile::DEFAULT_1080P30);
        let slow = Duration::from_millis(50);
        let fast = Duration::from_millis(5);

        for _ in 0..SUSTAIN_FRAMES_BEFORE_FALLBACK - 1 {
            monitor.observe(slow);
        }
        monitor.observe(fast); // proves the host can keep up; reset
        for _ in 0..SUSTAIN_FRAMES_BEFORE_FALLBACK - 1 {
            assert_eq!(monitor.observe(slow), SustainAction::Continue);
        }
        assert_eq!(monitor.observe(slow), SustainAction::Downgrade);
    }

    #[test]
    fn sustain_monitor_never_downgrades_from_the_floor() {
        let mut monitor = SustainMonitor::new(StreamProfile::SAFE_720P30);
        let slow = Duration::from_millis(50);
        for _ in 0..SUSTAIN_FRAMES_BEFORE_FALLBACK * 4 {
            assert_eq!(monitor.observe(slow), SustainAction::Continue);
        }
    }

    #[test]
    fn sustain_monitor_reopens_only_above_the_floor() {
        let mut monitor = SustainMonitor::new(StreamProfile::DEFAULT_1080P30);
        let slow = Duration::from_millis(50);
        for _ in 0..SUSTAIN_FRAMES_BEFORE_FALLBACK {
            monitor.observe(slow); // trips and latches
        }
        assert_eq!(monitor.observe(slow), SustainAction::Continue, "latched");

        // A manual change above the floor re-arms exactly one more evaluation.
        monitor.note_manual_bitrate(StreamProfile::DEFAULT_1080P30);
        for _ in 0..SUSTAIN_FRAMES_BEFORE_FALLBACK - 1 {
            assert_eq!(monitor.observe(slow), SustainAction::Continue);
        }
        assert_eq!(monitor.observe(slow), SustainAction::Downgrade);

        // At the floor, a manual change does not re-arm.
        let mut at_floor = SustainMonitor::new(StreamProfile::SAFE_720P30);
        at_floor.note_manual_bitrate(StreamProfile::SAFE_720P30);
        for _ in 0..SUSTAIN_FRAMES_BEFORE_FALLBACK * 2 {
            assert_eq!(at_floor.observe(slow), SustainAction::Continue);
        }
    }

    #[test]
    fn abr_next_target_ignores_the_unmoved_seed() {
        // GCC's published value equals the seed until feedback arrives: the
        // stream must keep the session profile's target (spec §2.3 step 2).
        assert_eq!(
            abr_next_target(crate::rtc::ABR_INITIAL_BPS, 6_000_000),
            None
        );
    }

    #[test]
    fn abr_next_target_applies_a_dead_band() {
        // A 10% move is inside the 15% dead-band and must not retarget.
        assert_eq!(abr_next_target(4_400_000.0, 4_000_000), None);
        // A 50% move is outside it.
        assert_eq!(abr_next_target(6_000_000.0, 4_000_000), Some(6_000_000));
    }

    #[test]
    fn abr_next_target_clamps_and_rejects_garbage() {
        assert_eq!(abr_next_target(0.0, 4_000_000), None);
        assert_eq!(abr_next_target(f64::NAN, 4_000_000), None);
        assert_eq!(abr_next_target(1.0e12, 4_000_000), Some(MAX_BITRATE_BPS));
        assert_eq!(abr_next_target(1.0, 4_000_000), Some(MIN_BITRATE_BPS));
    }
}
