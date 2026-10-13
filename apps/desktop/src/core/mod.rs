//! GUI-free core logic. Every module here is unit-testable without a display.

pub mod agent_host;
pub mod auth;
pub mod config;
pub mod devices;
pub mod error;
pub mod keychain;
pub mod session;
pub mod state;
pub mod wizard;

#[cfg(test)]
pub mod test_util;
