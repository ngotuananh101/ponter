//! The H1 shell allowlist: which executables a client-supplied
//! `terminal-create.shell` may name.
//!
//! `resolve_shell_value` returns any client string unmodified, and that string
//! is handed to `CommandBuilder::new` — arbitrary binary execution on the
//! agent host. This module closes that: a client value must canonicalize into
//! an allowlist of absolute paths. The configured `--shell` / `AGENT_SHELL` is
//! operator-trusted and always allowed — it is this agent's own deploy-time
//! policy, not client input.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};

/// The minimal floor every unix host is expected to have. `/etc/shells` is the
/// admin-maintained list and normally covers these, but a hardened container
/// can ship without the file; the floor keeps a usable shell reachable.
#[cfg(unix)]
const UNIX_SHELL_FLOOR: [&str; 4] = ["/bin/sh", "/bin/bash", "/usr/bin/sh", "/usr/bin/bash"];

#[derive(Debug, Clone)]
pub struct ShellPolicy {
    allowed: HashSet<PathBuf>,
}

impl ShellPolicy {
    /// Build the policy from the operator-configured shell plus the platform
    /// floor and (on unix) `/etc/shells`.
    pub fn from_config(configured: &str) -> Self {
        let mut candidates: Vec<PathBuf> = vec![PathBuf::from(configured)];
        #[cfg(unix)]
        {
            candidates.extend(UNIX_SHELL_FLOOR.iter().map(PathBuf::from));
            candidates.extend(load_etc_shells());
        }
        Self::new(candidates)
    }

    /// Policy over an explicit candidate set — the seam the unit tests use so
    /// they never depend on the host's `/etc/shells`.
    ///
    /// Every candidate is canonicalized on the way in, so membership compares
    /// resolved paths on both sides: `/bin/sh` and `/usr/bin/dash` are one
    /// entry, not two. A candidate that does not canonicalize (missing file)
    /// is skipped — an allowlist entry that names nothing allows nothing.
    pub fn new(candidates: impl IntoIterator<Item = PathBuf>) -> Self {
        let allowed = candidates
            .into_iter()
            .filter_map(|p| std::fs::canonicalize(p).ok())
            .collect();
        Self { allowed }
    }

    /// Resolve a client-supplied shell, or refuse it with the reason.
    ///
    /// The caller turns a refusal into a `terminal-error` frame, so the
    /// browser sees a sentence rather than a silent blank terminal.
    pub fn resolve_client_shell(&self, requested: &str) -> Result<PathBuf> {
        let path = Path::new(requested);
        if !path.is_absolute() {
            bail!("{requested:?} is not an absolute path");
        }
        // canonicalize() fails for a nonexistent path — the not-exists case
        // falls out here rather than as a separate probe.
        let resolved = std::fs::canonicalize(path)
            .with_context(|| format!("{requested:?} cannot be resolved"))?;
        if !resolved.is_file() {
            bail!("{requested:?} is not a file");
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&resolved)?.permissions().mode();
            if mode & 0o111 == 0 {
                bail!("{requested:?} is not executable");
            }
        }
        if !self.allowed.contains(&resolved) {
            bail!("{requested:?} is not in the shell allowlist");
        }
        Ok(resolved)
    }
}

/// Every non-comment, non-empty line of `/etc/shells`. A missing file is an
/// empty list, not an error: the floor still applies.
#[cfg(unix)]
fn load_etc_shells() -> Vec<PathBuf> {
    std::fs::read_to_string("/etc/shells")
        .map(|text| {
            text.lines()
                .map(str::trim)
                .filter(|l| !l.is_empty() && !l.starts_with('#'))
                .map(PathBuf::from)
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    /// A unique temp path per test. The caller removes it.
    fn temp_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("ponter-shell-policy-{}-{name}", std::process::id()))
    }

    /// Create an executable file at `path` (mode 0o755 on unix).
    fn write_executable(path: &Path) {
        std::fs::write(path, b"#!/bin/sh\n").expect("write temp shell");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
    }

    #[test]
    fn an_allowlisted_executable_is_resolved_to_its_canonical_path() {
        let file = temp_path("allowed");
        write_executable(&file);
        let policy = ShellPolicy::new(vec![file.clone()]);
        let resolved = policy.resolve_client_shell(file.to_str().unwrap()).unwrap();
        assert_eq!(resolved, std::fs::canonicalize(&file).unwrap());
        let _ = std::fs::remove_file(&file);
    }

    #[test]
    fn a_path_outside_the_allowlist_is_refused() {
        let file = temp_path("outside");
        write_executable(&file);
        let policy = ShellPolicy::new(Vec::new());
        let err = policy
            .resolve_client_shell(file.to_str().unwrap())
            .unwrap_err();
        assert!(
            err.to_string().contains("not in the shell allowlist"),
            "{err}"
        );
        let _ = std::fs::remove_file(&file);
    }

    #[test]
    fn a_relative_path_is_refused() {
        let policy = ShellPolicy::new(Vec::new());
        let err = policy.resolve_client_shell("sh").unwrap_err();
        assert!(err.to_string().contains("not an absolute path"), "{err}");
    }

    #[test]
    fn a_nonexistent_path_is_refused() {
        let policy = ShellPolicy::new(Vec::new());
        let missing = temp_path("missing");
        let err = policy
            .resolve_client_shell(missing.to_str().unwrap())
            .unwrap_err();
        assert!(err.to_string().contains("cannot be resolved"), "{err}");
    }

    #[test]
    fn a_directory_is_refused() {
        let dir = temp_path("dir");
        std::fs::create_dir_all(&dir).unwrap();
        let policy = ShellPolicy::new(vec![dir.clone()]);
        let err = policy
            .resolve_client_shell(dir.to_str().unwrap())
            .unwrap_err();
        assert!(err.to_string().contains("not a file"), "{err}");
        let _ = std::fs::remove_dir(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn a_non_executable_file_is_refused() {
        let file = temp_path("noexec");
        std::fs::write(&file, b"data").unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o644)).unwrap();
        let policy = ShellPolicy::new(vec![file.clone()]);
        let err = policy
            .resolve_client_shell(file.to_str().unwrap())
            .unwrap_err();
        assert!(err.to_string().contains("not executable"), "{err}");
        let _ = std::fs::remove_file(&file);
    }

    #[cfg(unix)]
    #[test]
    fn two_paths_that_resolve_to_the_same_file_are_one_entry() {
        // `/bin/sh` is a symlink to the real shell on most unix hosts. Both
        // sides canonicalize, so either spelling is one allowlist entry —
        // comparing raw strings would wrongly refuse the second spelling.
        let real = std::fs::canonicalize("/bin/sh").expect("/bin/sh must exist on unix");
        let policy = ShellPolicy::new(vec![PathBuf::from("/bin/sh")]);
        assert_eq!(
            policy.resolve_client_shell(real.to_str().unwrap()).unwrap(),
            real
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_that_resolves_outside_the_allowlist_is_refused() {
        let allowed = temp_path("sym-allowed");
        write_executable(&allowed);
        let target = temp_path("sym-target");
        write_executable(&target);
        let link = temp_path("sym-link");
        let _ = std::fs::remove_file(&link);
        std::os::unix::fs::symlink(&target, &link).unwrap();

        // The allowlist holds `allowed`, not `target`; a request through the
        // symlink canonicalizes to `target` and must be refused.
        let policy = ShellPolicy::new(vec![allowed.clone()]);
        let err = policy
            .resolve_client_shell(link.to_str().unwrap())
            .unwrap_err();
        assert!(
            err.to_string().contains("not in the shell allowlist"),
            "{err}"
        );
        for p in [allowed, target, link] {
            let _ = std::fs::remove_file(p);
        }
    }

    #[test]
    fn the_configured_shell_is_always_allowed() {
        // current_exe() is absolute, exists, and (on unix) is executable —
        // the exact shape a configured shell must have. Using it keeps the
        // test hermetic: no dependence on the host's /etc/shells or $SHELL.
        let exe = std::fs::canonicalize(std::env::current_exe().expect("test binary path"))
            .expect("the test binary exists");
        let policy = ShellPolicy::from_config(exe.to_str().unwrap());
        assert_eq!(
            policy.resolve_client_shell(exe.to_str().unwrap()).unwrap(),
            exe
        );
    }

    #[cfg(unix)]
    #[test]
    fn etc_shells_entries_are_allowed_when_the_file_exists() {
        let Ok(text) = std::fs::read_to_string("/etc/shells") else {
            return; // a container without /etc/shells still has the floor
        };
        let Some(first) = text
            .lines()
            .map(str::trim)
            .find(|l| !l.is_empty() && !l.starts_with('#') && std::path::Path::new(l).exists())
        else {
            return;
        };
        let policy = ShellPolicy::from_config("/bin/sh");
        assert!(
            policy.resolve_client_shell(first).is_ok(),
            "/etc/shells lists {first}, which the policy must accept"
        );
    }
}
