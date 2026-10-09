#[cfg(feature = "wgc")]
use std::sync::mpsc::Receiver;

#[cfg(feature = "wgc")]
use windows::Win32::Graphics::Gdi::HMONITOR;

#[cfg(feature = "wgc")]
use crate::{Frame, XCapResult};

#[cfg(feature = "wgc")]
pub(crate) use super::wgc_video_recorder::ImplVideoRecorder as WgcImplVideoRecorder;

#[cfg(not(feature = "wgc"))]
pub(crate) use super::dxgi_video_recorder::ImplVideoRecorder;

/// The active video recorder implementation for Windows.
///
/// When the `wgc` feature is enabled, `WgcVideoRecorder` is preferred because
/// it captures through Windows.Graphics.Capture per-monitor. However, on
/// hybrid-GPU laptops, WGC can fail to open a recorder: the `ID3D11Device` it
/// creates on the default adapter may not own the monitor's output, causing
/// `DuplicateOutput` to return `E_INVALIDARG`. When that happens, we fall back
/// to the DXGI Output Duplication path, which enumerates adapters to find the
/// one matching the monitor's output and works on any GPU configuration.
///
/// This fallback is transparent to the rest of the crate: `ImplVideoRecorder`
/// is always the type returned by `Monitor::video_recorder()`, and both
/// implementations expose the same `new`/`start`/`stop` API.
#[cfg(feature = "wgc")]
#[derive(Debug, Clone)]
pub(crate) struct ImplVideoRecorder {
    inner: VideoRecorderImpl,
}

#[cfg(feature = "wgc")]
#[derive(Debug, Clone)]
enum VideoRecorderImpl {
    Wgc(WgcImplVideoRecorder),
    Dxgi(super::dxgi_video_recorder::ImplVideoRecorder),
}

#[cfg(feature = "wgc")]
impl ImplVideoRecorder {
    pub fn new(h_monitor: HMONITOR) -> XCapResult<(Self, Receiver<Frame>)> {
        // Try WGC first. If it fails (hybrid-GPU, missing capability, etc.),
        // fall back to the DXGI Output Duplication path which enumerates
        // adapters to find the one matching the monitor's output.
        match WgcImplVideoRecorder::new(h_monitor) {
            Ok((recorder, frames)) => {
                log::info!("using WGC video recorder for monitor {:?}", h_monitor);
                Ok((
                    Self {
                        inner: VideoRecorderImpl::Wgc(recorder),
                    },
                    frames,
                ))
            }
            Err(e) => {
                log::warn!(
                    "WGC video recorder failed for monitor {:?}: {}; falling back to DXGI",
                    h_monitor,
                    e
                );
                let (recorder, frames) = super::dxgi_video_recorder::ImplVideoRecorder::new(h_monitor)?;
                Ok((
                    Self {
                        inner: VideoRecorderImpl::Dxgi(recorder),
                    },
                    frames,
                ))
            }
        }
    }

    pub fn start(&self) -> XCapResult<()> {
        match &self.inner {
            VideoRecorderImpl::Wgc(r) => r.start(),
            VideoRecorderImpl::Dxgi(r) => r.start(),
        }
    }

    pub fn stop(&self) -> XCapResult<()> {
        match &self.inner {
            VideoRecorderImpl::Wgc(r) => r.stop(),
            VideoRecorderImpl::Dxgi(r) => r.stop(),
        }
    }
}
