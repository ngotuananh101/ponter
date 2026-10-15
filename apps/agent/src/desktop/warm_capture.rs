//! Warm Capture Session Manager (ADR-90 Phase 1).
//!
//! Hoists the PipeWire screen capture stream and ScreenCast portal session
//! to the agent process lifetime, preventing repeated Wayland permission dialogs
//! across WebRTC reconnects while maintaining 0.0% CPU/GPU overhead when idle.

use anyhow::{bail, Result};

/// The lifecycle status of the warm capture session (ADR-90 §4.2).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
#[allow(dead_code)]
pub enum WarmCaptureStatus {
    /// No recorder or portal session has been initialized yet.
    #[default]
    Uninitialized,
    /// Warmup is in progress (prompting user or connecting PipeWire stream).
    Initializing,
    /// Stream is connected and portal session is alive, but PipeWire is paused
    /// (`stream.set_active(false)` / `stream.flush(true)`). 0.0% CPU/GPU overhead.
    IdlePaused,
    /// An active WebRTC session holds the lease; frames are flowing.
    ActiveStreaming,
    /// The manager has been shut down; resources released.
    Shutdown,
}

/// The action the capture worker must take following a state transition.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[allow(dead_code)]
pub enum WarmTransitionAction {
    /// Start a brand new capture recorder and wait for first frame.
    StartNew,
    /// Resume the paused stream (`recorder.start()` -> `stream.set_active(true)`).
    ResumeStream,
    /// Pause the active stream (`recorder.stop()` -> `stream.set_active(false)`).
    PauseStream,
    /// No action required.
    NoOp,
}

/// State tracker managing active lease counts and transitions.
#[derive(Debug, Default)]
#[allow(dead_code)]
pub struct WarmStateTracker {
    status: WarmCaptureStatus,
    active_leases: usize,
}

#[allow(dead_code)]
impl WarmStateTracker {
    pub fn new() -> Self {
        Self {
            status: WarmCaptureStatus::Uninitialized,
            active_leases: 0,
        }
    }

    pub fn status(&self) -> WarmCaptureStatus {
        self.status
    }

    pub fn active_leases(&self) -> usize {
        self.active_leases
    }

    pub fn transition_on_acquire(&mut self) -> Result<WarmTransitionAction> {
        match self.status {
            WarmCaptureStatus::Uninitialized => {
                self.status = WarmCaptureStatus::ActiveStreaming;
                self.active_leases = 1;
                Ok(WarmTransitionAction::StartNew)
            }
            WarmCaptureStatus::IdlePaused => {
                self.status = WarmCaptureStatus::ActiveStreaming;
                self.active_leases = 1;
                Ok(WarmTransitionAction::ResumeStream)
            }
            WarmCaptureStatus::ActiveStreaming => {
                bail!("capture lease already active (ADR-14 single session constraint)");
            }
            WarmCaptureStatus::Initializing => {
                bail!("capture session is currently initializing");
            }
            WarmCaptureStatus::Shutdown => {
                bail!("capture session has been shut down");
            }
        }
    }

    pub fn transition_on_release(&mut self) -> Result<WarmTransitionAction> {
        if self.active_leases == 0 {
            bail!("no active lease to release");
        }
        self.active_leases -= 1;
        if self.active_leases == 0 {
            self.status = WarmCaptureStatus::IdlePaused;
            Ok(WarmTransitionAction::PauseStream)
        } else {
            Ok(WarmTransitionAction::NoOp)
        }
    }

    pub fn transition_on_shutdown(&mut self) -> WarmTransitionAction {
        let action = if self.status == WarmCaptureStatus::ActiveStreaming {
            WarmTransitionAction::PauseStream
        } else {
            WarmTransitionAction::NoOp
        };
        self.status = WarmCaptureStatus::Shutdown;
        self.active_leases = 0;
        action
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uninitialized_to_initializing_on_first_acquire() {
        let mut tracker = WarmStateTracker::new();
        assert_eq!(tracker.status(), WarmCaptureStatus::Uninitialized);
        assert_eq!(tracker.active_leases(), 0);

        let action = tracker
            .transition_on_acquire()
            .expect("acquire should succeed");
        assert_eq!(action, WarmTransitionAction::StartNew);
        assert_eq!(tracker.status(), WarmCaptureStatus::ActiveStreaming);
        assert_eq!(tracker.active_leases(), 1);
    }

    #[test]
    fn second_acquire_while_active_is_rejected_adr14() {
        let mut tracker = WarmStateTracker::new();
        let _ = tracker.transition_on_acquire().unwrap();

        let err = tracker.transition_on_acquire().unwrap_err();
        assert!(err.to_string().contains("lease already active"));
        assert_eq!(tracker.active_leases(), 1);
    }

    #[test]
    fn active_to_idle_paused_on_release() {
        let mut tracker = WarmStateTracker::new();
        let _ = tracker.transition_on_acquire().unwrap();

        let action = tracker
            .transition_on_release()
            .expect("release should succeed");
        assert_eq!(action, WarmTransitionAction::PauseStream);
        assert_eq!(tracker.status(), WarmCaptureStatus::IdlePaused);
        assert_eq!(tracker.active_leases(), 0);
    }

    #[test]
    fn idle_paused_to_active_on_reacquire() {
        let mut tracker = WarmStateTracker::new();
        let _ = tracker.transition_on_acquire().unwrap();
        let _ = tracker.transition_on_release().unwrap();
        assert_eq!(tracker.status(), WarmCaptureStatus::IdlePaused);

        let action = tracker
            .transition_on_acquire()
            .expect("re-acquire should succeed");
        assert_eq!(action, WarmTransitionAction::ResumeStream);
        assert_eq!(tracker.status(), WarmCaptureStatus::ActiveStreaming);
        assert_eq!(tracker.active_leases(), 1);
    }

    #[test]
    fn release_when_no_leases_is_error() {
        let mut tracker = WarmStateTracker::new();
        let err = tracker.transition_on_release().unwrap_err();
        assert!(err.to_string().contains("no active lease to release"));
    }

    #[test]
    fn shutdown_from_active_pauses_and_transitions_to_shutdown() {
        let mut tracker = WarmStateTracker::new();
        let _ = tracker.transition_on_acquire().unwrap();

        let action = tracker.transition_on_shutdown();
        assert_eq!(action, WarmTransitionAction::PauseStream);
        assert_eq!(tracker.status(), WarmCaptureStatus::Shutdown);
        assert_eq!(tracker.active_leases(), 0);
    }

    #[test]
    fn shutdown_from_idle_returns_noop() {
        let mut tracker = WarmStateTracker::new();
        let _ = tracker.transition_on_acquire().unwrap();
        let _ = tracker.transition_on_release().unwrap();

        let action = tracker.transition_on_shutdown();
        assert_eq!(action, WarmTransitionAction::NoOp);
        assert_eq!(tracker.status(), WarmCaptureStatus::Shutdown);
    }
}

use crate::desktop::CaptureRecorder;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::time::Duration;
use tokio::sync::oneshot;

/// Commands dispatched from `WarmCaptureManager` to the capture worker thread.
#[allow(dead_code)]
pub(crate) enum WorkerCommand {
    /// Attach an active subscriber and resume streaming.
    Acquire {
        frame_tx: Sender<xcap::Frame>,
        ready_tx: oneshot::Sender<std::result::Result<(), String>>,
    },
    /// Detach the subscriber and pause streaming (0.0% CPU/GPU).
    Release,
    /// Terminate the capture worker loop and release portal resources.
    Shutdown,
}

/// The main loop of the warm capture worker thread.
#[allow(dead_code)]
pub(crate) fn run_warm_capture_worker<R: CaptureRecorder>(
    recorder: R,
    frames: Receiver<xcap::Frame>,
    cmd_rx: Receiver<WorkerCommand>,
    warmup_ready_tx: oneshot::Sender<std::result::Result<(), String>>,
    first_frame_timeout: Duration,
) {
    // 1. Initial warmup: start stream and await first frame to ensure portal permissions.
    if let Err(e) = recorder.start() {
        let _ = warmup_ready_tx.send(Err(e));
        return;
    }

    match frames.recv_timeout(first_frame_timeout) {
        Ok(_first_frame) => {
            let _ = warmup_ready_tx.send(Ok(()));
            if let Err(e) = recorder.stop() {
                tracing::warn!(error = %e, "pausing screen recorder during warmup failed");
            }
        }
        Err(e) => {
            let msg = format!("timeout or error awaiting first frame during warmup: {e}");
            let _ = warmup_ready_tx.send(Err(msg));
            let _ = recorder.stop();
            return;
        }
    }

    // 2. Main worker loop transitioning between IdlePaused and ActiveStreaming.
    let mut active_sub: Option<Sender<xcap::Frame>> = None;

    loop {
        if let Some(sub_tx) = &active_sub {
            // Check for commands without blocking
            match cmd_rx.try_recv() {
                Ok(WorkerCommand::Release) => {
                    active_sub = None;
                    if let Err(e) = recorder.stop() {
                        tracing::warn!(error = %e, "pausing screen recorder on release failed");
                    }
                    continue;
                }
                Ok(WorkerCommand::Shutdown) => {
                    if let Err(e) = recorder.stop() {
                        tracing::warn!(error = %e, "stopping screen recorder on shutdown failed");
                    }
                    break;
                }
                Ok(WorkerCommand::Acquire { frame_tx, ready_tx }) => {
                    active_sub = Some(frame_tx);
                    let _ = ready_tx.send(Ok(()));
                    continue;
                }
                Err(mpsc::TryRecvError::Empty) => {}
                Err(mpsc::TryRecvError::Disconnected) => {
                    let _ = recorder.stop();
                    break;
                }
            }

            // Forward frames to subscriber
            match frames.recv_timeout(Duration::from_millis(50)) {
                Ok(frame) => {
                    if sub_tx.send(frame).is_err() {
                        // Subscriber dropped receiver -> auto-pause stream
                        active_sub = None;
                        if let Err(e) = recorder.stop() {
                            tracing::warn!(
                                error = %e,
                                "pausing screen recorder on subscriber drop failed"
                            );
                        }
                    }
                }
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => {
                    let _ = recorder.stop();
                    break;
                }
            }
        } else {
            // IdlePaused: 0.0% CPU/GPU, block until command received
            match cmd_rx.recv() {
                Ok(WorkerCommand::Acquire { frame_tx, ready_tx }) => {
                    // Drain any stale frames accumulated prior to resume
                    while frames.try_recv().is_ok() {}

                    match recorder.start() {
                        Ok(()) => {
                            active_sub = Some(frame_tx);
                            let _ = ready_tx.send(Ok(()));
                        }
                        Err(e) => {
                            let _ = ready_tx.send(Err(e));
                        }
                    }
                }
                Ok(WorkerCommand::Release) => {
                    // Already paused, no-op
                }
                Ok(WorkerCommand::Shutdown) => {
                    break;
                }
                Err(_) => {
                    // Channel disconnected, manager dropped cmd_tx
                    break;
                }
            }
        }
    }
}

use crate::desktop::{drain_latest, FrameSource, RawFrame};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

#[allow(dead_code)]
struct WarmCaptureInner {
    monitor_id: Option<u32>,
    tracker: WarmStateTracker,
    cmd_tx: Option<Sender<WorkerCommand>>,
    worker_thread: Option<JoinHandle<()>>,
}

impl WarmCaptureInner {
    fn reset_on_worker_death(&mut self) -> Option<JoinHandle<()>> {
        self.tracker.status = WarmCaptureStatus::Uninitialized;
        self.tracker.active_leases = 0;
        self.cmd_tx = None;
        self.worker_thread.take()
    }
}

/// Thread-safe manager for the process-wide warm screen capture session.
#[derive(Clone)]
#[allow(dead_code)]
pub struct WarmCaptureManager {
    inner: Arc<Mutex<WarmCaptureInner>>,
}

impl std::fmt::Debug for WarmCaptureManager {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WarmCaptureManager")
            .field("status", &self.status())
            .field("active_leases", &self.active_leases())
            .finish()
    }
}

#[allow(dead_code)]
impl WarmCaptureManager {
    pub fn new(monitor_id: Option<u32>) -> Self {
        Self {
            inner: Arc::new(Mutex::new(WarmCaptureInner {
                monitor_id,
                tracker: WarmStateTracker::new(),
                cmd_tx: None,
                worker_thread: None,
            })),
        }
    }

    #[cfg(test)]
    pub(crate) fn from_recorder_for_test<R: CaptureRecorder>(
        recorder: R,
        frames: Receiver<xcap::Frame>,
        first_frame_timeout: Duration,
    ) -> Self {
        let (cmd_tx, cmd_rx) = mpsc::channel();
        let (ready_tx, _ready_rx) = oneshot::channel();
        let worker_thread = std::thread::spawn(move || {
            run_warm_capture_worker(recorder, frames, cmd_rx, ready_tx, first_frame_timeout);
        });

        let manager = Self::new(None);
        {
            let mut inner = manager.inner.lock().unwrap();
            inner.cmd_tx = Some(cmd_tx);
            inner.worker_thread = Some(worker_thread);
            inner.tracker.status = WarmCaptureStatus::IdlePaused;
        }
        manager
    }

    pub fn status(&self) -> WarmCaptureStatus {
        self.inner.lock().unwrap().tracker.status()
    }

    pub fn active_leases(&self) -> usize {
        self.inner.lock().unwrap().tracker.active_leases()
    }

    /// Acquires a streaming lease for an incoming WebRTC session.
    pub async fn acquire_lease(&self) -> Result<WarmScreenSource> {
        let (needs_spawn, monitor_id, existing_cmd_tx) = {
            let mut inner = self.inner.lock().unwrap();
            let _action = inner.tracker.transition_on_acquire()?;
            if inner.cmd_tx.is_none() {
                (true, inner.monitor_id, None)
            } else {
                (false, None, inner.cmd_tx.clone())
            }
        };

        let cmd_tx = if needs_spawn {
            let (tx, rx) = mpsc::channel();
            let (ready_tx, ready_rx) = oneshot::channel();

            let handle = match std::thread::Builder::new()
                .name("desktop-warm-capture".into())
                .spawn(move || {
                    let monitor = match monitor_id {
                        Some(id) => crate::desktop::find_monitor(id),
                        None => crate::desktop::primary_monitor(),
                    };
                    let monitor = match monitor {
                        Ok(m) => m,
                        Err(e) => {
                            let _ = ready_tx.send(Err(format!("finding monitor: {e:#}")));
                            return;
                        }
                    };
                    let (recorder, frames) = match monitor.video_recorder() {
                        Ok(r) => r,
                        Err(e) => {
                            let _ = ready_tx.send(Err(format!("opening video recorder: {e}")));
                            return;
                        }
                    };
                    run_warm_capture_worker(
                        recorder,
                        frames,
                        rx,
                        ready_tx,
                        crate::desktop::FIRST_FRAME_TIMEOUT,
                    );
                }) {
                Ok(h) => h,
                Err(e) => {
                    let mut inner = self.inner.lock().unwrap();
                    inner.reset_on_worker_death();
                    bail!("spawning warm capture thread: {e}");
                }
            };

            match ready_rx.await {
                Ok(Ok(())) => {
                    let mut inner = self.inner.lock().unwrap();
                    inner.cmd_tx = Some(tx.clone());
                    inner.worker_thread = Some(handle);
                    tx
                }
                Ok(Err(msg)) => {
                    let _ = handle.join();
                    let mut inner = self.inner.lock().unwrap();
                    inner.reset_on_worker_death();
                    bail!("warm capture initialization failed: {msg}");
                }
                Err(_) => {
                    let _ = handle.join();
                    let mut inner = self.inner.lock().unwrap();
                    inner.reset_on_worker_death();
                    bail!("warm capture thread exited during initialization");
                }
            }
        } else {
            existing_cmd_tx.unwrap()
        };

        let (frame_tx, frame_rx) = mpsc::channel();
        let (ready_tx, ready_rx) = oneshot::channel();

        if let Err(e) = cmd_tx.send(WorkerCommand::Acquire { frame_tx, ready_tx }) {
            let handle = {
                let mut inner = self.inner.lock().unwrap();
                inner.reset_on_worker_death()
            };
            if let Some(h) = handle {
                let _ = h.join();
            }
            bail!("failed to send acquire command to warm capture worker: {e}");
        }

        match ready_rx.await {
            Ok(Ok(())) => Ok(WarmScreenSource {
                manager: self.clone(),
                frames: Some(frame_rx),
                seq: 0,
                stopped: false,
            }),
            Ok(Err(msg)) => {
                self.release_lease();
                bail!("warm capture worker failed to resume: {msg}");
            }
            Err(_) => {
                let handle = {
                    let mut inner = self.inner.lock().unwrap();
                    inner.reset_on_worker_death()
                };
                if let Some(h) = handle {
                    let _ = h.join();
                }
                bail!("warm capture worker died while acquiring lease");
            }
        }
    }

    /// Releases an active streaming lease, transitioning the stream to IDLE_PAUSED.
    pub fn release_lease(&self) {
        let (cmd_tx, action) = {
            let mut inner = self.inner.lock().unwrap();
            match inner.tracker.transition_on_release() {
                Ok(action) => (inner.cmd_tx.clone(), action),
                Err(_) => return,
            }
        };
        if action == WarmTransitionAction::PauseStream {
            if let Some(cmd_tx) = cmd_tx {
                if cmd_tx.send(WorkerCommand::Release).is_err() {
                    let handle = {
                        let mut inner = self.inner.lock().unwrap();
                        inner.reset_on_worker_death()
                    };
                    if let Some(h) = handle {
                        let _ = h.join();
                    }
                }
            }
        }
    }

    /// Cleanly shuts down the warm capture session.
    pub fn shutdown(&self) {
        let (cmd_tx, worker_thread) = {
            let mut inner = self.inner.lock().unwrap();
            let _ = inner.tracker.transition_on_shutdown();
            (inner.cmd_tx.take(), inner.worker_thread.take())
        };
        if let Some(cmd_tx) = cmd_tx {
            let _ = cmd_tx.send(WorkerCommand::Shutdown);
        }
        if let Some(handle) = worker_thread {
            let _ = handle.join();
        }
    }
}

/// A `FrameSource` backed by the warm capture session lease.
#[allow(dead_code)]
pub struct WarmScreenSource {
    manager: WarmCaptureManager,
    frames: Option<Receiver<xcap::Frame>>,
    seq: u64,
    stopped: bool,
}

impl std::fmt::Debug for WarmScreenSource {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WarmScreenSource")
            .field("seq", &self.seq)
            .field("stopped", &self.stopped)
            .finish()
    }
}

impl FrameSource for WarmScreenSource {
    fn next_frame(&mut self) -> Result<Option<RawFrame>> {
        let Some(frames) = self.frames.as_ref() else {
            return Ok(None);
        };
        Ok(drain_latest(frames).map(|frame| {
            let seq = self.seq;
            self.seq += 1;
            RawFrame {
                width: frame.width,
                height: frame.height,
                rgba: frame.raw,
                seq,
            }
        }))
    }

    fn stop(&mut self) {
        if !self.stopped {
            self.stopped = true;
            self.frames = None;
            self.manager.release_lease();
        }
    }
}

impl Drop for WarmScreenSource {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(test)]
mod worker_tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::Arc;

    #[derive(Clone, Default)]
    pub struct FakeRecorder {
        pub is_running: Arc<AtomicBool>,
        pub start_count: Arc<AtomicUsize>,
        pub stop_count: Arc<AtomicUsize>,
        pub fail_start: Arc<AtomicBool>,
    }

    impl crate::desktop::CaptureRecorder for FakeRecorder {
        fn start(&self) -> std::result::Result<(), String> {
            if self.fail_start.load(Ordering::Relaxed) {
                return Err("simulated start failure".to_string());
            }
            self.is_running.store(true, Ordering::Relaxed);
            self.start_count.fetch_add(1, Ordering::Relaxed);
            Ok(())
        }

        fn stop(&self) -> std::result::Result<(), String> {
            self.is_running.store(false, Ordering::Relaxed);
            self.stop_count.fetch_add(1, Ordering::Relaxed);
            Ok(())
        }
    }

    #[test]
    fn worker_lifecycle_startup_and_idle_pause() {
        let recorder = FakeRecorder::default();
        let (cmd_tx, cmd_rx) = mpsc::channel();
        let (frames_in_tx, frames_in_rx) = mpsc::channel();
        let (worker_ready_tx, worker_ready_rx) = tokio::sync::oneshot::channel();

        let handle = std::thread::spawn({
            let rec = recorder.clone();
            move || {
                run_warm_capture_worker(
                    rec,
                    frames_in_rx,
                    cmd_rx,
                    worker_ready_tx,
                    Duration::from_millis(500),
                );
            }
        });

        // Feed first frame to simulate successful warmup
        frames_in_tx
            .send(xcap::Frame::new(1920, 1080, vec![0; 1920 * 1080 * 4]))
            .unwrap();

        // Worker should report ready and immediately pause the stream (idle state)
        let ready_res = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(worker_ready_rx)
            .expect("ready signal received");
        assert!(ready_res.is_ok());

        assert_eq!(recorder.start_count.load(Ordering::Relaxed), 1);
        assert_eq!(recorder.stop_count.load(Ordering::Relaxed), 1);
        assert!(!recorder.is_running.load(Ordering::Relaxed));

        // Shutdown cleanly
        cmd_tx.send(WorkerCommand::Shutdown).unwrap();
        handle.join().unwrap();
    }

    #[test]
    fn worker_resumes_on_acquire_and_pauses_on_release() {
        let recorder = FakeRecorder::default();
        let (cmd_tx, cmd_rx) = mpsc::channel();
        let (frames_in_tx, frames_in_rx) = mpsc::channel();
        let (worker_ready_tx, worker_ready_rx) = tokio::sync::oneshot::channel();

        let handle = std::thread::spawn({
            let rec = recorder.clone();
            move || {
                run_warm_capture_worker(
                    rec,
                    frames_in_rx,
                    cmd_rx,
                    worker_ready_tx,
                    Duration::from_millis(500),
                );
            }
        });

        frames_in_tx
            .send(xcap::Frame::new(100, 100, vec![0; 40000]))
            .unwrap();
        let _ = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(worker_ready_rx);

        // 1. Acquire lease
        let (sub_tx, sub_rx) = mpsc::channel();
        let (acquire_ready_tx, acquire_ready_rx) = tokio::sync::oneshot::channel();
        cmd_tx
            .send(WorkerCommand::Acquire {
                frame_tx: sub_tx,
                ready_tx: acquire_ready_tx,
            })
            .unwrap();

        tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(acquire_ready_rx)
            .unwrap()
            .unwrap();
        assert_eq!(recorder.start_count.load(Ordering::Relaxed), 2);
        assert!(recorder.is_running.load(Ordering::Relaxed));

        // Feed frame and verify subscriber gets it
        frames_in_tx
            .send(xcap::Frame::new(100, 100, vec![42; 40000]))
            .unwrap();
        let received = sub_rx.recv_timeout(Duration::from_millis(500)).unwrap();
        assert_eq!(received.raw[0], 42);

        // 2. Release lease
        cmd_tx.send(WorkerCommand::Release).unwrap();
        let start = std::time::Instant::now();
        while recorder.stop_count.load(Ordering::Relaxed) < 2
            && start.elapsed() < Duration::from_millis(500)
        {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(recorder.stop_count.load(Ordering::Relaxed), 2);
        assert!(!recorder.is_running.load(Ordering::Relaxed));

        // 3. Clean shutdown
        cmd_tx.send(WorkerCommand::Shutdown).unwrap();
        handle.join().unwrap();
    }

    #[test]
    fn worker_detects_subscriber_drop_and_pauses() {
        let recorder = FakeRecorder::default();
        let (cmd_tx, cmd_rx) = mpsc::channel();
        let (frames_in_tx, frames_in_rx) = mpsc::channel();
        let (worker_ready_tx, worker_ready_rx) = tokio::sync::oneshot::channel();

        let handle = std::thread::spawn({
            let rec = recorder.clone();
            move || {
                run_warm_capture_worker(
                    rec,
                    frames_in_rx,
                    cmd_rx,
                    worker_ready_tx,
                    Duration::from_millis(500),
                );
            }
        });

        frames_in_tx
            .send(xcap::Frame::new(100, 100, vec![0; 40000]))
            .unwrap();
        let _ = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(worker_ready_rx);

        let (sub_tx, sub_rx) = mpsc::channel();
        let (acquire_ready_tx, acquire_ready_rx) = tokio::sync::oneshot::channel();
        cmd_tx
            .send(WorkerCommand::Acquire {
                frame_tx: sub_tx,
                ready_tx: acquire_ready_tx,
            })
            .unwrap();
        tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(acquire_ready_rx)
            .unwrap()
            .unwrap();

        // Drop the subscriber receiver
        drop(sub_rx);

        // Feed frame — worker's send will fail and trigger auto-pause
        frames_in_tx
            .send(xcap::Frame::new(100, 100, vec![0; 40000]))
            .unwrap();
        let start = std::time::Instant::now();
        while recorder.stop_count.load(Ordering::Relaxed) < 2
            && start.elapsed() < Duration::from_millis(500)
        {
            std::thread::sleep(Duration::from_millis(10));
        }

        assert_eq!(recorder.stop_count.load(Ordering::Relaxed), 2);
        assert!(!recorder.is_running.load(Ordering::Relaxed));

        cmd_tx.send(WorkerCommand::Shutdown).unwrap();
        handle.join().unwrap();
    }

    #[test]
    fn worker_warmup_failure_propagates_error() {
        let recorder = FakeRecorder::default();
        recorder.fail_start.store(true, Ordering::Relaxed);

        let (_cmd_tx, cmd_rx) = mpsc::channel();
        let (_frames_in_tx, frames_in_rx) = mpsc::channel();
        let (worker_ready_tx, worker_ready_rx) = tokio::sync::oneshot::channel();

        let handle = std::thread::spawn({
            let rec = recorder.clone();
            move || {
                run_warm_capture_worker(
                    rec,
                    frames_in_rx,
                    cmd_rx,
                    worker_ready_tx,
                    Duration::from_millis(500),
                );
            }
        });

        let ready_res = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(worker_ready_rx)
            .expect("ready signal received");
        assert!(ready_res.is_err());
        assert!(ready_res.unwrap_err().contains("simulated start failure"));

        handle.join().unwrap();
    }
}

#[cfg(test)]
mod manager_tests {
    use super::*;
    use crate::desktop::FrameSource;

    async fn poll_frame(source: &mut WarmScreenSource) -> RawFrame {
        let start = std::time::Instant::now();
        while start.elapsed() < Duration::from_millis(500) {
            if let Some(frame) = source.next_frame().unwrap() {
                return frame;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        panic!("timed out waiting for frame from WarmScreenSource");
    }

    #[tokio::test]
    async fn warm_capture_manager_acquire_and_deliver_frames() {
        let recorder = worker_tests::FakeRecorder::default();
        let (frames_in_tx, frames_in_rx) = mpsc::channel();
        let manager = WarmCaptureManager::from_recorder_for_test(
            recorder.clone(),
            frames_in_rx,
            Duration::from_millis(500),
        );

        // Feed warmup frame
        frames_in_tx
            .send(xcap::Frame::new(100, 100, vec![1; 40000]))
            .unwrap();

        // 1. Acquire lease
        let mut source = manager.acquire_lease().await.expect("lease should acquire");
        assert_eq!(manager.status(), WarmCaptureStatus::ActiveStreaming);
        assert_eq!(manager.active_leases(), 1);

        // Push streaming frame
        frames_in_tx
            .send(xcap::Frame::new(100, 100, vec![99; 40000]))
            .unwrap();
        let frame = poll_frame(&mut source).await;
        assert_eq!(frame.width, 100);
        assert_eq!(frame.height, 100);
        assert_eq!(frame.rgba[0], 99);
        assert_eq!(frame.seq, 0);

        // Next frame increment sequence
        frames_in_tx
            .send(xcap::Frame::new(100, 100, vec![100; 40000]))
            .unwrap();
        let frame2 = poll_frame(&mut source).await;
        assert_eq!(frame2.seq, 1);

        // 2. Drop source releases lease
        drop(source);
        assert_eq!(manager.active_leases(), 0);
        assert_eq!(manager.status(), WarmCaptureStatus::IdlePaused);

        // 3. Re-acquire lease (reconnect without creating new thread)
        let mut source2 = manager
            .acquire_lease()
            .await
            .expect("re-acquire should succeed");
        assert_eq!(manager.active_leases(), 1);
        assert_eq!(manager.status(), WarmCaptureStatus::ActiveStreaming);

        frames_in_tx
            .send(xcap::Frame::new(100, 100, vec![101; 40000]))
            .unwrap();
        let frame3 = poll_frame(&mut source2).await;
        assert_eq!(frame3.rgba[0], 101);

        // 4. Shutdown
        manager.shutdown();
        assert_eq!(manager.status(), WarmCaptureStatus::Shutdown);
    }

    #[tokio::test]
    async fn warm_capture_manager_refuses_second_concurrent_lease() {
        let recorder = worker_tests::FakeRecorder::default();
        let (frames_in_tx, frames_in_rx) = mpsc::channel();
        let manager = WarmCaptureManager::from_recorder_for_test(
            recorder.clone(),
            frames_in_rx,
            Duration::from_millis(500),
        );
        frames_in_tx
            .send(xcap::Frame::new(100, 100, vec![0; 40000]))
            .unwrap();

        let source1 = manager.acquire_lease().await.unwrap();
        assert_eq!(manager.active_leases(), 1);

        let err = manager.acquire_lease().await.unwrap_err();
        assert!(err.to_string().contains("lease already active"));

        drop(source1);
    }

    #[tokio::test]
    async fn warm_capture_manager_self_heals_when_worker_dies() {
        use std::sync::atomic::Ordering;

        let recorder = worker_tests::FakeRecorder::default();
        let (frames_in_tx, frames_in_rx) = mpsc::channel();
        let manager = WarmCaptureManager::from_recorder_for_test(
            recorder.clone(),
            frames_in_rx,
            Duration::from_millis(500),
        );
        frames_in_tx
            .send(xcap::Frame::new(100, 100, vec![0; 40000]))
            .unwrap();

        // Wait for warmup to complete (recorder.stop() called)
        while recorder.stop_count.load(Ordering::Relaxed) < 1 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }

        assert_eq!(manager.status(), WarmCaptureStatus::IdlePaused);
        assert_eq!(manager.active_leases(), 0);

        // Terminate worker by sending Shutdown command directly to worker channel.
        let worker_tx = manager.inner.lock().unwrap().cmd_tx.clone().unwrap();
        worker_tx.send(WorkerCommand::Shutdown).unwrap();

        let handle = manager.inner.lock().unwrap().worker_thread.take().unwrap();
        handle.join().unwrap();

        // Put dead channel back into manager to test recovery
        manager.inner.lock().unwrap().cmd_tx = Some(worker_tx);

        // Acquire lease should fail because worker is dead, but it MUST rollback state.
        let err = manager.acquire_lease().await.unwrap_err();
        assert!(
            err.to_string().contains("failed to send acquire command")
                || err.to_string().contains("worker died"),
            "unexpected error message: {err}"
        );

        // Verify rollback: state must NOT be stuck in ActiveStreaming with 1 lease!
        assert_eq!(manager.status(), WarmCaptureStatus::Uninitialized);
        assert_eq!(manager.active_leases(), 0);
        assert!(manager.inner.lock().unwrap().cmd_tx.is_none());
        assert!(manager.inner.lock().unwrap().worker_thread.is_none());

        // Subsequent acquire_lease should NOT fail with "lease already active"!
        // It self-heals: either spawns a new worker or fails for reasons other than lease deadlock.
        match manager.acquire_lease().await {
            Ok(new_source) => {
                assert_eq!(manager.status(), WarmCaptureStatus::ActiveStreaming);
                assert_eq!(manager.active_leases(), 1);
                drop(new_source);
                assert_eq!(manager.status(), WarmCaptureStatus::IdlePaused);
                assert_eq!(manager.active_leases(), 0);
            }
            Err(err2) => {
                assert!(
                    !err2.to_string().contains("lease already active"),
                    "reconnect after worker crash should not fail with lease already active: {err2}"
                );
            }
        }
    }

    #[tokio::test]
    async fn warm_capture_manager_rolls_back_when_worker_drops_ready_channel() {
        let (cmd_tx, cmd_rx) = mpsc::channel();
        let handle = std::thread::spawn(move || {
            // Read acquire command and immediately drop ready_tx without responding
            if let Ok(WorkerCommand::Acquire { ready_tx, .. }) = cmd_rx.recv() {
                drop(ready_tx);
            }
        });

        let manager = WarmCaptureManager::new(None);
        {
            let mut inner = manager.inner.lock().unwrap();
            inner.cmd_tx = Some(cmd_tx);
            inner.worker_thread = Some(handle);
            inner.tracker.status = WarmCaptureStatus::IdlePaused;
        }

        let err = manager.acquire_lease().await.unwrap_err();
        assert!(err
            .to_string()
            .contains("worker died while acquiring lease"));
        assert_eq!(manager.status(), WarmCaptureStatus::Uninitialized);
        assert_eq!(manager.active_leases(), 0);
        assert!(manager.inner.lock().unwrap().cmd_tx.is_none());
        assert!(manager.inner.lock().unwrap().worker_thread.is_none());
    }

    #[test]
    fn warm_capture_manager_shutdown_releases_lock_before_join() {
        let (cmd_tx, cmd_rx) = mpsc::channel();
        let barrier = Arc::new(std::sync::Barrier::new(2));
        let barrier_clone = barrier.clone();

        let handle = std::thread::spawn(move || {
            let _cmd = cmd_rx.recv();
            // Block until test thread verifies lock is released
            barrier_clone.wait();
        });

        let manager = WarmCaptureManager::new(None);
        {
            let mut inner = manager.inner.lock().unwrap();
            inner.cmd_tx = Some(cmd_tx);
            inner.worker_thread = Some(handle);
            inner.tracker.status = WarmCaptureStatus::IdlePaused;
        }

        let mgr_clone = manager.clone();
        let shutdown_thread = std::thread::spawn(move || {
            mgr_clone.shutdown();
        });

        // Small pause to allow shutdown thread to reach handle.join()
        std::thread::sleep(Duration::from_millis(20));

        // Attempt to lock manager from another thread while worker thread is waiting on barrier
        let lock_acquired = manager.inner.try_lock().is_ok();
        assert!(
            lock_acquired,
            "shutdown should have released mutex before joining worker thread"
        );

        // Release worker thread and wait for shutdown to complete
        barrier.wait();
        shutdown_thread.join().unwrap();
        assert_eq!(manager.status(), WarmCaptureStatus::Shutdown);
    }
}

#[cfg(test)]
mod integration_tests {
    use super::*;
    use crate::desktop::FrameSource;
    use std::sync::atomic::Ordering;

    async fn poll_frame(source: &mut WarmScreenSource) -> RawFrame {
        let start = std::time::Instant::now();
        while start.elapsed() < Duration::from_millis(500) {
            if let Some(frame) = source.next_frame().unwrap() {
                return frame;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        panic!("timed out waiting for frame from WarmScreenSource");
    }

    #[tokio::test]
    async fn simulated_webrtc_client_reconnect_retains_single_recorder() {
        let recorder = worker_tests::FakeRecorder::default();
        let (frames_in_tx, frames_in_rx) = mpsc::channel();
        let manager = WarmCaptureManager::from_recorder_for_test(
            recorder.clone(),
            frames_in_rx,
            Duration::from_millis(500),
        );

        // Warmup frame
        frames_in_tx
            .send(xcap::Frame::new(800, 600, vec![1; 800 * 600 * 4]))
            .unwrap();
        assert_eq!(manager.status(), WarmCaptureStatus::IdlePaused);

        // --- Client 1 Connects ---
        {
            let mut client1_source = manager.acquire_lease().await.expect("client 1 acquires");
            assert_eq!(manager.status(), WarmCaptureStatus::ActiveStreaming);
            assert_eq!(recorder.start_count.load(Ordering::Relaxed), 2); // 1 warmup + 1 acquire

            frames_in_tx
                .send(xcap::Frame::new(800, 600, vec![10; 800 * 600 * 4]))
                .unwrap();
            let frame = poll_frame(&mut client1_source).await;
            assert_eq!(frame.rgba[0], 10);

            // Client 1 disconnects (e.g. browser closes)
            client1_source.stop();
        }

        let start = std::time::Instant::now();
        while recorder.stop_count.load(Ordering::Relaxed) < 2
            && start.elapsed() < Duration::from_millis(500)
        {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }

        assert_eq!(manager.status(), WarmCaptureStatus::IdlePaused);
        assert_eq!(recorder.stop_count.load(Ordering::Relaxed), 2); // 1 idle warmup + 1 release

        // --- Client 2 Reconnects ---
        {
            let mut client2_source = manager
                .acquire_lease()
                .await
                .expect("client 2 acquires without prompt");
            assert_eq!(manager.status(), WarmCaptureStatus::ActiveStreaming);
            assert_eq!(recorder.start_count.load(Ordering::Relaxed), 3); // resumed existing stream

            frames_in_tx
                .send(xcap::Frame::new(800, 600, vec![20; 800 * 600 * 4]))
                .unwrap();
            let frame = poll_frame(&mut client2_source).await;
            assert_eq!(frame.rgba[0], 20);

            client2_source.stop();
        }

        let start = std::time::Instant::now();
        while recorder.stop_count.load(Ordering::Relaxed) < 3
            && start.elapsed() < Duration::from_millis(500)
        {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }

        assert_eq!(manager.status(), WarmCaptureStatus::IdlePaused);
        assert_eq!(recorder.stop_count.load(Ordering::Relaxed), 3);

        manager.shutdown();
        assert_eq!(manager.status(), WarmCaptureStatus::Shutdown);
    }

    #[tokio::test]
    async fn rapid_reconnect_loop_cycles_cleanly() {
        let recorder = worker_tests::FakeRecorder::default();
        let (frames_in_tx, frames_in_rx) = mpsc::channel();
        let manager = WarmCaptureManager::from_recorder_for_test(
            recorder.clone(),
            frames_in_rx,
            Duration::from_millis(500),
        );

        frames_in_tx
            .send(xcap::Frame::new(100, 100, vec![0; 40000]))
            .unwrap();

        for i in 1..=5 {
            let mut source = manager.acquire_lease().await.expect("acquire iteration");
            assert_eq!(manager.status(), WarmCaptureStatus::ActiveStreaming);

            frames_in_tx
                .send(xcap::Frame::new(100, 100, vec![i as u8; 40000]))
                .unwrap();
            let frame = poll_frame(&mut source).await;
            assert_eq!(frame.rgba[0], i as u8);

            drop(source);

            let start = std::time::Instant::now();
            while recorder.stop_count.load(Ordering::Relaxed) < i + 1
                && start.elapsed() < Duration::from_millis(500)
            {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            assert_eq!(manager.status(), WarmCaptureStatus::IdlePaused);
        }

        assert_eq!(recorder.start_count.load(Ordering::Relaxed), 6); // 1 warmup + 5 acquires
        assert_eq!(recorder.stop_count.load(Ordering::Relaxed), 6); // 1 idle warmup + 5 drops
        manager.shutdown();
    }
}
