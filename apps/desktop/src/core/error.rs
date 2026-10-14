//! Centralized auth-error classification. The two prefixes are the stable
//! markers the shell matches on; they are shared so no module re-declares them
//! (this was a Sonar duplication point in the Tauri code).

/// Prefix prepended to an error whose cause is an authentication failure.
pub const AUTH_FAILED_PREFIX: &str = "unauthorized request";

/// Prefix prepended to an error from a failed session refresh.
pub const REFRESH_FAILED_PREFIX: &str = "session expired after refresh attempt";

/// True when `err` carries the auth-failure marker. Callers use this to decide
/// whether a device call is worth one refresh-and-retry.
pub fn is_auth_error(err: &str) -> bool {
    err.starts_with(AUTH_FAILED_PREFIX)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auth_failed_prefix_is_the_stable_marker() {
        assert_eq!(AUTH_FAILED_PREFIX, "unauthorized request");
        assert_eq!(
            REFRESH_FAILED_PREFIX,
            "session expired after refresh attempt"
        );
    }

    #[test]
    fn is_auth_error_matches_only_the_marker() {
        assert!(is_auth_error("unauthorized request: token expired"));
        assert!(is_auth_error("unauthorized request"));
        assert!(!is_auth_error("session expired after refresh attempt"));
        assert!(!is_auth_error("Request failed (HTTP 500)"));
        assert!(!is_auth_error(""));
    }
}
