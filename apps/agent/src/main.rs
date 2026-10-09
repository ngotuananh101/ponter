//! `ponter-agent` — the CLI front end over [`ponter_agent::AgentRuntime`].
//!
//! This binary owns the command-line surface only: `Cli` (clap), the
//! credential / shell / identity-path resolvers, and the process-level startup
//! pipeline. The agent runtime itself lives in the `ponter_agent` library
//! (ADR-50), so the same runtime can be embedded in-process by the desktop app.

#[cfg(windows)]
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use clap::Parser;

use ponter_agent::{identity, logging, AgentRuntime, DesktopSource, RuntimeConfig, StreamProfile};

#[derive(Parser, Debug)]
#[command(name = "ponter-agent", version, about = "Ponter remote desktop agent")]
struct Cli {
    /// Agent id registered with the signaling service.
    #[arg(long, env = "AGENT_ID")]
    agent_id: String,

    /// Signaling WebSocket URL.
    #[arg(
        long,
        env = "AGENT_SERVER",
        default_value = "ws://localhost:8787/api/ws/agent"
    )]
    server: String,

    /// Shell to spawn. Overrides auto-detection. Defaults to $SHELL (unix) or
    /// the best shell found on PATH (pwsh, then powershell, then cmd.exe on
    /// windows).
    #[arg(long, env = "AGENT_SHELL")]
    shell: Option<String>,

    /// Agent credential (ag_...). Prefer AGENT_CREDENTIAL: argv is visible via
    /// ps (ADR-13).
    #[arg(long, env = "AGENT_CREDENTIAL")]
    credential: Option<String>,

    /// Path to the persisted Ed25519 identity (PKCS#8). Generated on first run.
    #[arg(long, env = "AGENT_IDENTITY_PATH")]
    identity_path: Option<String>,

    /// STUN server; an empty string disables ICE servers entirely (loopback).
    #[arg(
        long,
        env = "STUN_SERVER",
        default_value = "stun:stun.l.google.com:19302"
    )]
    stun: String,

    /// Terminal size for the initial PTY.
    #[arg(long, default_value_t = 80)]
    cols: u16,
    #[arg(long, default_value_t = 24)]
    rows: u16,

    /// Desktop frame source: `screen` captures the display, `test` streams a
    /// deterministic pattern (what CI and the E2E harness use).
    #[arg(long, env = "AGENT_DESKTOP_SOURCE", value_enum, default_value_t = DesktopSource::Screen)]
    desktop_source: DesktopSource,

    /// Desktop quality profile. `1080p30` is the default; `720p30` is the safe
    /// floor for a host that cannot sustain 1080p30 (ADR-24).
    #[arg(long, env = "AGENT_DESKTOP_PROFILE", default_value = "1080p30")]
    desktop_profile: String,

    /// Which source streams before any selection (spec §6.1). `primary` (the
    /// default) means the primary monitor; any other value is an explicit
    /// source id validated against the enumeration at startup.
    #[arg(long, env = "AGENT_DESKTOP_DEFAULT_SOURCE", default_value = "primary")]
    desktop_default_source: String,

    /// Bounded window to apply a requested source switch before keeping the
    /// current source (ADR-22).
    #[arg(long, env = "AGENT_DESKTOP_SELECT_TIMEOUT_MS", default_value_t = 5000)]
    desktop_select_timeout_ms: u64,

    /// Enable remote input injection (mouse + keyboard). OFF by default: this
    /// is the ADR-29 gate, an agent-local opt-in a remote peer cannot set.
    #[arg(
        long,
        env = "AGENT_ALLOW_INPUT",
        value_parser = clap::builder::BoolishValueParser::new(),
        num_args = 0..=1,
        default_missing_value = "true",
        default_value_t = false,
    )]
    allow_input: bool,

    /// Directory served by files sessions. Unset = the files gate is closed
    /// (ADR-32); the root is resolved per offer, never cached at startup.
    #[arg(long, env = "AGENT_FILES_ROOT")]
    files_root: Option<String>,
}

/// `--credential-or-env` in the roadmap is realised as clap's
/// `env = "AGENT_CREDENTIAL"` on `--credential`: clap resolves flag -> env ->
/// default in that order, which is exactly ADR-13's rule, with one struct field
/// instead of two.
///
/// If neither is present the process exits non-zero with a message naming both
/// sources — **never a default**. A default credential would be a credential
/// that authenticates nothing and a failure that reads as a server problem.
fn resolve_credential(cli: &Cli) -> Result<String> {
    match &cli.credential {
        Some(c) if !c.trim().is_empty() => Ok(c.clone()),
        _ => bail!(
            "no agent credential: pass --credential or set AGENT_CREDENTIAL \
             (the value is issued once by POST /api/agents and cannot be recovered)"
        ),
    }
}

fn resolve_identity_path(cli: &Cli) -> std::path::PathBuf {
    if let Some(p) = &cli.identity_path {
        if !p.trim().is_empty() {
            return std::path::PathBuf::from(p);
        }
    }
    let base = std::env::var("XDG_CONFIG_HOME")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| std::env::var("HOME").ok().map(|h| format!("{h}/.config")))
        .unwrap_or_else(|| ".".to_string());
    std::path::PathBuf::from(base)
        .join("ponter")
        .join("agent-identity.pkcs8")
}

/// `--shell` -> `AGENT_SHELL` -> platform default.
///
/// An explicit value always wins, so an existing deployment that pins a shell
/// is never overridden by auto-detection. Otherwise the platform picks a
/// default: `$SHELL` (falling back to `/bin/sh`) on unix, and the best shell
/// found on the host on windows (see [`detect_windows_shell`]).
///
/// The path is passed through to `CommandBuilder::new` unmodified — no shell
/// interpolation of user input, because the value is the executable, not a
/// command line.
fn resolve_shell(cli: &Cli) -> Result<String> {
    Ok(resolve_shell_value(cli.shell.as_deref()))
}

/// The value half of [`resolve_shell`], split out so the override precedence is
/// unit-testable without constructing a `Cli` (and on every platform).
///
/// **Only the configured value takes this path.** A client-supplied
/// `terminal-create.shell` never reaches `CommandBuilder` unvalidated: the
/// dispatcher resolves it through [`shell_policy::ShellPolicy`] first (H1).
fn resolve_shell_value(explicit: Option<&str>) -> String {
    if let Some(s) = explicit {
        return s.to_string();
    }
    #[cfg(unix)]
    {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into())
    }
    #[cfg(windows)]
    {
        detect_windows_shell().unwrap_or_else(|| "cmd.exe".into())
    }
}

/// The first candidate `resolve` succeeds for, in the given preference order.
/// Pure, so the ordering can be unit-tested without touching a real `PATH` or
/// filesystem, and generic over the resolved value so the caller can return an
/// absolute path rather than the bare name.
#[cfg(any(windows, test))]
fn first_available<'a, T>(
    preference: &[&'a str],
    mut resolve: impl FnMut(&'a str) -> Option<T>,
) -> Option<T> {
    preference.iter().copied().find_map(&mut resolve)
}

/// Windows shells in preference order: PowerShell 7, then Windows PowerShell
/// 5.1, then the command prompt. `cmd.exe` is last because it is always present
/// — probing it first would make the others unreachable.
#[cfg(windows)]
const WINDOWS_SHELL_PREFERENCE: [&str; 3] = ["pwsh", "powershell", "cmd.exe"];

/// Directories where a shell may live without being on `PATH`. `pwsh` is the
/// case that matters: the MSI installs to `C:\Program Files\PowerShell\7\` and
/// does not always add that directory to `PATH`, so a `PATH`-only probe would
/// miss PowerShell 7 and fall through to the older `powershell.exe`.
#[cfg(windows)]
fn windows_shell_roots() -> Vec<PathBuf> {
    let mut roots = vec![
        PathBuf::from(r"C:\Program Files\PowerShell\7"),
        PathBuf::from(r"C:\Program Files\PowerShell\7-preview"),
    ];
    if let Ok(program_files) = std::env::var("ProgramFiles") {
        roots.push(Path::new(&program_files).join("PowerShell").join("7"));
        roots.push(
            Path::new(&program_files)
                .join("PowerShell")
                .join("7-preview"),
        );
    }
    if let Ok(program_files_x86) = std::env::var("ProgramFiles(x86)") {
        roots.push(Path::new(&program_files_x86).join("PowerShell").join("7"));
    }
    roots.push(PathBuf::from(r"C:\Windows\System32\WindowsPowerShell\v1.0"));
    roots
}

/// First Windows shell found, in preference order, resolved to an absolute path
/// so `portable-pty` never has to guess. Returns `None` only when nothing is
/// found; the caller then falls back to the bare `cmd.exe`, which
/// `CreateProcess` resolves to `%SystemRoot%\System32\cmd.exe`.
#[cfg(windows)]
fn detect_windows_shell() -> Option<String> {
    let roots = windows_shell_roots();
    first_available(&WINDOWS_SHELL_PREFERENCE, |name| {
        resolve_windows_shell(name, &roots)
    })
}

/// Locate one shell, preferring a `PATH` hit (which `where.exe` reports as an
/// absolute path) and falling back to the well-known install roots.
#[cfg(windows)]
fn resolve_windows_shell(name: &str, roots: &[PathBuf]) -> Option<String> {
    if let Some(path) = shell_on_path(name) {
        return Some(path);
    }
    roots
        .iter()
        .map(|root| root.join(name))
        .find(|candidate| candidate.is_file())
        .map(|candidate| candidate.to_string_lossy().into_owned())
}

/// The absolute path `where.exe` reports for `name`, or `None` when it is not on
/// `PATH`. `where.exe` is the Windows lookup tool and is itself always on
/// `PATH`; a missing `where.exe` or a non-zero exit (not found) both read as
/// "absent". Only the first match is used — that is what `CreateProcess` would
/// pick.
#[cfg(windows)]
fn shell_on_path(name: &str) -> Option<String> {
    let output = std::process::Command::new("where.exe")
        .arg(name)
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    stdout
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(str::to_string)
}

#[tokio::main]
async fn main() -> Result<()> {
    logging::init();

    // Set DPI awareness before any capture object is created so xcap's
    // `GetDpiForMonitor` path sees the real per-monitor scale factor.
    // Best-effort: safe no-op on non-Windows / older builds.
    ponter_agent::enable_dpi_awareness();

    let cli = Cli::parse();
    let credential = resolve_credential(&cli)?;
    let shell = resolve_shell(&cli)?;
    let identity = identity::AgentIdentity::load_or_generate(&resolve_identity_path(&cli))?;
    tracing::info!(public_key = %identity.public_key_base64(), "agent identity loaded");

    tracing::info!(server = %cli.server, shell = %shell, "starting ponter-agent");

    // Parsed here — after the two startup log lines, exactly as the pre-split
    // binary did inside `run_with_reconnect` — so a bad `--desktop-profile`
    // still fails loudly with the same message *and* the same log output.
    let desktop_profile: StreamProfile = cli
        .desktop_profile
        .parse()
        .context("--desktop-profile / AGENT_DESKTOP_PROFILE")?;

    let config = RuntimeConfig {
        server: cli.server.clone(),
        credential,
        shell,
        stun: cli.stun.clone(),
        cols: cli.cols,
        rows: cli.rows,
        desktop_source: cli.desktop_source,
        desktop_profile,
        desktop_default_source: cli.desktop_default_source.clone(),
        desktop_select_timeout: Duration::from_millis(cli.desktop_select_timeout_ms),
        allow_input: cli.allow_input,
        files_root: cli.files_root.clone(),
        identity: Arc::new(identity),
    };

    let handle = AgentRuntime::start(config).await?;
    handle.wait().await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_explicit_shell_always_wins_over_detection() {
        // A pinned --shell/AGENT_SHELL must never be overridden by the
        // auto-detect path, or existing deployments would silently change shell.
        assert_eq!(resolve_shell_value(Some("/usr/bin/fish")), "/usr/bin/fish");
        assert_eq!(resolve_shell_value(Some("pwsh.exe")), "pwsh.exe");
    }

    #[test]
    #[cfg(unix)]
    fn unix_falls_back_to_shell_env_then_bin_sh() {
        // `$SHELL` is read from the environment; only the value shape is
        // asserted so the test is hermetic regardless of the CI shell.
        let resolved = resolve_shell_value(None);
        assert!(!resolved.is_empty());
        if let Ok(shell) = std::env::var("SHELL") {
            assert_eq!(resolved, shell);
        } else {
            assert_eq!(resolved, "/bin/sh");
        }
    }

    #[test]
    fn shell_preference_is_ordered_and_stops_at_the_first_hit() {
        // Windows order: PowerShell 7 > Windows PowerShell > cmd. `cmd.exe`
        // being present must not shadow a pwsh that is also installed.
        let pref = ["pwsh", "powershell", "cmd.exe"];

        let only_cmd = first_available(&pref, |c| (c == "cmd.exe").then_some(c));
        assert_eq!(only_cmd, Some("cmd.exe"));

        let pwsh_and_cmd = first_available(&pref, |c| (c != "powershell").then_some(c));
        assert_eq!(pwsh_and_cmd, Some("pwsh"));

        let powershell_and_cmd = first_available(&pref, |c| (c != "pwsh").then_some(c));
        assert_eq!(powershell_and_cmd, Some("powershell"));

        let none = first_available(&pref, |_| None::<&str>);
        assert_eq!(none, None);
    }

    #[test]
    fn first_available_can_resolve_to_a_path_not_just_the_bare_name() {
        // The Windows detector returns an absolute path when a shell lives off
        // `PATH`; the helper must carry that value through, not the name.
        let pref = ["pwsh", "powershell", "cmd.exe"];
        let resolved = first_available(&pref, |c| {
            (c == "pwsh").then(|| r"C:\Program Files\PowerShell\7\pwsh.exe".to_string())
        });
        assert_eq!(
            resolved.as_deref(),
            Some(r"C:\Program Files\PowerShell\7\pwsh.exe")
        );
    }

    #[test]
    #[cfg(windows)]
    fn windows_prefers_powershell_7_over_legacy_powershell() {
        // pwsh (7) is preferred whenever present; cmd.exe is last-resort only.
        assert_eq!(WINDOWS_SHELL_PREFERENCE, ["pwsh", "powershell", "cmd.exe"]);
        let resolved = detect_windows_shell();
        if let Some(shell) = resolved {
            assert!(!shell.is_empty());
            let lower = shell.to_ascii_lowercase();
            assert!(
                lower.contains("pwsh") || lower.contains("powershell") || lower.contains("cmd.exe"),
                "unexpected shell resolved: {shell}"
            );
        }
    }

    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn allow_input_cli_and_env_parsing() {
        let _guard = ENV_LOCK.lock().unwrap();

        // 1. Neither flag nor env -> false
        std::env::remove_var("AGENT_ALLOW_INPUT");
        let cli = Cli::try_parse_from(["ponter-agent", "--agent-id", "a1"]).unwrap();
        assert!(
            !cli.allow_input,
            "absent flag and env should default to false"
        );

        // 2. CLI flag alone -> true
        let cli =
            Cli::try_parse_from(["ponter-agent", "--agent-id", "a1", "--allow-input"]).unwrap();
        assert!(cli.allow_input, "--allow-input flag should enable input");

        // CLI flag with explicit values
        let cli = Cli::try_parse_from(["ponter-agent", "--agent-id", "a1", "--allow-input=true"])
            .unwrap();
        assert!(cli.allow_input, "--allow-input=true should enable input");
        let cli =
            Cli::try_parse_from(["ponter-agent", "--agent-id", "a1", "--allow-input=1"]).unwrap();
        assert!(cli.allow_input, "--allow-input=1 should enable input");
        let cli = Cli::try_parse_from(["ponter-agent", "--agent-id", "a1", "--allow-input=false"])
            .unwrap();
        assert!(!cli.allow_input, "--allow-input=false should disable input");
        let cli =
            Cli::try_parse_from(["ponter-agent", "--agent-id", "a1", "--allow-input=0"]).unwrap();
        assert!(!cli.allow_input, "--allow-input=0 should disable input");

        // 3. Env AGENT_ALLOW_INPUT=1 -> true
        std::env::set_var("AGENT_ALLOW_INPUT", "1");
        let cli = Cli::try_parse_from(["ponter-agent", "--agent-id", "a1"]).unwrap();
        assert!(cli.allow_input, "AGENT_ALLOW_INPUT=1 should enable input");

        // 4. Env AGENT_ALLOW_INPUT=true -> true
        std::env::set_var("AGENT_ALLOW_INPUT", "true");
        let cli = Cli::try_parse_from(["ponter-agent", "--agent-id", "a1"]).unwrap();
        assert!(
            cli.allow_input,
            "AGENT_ALLOW_INPUT=true should enable input"
        );

        // 5. Env AGENT_ALLOW_INPUT=0 -> false
        std::env::set_var("AGENT_ALLOW_INPUT", "0");
        let cli = Cli::try_parse_from(["ponter-agent", "--agent-id", "a1"]).unwrap();
        assert!(!cli.allow_input, "AGENT_ALLOW_INPUT=0 should disable input");

        // 6. Env AGENT_ALLOW_INPUT=false -> false
        std::env::set_var("AGENT_ALLOW_INPUT", "false");
        let cli = Cli::try_parse_from(["ponter-agent", "--agent-id", "a1"]).unwrap();
        assert!(
            !cli.allow_input,
            "AGENT_ALLOW_INPUT=false should disable input"
        );

        std::env::remove_var("AGENT_ALLOW_INPUT");
    }

    #[test]
    fn enable_dpi_awareness_compiles_and_runs_without_panic() {
        // Best-effort: the function must not panic on any platform.
        ponter_agent::enable_dpi_awareness();
    }
}
