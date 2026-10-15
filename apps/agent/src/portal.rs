//! Linux Upfront Consent & Persistent RemoteDesktop Portal Subsystem (ADR-90 Phase 2).

pub mod evdev_map;
#[cfg(not(target_env = "musl"))]
pub mod injector;
pub mod remote_desktop;
pub mod token_store;

/// Active portal session state cached across reconnections for input injection and stream mapping (ADR-90 §5.3).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PortalSessionHolder {
    pub session_handle: String,
    pub stream_id: u32,
    pub display_width: u32,
    pub display_height: u32,
}
