mod capture;
// `dxgi_video_recorder` is always compiled on Windows, even with the
// `wgc` feature: the WGC path falls back to DXGI Output Duplication when
// Windows.Graphics.Capture fails (e.g. hybrid-GPU laptops where the D3D11
// device adapter does not own the monitor's output — upstream xcap#264).
mod dxgi_video_recorder;
// `gdi` is always compiled on Windows: `capture_monitor` and `capture_window`
// fall back to GDI BitBlt when WGC fails (e.g. hybrid-GPU laptops returning
// 0x80070057 E_INVALIDARG).
mod gdi;
mod utils;
#[cfg(feature = "wgc")]
mod wgc;
#[cfg(feature = "wgc")]
mod wgc_video_recorder;

pub mod impl_monitor;
pub mod impl_video_recorder;
pub mod impl_window;
