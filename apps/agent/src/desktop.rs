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
use rtc::media::Sample;
use rtc::rtp_transceiver::{PayloadType, SSRC};
use tokio::sync::{oneshot, watch};
use webrtc::media_stream::track_local::static_sample::TrackLocalStaticSample;

// The whole module is compiled only on non-musl targets (see main.rs), so the
// xcap-only imports below need no cfg of their own.
use std::sync::mpsc::{Receiver, RecvTimeoutError};

/// The biggest frame that is ever encoded: ~720p, the Week 7 budget.
pub const MAX_WIDTH: u32 = 1280;
pub const MAX_HEIGHT: u32 = 720;

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
/// produces a frame.
pub struct ScreenSource {
    frames: Option<Receiver<xcap::Frame>>,
    stop: Option<std::sync::mpsc::Sender<()>>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl ScreenSource {
    /// Starts capture of the primary monitor (falling back to the first
    /// monitor when there is no primary, e.g. some Wayland sessions).
    pub async fn new() -> Result<Self> {
        let (ready_tx, ready_rx) = oneshot::channel::<std::result::Result<(), String>>();
        let (stop_tx, stop_rx) = std::sync::mpsc::channel::<()>();
        let (frame_tx, frame_rx) = std::sync::mpsc::channel::<xcap::Frame>();

        let thread = std::thread::Builder::new()
            .name("desktop-capture".into())
            .spawn(move || {
                let recorder = match primary_recorder() {
                    Ok(recorder) => recorder,
                    Err(e) => {
                        let _ = ready_tx.send(Err(e.to_string()));
                        return;
                    }
                };
                let (recorder, frames) = recorder;
                if let Err(e) = recorder.start() {
                    let _ = ready_tx.send(Err(format!("starting capture: {e}")));
                    return;
                }
                let _ = ready_tx.send(Ok(()));

                // Forward frames until stopped. `recv_timeout` keeps the loop
                // responsive to the stop signal while the recorder is idle.
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

/// Picks a monitor and opens its recorder.
///
/// Preference order: the monitor at the origin (the primary in practice),
/// then an explicitly primary monitor, then any monitor at all. A Wayland
/// session with no primary flag set still gets a stream.
fn primary_recorder() -> Result<(xcap::VideoRecorder, Receiver<xcap::Frame>)> {
    let monitor = match xcap::Monitor::from_point(0, 0) {
        Ok(monitor) => monitor,
        Err(_) => {
            let monitors = xcap::Monitor::all().context("listing monitors")?;
            monitors
                .iter()
                .find(|m| m.is_primary().unwrap_or(false))
                .or_else(|| monitors.first())
                .ok_or_else(|| anyhow::anyhow!("no monitors found"))?
                .clone()
        }
    };
    let recorder = monitor
        .video_recorder()
        .context("opening the video recorder")?;
    Ok(recorder)
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

/// Tick interval: 15 fps. A tick with no new frame is skipped, so the real
/// rate follows the display, never faster than this.
pub const FRAME_INTERVAL: Duration = Duration::from_millis(66);

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
pub async fn run_stream(
    mut source: Box<dyn FrameSource>,
    track: Arc<TrackLocalStaticSample>,
    ssrc: SSRC,
    payload_type: PayloadType,
    mut stop: watch::Receiver<bool>,
) -> Result<()> {
    // `changed()` only resolves on the *next* send, so a signal that is
    // already set would be missed until the caller sends again. Check first.
    if *stop.borrow() {
        source.stop();
        return Ok(());
    }

    let mut encoder = DesktopEncoder::new()?;
    let mut ticker = tokio::time::interval(FRAME_INTERVAL);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    let mut skipped: u64 = 0;
    loop {
        tokio::select! {
            _ = stop.changed() => {
                if *stop.borrow() {
                    break;
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
                let frame = crop_to_even(downscale(&frame, MAX_WIDTH, MAX_HEIGHT));
                let data = encoder.encode(&frame)?;
                let sample = Sample {
                    data: Bytes::from(data),
                    duration: FRAME_INTERVAL,
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
}

impl DesktopEncoder {
    pub fn new() -> Result<Self> {
        let config = EncoderConfig::new()
            .bitrate(BitRate::from_bps(2_000_000))
            .max_frame_rate(FrameRate::from_hz(15.0))
            .usage_type(UsageType::ScreenContentRealTime)
            .rate_control_mode(RateControlMode::Bitrate)
            .complexity(Complexity::Low)
            .intra_frame_period(IntraFramePeriod::from_num_frames(60))
            .vui(VuiConfig::bt709());
        let encoder = Encoder::with_api_config(OpenH264API::from_source(), config)
            .context("creating the H.264 encoder")?;
        Ok(Self { encoder })
    }

    /// Encodes one frame to Annex-B bytes (each NAL carries its own start
    /// code — verified against `openh264 0.9.8`, see spec §3.2).
    pub fn encode(&mut self, frame: &RawFrame) -> Result<Vec<u8>> {
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

    #[test]
    fn downscale_fits_1080p_into_the_720p_box() {
        let frame = downscale(&solid(1920, 1080), MAX_WIDTH, MAX_HEIGHT);
        assert_eq!((frame.width, frame.height), (1280, 720));
        assert_eq!(frame.rgba.len(), (1280 * 720 * 4) as usize);
    }

    #[test]
    fn downscale_preserves_aspect_for_an_ultrawide() {
        let frame = downscale(&solid(2560, 1080), MAX_WIDTH, MAX_HEIGHT);
        assert_eq!((frame.width, frame.height), (1280, 540));
        assert_eq!(frame.width % 2, 0);
        assert_eq!(frame.height % 2, 0);
    }

    #[test]
    fn downscale_never_upscales_a_small_screen() {
        let source = solid(800, 600);
        let frame = downscale(&source, MAX_WIDTH, MAX_HEIGHT);
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
        let mut encoder = DesktopEncoder::new().expect("encoder");
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

    /// `ScreenSource::new` must not panic or hang on a headless machine; it
    /// either returns a source or a clean error. Needs a live display, so it
    /// is ignored by default and run manually on the dev machine.
    #[tokio::test]
    #[ignore = "needs a live display; run manually on the dev machine"]
    async fn screen_source_smoke_on_a_live_display() {
        let mut source = ScreenSource::new().await.expect("live display");
        let frame = source.next_frame().unwrap();
        if let Some(frame) = frame {
            assert_eq!(frame.rgba.len(), (frame.width * frame.height * 4) as usize);
        }
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

        let result = run_stream(source, unbound_track(), 1234, 96, stop_rx).await;
        assert!(
            result.is_err(),
            "writing to an unbound track must surface an error, got {result:?}"
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

        let result = tokio::time::timeout(
            Duration::from_secs(1),
            run_stream(source, unbound_track(), 1234, 96, stop_rx),
        )
        .await
        .expect("run_stream must exit promptly when stop is already set");
        assert!(result.is_ok());
        drop(stop_tx);
    }
}
