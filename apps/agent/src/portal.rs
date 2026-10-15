//! Linux Upfront Consent & Persistent RemoteDesktop Portal Subsystem (ADR-90 Phase 2).

pub mod evdev_map;
#[cfg(not(target_env = "musl"))]
pub mod injector;
pub mod remote_desktop;
pub mod token_store;
