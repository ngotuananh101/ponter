//! Warm Capture Session Manager (ADR-90 Phase 1).
//!
//! Hoists the PipeWire screen capture stream and ScreenCast portal session
//! to the agent process lifetime, preventing repeated Wayland permission dialogs
//! across WebRTC reconnects while maintaining 0.0% CPU/GPU overhead when idle.

use anyhow::{bail, Result};

/// The lifecycle status of the warm capture session (ADR-90 §4.2).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
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
pub struct WarmStateTracker {
    status: WarmCaptureStatus,
    active_leases: usize,
}

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
