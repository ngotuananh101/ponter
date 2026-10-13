//! GUI-free core logic. Every module here is unit-testable without a display.

pub mod config;
pub mod error;
pub mod keychain;
pub mod state;

#[cfg(test)]
pub mod test_util;
