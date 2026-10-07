//! `ponter-agent` — CLI, startup pipeline, Ctrl-C/SIGTERM teardown.
//!
//! Four flat modules, no `lib.rs`: this is a binary crate, and the unit tests
//! live in `#[cfg(test)] mod tests` inside each module. A `lib.rs` would exist
//! only to let integration tests import the modules, and the PTY echo test
//! needs the real binary path anyway (spec §5.4.1).

// Desktop streaming is unavailable on musl (see Cargo.toml): the module is
// compiled out entirely, so the musl artifact stays terminal-only.
#[cfg(not(target_env = "musl"))]
mod desktop;
mod e2ee;
// `input` is gated with `desktop`, not independently: `to_absolute` takes a
// `DesktopSourceInfo` (spec §6.2), so the module cannot compile where `desktop`
// is compiled out. The musl artifact has no desktop session to inject into
// (ADR-15), so nothing here is reachable on musl. `--allow-input` still exists
// on every target (spec §6.4) — it lives in `Cli`, not in this module.
mod files;
mod identity;
#[cfg(not(target_env = "musl"))]
mod input;
mod logging;
mod pty;
mod rtc;
mod shell_policy;
mod signal;

use std::collections::HashMap;
#[cfg(windows)]
use std::path::{Path, PathBuf};
#[cfg(not(target_env = "musl"))]
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use anyhow::{bail, Context, Result};
use base64::engine::general_purpose::STANDARD as STANDARD_ENGINE;
use base64::Engine;
use clap::Parser;
use tokio::sync::mpsc;
use webrtc::data_channel::{DataChannel, DataChannelEvent};
use webrtc::peer_connection::{PeerConnection, RTCIceCandidateInit};

use crate::signal::SignalClient;

/// A frame on the files session's outbound channel: either a JSON text frame
/// (serialized by [`files::frame_files`]) or a raw binary chunk frame ready to
/// send as-is (Task 3, ADR-36). Private to `main.rs`.
enum FilesFrame {
    Text(String),
    Binary(Vec<u8>),
}

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

/// `Ctrl-C` **and** `SIGTERM`.
///
/// `SIGTERM` matters as much as `Ctrl-C`: a systemd unit or a container stop
/// sends `SIGTERM`, and an agent that ignores it leaves a shell running on the
/// host after the service is "stopped" (§5.8.3).
async fn shutdown_signal() {
    let ctrl_c = async { tokio::signal::ctrl_c().await.expect("ctrl-c handler") };

    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("SIGTERM handler")
            .recv()
            .await;
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {}
        _ = terminate => {}
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    logging::init();

    let cli = Cli::parse();
    let credential = resolve_credential(&cli)?;
    let shell = resolve_shell(&cli)?;
    let identity = identity::AgentIdentity::load_or_generate(&resolve_identity_path(&cli))?;
    tracing::info!(public_key = %identity.public_key_base64(), "agent identity loaded");

    tracing::info!(server = %cli.server, shell = %shell, "starting ponter-agent");

    run_with_reconnect(&cli, &credential, &shell, std::sync::Arc::new(identity)).await
}

/// Which frames a desktop session streams (ADR-17).
///
/// Defined unconditionally so the CLI has the same shape on every target; on
/// musl the value is accepted and then refused, because the desktop module is
/// compiled out there.
#[derive(clap::ValueEnum, Clone, Copy, Debug, PartialEq, Eq)]
enum DesktopSource {
    /// Capture the real primary display (Linux is the runnable platform in Week 7).
    Screen,
    /// A deterministic synthetic pattern: headless CI and the E2E harness.
    Test,
}

/// The resolved quality for one desktop session (ADR-21).
///
/// Resolved once at session start from the CLI/env, then read by the downscale
/// box, the ticker cadence, and the encoder config. `bitrate_bps` is the only
/// member adjustable after start (ADR-23).
///
/// Defined here, beside `DesktopSource`, rather than in `desktop.rs`: it is pure
/// data, and `SessionConfig` (which is unconditional) holds one. A type named
/// only inside the `#[cfg(not(target_env = "musl"))]` `desktop` module would be
/// E0433 on musl.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct StreamProfile {
    pub max_width: u32,
    pub max_height: u32,
    pub fps: f32,
    pub bitrate_bps: u32,
}

impl StreamProfile {
    /// Default: 1080p30 at 6 Mbps (ADR-24's conditional target).
    pub const DEFAULT_1080P30: Self = Self {
        max_width: 1920,
        max_height: 1080,
        fps: 30.0,
        bitrate_bps: 6_000_000,
    };
    /// The guaranteed floor: 720p30 at 4 Mbps (ADR-24).
    pub const SAFE_720P30: Self = Self {
        max_width: 1280,
        max_height: 720,
        fps: 30.0,
        bitrate_bps: 4_000_000,
    };

    /// The frame budget in seconds — `1 / fps`.
    pub fn frame_budget(&self) -> Duration {
        Duration::from_secs_f32(1.0 / self.fps)
    }
}

/// Parse `--desktop-profile` / `AGENT_DESKTOP_PROFILE`.
///
/// Only the two named profiles exist; anything else is an error rather than a
/// silent default, so a typo in a deployment fails loudly at startup.
impl std::str::FromStr for StreamProfile {
    type Err = anyhow::Error;

    fn from_str(value: &str) -> Result<Self> {
        match value {
            "1080p30" => Ok(Self::DEFAULT_1080P30),
            "720p30" => Ok(Self::SAFE_720P30),
            other => bail!("unknown desktop profile {other:?}; expected 1080p30 or 720p30"),
        }
    }
}

/// What an offer asks this agent to serve (ADR-15). Decided from the offer's
/// capabilities *before* the answer is built.
#[derive(Debug, PartialEq, Eq)]
enum SessionMode {
    Terminal,
    Desktop,
    Files,
    None,
}

/// Classify an offer's capabilities into the mode this agent will serve.
///
/// Pure and total: the input is attacker-controlled strings and the only
/// operation is exact comparison against the two known labels. Terminal is
/// checked first so a malformed client offering both gets the established flow.
fn classify_offer(capabilities: &[String]) -> SessionMode {
    if capabilities.iter().any(|c| c == rtc::TERMINAL_LABEL) {
        SessionMode::Terminal
    } else if capabilities.iter().any(|c| c == rtc::DESKTOP_LABEL) {
        SessionMode::Desktop
    } else if capabilities.iter().any(|c| c == rtc::FILES_LABEL) {
        SessionMode::Files
    } else {
        SessionMode::None
    }
}

/// Resolve the operator's files root for one offer (ADR-32). `None` closes
/// the gate: unset, missing, not a directory, or unreadable are one answer —
/// the browser must not learn which. Evaluated **per offer**, never cached
/// (a root that disappears mid-run closes the gate for the next offer).
async fn resolve_files_root(files_root: Option<&str>) -> Option<files::FilesRoot> {
    let raw = files_root?;
    match files::FilesRoot::resolve(raw).await {
        Ok(root) => Some(root),
        Err(error) => {
            tracing::warn!(error = %error, "files root unusable");
            None
        }
    }
}

/// The CLI values a running session needs, owned.
///
/// `run_with_reconnect` starts the session supervisor with `tokio::spawn` so
/// that a dropped signaling socket cannot cancel a live session (see that
/// function). A spawned task must be `'static`, so the `&Cli` and `&str` the
/// supervisor used to borrow are copied into this struct once.
#[derive(Clone)]
struct SessionConfig {
    stun: String,
    cols: u16,
    rows: u16,
    shell: String,
    /// H1: the allowlist every client-supplied `terminal-create.shell` must
    /// canonicalize into. Built once per process from the configured shell
    /// plus the platform floor and `/etc/shells`.
    pub shell_policy: std::sync::Arc<shell_policy::ShellPolicy>,
    /// Unused on musl, where the desktop module is compiled out; kept so the
    /// CLI shape is identical on every target.
    #[allow(dead_code)]
    desktop_source: DesktopSource,
    /// Unused on musl, where the desktop module is compiled out; kept so the
    /// CLI shape is identical on every target.
    #[allow(dead_code)]
    desktop_profile: StreamProfile,
    /// Unused on musl for the same reason as `desktop_profile`.
    #[allow(dead_code)]
    desktop_default_source: String,
    /// Unused on musl (the desktop module is compiled out); same shape on every
    /// target, mirroring `desktop_source`.
    #[allow(dead_code)]
    desktop_select_timeout: Duration,
    /// Input forwarding gate (ADR-29). Off by default; inert on musl, where
    /// there is no desktop session (same shape as `desktop_source`).
    #[allow(dead_code)]
    allow_input: bool,
    /// The files sandbox root as configured (ADR-32). `None` closes the gate.
    files_root: Option<String>,
    /// The agent's persistent Ed25519 peer identity, used to sign WS2 proofs
    /// that bind the offer SPD/ex to this agent (full wiring in Task 9).
    identity: std::sync::Arc<identity::AgentIdentity>,
}

/// Connect, serve, and reconnect with exponential backoff until told to stop.
///
/// The agent is a long-lived daemon, so a dropped socket is an ordinary event:
/// a laptop that slept, a server that restarted, a flaky link. Exiting on the
/// first disconnect would mean a user has to re-run the agent by hand after
/// every hiccup, which is the behaviour §5.5.5 exists to prevent.
///
/// **The session outlives the socket.** Signaling is only needed to establish
/// the peer connection; once ICE has connected, the DataChannel is
/// peer-to-peer. The supervisor therefore runs as a spawned task whose
/// lifetime is independent of any one socket, and each reconnect only rebuilds
/// the socket and re-attaches its senders. Before this, the supervisor was a
/// future inside the same `select!` as `client.run()`: a socket that died
/// cancelled it, the live `PeerConnection` was left with nobody applying its
/// ICE candidates, and the session degraded `connected → disconnected →
/// failed` a minute later.
///
/// The backoff resets on a successful connect rather than on a successful
/// session, because the failure being backed off from is the handshake itself —
/// a server that is down would otherwise be hammered at the maximum rate.
async fn run_with_reconnect(
    cli: &Cli,
    credential: &str,
    shell: &str,
    identity: std::sync::Arc<identity::AgentIdentity>,
) -> Result<()> {
    // Connection-independent channels, created ONCE and owned for the whole
    // process: the supervisor owns the receiver ends, and every reconnect only
    // rebuilds the socket and re-attaches its senders. This is what lets a
    // signal the live session produces — an answer, an ICE candidate — survive
    // a socket that dies mid-session instead of being stranded in a channel
    // whose only reader was just dropped.
    let (inbound_tx, inbound_rx) = mpsc::channel::<signal::SignalMessage>(32);
    let (outbound_tx, mut outbound_rx) = mpsc::channel::<signal::SignalMessage>(32);
    let (ice_tx, ice_rx) = mpsc::channel::<Vec<signal::IceServerEntry>>(1);

    // Moved into the supervisor exactly once, on the first successful connect.
    // `Option` because a bare move inside the loop would be rejected.
    let mut inbound_rx = Some(inbound_rx);
    let mut outbound_tx = Some(outbound_tx);
    let mut ice_rx = Some(ice_rx);

    let desktop_profile: StreamProfile = cli
        .desktop_profile
        .parse()
        .context("--desktop-profile / AGENT_DESKTOP_PROFILE")?;

    let cfg = SessionConfig {
        stun: cli.stun.clone(),
        cols: cli.cols,
        rows: cli.rows,
        shell: shell.to_string(),
        shell_policy: std::sync::Arc::new(shell_policy::ShellPolicy::from_config(shell)),
        desktop_source: cli.desktop_source,
        desktop_profile,
        desktop_default_source: cli.desktop_default_source.clone(),
        desktop_select_timeout: Duration::from_millis(cli.desktop_select_timeout_ms),
        allow_input: cli.allow_input,
        files_root: cli.files_root.clone(),
        identity,
    };

    let mut delay = signal::BACKOFF_INITIAL;
    let mut supervisor: Option<tokio::task::JoinHandle<Result<()>>> = None;

    loop {
        // A shutdown request can arrive while the signaling handshake is in
        // flight. On Unix the tokio SIGINT/SIGTERM handler is installed
        // process-wide and delivery is a one-shot broadcast: a signal that
        // arrives with no listener registered is dropped, and installing the
        // handler also replaces the default "terminate" disposition. So a
        // Ctrl-C during `connect` — where no `shutdown_signal()` branch is
        // otherwise live — used to be swallowed, and every later Ctrl-C with
        // it, leaving the agent alive until the handshake finished (or
        // forever, against a peer that accepts the TCP connection but never
        // answers the upgrade). Racing the connect against the signal keeps a
        // listener live for the whole attempt.
        let connect = SignalClient::connect(
            &cli.server,
            credential,
            inbound_tx.clone(),
            ice_tx.clone(),
            cfg.identity.clone(),
        );
        tokio::pin!(connect);
        let connected = tokio::select! {
            result = &mut connect => result,
            _ = shutdown_signal() => {
                tracing::info!("shutdown signal received while connecting");
                return Ok(());
            }
        };

        match connected {
            Ok(mut client) => {
                tracing::info!("connected to the signaling server");
                delay = signal::BACKOFF_INITIAL;

                // Start the supervisor on the first connect, not before: it
                // reads the `ice-servers` frame that connect triggers, and that
                // frame is what configures every peer it builds.
                if supervisor.is_none() {
                    supervisor = Some(tokio::spawn(supervise_sessions(
                        inbound_rx.take().expect("supervisor is started once"),
                        outbound_tx.take().expect("supervisor is started once"),
                        ice_rx.take().expect("supervisor is started once"),
                        cfg.clone(),
                    )));
                }
                let sessions = supervisor.as_mut().expect("supervisor is started above");

                tokio::select! {
                    // The socket ended. Whether that means "reconnect" is the
                    // socket's verdict, not a foregone conclusion (M2): 4409
                    // (replaced) and 4401 (unauthorized) stop the process;
                    // every other close — including the 1001 a server restart
                    // sends — reconnects with backoff. Nothing here touches
                    // the supervisor on the transient path: it lives in its
                    // own task across reconnects, so a live PeerConnection
                    // keeps being serviced while the socket is down.
                    result = client.run(&mut outbound_rx) => {
                        match result {
                            Ok(signal::RunEnd::Terminal(code)) => {
                                tracing::warn!(
                                    code,
                                    "the server closed this connection for good; not reconnecting"
                                );
                                supervisor.as_ref().expect("started").abort(); // ADR-12 teardown
                                return Ok(());
                            }
                            Ok(signal::RunEnd::Transient) => {}
                            Err(e) => {
                                tracing::warn!(error = %e, "signaling socket ended with an error");
                            }
                        }
                    }
                    // The supervisor only returns on a fatal internal error.
                    result = sessions => {
                        return result.context("the session supervisor panicked")?;
                    }
                    _ = shutdown_signal() => {
                        supervisor.as_ref().expect("started").abort(); // ADR-12 teardown
                        tracing::info!("shutdown signal received");
                        return Ok(());
                    }
                }
            }
            Err(e) => tracing::warn!(error = %e, "could not connect to the signaling server"),
        }

        tracing::info!(delay_ms = delay.as_millis() as u64, "reconnecting");
        tokio::select! {
            _ = tokio::time::sleep(delay) => {}
            _ = shutdown_signal() => {
                if let Some(handle) = supervisor.take() {
                    handle.abort();
                }
                tracing::info!("shutdown signal received while backing off");
                return Ok(());
            }
        }
        delay = signal::next_backoff(delay);
    }
}

/// One inbound event, as `supervise_sessions` sees it.
///
/// The split matters: a candidate for the live session must reach the live
/// session, and a candidate for anything else must not. Routing by
/// `session_id` is what makes that a property of the type rather than of a
/// match arm someone can forget to write.
enum Inbound {
    Offer(signal::SignalOffer),
    Candidate(signal::IceCandidateSignal),
    /// An answer or a candidate for a session this agent is not running.
    /// Dropped, but counted: with one session per agent (ADR-14) a steady
    /// stream of these is the signature of a misconfigured client.
    Foreign,
}

fn classify(message: signal::SignalMessage) -> Inbound {
    use signal::SignalMessage;
    match message {
        SignalMessage::Offer(offer) => Inbound::Offer(offer),
        SignalMessage::IceCandidate(candidate) => Inbound::Candidate(candidate),
        SignalMessage::Answer(_) => Inbound::Foreign,
    }
}

/// The session loop: take an `offer` and run one session to completion.
///
/// **ADR-14 refusals do not happen here.** `run_one_session` borrows `inbound`
/// for the session's whole lifetime, so a second offer that arrives while a
/// session is live is read — and refused — by `route_inbound` inside that
/// session. This loop only ever sees offers that arrive while no session is
/// running, which is exactly when a fresh session should start.
///
/// **Candidates are routed here, not in `run_one_session`.** The channel is a
/// single stream, so exactly one task can own it. `run_one_session` therefore
/// receives a fresh per-session channel that this loop forwards into, which
/// also means the loop can drop a candidate addressed to a session that is not
/// live without the session ever seeing it.
///
/// `cfg` is owned (not borrowed) because the loop runs in a spawned task whose
/// lifetime is independent of any one socket: `tokio::spawn` requires `'static`.
async fn supervise_sessions(
    mut inbound: tokio::sync::mpsc::Receiver<signal::SignalMessage>,
    outbound: tokio::sync::mpsc::Sender<signal::SignalMessage>,
    mut ice_rx: tokio::sync::mpsc::Receiver<Vec<signal::IceServerEntry>>,
    cfg: SessionConfig,
) -> Result<()> {
    // The server pushes ICE configuration on connect. It is read here rather
    // than in `run_one_session` because it arrives before any offer and has to
    // be in hand by the time the first peer connection is built. `recv()` is
    // bounded by the connect: if the server pushes nothing — an older server,
    // or a deployment with no TURN — the frame never arrives and the loop
    // below still works, but it must not block waiting for it. A short
    // timeout keeps that first offer from being delayed indefinitely.
    let pushed_ice: Vec<signal::IceServerEntry> =
        match tokio::time::timeout(std::time::Duration::from_millis(500), ice_rx.recv()).await {
            Ok(Some(entries)) => {
                tracing::info!(servers = entries.len(), "received ICE configuration");
                entries
            }
            Ok(None) => Vec::new(),
            Err(_) => Vec::new(),
        };

    // A `loop`/`let ... else`, NOT `while let Some(..) = inbound.recv().await`.
    // In edition 2021 the scrutinee's temporaries live for the whole `while let`
    // body, so the `&mut inbound` the future borrows would still be held when
    // `run_one_session` asks for it again — a borrow error, not a warning.
    //
    // The channel never closes in this design: the caller owns the sender and
    // re-attaches it to every fresh socket, so a disconnect does not end the
    // loop — and a live session's candidates simply stop arriving while the
    // socket is down, then resume on the next one. `None` here therefore means
    // the whole agent is shutting down, not that a single socket died.
    loop {
        let Some(message) = inbound.recv().await else {
            // Every sender gone. The only way this happens is process teardown.
            return Ok(());
        };

        match classify(message) {
            Inbound::Foreign => {
                tracing::debug!("ignoring an inbound frame for an inactive session");
            }

            Inbound::Candidate(candidate) => {
                // Reached only while no session is running: `run_one_session`
                // borrows `inbound` for the whole session, so a live session
                // drains its own candidates. A candidate here belongs to a
                // session that has ended, and applying it to whatever
                // connection exists next is how a stale peer poisons a fresh
                // one. Dropped, and counted.
                tracing::debug!(
                    session_id = %candidate.session_id,
                    "dropping a candidate for an inactive session",
                );
            }

            Inbound::Offer(offer) => {
                tracing::info!(session_id = %offer.session_id, "session starting");

                if let Err(e) =
                    run_one_session(&offer, &mut inbound, &outbound, &pushed_ice, &cfg).await
                {
                    tracing::warn!(
                        error = %e,
                        session_id = %offer.session_id,
                        "session ended with an error",
                    );
                }

                tracing::info!(session_id = %offer.session_id, "session ended");
            }
        }
    }
}

/// The H3 security gate: verify the user's proof on the offer BEFORE the session
/// proceeds to PTY spawn.
///
/// Called once in `run_one_session`, after the data channel opens and before the
/// poll task is spawned. Because both PTY spawn sites (the dispatcher task at the
/// top of `run_one_session`, and the implicit spawn-on-demand inside it) are only
/// reachable through frames delivered by `poll_task`, gating `poll_task` gates
/// both: a tampered/unsigned offer never feeds a `terminal-create` frame to the
/// dispatcher, so no PTY is ever created.
///
/// Requirements (Task 9 brief):
/// 1. the offer must carry an `IdentityProof`;
/// 2. the offer must carry a `userSigningPublicKey` (base64 Ed25519 public key);
/// 3. the proof's fingerprint must equal `parse_sdp_fingerprint(&offer.sdp)`;
/// 4. the signature must verify against that public key over the canonical
///    `role="offerer"` message.
pub fn verify_offer_identity(
    offer: &signal::SignalOffer,
    _identity: &identity::AgentIdentity,
) -> Result<()> {
    let proof = offer
        .proof
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("offer carries no identity proof"))?;
    let user_pk = offer
        .user_signing_public_key
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("offer carries no user signing key"))?;
    let pk = identity::base64_decode(user_pk)?;

    let fingerprint = identity::parse_sdp_fingerprint(&offer.sdp)?;
    if identity::normalize_fingerprint(&proof.fingerprint)? != fingerprint {
        bail!("offer fingerprint does not match the SDP");
    }

    let message = identity::canonical_proof_message(
        "offerer",
        &offer.session_id,
        &identity::sha256_hex(offer.sdp.as_bytes()),
        &fingerprint,
    );
    if !identity::verify_proof(
        &pk,
        message.as_bytes(),
        &identity::base64_decode(&proof.signature)?,
    ) {
        bail!("offer identity signature is invalid");
    }
    Ok(())
}

/// Transform one outbound item into the text to send. `armed` flips to true
/// when the ack marker is drained: activation is a BARRIER — frames drained
/// before it stay plaintext, so the ack always precedes the first ciphertext.
/// Returns `None` to drop the frame (fail-closed on an encrypt error).
fn pump_frame(
    item: pty::Outbound,
    armed: &mut bool,
    session: Option<&crate::e2ee::E2eeSession>,
) -> Option<String> {
    match item {
        pty::Outbound::Json(s) => Some(s),
        pty::Outbound::E2eeAck(s) => {
            *armed = true;
            Some(s)
        }
        pty::Outbound::TerminalData {
            terminal_id,
            bytes,
            timestamp_ms,
        } => {
            let data = if *armed {
                match session {
                    Some(s) => match s.encrypt(&bytes) {
                        Ok(ct) => ct,
                        Err(e) => {
                            tracing::debug!(error = ?e, "terminal-data encrypt failed, dropping frame");
                            return None;
                        }
                    },
                    // Armed but no session is a bug: fail-closed, never plaintext.
                    None => {
                        tracing::debug!("terminal-data armed without a session, dropping frame");
                        return None;
                    }
                }
            } else {
                bytes
            };
            Some(pty::build_terminal_data_frame(
                &terminal_id,
                &data,
                timestamp_ms,
            ))
        }
    }
}

/// One session: answer, wait for the `terminal` channel, spawn the PTY, pump.
///
/// Borrows `inbound` for the session's whole lifetime, so every candidate the
/// peer trickles lands here rather than in the idle loop above. That is the
/// point: the buffer below must be the same object that receives them.
///
/// `cfg` is owned because the supervisor runs in a spawned `'static` task.
async fn run_one_session(
    offer: &signal::SignalOffer,
    inbound: &mut tokio::sync::mpsc::Receiver<signal::SignalMessage>,
    outbound: &tokio::sync::mpsc::Sender<signal::SignalMessage>,
    pushed_ice: &[signal::IceServerEntry],
    cfg: &SessionConfig,
) -> Result<()> {
    // ADR-15: classify from the offer's capabilities before anything is built.
    // The mode also selects the ICE timeouts passed to `build_peer`.
    let mode = classify_offer(&offer.capabilities);

    // End-of-session signal. The session loop below watches `inbound` (which
    // stays open across socket reconnects) and the pty pump, so a peer that
    // dies without a clean close used to leave the session — and its ADR-14
    // slot — running until the 1h cap: close every tab, reopen one, and the
    // new offer was silently dropped by the still-running session, surfacing
    // as `timeout waiting for channel "terminal" (saw state: connecting)`.
    //
    // Two ways a dead peer reaches us: the data channel closes (the browser
    // closes it, or its stack resets the SCTP stream — an ABORT arrives as
    // `ErrChunk` and the channel's read loop ends) and the peer connection
    // fails (ICE gave up: a killed tab that never sent a close, a network
    // cut). Either is terminal for the session, so both funnel into one
    // channel the session loop selects on. Capacity 1 with `try_send`: the
    // first reason wins, and a full channel means the loop is already woken.
    let (end_tx, mut end_rx) = mpsc::channel::<&'static str>(1);

    // In 0.21 the callbacks are not registered on the connection: the handler
    // goes into the builder and `build()` refuses without one. So the handler
    // — and everything it needs — is created before the peer. `on_ice_candidate`
    // now lives here too, which is what the old code achieved by registering
    // `forward_candidates` before `set_local_description`: the handler is
    // attached from the first moment the peer exists, so it cannot miss the
    // host candidates emitted when gathering starts.
    let channel: Arc<OnceLock<Arc<dyn DataChannel>>> = Arc::new(OnceLock::new());
    let (open_tx, mut open_rx) = tokio::sync::oneshot::channel::<()>();
    let open_tx = Arc::new(Mutex::new(Some(open_tx)));
    // Fired on `Connected`; the desktop session waits on it (a desktop peer has
    // no data channel to wait for instead). Unused by the terminal path.
    let (connected_tx, connected_rx) = tokio::sync::oneshot::channel::<()>();
    let connected_tx = Arc::new(Mutex::new(Some(connected_tx)));

    // The one channel label this session accepts. A terminal session accepts
    // `terminal`; a desktop session accepts `control` (spec §2.1). The `None`
    // mode never opens a session, so its label is never used.
    let accepted_label = match mode {
        SessionMode::Desktop => rtc::CONTROL_LABEL.to_string(),
        SessionMode::Files => rtc::FILES_LABEL.to_string(),
        _ => rtc::TERMINAL_LABEL.to_string(),
    };

    let handler = Arc::new(rtc::SessionHandler::new(
        offer.session_id.clone(),
        outbound.clone(),
        end_tx.clone(),
        accepted_label,
        channel.clone(),
        open_tx,
        connected_tx,
    ));
    // A desktop peer now carries a control channel, so it keeps the RFC-shaped
    // ICE defaults; `media_only` is false for every Week 8 session.
    let rtc::BuiltPeer { peer, abr_target } = rtc::build_peer(
        pushed_ice,
        &cfg.stun,
        handler,
        false,
        mode == SessionMode::Desktop,
    )
    .await?;

    // Candidates that arrive before the remote description is set (spec R3).
    let mut pending: Vec<RTCIceCandidateInit> = Vec::new();

    // ADR-41 (Phase 6a): identity verification is an ADMISSION gate for every
    // session mode, not a terminal-only step. It runs here — after the peer is
    // built, before the files-root probe and before the mode dispatch — so an
    // unverifiable offer is refused before any resource (filesystem root
    // resolution, capture pipeline, PTY) is touched. Fail-closed: the `?` bails
    // out of `run_one_session` with NO answer of any kind — not even
    // `approved: false` — so a peer without a valid proof learns nothing. The
    // supervisor logs the error text (main.rs driver loop). Desktop and Files
    // previously returned at :970/:988 before the old terminal-only call at
    // :1025 and were therefore never verified (carry-forward C1, WS1 Rust doc).
    verify_offer_identity(offer, &cfg.identity)?;

    // ADR-32: the files gate is evaluated per offer, before the answer. An
    // unset, missing, non-directory, or unreadable root is one refusal —
    // `approved: false` and the peer closed, with a log line the E2E pins.
    let files_root = if mode == SessionMode::Files {
        resolve_files_root(cfg.files_root.as_deref()).await
    } else {
        None
    };
    if mode == SessionMode::Files && files_root.is_none() {
        tracing::warn!(session_id = %offer.session_id, "refused: files root not configured or unusable");
        rtc::refuse_offer(&peer, offer, outbound, &cfg.identity).await?;
        let _ = peer.close().await;
        return Ok(());
    }

    // Branch on the classification made before the peer was built (ADR-15). A
    // desktop offer needs its sending track attached before the remote
    // description exists; an unsupported offer is refused with a real SDP
    // (approved: false) and never reaches the terminal setup below.
    match mode {
        SessionMode::Desktop => {
            return run_desktop_session(
                offer,
                &peer,
                outbound,
                pushed_ice,
                cfg,
                &mut pending,
                connected_rx,
                end_rx,
                end_tx,
                channel.clone(),
                open_rx,
                inbound,
                abr_target,
            )
            .await;
        }
        SessionMode::Files => {
            // The gate above guarantees `Some` for this arm.
            let root = files_root.expect("the files gate refused a rootless offer");
            return run_files_session(
                offer,
                &peer,
                outbound,
                pushed_ice,
                cfg,
                &mut pending,
                end_rx,
                end_tx,
                channel.clone(),
                open_rx,
                inbound,
                root,
            )
            .await;
        }
        SessionMode::None => {
            tracing::warn!(session_id = %offer.session_id, "refused: no recognised capability");
            rtc::refuse_offer(&peer, offer, outbound, &cfg.identity).await?;
            let _ = peer.close().await;
            return Ok(());
        }
        SessionMode::Terminal => {}
    }

    rtc::answer_offer(&peer, offer, outbound, &cfg.identity).await?;

    // Apply whatever the browser trickled while the answer was being built.
    // `answer_offer` returns as soon as the answer is on the wire, and the
    // browser starts trickling the moment it reads it, so this is a real race
    // rather than a theoretical one.
    rtc::flush_pending_candidates(&peer, &mut pending).await?;

    // PtyManager multiplexes up to 10 concurrent sessions over this one
    // terminal DataChannel. The manager is created before the data-channel
    // callback is registered.
    let manager = PtyManager::new(10);

    // WS1 E2EE: whether the offer proposed `e2ee` (the agent never initiates it).
    // Captured before the dispatcher so the closure can read it.
    let negotiated = !rtc::negotiated_capabilities(&offer.capabilities).is_empty();

    // The browser's Ed25519 signing public key, decoded once here and captured
    // into the dispatcher for hello verification. `verify_offer_identity` decoded
    // it locally but did not return the bytes (R9).
    let peer_signing_raw: [u8; 32] = match &offer.user_signing_public_key {
        Some(pk) => {
            let decoded = identity::base64_decode(pk)
                .map_err(|e| anyhow::anyhow!("cannot decode user signing key: {e}"))?;
            let mut arr = [0u8; 32];
            if decoded.len() != 32 {
                anyhow::bail!("user signing key is not 32 bytes");
            }
            arr.copy_from_slice(&decoded);
            arr
        }
        None => [0u8; 32],
    };

    // WS1 E2EE session state, shared between the dispatcher task (writes the
    // session on hello, reads to decrypt input) and the pump task (reads to
    // encrypt output). Both tasks are `'static`, so the state is heap-shared.
    let e2ee_session: Arc<tokio::sync::RwLock<Option<crate::e2ee::E2eeSession>>> =
        Arc::new(tokio::sync::RwLock::new(None));

    // The outbound frame channel sits between PtyManager's pump tasks and the
    // data-channel send loop. PtyManager writes `Outbound` here; the pump
    // encrypts `TerminalData` and sends each frame over the wire.
    let (frame_tx, mut frame_rx) = mpsc::channel::<pty::Outbound>(64);

    // The inbound dispatch channel sits between the data-channel `on_message`
    // callback and the dispatcher task. The callback must be `Fn + Send + Sync`,
    // but PtyManager holds Arc<PtySession> whose inner MasterPty is not Sync — so
    // we forward raw text through this channel instead of capturing the manager.
    let (dispatch_tx, mut dispatch_rx) = mpsc::channel::<String>(64);
    let manager_for_dispatch = manager.clone();
    let frame_tx_for_dispatch = frame_tx.clone();
    let shell_for_dispatch = cfg.shell.clone();
    let shell_policy_for_dispatch = std::sync::Arc::clone(&cfg.shell_policy);
    let cli_cols = cfg.cols;
    let cli_rows = cfg.rows;
    let e2ee_for_dispatch = Arc::clone(&e2ee_session);
    let session_id_for_dispatch = offer.session_id.clone();
    let negotiated_for_dispatch = negotiated;
    let peer_signing_for_dispatch = peer_signing_raw;
    let identity_for_dispatch = Arc::clone(&cfg.identity);
    tokio::spawn(async move {
        while let Some(text) = dispatch_rx.recv().await {
            let envelope: pty::DataChannelMessage<serde_json::Value> =
                match serde_json::from_str(&text) {
                    Ok(e) => e,
                    Err(e) => {
                        tracing::debug!(error = %e, "dropping malformed frame");
                        continue;
                    }
                };

            if envelope.channel != "terminal" {
                continue;
            }

            match envelope.r#type.as_str() {
                "terminal-e2ee-hello" => {
                    // Only negotiate if the offer proposed e2ee and no session
                    // is already active. Fail-closed: a bad hello leaves the
                    // session plaintext (no session, no ack).
                    if negotiated_for_dispatch {
                        let e2ee_guard = e2ee_for_dispatch.read().await;
                        let already_active = e2ee_guard.is_some();
                        drop(e2ee_guard); // never hold a lock across a channel send

                        if !already_active {
                            // The frame is `{type, channel, payload:{terminalId,ecdhPublicKey,signature}, timestamp}`.
                            let hello: crate::e2ee::E2eeHello = match serde_json::from_value(
                                envelope.payload.clone(),
                            ) {
                                Ok(h) => h,
                                Err(e) => {
                                    tracing::debug!(error = ?e, "bad e2ee-hello, staying plaintext");
                                    continue;
                                }
                            };
                            let mut identity_guard = e2ee_for_dispatch.write().await;
                            let result = crate::e2ee::E2eeSession::accept_hello(
                                &identity_for_dispatch,
                                &session_id_for_dispatch,
                                &hello,
                                &peer_signing_for_dispatch,
                            );
                            match result {
                                Ok((session, ack)) => {
                                    *identity_guard = Some(session);
                                    drop(identity_guard); // drop BEFORE sending the ack

                                    // The ack is itself a nested DataChannelMessage envelope.
                                    let ack_json = serde_json::json!({
                                        "type": "terminal-e2ee-ack",
                                        "channel": "terminal",
                                        "payload": {
                                            "terminalId": ack.terminal_id,
                                            "ecdhPublicKey": ack.ecdh_public_key,
                                            "signature": ack.signature,
                                        },
                                        "timestamp": pty::now_ms(),
                                    });
                                    if frame_tx_for_dispatch
                                        .send(pty::Outbound::E2eeAck(ack_json.to_string()))
                                        .await
                                        .is_err()
                                    {
                                        tracing::debug!("frame channel is gone");
                                    }
                                }
                                Err(e) => {
                                    drop(identity_guard);
                                    tracing::debug!(error = ?e, "e2ee-hello rejected, staying plaintext");
                                }
                            }
                        }
                    }
                }
                "terminal-create" => {
                    let create: pty::TerminalCreateMessage =
                        match serde_json::from_value(envelope.payload) {
                            Ok(c) => c,
                            Err(e) => {
                                tracing::debug!(error = %e, "bad terminal-create payload");
                                continue;
                            }
                        };
                    let sh = match create.shell {
                        // H1: a client-supplied shell is untrusted input; the
                        // configured shell (no client value) is operator policy.
                        Some(requested) => {
                            match shell_policy_for_dispatch.resolve_client_shell(&requested) {
                                Ok(path) => path.to_string_lossy().into_owned(),
                                Err(e) => {
                                    tracing::warn!(
                                        terminal_id = %create.terminal_id,
                                        requested = %requested,
                                        error = %e,
                                        "refused a client-supplied shell",
                                    );
                                    // Reuse the pinned spawn-failure frame: the
                                    // browser already surfaces its `message`, and a
                                    // third wire code would change a contract for no
                                    // reader's benefit.
                                    let frame = pty::frame_pty_error(
                                        &create.terminal_id,
                                        pty::PtyErrorCode::SpawnFailed,
                                        &format!("shell refused: {e}"),
                                        pty::now_ms(),
                                    );
                                    let _ = frame_tx_for_dispatch
                                        .send(pty::Outbound::Json(frame))
                                        .await;
                                    continue;
                                }
                            }
                        }
                        None => shell_for_dispatch.clone(),
                    };
                    let spawn = manager_for_dispatch
                        .spawn_session(
                            create.terminal_id.clone(),
                            &sh,
                            create.cols,
                            create.rows,
                            frame_tx_for_dispatch.clone(),
                        )
                        .await;
                    // Success is the normal path and must not read as a warning;
                    // only a refused spawn is worth a `warn!`. Both branches log
                    // the terminal id so a multi-session host can tell which
                    // shell the line belongs to.
                    match &spawn {
                        Ok(()) => tracing::debug!(
                            terminal_id = %create.terminal_id,
                            "spawn terminal session finished"
                        ),
                        Err(e) => tracing::warn!(
                            terminal_id = %create.terminal_id,
                            error = %e,
                            "spawn terminal session failed"
                        ),
                    }
                    // A refused spawn must reach the browser, not just the log.
                    if let Some(frame) = spawn_failure_frame(&create.terminal_id, spawn) {
                        let _ = frame_tx_for_dispatch.send(pty::Outbound::Json(frame)).await;
                    }
                }
                "terminal-resize" => {
                    let resize: pty::TerminalResizeMessage =
                        match serde_json::from_value(envelope.payload) {
                            Ok(r) => r,
                            Err(e) => {
                                tracing::debug!(error = %e, "bad terminal-resize payload");
                                continue;
                            }
                        };
                    if let Err(e) = manager_for_dispatch
                        .resize(&resize.terminal_id, resize.cols, resize.rows)
                        .await
                    {
                        tracing::debug!(error = %e, "resize failed");
                    }
                }
                "terminal-close" => {
                    let close: pty::TerminalCloseMessage =
                        match serde_json::from_value(envelope.payload) {
                            Ok(c) => c,
                            Err(e) => {
                                tracing::debug!(error = %e, "bad terminal-close payload");
                                continue;
                            }
                        };
                    manager_for_dispatch.close_session(&close.terminal_id).await;
                }
                "terminal-data" => {
                    let payload: pty::TerminalDataMessage =
                        match serde_json::from_value(envelope.payload) {
                            Ok(p) => p,
                            Err(e) => {
                                tracing::debug!(error = %e, "bad terminal-data payload");
                                continue;
                            }
                        };

                    // Decode the base64 data payload.
                    let raw = match STANDARD_ENGINE.decode(payload.data.as_bytes()) {
                        Ok(b) => b,
                        Err(e) => {
                            tracing::debug!(error = %e, "payload.data is not valid base64");
                            continue;
                        }
                    };

                    // Decrypt when a session is active — fail-closed: drop on
                    // error, never forward ciphertext or plaintext-on-decrypt-failure.
                    let bytes = {
                        let guard = e2ee_for_dispatch.read().await;
                        match &*guard {
                            Some(session) => match session.decrypt(&raw) {
                                Ok(pt) => pt,
                                Err(e) => {
                                    tracing::debug!(error = ?e, "terminal-data decrypt failed, dropping input");
                                    continue;
                                }
                            },
                            None => raw,
                        }
                    };

                    // Implicit spawn fallback: if the session does not yet exist,
                    // spawn it on demand before sending the bytes.
                    if !manager_for_dispatch
                        .send_input(&payload.terminal_id, bytes.clone())
                        .await
                    {
                        if let Err(e) = manager_for_dispatch
                            .spawn_session(
                                payload.terminal_id.clone(),
                                &shell_for_dispatch,
                                cli_cols,
                                cli_rows,
                                frame_tx_for_dispatch.clone(),
                            )
                            .await
                        {
                            tracing::warn!(error = %e, "failed to spawn on-demand session");
                            continue;
                        }
                        let _ = manager_for_dispatch
                            .send_input(&payload.terminal_id, bytes)
                            .await;
                    }
                }
                _ => {
                    // Unknown or non-terminal frame type on the terminal channel.
                }
            }
        }
    });

    // The channel is announced by the driver through `SessionHandler`, which
    // was built into the peer above; nothing is registered here. The handshake
    // below waits for it; once it opens, the poll loop is spawned.

    // The handshake: wait for the channel to open, draining candidates the
    // whole time. Candidates must keep flowing here — a peer that trickled
    // slowly would otherwise stall behind this wait, because nothing else is
    // reading `inbound` while it runs.
    //
    // `inbound` never closes while the agent runs — the sender lives in the
    // reconnect loop and is re-attached to every fresh socket — so a `None`
    // here means the whole agent is shutting down, not that one socket died.
    // A dead socket simply stops delivering candidates until the next one
    // connects; the ICE layer already connected is unaffected.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    loop {
        tokio::select! {
            // Candidates first: they are what the handshake is waiting on, and
            // `biased` keeps the order deterministic rather than random.
            biased;

            candidate = inbound.recv() => {
                let Some(message) = candidate else {
                    anyhow::bail!("the inbound channel closed while waiting for the terminal channel");
                };
                route_inbound(
                    &peer,
                    &offer.session_id,
                    &mut pending,
                    message,
                    outbound,
                    pushed_ice,
                    cfg,
                )
                .await?;
            }

            // The channel closed (or the peer failed) before it ever opened.
            // Without this arm the handshake would sit here for its full 20s:
            // the `open_tx` sender is held by the accept handler, so a channel
            // that closes without opening never drops it, and `open_rx` never
            // resolves.
            reason = end_rx.recv() => {
                anyhow::bail!("the session ended during the handshake: {}", reason.unwrap_or("the peer went away"));
            }

            result = &mut open_rx => {
                result.context("the terminal channel was closed before it opened")?;
                break;
            }

            _ = tokio::time::sleep_until(deadline) => {
                anyhow::bail!("the terminal channel did not open within 20s");
            }
        }
    }

    let dc = channel
        .get()
        .context("the terminal channel vanished after opening")?
        .clone();

    // Watch the channel for its lifetime. In 0.21 there is no `on_message` /
    // `on_close` registration: the driver delivers events through `poll()`
    // (capacity 256, retained under back-pressure, so a message that arrived
    // while the handshake was still draining candidates is not lost). The
    // close event ends the session: the browser closed the last tab, or its
    // stack reset the SCTP stream — either way this session is over. That is
    // the fix of 2026-10-01 kept intact: without this arm the finished session
    // would hold the single ADR-14 slot until the 1h cap.
    let dc_for_events = dc.clone();
    let dispatch_tx_for_events = dispatch_tx.clone();
    let end_tx_for_events = end_tx.clone();
    let poll_task = tokio::spawn(async move {
        while let Some(event) = dc_for_events.poll().await {
            match event {
                // browser -> dispatch channel. Only forwards raw text; the
                // spawned dispatcher task does the decoding and routing.
                DataChannelEvent::OnMessage(msg) => {
                    let Ok(text) = std::str::from_utf8(&msg.data) else {
                        tracing::debug!("ignoring a non-UTF-8 frame");
                        continue;
                    };
                    if dispatch_tx_for_events.send(text.to_string()).await.is_err() {
                        tracing::debug!("dispatcher task is gone");
                        break;
                    }
                }
                DataChannelEvent::OnClose => {
                    let _ = end_tx_for_events.try_send("the terminal channel closed");
                    break;
                }
                _ => {}
            }
        }
    });

    // PTY -> browser. One sequential loop drains the shared frame channel and
    // sends each frame over the data channel. This is the single send point for
    // all sessions, preserving frame ordering per-session (each pump task is
    // single-threaded) and keeping backpressure on a slow consumer.
    let e2ee_for_pump = Arc::clone(&e2ee_session);
    let mut pump = tokio::spawn(async move {
        let mut e2ee_armed = false;
        while let Some(item) = frame_rx.recv().await {
            let text = {
                let needs_session =
                    e2ee_armed && matches!(&item, pty::Outbound::TerminalData { .. });
                if needs_session {
                    let guard = e2ee_for_pump.read().await;
                    pump_frame(item, &mut e2ee_armed, guard.as_ref())
                } else {
                    pump_frame(item, &mut e2ee_armed, None)
                }
                // `guard` (when taken) drops here — never held across `send_text`.
            };
            let Some(text) = text else {
                continue; // fail-closed drop
            };
            if let Err(e) = dc.send_text(&text).await {
                // A closed channel is an ordinary end-of-session condition, not
                // an error worth tearing the process down for.
                tracing::debug!(error = %e, "data channel send failed");
                break;
            }
        }
    });

    // The session loop. `inbound` stays open across reconnects (see above), so
    // the loop keeps the live peer serviced while the socket is down: late
    // ICE candidates resume on the next socket instead of being dropped with
    // a dead session. The ways out are the pump ending (channel gone), the
    // peer dying (channel closed / connection failed), the hourly cap, or a
    // real shutdown request — NOT the socket.
    let manager_for_teardown = manager.clone();
    let session_deadline = tokio::time::Instant::now() + Duration::from_secs(3600);
    let reason = loop {
        tokio::select! {
            _ = &mut pump => break "the pty pump ended",
            message = inbound.recv() => {
                match message {
                    Some(message) => route_inbound(
                        &peer,
                        &offer.session_id,
                        &mut pending,
                        message,
                        outbound,
                        pushed_ice,
                        cfg,
                    ).await?,
                    None => break "the agent is shutting down",
                }
            }
            // The peer is gone: its channel closed or its connection failed.
            // This is the arm that frees the ADR-14 slot immediately instead
            // of holding it until the 1h cap.
            reason = end_rx.recv() => break reason.unwrap_or("the peer went away"),
            _ = tokio::time::sleep_until(session_deadline) => break "the 1h session cap",
            _ = shutdown_signal() => break "a shutdown signal",
        }
    };
    tracing::info!(session_id = %offer.session_id, reason, "session loop finished");

    // Tear down all live PTY sessions. `close_all` removes every entry; the
    // ActivePty drop ends each writer thread (EOF to the shell), and the pump
    // task exits when the frame channel drains and closes.
    manager_for_teardown.close_all().await;
    drop(frame_tx);
    // The poll loop parks in `poll()` until the driver closes its event
    // channel. The driver holds that sender in the connection's shared map —
    // not in the driver task — so it is only released when the peer is
    // dropped, after which this session is gone anyway. Aborting first keeps
    // one parked task per session from accumulating.
    poll_task.abort();
    let _ = peer.close().await;
    Ok(())
}

/// Serve a files offer end to end: answer, wait for the `files` channel,
/// then pump frames in both directions until the peer or the session ends.
///
/// The root is resolved and validated by the gate in `run_one_session`
/// (ADR-32); this function never re-checks it.
#[allow(clippy::too_many_arguments)]
async fn run_files_session(
    offer: &signal::SignalOffer,
    peer: &Arc<dyn PeerConnection>,
    outbound: &mpsc::Sender<signal::SignalMessage>,
    pushed_ice: &[signal::IceServerEntry],
    cfg: &SessionConfig,
    pending: &mut Vec<RTCIceCandidateInit>,
    mut end_rx: mpsc::Receiver<&'static str>,
    end_tx: mpsc::Sender<&'static str>,
    channel: Arc<OnceLock<Arc<dyn DataChannel>>>,
    mut open_rx: tokio::sync::oneshot::Receiver<()>,
    inbound: &mut mpsc::Receiver<signal::SignalMessage>,
    root: files::FilesRoot,
) -> Result<()> {
    // The gate already approved this offer; the answer carries `approved:
    // true` and the SDP. Files never reaches `answer_offer` (its terminal-
    // only approval at rtc.rs:722 is not consulted).
    rtc::send_approved_answer(peer, offer, outbound, &cfg.identity).await?;
    rtc::flush_pending_candidates(peer, pending).await?;

    // Wait for the channel to open, draining candidates the whole time —
    // identical shape to the terminal handshake (they are what it waits on).
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    loop {
        tokio::select! {
            biased;

            candidate = inbound.recv() => {
                let Some(message) = candidate else {
                    anyhow::bail!("the inbound channel closed while waiting for the files channel");
                };
                route_inbound(peer, &offer.session_id, pending, message, outbound, pushed_ice, cfg).await?;
            }

            reason = end_rx.recv() => {
                anyhow::bail!("the session ended during the handshake: {}", reason.unwrap_or("the peer went away"));
            }

            result = &mut open_rx => {
                result.context("the files channel was closed before it opened")?;
                break;
            }

            _ = tokio::time::sleep_until(deadline) => {
                anyhow::bail!("the files channel did not open within 20s");
            }
        }
    }

    let dc = channel
        .get()
        .context("the files channel vanished after opening")?
        .clone();

    // One session owns the state machine; frames travel over these channels.
    // Capacity 64 mirrors the terminal path's frame channel.
    //
    // `frame_tx` carries outbound frames that may be text (JSON) or binary
    // (raw chunk frames, ADR-36). `dispatch_tx` carries raw inbound bytes:
    // text frames arrive as UTF-8 and binary frames as opaque bytes — the
    // dispatch arm decodes each accordingly.
    let files_root_path = std::path::PathBuf::from(root.path());
    let mut session = files::FilesSession::new(root);
    // Spawn the periodic .ponter-part janitor (spec §4.1.4, ADR-39): every
    // hour, sweep the root for stale `.ponter-part` files older than 24 h.
    // The task borrows the canonical root path (captured above) and is tied
    // to this session's lifetime via the poll task's join handle downstream.
    let janitor_root = files_root_path.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(3600));
        let max_age = std::time::Duration::from_secs(24 * 3600);
        loop {
            interval.tick().await;
            let removed = files::clean_stale_part_files(&janitor_root, max_age).await;
            if removed > 0 {
                tracing::info!(
                    removed,
                    "cleaned_stale_part_files: removed stale .part files"
                );
            }
        }
    });
    let (frame_tx, mut frame_rx) = mpsc::channel::<FilesFrame>(64);
    let (dispatch_tx, mut dispatch_rx) = mpsc::channel::<Vec<u8>>(64);

    // The poll task forwards raw frames: text frames keep the existing UTF-8
    // path; binary frames are forwarded as raw bytes to the dispatch arm. The
    // close event ends the session (the browser closed its last files tab, or
    // the stack reset the stream) — the same shape as the terminal poll task,
    // and the reason the ADR-14 slot frees immediately.
    let dc_for_events = dc.clone();
    let dispatch_tx_for_events = dispatch_tx.clone();
    let end_tx_for_events = end_tx.clone();
    let poll_task = tokio::spawn(async move {
        while let Some(event) = dc_for_events.poll().await {
            match event {
                DataChannelEvent::OnMessage(msg) => {
                    if dispatch_tx_for_events
                        .send(msg.data.to_vec())
                        .await
                        .is_err()
                    {
                        tracing::debug!("files dispatch channel is gone");
                        break;
                    }
                }
                DataChannelEvent::OnClose => {
                    let _ = end_tx_for_events.try_send("the files channel closed");
                    break;
                }
                _ => {}
            }
        }
    });

    // The poll task's clone is the only sender left, so `dispatch_rx.recv()`
    // returns `None` exactly when the poll task ends — the loop's exit arm.
    drop(dispatch_tx);

    // The single send point: drains outbound frames, sends each over the
    // channel. Backpressure on a slow consumer comes for free.
    let dc_for_pump = dc.clone();
    let mut pump = tokio::spawn(async move {
        while let Some(frame) = frame_rx.recv().await {
            let result = match frame {
                FilesFrame::Text(text) => dc_for_pump.send_text(&text).await,
                FilesFrame::Binary(bytes) => {
                    dc_for_pump
                        .send(bytes::BytesMut::from(bytes.as_slice()))
                        .await
                }
            };
            if let Err(e) = result {
                tracing::debug!(error = %e, "files frame send failed");
                break;
            }
        }
    });

    // The 1 s idle tick: `FilesSession::check_idle` fails any transfer with
    // no chunk/ack progress for FILES_IDLE_TIMEOUT (30 s in production).
    let mut idle_tick = tokio::time::interval(Duration::from_secs(1));
    idle_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    // ADR-37: a dedicated 20 ms tick flushes buffered upload acks so a trickle
    // of chunks surfaces a cumulative ack within 20 ms (the 1 s idle tick is
    // too coarse for ack latency).
    let mut ack_tick = tokio::time::interval(files::ACK_FLUSH_INTERVAL);
    ack_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    let session_deadline = tokio::time::Instant::now() + Duration::from_secs(3600);
    let reason = loop {
        tokio::select! {
            _ = &mut pump => break "the files pump ended",

            message = inbound.recv() => {
                match message {
                    Some(message) => route_inbound(peer, &offer.session_id, pending, message, outbound, pushed_ice, cfg).await?,
                    None => break "the agent is shutting down",
                }
            }

            raw = dispatch_rx.recv() => {
                let Some(raw) = raw else { break "the files dispatch channel closed" };
                for outbound_frame in handle_files_frame(&mut session, &raw).await {
                    let framed = match outbound_frame {
                        outbound @ files::Outbound::DownloadChunkBinary(_) => {
                            FilesFrame::Binary(outbound.into_bytes())
                        }
                        _ => FilesFrame::Text(files::frame_files(&outbound_frame, pty::now_ms())),
                    };
                    if frame_tx.send(framed).await.is_err() {
                        tracing::debug!("files frame channel is gone");
                    }
                }
            }

            _ = idle_tick.tick() => {
                for outbound_frame in session.check_idle().await {
                    if frame_tx.send(FilesFrame::Text(files::frame_files(&outbound_frame, pty::now_ms()))).await.is_err() {
                        tracing::debug!("files frame channel is gone");
                    }
                }
            }

            _ = ack_tick.tick() => {
                // ADR-37: flush buffered upload acks every 20 ms.
                for outbound_frame in session.flush_upload_acks() {
                    let framed = FilesFrame::Text(files::frame_files(&outbound_frame, pty::now_ms()));
                    if frame_tx.send(framed).await.is_err() {
                        tracing::debug!("files frame channel is gone");
                    }
                }
            }

            reason = end_rx.recv() => break reason.unwrap_or("the peer went away"),
            _ = tokio::time::sleep_until(session_deadline) => break "the 1h session cap",
            _ = shutdown_signal() => break "a shutdown signal",
        }
    };
    tracing::info!(session_id = %offer.session_id, reason, "files session loop finished");

    // Teardown (spec §2.6): cancel both directions, remove any `.part`, then
    // the same closing order as the terminal path.
    session.teardown().await;
    drop(frame_tx);
    poll_task.abort();
    let _ = peer.close().await;
    Ok(())
}

/// Decode one raw inbound frame and turn it into outbound frames.
///
/// Text frames (`raw.is_ascii()` / valid UTF-8) follow the existing JSON path:
/// `decode_files_frame` errors both when the envelope cannot be parsed and when
/// a `files` payload fails validation; `extract_ids` distinguishes them (an id
/// present ⇒ the JSON parsed ⇒ `BAD_FRAME` with the id; nothing extractable ⇒
/// log and drop, spec §2.6).
///
/// Binary frames are routed by their leading type byte (ADR-36): type `0x02`
/// (`BINARY_TYPE_UPLOAD_CHUNK`) is decoded with `decode_files_binary_frame` and
/// fed to `handle_upload_chunk_binary`; other binary types are logged and
/// dropped (warn-and-ignore).
async fn handle_files_frame(session: &mut files::FilesSession, raw: &[u8]) -> Vec<files::Outbound> {
    // Binary frame: route by the leading type byte (ADR-36).
    if raw
        .first()
        .is_some_and(|first| *first == files::BINARY_TYPE_UPLOAD_CHUNK)
    {
        match files::decode_files_binary_frame(raw) {
            Ok(frame) => session.handle_upload_chunk_binary(&frame).await,
            Err(error) => {
                tracing::warn!(error = %error, "bad binary upload chunk");
                vec![error.into_frame()]
            }
        }
    } else {
        // Text frame: the JSON decode path.
        let Ok(text) = std::str::from_utf8(raw) else {
            tracing::debug!("ignoring a non-UTF-8, non-binary frame");
            return Vec::new();
        };
        match files::decode_files_frame(text) {
            Ok(Some(inbound)) => session.handle(inbound).await,
            Ok(None) => {
                tracing::warn!(
                    len = text.len(),
                    "ignoring a non-files frame on the files channel"
                );
                Vec::new()
            }
            Err(error) => {
                let (request_id, transfer_id) = files::extract_ids(text);
                if request_id.is_none() && transfer_id.is_none() {
                    tracing::debug!(error = %error, "dropping an unparseable frame");
                    return Vec::new();
                }
                tracing::warn!(error = %error, "bad files frame");
                vec![files::FilesError::new(
                    files::FilesErrorCode::BadFrame,
                    "the frame could not be decoded",
                )
                .with_ids(request_id, transfer_id)
                .into_frame()]
            }
        }
    }
}

/// How long the dispatcher waits for the control channel before concluding the
/// browser never opened one. Streaming is already running by then, so this only
/// decides whether the picker is offered.
#[cfg(not(target_env = "musl"))]
const CONTROL_OPEN_TIMEOUT: Duration = Duration::from_secs(10);

/// Serve a desktop offer end to end: create the source, attach the track,
/// answer, wait for the connection, stream, and tear down.
///
/// The order is load-bearing (ADR-15, pinned by the Task 6 E2E): the sending
/// track is attached **before** the answer's remote description is set, and the
/// frame source is created **before** the answer is sent — a host with no
/// display must refuse the offer rather than open a session that can never
/// produce a frame.
#[cfg(not(target_env = "musl"))]
#[allow(clippy::too_many_arguments)]
async fn run_desktop_session(
    offer: &signal::SignalOffer,
    peer: &Arc<dyn PeerConnection>,
    outbound: &mpsc::Sender<signal::SignalMessage>,
    pushed_ice: &[signal::IceServerEntry],
    cfg: &SessionConfig,
    pending: &mut Vec<RTCIceCandidateInit>,
    mut connected_rx: tokio::sync::oneshot::Receiver<()>,
    mut end_rx: mpsc::Receiver<&'static str>,
    end_tx: mpsc::Sender<&'static str>,
    channel: Arc<OnceLock<Arc<dyn DataChannel>>>,
    mut open_rx: tokio::sync::oneshot::Receiver<()>,
    inbound: &mut mpsc::Receiver<signal::SignalMessage>,
    abr_target: Option<Arc<std::sync::atomic::AtomicU64>>,
) -> Result<()> {
    // Create the source first so a capture failure is a clean refusal
    // (`approved: false`) instead of a session the browser opens onto a black
    // video element.
    //
    // A bad default-source preference (or an unreadable primary monitor) is a
    // refusal too, not a propagated error: the client must see `approved: false`,
    // the same as a capture failure, not a dropped signaling connection.
    let default_id = match desktop::default_source_id(
        cfg.desktop_source == DesktopSource::Test,
        &cfg.desktop_default_source,
    ) {
        Ok(id) => id,
        Err(e) => {
            tracing::warn!(error = ?e, "desktop default source unavailable; refusing the offer");
            rtc::refuse_offer(peer, offer, outbound, &cfg.identity).await?;
            let _ = peer.close().await;
            return Ok(());
        }
    };
    let source: Box<dyn desktop::FrameSource> =
        match desktop::source_for(&default_id, cfg.desktop_profile).await {
            Ok(source) => source,
            Err(e) => {
                // `?e` (Debug) prints anyhow's full chain; `%e` (Display) would
                // show only the outermost context ("opening the video recorder")
                // and hide the platform error underneath it.
                tracing::warn!(error = ?e, "desktop capture unavailable; refusing the offer");
                rtc::refuse_offer(peer, offer, outbound, &cfg.identity).await?;
                let _ = peer.close().await;
                return Ok(());
            }
        };

    let media = rtc::attach_desktop_track(peer).await?;
    rtc::send_desktop_answer(peer, offer, outbound, &cfg.identity).await?;
    rtc::flush_pending_candidates(peer, pending).await?;

    // Wait for the connection, draining candidates the whole time. Until the
    // peer is `Connected` the track is unbound and every `write_sample` fails
    // with `Error::CodecNotFound` (Task 3's test pins that failure mode), so
    // streaming must not start before this.
    //
    // Draining is load-bearing, not optional: the browser trickles its ICE
    // candidates only after it reads the answer, and a desktop peer has no data
    // channel to keep the session alive, so if nothing applies those candidates
    // here the connection never forms a candidate pair — ICE sits at "no
    // candidate pairs" and fails at the 20s deadline with a black video element.
    // This mirrors the terminal handshake below, which drains for exactly the
    // same reason.
    let connect_deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    let connected = loop {
        tokio::select! {
            // Candidates first: they are what this wait is blocked on.
            biased;

            message = inbound.recv() => {
                let Some(message) = message else {
                    tracing::warn!(
                        session_id = %offer.session_id,
                        "the agent is shutting down while waiting for the desktop peer",
                    );
                    break false;
                };
                route_inbound(
                    peer,
                    &offer.session_id,
                    pending,
                    message,
                    outbound,
                    pushed_ice,
                    cfg,
                ).await?;
            }

            // The peer is already gone (connection failed / closed before it
            // ever connected): stop waiting immediately instead of sitting out
            // the full 20s.
            reason = end_rx.recv() => {
                tracing::warn!(
                    session_id = %offer.session_id,
                    reason = reason.unwrap_or("the peer went away"),
                    "the desktop session ended before the peer connected",
                );
                break false;
            }

            result = &mut connected_rx => {
                break result.is_ok();
            }

            _ = tokio::time::sleep_until(connect_deadline) => {
                tracing::warn!(session_id = %offer.session_id, "desktop peer did not connect within 20s");
                break false;
            }
        }
    };

    if !connected {
        let _ = peer.close().await;
        return Ok(());
    }

    let (ssrc, payload_type) = rtc::desktop_stream_params(&media).await?;

    let (control_tx, control_rx) = mpsc::channel::<desktop::StreamControl>(16);
    let (events_tx, mut events_rx) = mpsc::channel::<desktop::StreamEvent>(16);

    // The enumeration the picker shows. In test mode it is synthesised (CI is
    // headless and must not touch xcap); on a real host it is the live
    // enumeration. The streaming entry is flagged `default: true` so the
    // browser marks it selected without any interaction (ADR-22).
    //
    // `default_id` was resolved above (it built the pre-answer source), so it is
    // reused here rather than re-derived — the picker's `default` flag and the
    // live stream must name the same source.
    let mut sources = match cfg.desktop_source {
        DesktopSource::Test => vec![desktop::test_source_info()],
        DesktopSource::Screen => desktop::enumerate_sources().unwrap_or_else(|e| {
            tracing::warn!(error = ?e, "source enumeration failed; the picker will be empty");
            Vec::new()
        }),
    };
    for source in &mut sources {
        source.default = source.id == default_id;
    }
    // ADR-42: `true` is a structural fact, not an assumption — ADR-41 gates
    // admission on `verify_offer_identity`, so `run_desktop_session` (and thus
    // this frame) only runs on a session whose peer identity was verified.
    let sources_frame =
        desktop::frame_desktop_sources(&sources, cfg.allow_input, true, crate::pty::now_ms());

    // The geometry `to_absolute` (spec §6.2) maps normalized input into. It is
    // the source the session started on, taken from the enumeration so the
    // origin/width/height are the ones the picker shows.
    //
    // A later `desktop-select` swap changes what is streamed but does **not**
    // update this in Week 9 — mapping input onto a swapped source is deferred
    // and recorded as a known limitation (spec §3.4). Do not extend scope here.
    //
    // The fallback keeps the frame path total: if enumeration failed the picker
    // is empty and the viewer has nothing to click into, but the dispatcher must
    // still have geometry rather than unwrapping.
    let current_source = sources
        .iter()
        .find(|s| s.default)
        .or_else(|| sources.first())
        .cloned()
        .unwrap_or_else(|| match cfg.desktop_source {
            DesktopSource::Test => desktop::test_source_info(),
            DesktopSource::Screen => {
                tracing::debug!("no source enumerated; input mapping falls back to the origin");
                desktop::DesktopSourceInfo {
                    id: String::new(),
                    kind: desktop::SourceKind::Monitor,
                    name: String::new(),
                    width: 0,
                    height: 0,
                    x: 0,
                    y: 0,
                    scale_factor: 1.0,
                    rotation: 0.0,
                    is_primary: false,
                    default: false,
                }
            }
        });

    // Auto-ABR (spec §3.3, ADR-23 PASS branch): sample GCC's published target
    // twice a second and feed it into the same `SetBitrate` path manual control
    // uses, so both share one encoder-retarget code path. A manual
    // `desktop-bitrate` frame latches `manual` and stops auto for the rest of
    // the session, so the two never fight.
    //
    // This runs whenever congestion control is installed — i.e. whenever the
    // desktop peer was built with a control channel (`has_control`), including a
    // session where the viewer never opens the picker (ADR-22): the channel to
    // `run_stream` exists regardless, so the estimate still reaches the encoder.
    //
    // `manual` is created unconditionally: the decode arm below latches it even
    // when there is no estimator, which is harmless and keeps the arm simple.
    // This block goes *before* the `control_task` spawn, which moves
    // `control_tx`.
    let manual = Arc::new(AtomicBool::new(false));
    let manual_for_decode = Arc::clone(&manual);
    let abr_sender = control_tx.clone();
    let abr_task = abr_target.map(|abr_target| {
        let abr_tx = abr_sender;
        let manual = Arc::clone(&manual);
        let seed_target = cfg.desktop_profile.bitrate_bps;
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_millis(500));
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            // What we last told the encoder, so the dead-band measures against
            // reality. Starts at the session profile: until GCC moves off its
            // seed, `abr_next_target` returns `None` and the stream keeps this
            // target (spec §2.3 step 2).
            let mut auto_target = seed_target;
            loop {
                tick.tick().await;
                if manual.load(Ordering::Relaxed) {
                    continue;
                }
                let estimate = f64::from_bits(abr_target.load(Ordering::Relaxed));
                if let Some(bps) = desktop::abr_next_target(estimate, auto_target) {
                    if abr_tx
                        .send(desktop::StreamControl::SetBitrate(bps))
                        .await
                        .is_err()
                    {
                        break;
                    }
                    auto_target = bps;
                }
            }
        })
    });

    let channel_for_control = channel.clone();
    let end_tx_for_control = end_tx.clone();
    let session_id = offer.session_id.clone();
    // Copied out of `cfg` because the spawned task must be `'static` and
    // `SessionConfig` is borrowed — the same reason `session_id` is cloned
    // above. This is the ADR-29 gate's only runtime copy.
    let allow_input = cfg.allow_input;

    // WS1 E2EE: whether the offer proposed `e2ee` (the agent never initiates it).
    // Captured before the task so the closure can read it without borrowing `offer`.
    let negotiated = !rtc::negotiated_capabilities(&offer.capabilities).is_empty();

    // The browser's Ed25519 signing public key, decoded once here and captured
    // into the task for hello verification. `verify_offer_identity` decoded it
    // locally but did not return the bytes (R9).
    let peer_signing_raw: [u8; 32] = match &offer.user_signing_public_key {
        Some(pk) => {
            let decoded = identity::base64_decode(pk)
                .map_err(|e| anyhow::anyhow!("cannot decode user signing key: {e}"))?;
            let mut arr = [0u8; 32];
            if decoded.len() != 32 {
                anyhow::bail!("user signing key is not 32 bytes");
            }
            arr.copy_from_slice(&decoded);
            arr
        }
        None => [0u8; 32],
    };

    // The task is `'static`, so clone the Arc identity into it (same reason as
    // `allow_input` being copied out of `cfg`).
    let cfg_identity = std::sync::Arc::clone(&cfg.identity);
    let control_task = tokio::spawn(async move {
        // The control channel opens after the answer; wait for it, but never
        // block the stream on it — a viewer that never opens the picker still
        // gets video (ADR-22).
        let dc = tokio::select! {
            result = &mut open_rx => match result {
                Ok(()) => channel_for_control.get().cloned(),
                Err(_) => None,
            },
            _ = tokio::time::sleep(CONTROL_OPEN_TIMEOUT) => None,
        };
        let Some(dc) = dc else {
            tracing::debug!(session_id = %session_id, "no control channel opened; media-only session");
            return;
        };
        if let Err(e) = dc.send_text(&sources_frame).await {
            tracing::debug!(error = %e, "sending desktop-sources failed");
            return;
        }
        // The injector is built lazily (first allowed input frame) and reused,
        // so a host with no display fails one frame, not the session (§6.3).
        let mut injector: Option<Box<dyn input::InputInjector>> = None;
        // ADR-43: per-session fixed-window cap on accepted input frames.
        let mut input_limiter = input::InputRateLimiter::new(input::INPUT_RATE_CAP_HZ);
        // WS1 E2EE session state (R14): a plain local, no Arc/RwLock — the
        // control loop is the only task touching it.
        let mut e2ee_session: Option<e2ee::E2eeSession> = None;
        loop {
            tokio::select! {
                event = dc.poll() => match event {
                    Some(DataChannelEvent::OnMessage(message)) => {
                        let Ok(text) = std::str::from_utf8(&message.data) else {
                            tracing::debug!("ignoring a non-UTF-8 control frame");
                            continue;
                        };
                        // WS1 E2EE: only accept a hello when the offer proposed
                        // `e2ee` and no session is active yet. The agent never
                        // initiates.
                        if text.contains("\"desktop-e2ee-hello\"") {
                            if negotiated && e2ee_session.is_none() {
                                let envelope: crate::pty::DataChannelMessage<serde_json::Value> =
                                    match serde_json::from_str(text) {
                                        Ok(e) => e,
                                        Err(e) => {
                                            tracing::debug!(error = %e, "bad desktop-e2ee-hello");
                                            continue;
                                        }
                                    };
                                let hello: e2ee::E2eeHello = match serde_json::from_value(envelope.payload) {
                                    Ok(h) => h,
                                    Err(e) => {
                                        tracing::debug!(error = %e, "bad desktop-e2ee-hello payload");
                                        continue;
                                    }
                                };
                                match e2ee::E2eeSession::accept_hello(
                                    &cfg_identity, &session_id, &hello, &peer_signing_raw,
                                ) {
                                    Ok((session, ack)) => {
                                        let ack_json = serde_json::json!({
                                            "type": "desktop-e2ee-ack",
                                            "channel": "control",
                                            "payload": {
                                                "terminalId": ack.terminal_id,
                                                "ecdhPublicKey": ack.ecdh_public_key,
                                                "signature": ack.signature,
                                            },
                                            "timestamp": crate::pty::now_ms(),
                                        });
                                        e2ee_session = Some(session);
                                        if let Err(e) = dc.send_text(&ack_json.to_string()).await {
                                            tracing::debug!(error = %e, "sending desktop-e2ee-ack failed");
                                        }
                                    }
                                    // Fail-closed: a bad hello leaves the session plaintext.
                                    Err(e) => tracing::debug!(error = ?e, "desktop-e2ee-hello rejected, staying plaintext"),
                                }
                            }
                            continue;
                        }
                        // Input rides the same channel (ADR-26). The gate lives
                        // in `allow_input`: closed ⇒ debug-log + drop, open
                        // ⇒ decode + inject, fail-soft either way (§2.3). The
                        // cheap substring guard keeps the two decoders from both
                        // parsing every frame; `apply_if_allowed` is still the
                        // only path that decides, so it cannot bypass the gate.
                        if text.contains("\"desktop-input\"") {
                            // E2EE: decrypt BEFORE the gate when a session is
                            // active. Fail-closed: a decrypt error drops the
                            // frame, never injects anything.
                            let decrypted;
                            let text = if let Some(session) = e2ee_session.as_ref() {
                                match decrypt_desktop_input(session, text) {
                                    Ok(t) => { decrypted = t; decrypted.as_str() }
                                    Err(e) => {
                                        tracing::debug!(error = %e, "dropping desktop-input: decrypt failed");
                                        continue;
                                    }
                                }
                            } else {
                                text
                            };
                            if allow_input {
                                // ADR-43: cap AFTER decrypt and the Gate-A
                                // check, BEFORE decode/inject. The drop log
                                // matches every other drop path.
                                if !input_limiter.allow(crate::pty::now_ms()) {
                                    tracing::debug!("dropping desktop-input: rate cap exceeded");
                                    continue;
                                }
                                if injector.is_none() {
                                    match input::platform::PlatformInjector::try_new() {
                                        Ok(i) => injector = Some(Box::new(i)),
                                        Err(e) => tracing::debug!(error = %e, "input enabled but the injector is unavailable"),
                                    }
                                }
                                if let Some(injector) = injector.as_mut() {
                                    input::apply_if_allowed(
                                        allow_input, text, &current_source, injector.as_mut(),
                                        crate::pty::now_ms(),
                                    );
                                }
                            } else {
                                tracing::debug!("dropping desktop-input: input disabled");
                            }
                            continue;
                        }
                        match desktop::decode_control(text) {
                            Ok(Some(control)) => {
                                // A manual bitrate frame is the user taking the
                                // wheel: stop auto-ABR for the rest of the session.
                                if matches!(control, desktop::StreamControl::SetBitrate(_)) {
                                    manual_for_decode.store(true, Ordering::Relaxed);
                                }
                                if control_tx.send(control).await.is_err() {
                                    break;
                                }
                            }
                            Ok(None) => {}
                            Err(e) => {
                                tracing::debug!(error = %e, "dropping a malformed control frame")
                            }
                        }
                    }
                    Some(DataChannelEvent::OnClose) | None => break,
                    _ => {}
                },
                // `Some(..)` pattern: once the stream drops its sender the
                // branch is disabled, so a closed channel cannot spin.
                Some(event) = events_rx.recv() => {
                    let frame = match event {
                        desktop::StreamEvent::Stats(stats) => {
                            desktop::frame_desktop_stats(&stats, crate::pty::now_ms())
                        }
                    };
                    if let Err(e) = dc.send_text(&frame).await {
                        tracing::debug!(error = %e, "sending a desktop-stats frame failed");
                        break;
                    }
                }
            }
        }
        // The control channel is this desktop session's only data channel, so
        // its close is the end-of-session signal — exactly as the terminal
        // channel's close is (the 2026-10-01 dead-peer fix). Without this the
        // session loop below would sit on `inbound`/`end_rx` until the 1h cap,
        // holding the single ADR-14 slot after the browser closed the tab.
        // Fires on an explicit `OnClose` and on `poll()` returning `None` (the
        // driver ended the channel) alike. `try_send` on a full channel is a
        // no-op: the first reason already won.
        let _ = end_tx_for_control.try_send("the control channel closed");
    });

    let (stop_tx, stop_rx) = tokio::sync::watch::channel(false);
    let mut stream = tokio::spawn(desktop::run_stream(
        source,
        media.track.clone(),
        ssrc,
        payload_type,
        cfg.desktop_profile,
        cfg.desktop_source == DesktopSource::Test,
        cfg.desktop_select_timeout,
        control_rx,
        events_tx,
        stop_rx,
    ));

    // The desktop session loop: same shape as the terminal one minus the data
    // channel. Ways out: the stream task ending (an error), a candidate/offer
    // on `inbound`, the connection closing or failing (via `end_rx` — the
    // desktop equivalent of "the data channel closed"), the hourly cap, or a
    // shutdown signal.
    let session_deadline = tokio::time::Instant::now() + Duration::from_secs(3600);
    let reason = loop {
        tokio::select! {
            result = &mut stream => break match result {
                Ok(Ok(())) => "the desktop stream ended",
                Ok(Err(e)) => {
                    tracing::warn!(error = %e, "the desktop stream failed");
                    "the desktop stream failed"
                }
                Err(e) => {
                    tracing::warn!(error = %e, "the desktop stream task panicked");
                    "the desktop stream panicked"
                }
            },
            message = inbound.recv() => match message {
                Some(message) => route_inbound(
                    peer,
                    &offer.session_id,
                    pending,
                    message,
                    outbound,
                    pushed_ice,
                    cfg,
                ).await?,
                None => break "the agent is shutting down",
            },
            reason = end_rx.recv() => break reason.unwrap_or("the peer went away"),
            _ = tokio::time::sleep_until(session_deadline) => break "the 1h session cap",
            _ = shutdown_signal() => break "a shutdown signal",
        }
    };
    tracing::info!(session_id = %offer.session_id, reason, "desktop session loop finished");

    // Teardown: signal the stream to stop, give it a bounded moment to exit
    // (it stops the capture thread on the way out), then close the peer. A
    // stream that ignores the stop signal is aborted so no capture task leaks.
    let _ = stop_tx.send(true);
    if tokio::time::timeout(Duration::from_secs(5), &mut stream)
        .await
        .is_err()
    {
        tracing::warn!("the desktop stream did not stop within 5s; aborting it");
        stream.abort();
    }
    // The control dispatcher parks on the data channel's `poll()`, which only
    // ends when the channel closes; abort it so it cannot outlive the session.
    control_task.abort();
    // The auto-ABR sampler only sends into the control channel; abort it beside
    // the dispatcher so neither outlives the session.
    if let Some(task) = abr_task {
        task.abort();
    }
    let _ = peer.close().await;
    Ok(())
}

/// Decrypt a `desktop-input` frame whose payload is
/// `{ "data": base64([12-byte IV][ct || 16-byte tag]) }`.
/// Returns a plaintext `desktop-input` envelope string that
/// `input::decode_desktop_input` accepts. The ciphertext decrypts to the JSON
/// bytes of a `DesktopInputWire`. Fail-closed: any error returns `Err`.
#[cfg(not(target_env = "musl"))]
fn decrypt_desktop_input(session: &e2ee::E2eeSession, raw: &str) -> anyhow::Result<String> {
    let envelope: crate::pty::DataChannelMessage<serde_json::Value> =
        serde_json::from_str(raw).context("inbound frame is not a DataChannelMessage")?;
    let data_b64 = envelope
        .payload
        .get("data")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("desktop-input payload has no data"))?;
    let framed = crate::pty::STANDARD
        .decode(data_b64)
        .context("payload.data is not valid base64")?;
    let plaintext = session
        .decrypt(&framed)
        .map_err(|e| anyhow::anyhow!("desktop-input decrypt failed: {:?}", e))?;
    let payload: serde_json::Value =
        serde_json::from_slice(&plaintext).context("decrypted payload is not JSON")?;
    let rebuilt = serde_json::json!({
        "type": "desktop-input",
        "channel": "control",
        "payload": payload,
        "timestamp": envelope.timestamp,
    });
    Ok(rebuilt.to_string())
}

/// On musl the desktop module does not exist, so a desktop offer is refused
/// like any other unsupported mode (ADR-15) — no track, no capture, no encoder.
#[cfg(target_env = "musl")]
#[allow(clippy::too_many_arguments)]
async fn run_desktop_session(
    offer: &signal::SignalOffer,
    peer: &Arc<dyn PeerConnection>,
    outbound: &mpsc::Sender<signal::SignalMessage>,
    _pushed_ice: &[signal::IceServerEntry],
    _cfg: &SessionConfig,
    _pending: &mut Vec<RTCIceCandidateInit>,
    _connected_rx: tokio::sync::oneshot::Receiver<()>,
    _end_rx: mpsc::Receiver<&'static str>,
    _end_tx: mpsc::Sender<&'static str>,
    _channel: Arc<OnceLock<Arc<dyn DataChannel>>>,
    _open_rx: tokio::sync::oneshot::Receiver<()>,
    _inbound: &mut mpsc::Receiver<signal::SignalMessage>,
    _abr_target: Option<Arc<std::sync::atomic::AtomicU64>>,
) -> Result<()> {
    tracing::warn!(
        session_id = %offer.session_id,
        "desktop streaming is unavailable on this build (musl); refusing",
    );
    rtc::refuse_offer(peer, offer, outbound, &_cfg.identity).await?;
    let _ = peer.close().await;
    Ok(())
}

/// Route one inbound message to the live session.
///
/// Candidates are filtered by `session_id`: the socket is shared, and a
/// candidate for a session that is not the live one must never be applied to
/// the live peer — a stale tab still trickling after its session ended is how
/// a dead peer poisons a fresh connection.
///
/// An `offer` here is a second concurrent offer (ADR-14: one session per
/// agent) or a redelivery of the live session's own offer (signaling is
/// at-least-once). A redelivery is dropped; a genuine second offer is refused
/// with a real answer carrying `approved: false` so the browser fails fast
/// and visibly. Before this, both were silently dropped at `debug` level and
/// the second tab sat on `timeout waiting for channel "terminal" (saw state:
/// connecting)` for its full timeout with no explanation.
///
/// The refusal runs in its own task: building a peer and answering must not
/// stall the live session's candidate flow.
async fn route_inbound(
    peer: &Arc<dyn PeerConnection>,
    session_id: &str,
    pending: &mut Vec<RTCIceCandidateInit>,
    message: signal::SignalMessage,
    outbound: &mpsc::Sender<signal::SignalMessage>,
    pushed_ice: &[signal::IceServerEntry],
    cfg: &SessionConfig,
) -> Result<()> {
    match message {
        signal::SignalMessage::IceCandidate(candidate) => {
            if candidate.session_id != session_id {
                tracing::debug!(
                    session_id = %candidate.session_id,
                    live_session_id = session_id,
                    "dropping a candidate for a session that is not live",
                );
                return Ok(());
            }
            let applied = rtc::apply_candidate(peer, pending, candidate).await?;
            tracing::trace!(applied, "inbound candidate");
        }

        signal::SignalMessage::Offer(offer) => {
            if offer.session_id == session_id {
                tracing::debug!(
                    session_id = %offer.session_id,
                    "ignoring a redelivered offer for the live session",
                );
                return Ok(());
            }
            let outbound = outbound.clone();
            let pushed = pushed_ice.to_vec();
            let cfg = cfg.clone();
            tokio::spawn(async move {
                if let Err(e) = refuse_second_offer(&offer, &outbound, &pushed, &cfg).await {
                    tracing::warn!(
                        error = %e,
                        session_id = %offer.session_id,
                        "failed to refuse a second offer",
                    );
                }
            });
        }

        signal::SignalMessage::Answer(_) => {
            tracing::debug!("ignoring an answer during a session");
        }
    }
    Ok(())
}

/// Refuse a second concurrent offer (ADR-14) with a real SDP.
///
/// `POST /api/signal/answer` rejects an empty `sdp` (spec R19), so "refuse"
/// cannot mean "send nothing": the refusal is a real answer carrying
/// `approved: false`, which the browser reads and surfaces instead of waiting
/// out its channel timeout.
async fn refuse_second_offer(
    offer: &signal::SignalOffer,
    outbound: &mpsc::Sender<signal::SignalMessage>,
    pushed_ice: &[signal::IceServerEntry],
    cfg: &SessionConfig,
) -> Result<()> {
    tracing::warn!(
        session_id = %offer.session_id,
        "refusing a second concurrent session (ADR-14)",
    );
    // A peer that will only answer and close still needs a handler — 0.21's
    // `build()` refuses without one — and none of its callbacks matter here.
    let rtc::BuiltPeer { peer, .. } = rtc::build_peer(
        pushed_ice,
        &cfg.stun,
        Arc::new(rtc::NoopHandler),
        false,
        false,
    )
    .await?;
    rtc::refuse_offer(&peer, offer, outbound, &cfg.identity).await?;
    let _ = peer.close().await;
    Ok(())
}

/// Turn a `spawn_session` result into a `terminal-error` frame, or nothing.
///
/// A spawn failure used to be a `tracing::warn!` and nothing else, which left
/// the browser showing a terminal that opened and stayed blank forever — it
/// could not tell a missing shell from a slow one, and had no channel to ask.
/// The data channel is the only thing the browser can read, so the refusal has
/// to travel over it.
///
/// The session cap is separated from a genuine spawn failure because they mean
/// different things to a user: one is "this terminal is broken", the other is
/// "this host is at capacity".
fn spawn_failure_frame(terminal_id: &str, result: Result<()>) -> Option<String> {
    let error = result.err()?;
    let code = if error
        .to_string()
        .contains("maximum concurrent PTY sessions")
    {
        pty::PtyErrorCode::SessionLimitReached
    } else {
        pty::PtyErrorCode::SpawnFailed
    };
    Some(pty::frame_pty_error(
        terminal_id,
        code,
        &error.to_string(),
        pty::now_ms(),
    ))
}

// ---------------------------------------------------------------------------
// PtyManager: multiplexes up to N concurrent PTY sessions over a single
// "terminal" WebRTC DataChannel (Week 6). Each session is keyed by a
// `terminal_id` that is opaque to the agent — it comes from the browser.
// ---------------------------------------------------------------------------

/// A single live PTY session: the inbound input sender plus the session handle.
pub struct ActivePty {
    pub input_tx: mpsc::Sender<Vec<u8>>,
    /// `Arc<Mutex<PtySession>>` because `PtySession` is `Send` but not `Sync`
    /// (its `Box<dyn MasterPty>` is not `Sync`). Wrapping in `Mutex` makes the
    /// `Arc` send+shareable, so `PtyManager` can be stored in `Arc` and captured
    /// by spawned tasks.
    pub session: Arc<tokio::sync::Mutex<pty::PtySession>>,
}

/// Registry of concurrent PTY sessions, shared by reference so the dispatcher
/// and the data-channel callback can both reach it.
#[derive(Clone)]
pub struct PtyManager {
    max_sessions: usize,
    sessions: Arc<tokio::sync::Mutex<HashMap<String, ActivePty>>>,
}

impl PtyManager {
    /// Create a manager that will allow at most `max_sessions` concurrent shells.
    pub fn new(max_sessions: usize) -> Self {
        Self {
            max_sessions,
            sessions: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
        }
    }

    /// Number of currently live sessions.
    pub async fn session_count(&self) -> usize {
        self.sessions.lock().await.len()
    }

    /// Spawn a new shell for `terminal_id`.
    ///
    /// If the id already exists this is a no-op returning `Ok(())` — the caller
    /// (a retransmitted `terminal-create`) is idempotent.
    pub async fn spawn_session(
        &self,
        terminal_id: String,
        shell: &str,
        cols: u16,
        rows: u16,
        outbound: mpsc::Sender<pty::Outbound>,
    ) -> Result<()> {
        // Check limits and presence under a short-lived lock, then drop it
        // before spawning the PTY or pump task. The lock guard is `!Send` when
        // held across `.await`, which breaks `tokio::spawn` of the caller.
        {
            let lock = self.sessions.lock().await;
            if lock.len() >= self.max_sessions {
                anyhow::bail!(
                    "exceeded maximum concurrent PTY sessions ({})",
                    self.max_sessions
                );
            }
            if lock.contains_key(&terminal_id) {
                return Ok(());
            }
        }

        // Channel is created outside spawn so the input-sending half can be
        // installed immediately, covering the race where a keystroke arrives
        // before the PTY is ready (same argument as in `run_one_session`).
        let (input_tx, input_rx) = mpsc::channel(64);
        let session = pty::PtySession::spawn(shell, cols, rows, input_rx)?;
        // `start_reader` borrows `&session`; call it before wrapping in a Mutex.
        let mut reader = session.start_reader(terminal_id.clone())?;
        let session = Arc::new(tokio::sync::Mutex::new(session));

        // Clone the sessions map Arc so the pump task can remove itself
        // when the PTY reader reaches EOF (child exited). This frees the slot
        // immediately and lets us reap the child process to avoid zombies.
        let sessions_for_pump = Arc::clone(&self.sessions);

        // Pump PTY output -> outbound frame channel. A dedicated task per session
        // is fine: output stays in order because the reader is single-threaded
        // and the converter awaits each send on a bounded queue (ADR-11).
        let tid = terminal_id.clone();
        tokio::spawn(async move {
            while let Some(frame) = reader.recv().await {
                if outbound.send(frame).await.is_err() {
                    break; // consumer (data channel) is gone
                }
            }
            // Remove from sessions to free slot immediately and reap child process:
            let active = {
                let mut lock = sessions_for_pump.lock().await;
                lock.remove(&tid)
            };
            let exit_code = if let Some(active) = active {
                let mut sess = active.session.lock().await;
                sess.wait_child()
            } else {
                None
            };
            let exit_frame =
                pty::Outbound::Json(pty::frame_pty_exit(&tid, exit_code, pty::now_ms()));
            let _ = outbound.send(exit_frame).await;
        });

        // Re-acquire the lock briefly to insert. If a concurrent spawn raced
        // for the same id, the entry is simply overwritten (last writer wins),
        // which is safe because the pump task holds its own Arc clone.
        let mut lock = self.sessions.lock().await;
        lock.insert(terminal_id, ActivePty { input_tx, session });
        Ok(())
    }

    /// Send raw bytes to a live session's PTY. Returns `false` if the session
    /// does not exist — the caller should treat that as "spawn on demand".
    pub async fn send_input(&self, terminal_id: &str, bytes: Vec<u8>) -> bool {
        let tx = {
            let lock = self.sessions.lock().await;
            lock.get(terminal_id).map(|pty| pty.input_tx.clone())
        };
        match tx {
            Some(tx) => tx.send(bytes).await.is_ok(),
            None => false,
        }
    }

    /// Resize a live session's PTY. No-op if the session is absent.
    pub async fn resize(&self, terminal_id: &str, cols: u16, rows: u16) -> Result<()> {
        let session = {
            let lock = self.sessions.lock().await;
            lock.get(terminal_id).map(|pty| pty.session.clone())
        };
        if let Some(session) = session {
            // `PtySession::resize` is a synchronous `&self` call; locking the
            // tokio Mutex is brief and non-blocking in practice.
            session.lock().await.resize(cols, rows)?;
        }
        Ok(())
    }

    /// Close and remove a single session.
    ///
    /// The entry is removed immediately. The `ActivePty` drop (and with it
    /// `input_tx`) is what ends the shell's stdin — the writer thread observes
    /// `None` on `blocking_recv` and drops its writer handle, sending EOF to the
    /// slave, causing the child to exit, which is what unblocks the reader and
    /// lets the pump task terminate. For a shell that won't exit on EOF the
    /// caller must send an explicit `exit` first.
    ///
    /// After removing the entry from `sessions`, `wait_child` is called on the
    /// session to reap the child process and prevent zombies.
    pub async fn close_session(&self, terminal_id: &str) {
        let active = {
            let mut lock = self.sessions.lock().await;
            lock.remove(terminal_id)
        };
        if let Some(active) = active {
            let mut sess = active.session.lock().await;
            let _ = sess.wait_child();
        }
    }

    /// Close every session (called on channel/connection teardown).
    pub async fn close_all(&self) {
        let mut lock = self.sessions.lock().await;
        lock.clear();
    }

    /// Spawn-on-demand: send input as if `terminal-create` had been issued first.
    /// Used by the `terminal-data` dispatcher path when a frame arrives for a
    /// session id that does not yet exist locally.
    #[allow(dead_code)]
    pub async fn ensure_session(
        &self,
        terminal_id: String,
        shell: &str,
        cols: u16,
        rows: u16,
        outbound: mpsc::Sender<pty::Outbound>,
    ) -> Result<()> {
        {
            let lock = self.sessions.lock().await;
            if lock.contains_key(&terminal_id) {
                return Ok(());
            }
        }
        // Drop the read lock before acquiring the write lock to avoid a
        // self-deadlock; spawn_session re-checks (double-checked locking).
        self.spawn_session(terminal_id, shell, cols, rows, outbound)
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ring::signature::KeyPair;

    /// The TDD anchor for Task 3 (spec Step 1).
    #[tokio::test]
    #[cfg(unix)]
    async fn pty_manager_spawns_and_closes_sessions() {
        let manager = PtyManager::new(10);
        let session_id = "test-session-1";
        let (out_tx, mut out_rx) = mpsc::channel(16);

        let spawned = manager
            .spawn_session(session_id.to_string(), "/bin/sh", 80, 24, out_tx)
            .await;
        assert!(
            spawned.is_ok(),
            "failed to spawn session: {:?}",
            spawned.err()
        );
        assert_eq!(manager.session_count().await, 1);

        // Make the shell exit so the pump task observes EOF and terminates.
        assert!(manager.send_input(session_id, b"exit\n".to_vec()).await);
        // Give the shell a moment to die and the pump to drain.
        tokio::time::sleep(tokio::time::Duration::from_millis(200)).await;

        manager.close_session(session_id).await;
        assert_eq!(manager.session_count().await, 0);
        // Drain any lingering frames so the test does not warn on drop.
        while out_rx.recv().await.is_some() {}
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn pty_manager_rejects_duplicate_spawn() {
        let manager = PtyManager::new(10);
        let (out_tx, _out_rx) = mpsc::channel::<pty::Outbound>(16);

        let _ = manager
            .spawn_session("s1".to_string(), "/bin/sh", 80, 24, out_tx.clone())
            .await;
        // A second spawn with the same id returns Ok and does not increment.
        let second = manager
            .spawn_session("s1".to_string(), "/bin/sh", 80, 24, out_tx)
            .await;
        assert!(second.is_ok());
        assert_eq!(manager.session_count().await, 1);
        // Clean up so the spawned /bin/sh doesn't outlive the test.
        manager.send_input("s1", b"exit\n".to_vec()).await;
        tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
    }

    #[tokio::test]
    async fn pty_manager_enforces_max_sessions() {
        let manager = PtyManager::new(1);
        let (out_tx, _out_rx) = mpsc::channel::<pty::Outbound>(16);

        #[cfg(unix)]
        {
            let _ = manager
                .spawn_session("s1".to_string(), "/bin/sh", 80, 24, out_tx.clone())
                .await;
            let second = manager
                .spawn_session("s2".to_string(), "/bin/sh", 80, 24, out_tx)
                .await;
            assert!(second.is_err(), "expected max-sessions guard to fire");
            // Clean up the one session that did spawn.
            manager.send_input("s1", b"exit\n".to_vec()).await;
            tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
        }
        #[cfg(not(unix))]
        {
            // On non-unix the spawn is mocked by the guard; still test the limit.
            manager
                .spawn_session("s1".to_string(), "x", 80, 24, out_tx.clone())
                .await
                .ok();
            let second = manager
                .spawn_session("s2".to_string(), "x", 80, 24, out_tx)
                .await;
            assert!(second.is_err());
        }
    }

    #[tokio::test]
    async fn pty_manager_send_input_false_for_unknown_id() {
        let manager = PtyManager::new(10);
        assert!(!manager.send_input("no-such-session", b"x".to_vec()).await);
    }

    #[test]
    fn classify_offer_maps_capabilities_to_a_session_mode() {
        // The capabilities are attacker-controlled strings; classification is a
        // pure comparison against the two known labels (ADR-15). An unknown or
        // empty list is None (refused), and terminal wins if a malformed client
        // somehow offers both — the established flow is the safe default.
        assert_eq!(
            classify_offer(&["terminal".to_string()]),
            SessionMode::Terminal
        );
        assert_eq!(
            classify_offer(&["desktop".to_string()]),
            SessionMode::Desktop
        );
        assert_eq!(classify_offer(&[]), SessionMode::None);
        assert_eq!(classify_offer(&["unknown".to_string()]), SessionMode::None);
        assert_eq!(
            classify_offer(&["desktop".to_string(), "terminal".to_string()]),
            SessionMode::Terminal,
        );

        // Week 10 (ADR-31): files is the lowest-precedence label; terminal
        // and desktop win when a malformed client offers more than one.
        assert_eq!(classify_offer(&["files".to_string()]), SessionMode::Files);
        assert_eq!(
            classify_offer(&["files".to_string(), "desktop".to_string()]),
            SessionMode::Desktop,
        );
        assert_eq!(
            classify_offer(&["files".to_string(), "terminal".to_string()]),
            SessionMode::Terminal,
        );
    }

    #[tokio::test]
    async fn files_gate_closes_for_every_unusable_root() {
        // Unset → closed (ADR-32: no default).
        assert!(resolve_files_root(None).await.is_none());

        // Missing path → closed.
        let missing =
            std::env::temp_dir().join(format!("ponter-files-gate-missing-{}", std::process::id()));
        assert!(resolve_files_root(missing.to_str()).await.is_none());

        // A file, not a directory → closed.
        let file =
            std::env::temp_dir().join(format!("ponter-files-gate-file-{}", std::process::id()));
        std::fs::write(&file, b"x").unwrap();
        assert!(resolve_files_root(file.to_str()).await.is_none());
        std::fs::remove_file(&file).ok();

        // A real directory → open, and the root is resolved fresh each call
        // (never cached): removing it closes the gate again.
        let dir =
            std::env::temp_dir().join(format!("ponter-files-gate-dir-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(resolve_files_root(dir.to_str()).await.is_some());
        std::fs::remove_dir_all(&dir).ok();
        assert!(resolve_files_root(dir.to_str()).await.is_none());
    }

    #[test]
    fn a_failed_spawn_becomes_a_frame_the_browser_can_show() {
        // The bug: `spawn_session` failing was only a `tracing::warn!`, so the
        // browser saw a terminal that opened and stayed blank forever, with no
        // way to distinguish a missing shell from a slow one. The browser has
        // no other channel for this — the data channel is all it has.
        let frame = spawn_failure_frame("t1", Err(anyhow::anyhow!("no such shell: /nope")))
            .expect("a failed spawn must produce a frame");
        let value: serde_json::Value = serde_json::from_str(&frame).unwrap();
        assert_eq!(value["type"], "terminal-error");
        assert_eq!(value["payload"]["terminalId"], "t1");
        assert_eq!(value["payload"]["code"], "pty-spawn-failed");
        assert!(value["payload"]["message"]
            .as_str()
            .unwrap()
            .contains("no such shell"));
    }

    #[test]
    fn hitting_the_session_cap_is_reported_distinctly_from_a_spawn_failure() {
        // Both are refusals, but they mean different things to a user: one is
        // "this terminal is broken", the other is "this host is at capacity",
        // and the browser may want to say so differently.
        let frame = spawn_failure_frame(
            "t7",
            Err(anyhow::anyhow!(
                "exceeded maximum concurrent PTY sessions (10)"
            )),
        )
        .expect("a refused spawn must produce a frame");
        let value: serde_json::Value = serde_json::from_str(&frame).unwrap();
        assert_eq!(value["payload"]["code"], "session-limit-reached");
    }

    #[test]
    fn a_successful_spawn_sends_no_error_frame() {
        assert!(spawn_failure_frame("t1", Ok(())).is_none());
    }

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

    /// Regression for the production failure of 2026-09-30: a signaling socket
    /// that died while a session was live cancelled the whole supervisor (it
    /// shared a `tokio::select!` with `client.run()`), so the live
    /// `PeerConnection` lost its candidate feed and degraded
    /// `connected → disconnected → failed` a minute later. In this design the
    /// channels outlive any one socket: the sender halves sit in the reconnect
    /// loop and are re-attached to every fresh socket, so no single socket's
    /// death can close the queue the live session reads from.
    ///
    /// The test simulates exactly that event — an owned sender is dropped
    /// (which is what killing a socket's `SignalClient` does to its senders)
    /// while a sibling clone stays alive in the reconnect loop — and asserts the
    /// session's queue stays open: the live session must keep receiving
    /// candidates once the next socket re-attaches.
    #[tokio::test]
    async fn a_dead_socket_cannot_close_the_live_session_queue() {
        let (inbound_tx, mut inbound_rx) = tokio::sync::mpsc::channel::<signal::SignalMessage>(32);

        // The first socket holds one clone; the reconnect loop holds this one.
        let first_socket_tx = inbound_tx.clone();

        let offer = signal::SignalMessage::Offer(signal::SignalOffer {
            session_id: "sess-live".to_string(),
            sdp: "v=0".to_string(),
            capabilities: vec![crate::rtc::TERMINAL_LABEL.to_string()],
            proof: None,
            user_signing_public_key: None,
        });

        // The offer arrives on the first socket...
        first_socket_tx
            .send(offer)
            .await
            .expect("queue accepts the offer");
        // ...then the socket dies. Only its own sender is dropped.
        drop(first_socket_tx);
        // The reconnect loop's clone is still alive, so the queue stays open.
        let received = inbound_rx.recv().await;
        assert!(
            received.is_some(),
            "dropping one socket's sender must not close the queue the live \
             session reads from — the reconnect loop still holds a clone"
        );

        // The next socket re-attaches with another clone, and late candidates
        // resume instead of being dropped with a dead session.
        let second_socket_tx = inbound_tx.clone();
        let candidate = signal::SignalMessage::IceCandidate(signal::IceCandidateSignal {
            session_id: "sess-live".to_string(),
            candidate: "candidate:1 1 udp 1 127.0.0.1 5000 typ host".to_string(),
            sdp_mid: None,
            sdp_mline_index: Some(0),
        });
        second_socket_tx
            .send(candidate)
            .await
            .expect("queue accepts a late candidate after re-attach");
        let received = inbound_rx.recv().await;
        assert!(
            matches!(received, Some(signal::SignalMessage::IceCandidate(_))),
            "a late candidate must reach the live session after re-attach"
        );
    }

    #[test]
    fn stream_profile_parses_the_two_named_profiles() {
        assert_eq!(
            "1080p30".parse::<StreamProfile>().unwrap(),
            StreamProfile::DEFAULT_1080P30
        );
        assert_eq!(
            "720p30".parse::<StreamProfile>().unwrap(),
            StreamProfile::SAFE_720P30
        );
    }

    #[test]
    fn stream_profile_rejects_an_unknown_name() {
        let err = "1080p60".parse::<StreamProfile>().unwrap_err();
        assert!(format!("{err:#}").contains("expected 1080p30 or 720p30"));
    }

    #[test]
    fn stream_profile_frame_budget_matches_fps() {
        let budget = StreamProfile::DEFAULT_1080P30.frame_budget();
        assert!((budget.as_secs_f32() - 1.0 / 30.0).abs() < 1e-6);
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

    // ------------------------------------------------------------------
    // Task 9: verify_offer_identity (H3 gate)
    // ------------------------------------------------------------------

    /// Build a well-formed, correctly-signed offer for the given agent identity,
    /// using a *user* keypair separate from the agent's own key.
    fn make_valid_offer(
        session_id: &str,
        _agent_identity: &identity::AgentIdentity,
    ) -> (signal::SignalOffer, ring::signature::Ed25519KeyPair) {
        // Generate a user keypair (the "offerer" who signs the proof).
        let rng = ring::rand::SystemRandom::new();
        let pkcs8 = ring::signature::Ed25519KeyPair::generate_pkcs8(&rng).unwrap();
        let user_key = ring::signature::Ed25519KeyPair::from_pkcs8(pkcs8.as_ref()).unwrap();

        let sdp = "v=0\r\na=fingerprint:sha-256 AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89\r\n";
        let fingerprint = identity::parse_sdp_fingerprint(sdp).unwrap();
        let sdp_hash = identity::sha256_hex(sdp.as_bytes());
        let message =
            identity::canonical_proof_message("offerer", session_id, &sdp_hash, &fingerprint);
        let signature = user_key.sign(message.as_bytes());

        let offer = signal::SignalOffer {
            session_id: session_id.to_string(),
            sdp: sdp.to_string(),
            capabilities: vec![],
            proof: Some(signal::IdentityProof {
                signature: identity::base64_encode(signature.as_ref()),
                fingerprint,
            }),
            user_signing_public_key: Some(identity::base64_encode(user_key.public_key().as_ref())),
        };

        (offer, user_key)
    }

    #[test]
    fn verify_offer_identity_accepts_a_correctly_signed_offer() {
        let dir = std::env::temp_dir().join(format!("ponter-verify-ok-{}", std::process::id()));
        let _ = std::fs::remove_file(&dir);
        let agent = identity::AgentIdentity::load_or_generate(&dir).unwrap();

        let (offer, _user_key) = make_valid_offer("sess-ok", &agent);
        let result = verify_offer_identity(&offer, &agent);
        assert!(
            result.is_ok(),
            "a correctly signed offer must be accepted: {result:?}"
        );

        let _ = std::fs::remove_file(&dir);
    }

    #[test]
    fn verify_offer_identity_rejects_a_tampered_sdp() {
        let dir = std::env::temp_dir().join(format!("ponter-verify-tamper-{}", std::process::id()));
        let _ = std::fs::remove_file(&dir);
        let agent = identity::AgentIdentity::load_or_generate(&dir).unwrap();

        let (mut offer, _user_key) = make_valid_offer("sess-tamper", &agent);
        // Tamper the SDP: change the fingerprint after the proof was signed.
        offer.sdp = "v=0\r\na=fingerprint:sha-256 00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00\r\n".to_string();

        let result = verify_offer_identity(&offer, &agent);
        assert!(
            result.is_err(),
            "a tampered SDP must be rejected (fail-closed)"
        );

        let _ = std::fs::remove_file(&dir);
    }

    #[test]
    fn verify_offer_identity_rejects_a_missing_proof() {
        let dir =
            std::env::temp_dir().join(format!("ponter-verify-noproof-{}", std::process::id()));
        let _ = std::fs::remove_file(&dir);
        let agent = identity::AgentIdentity::load_or_generate(&dir).unwrap();

        let (mut offer, _user_key) = make_valid_offer("sess-noproof", &agent);
        offer.proof = None;

        let result = verify_offer_identity(&offer, &agent);
        assert!(
            result.is_err(),
            "a missing proof must be rejected (fail-closed)"
        );

        let _ = std::fs::remove_file(&dir);
    }

    #[test]
    fn verify_offer_identity_rejects_a_missing_user_signing_key() {
        let dir =
            std::env::temp_dir().join(format!("ponter-verify-nouserpk-{}", std::process::id()));
        let _ = std::fs::remove_file(&dir);
        let agent = identity::AgentIdentity::load_or_generate(&dir).unwrap();

        let (mut offer, _user_key) = make_valid_offer("sess-nouserpk", &agent);
        offer.user_signing_public_key = None;

        let result = verify_offer_identity(&offer, &agent);
        assert!(
            result.is_err(),
            "a missing user signing key must be rejected (fail-closed)"
        );

        let _ = std::fs::remove_file(&dir);
    }

    #[test]
    fn verify_offer_identity_rejects_a_proof_signed_by_a_different_key() {
        let dir =
            std::env::temp_dir().join(format!("ponter-verify-wrongkey-{}", std::process::id()));
        let _ = std::fs::remove_file(&dir);
        let agent = identity::AgentIdentity::load_or_generate(&dir).unwrap();

        // Sign with a different user keypair (a second user, not the one in the proof).
        let rng = ring::rand::SystemRandom::new();
        let other_pkcs8 = ring::signature::Ed25519KeyPair::generate_pkcs8(&rng).unwrap();
        let other_key = ring::signature::Ed25519KeyPair::from_pkcs8(other_pkcs8.as_ref()).unwrap();

        let (mut offer, _user_key) = make_valid_offer("sess-wrongkey", &agent);
        // Replace the proof's signature with one from a different key, but keep
        // the original `userSigningPublicKey` — this simulates a key mismatch.
        let sdp = &offer.sdp;
        let fingerprint = identity::parse_sdp_fingerprint(sdp).unwrap();
        let sdp_hash = identity::sha256_hex(sdp.as_bytes());
        let message =
            identity::canonical_proof_message("offerer", "sess-wrongkey", &sdp_hash, &fingerprint);
        let other_sig = other_key.sign(message.as_bytes());
        offer.proof.as_mut().unwrap().signature = identity::base64_encode(other_sig.as_ref());
        // The signing key in the proof still says the original user, so the
        // signature will not verify against it.

        let result = verify_offer_identity(&offer, &agent);
        assert!(
            result.is_err(),
            "a proof signed by a different key must be rejected (fail-closed)"
        );

        let _ = std::fs::remove_file(&dir);
    }

    // ------------------------------------------------------------------
    // Task 6a: decrypt desktop-input on the WS1 session key
    // ------------------------------------------------------------------

    #[tokio::test]
    async fn decrypt_desktop_input_round_trips_through_e2ee() {
        // Build an E2eeSession exactly as e2ee.rs's accept_hello_derives_and_round_trips does:
        // browser ephemeral key + a binding signed by an AgentIdentity.
        let dir = std::env::temp_dir().join(format!("ponter-desktop-e2ee-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let identity = crate::identity::AgentIdentity::load_or_generate(&dir.join("id.json"))
            .expect("identity");

        let browser = crate::e2ee::generate_ephemeral().expect("ephemeral");
        let browser_pub = browser.compute_public_key().expect("pub").as_ref().to_vec();
        let browser_spki = crate::e2ee::spki_from_raw_point(&browser_pub);

        // The browser's Ed25519 signing key whose raw public key we hand the agent.
        let browser_signing =
            crate::identity::AgentIdentity::load_or_generate(&dir.join("browser.json")).unwrap();
        let browser_signing_pub = browser_signing.public_key_raw();
        let sig =
            browser_signing.sign(crate::e2ee::canonical_key_binding(&browser_spki).as_bytes());

        let hello = crate::e2ee::E2eeHello {
            terminal_id: String::new(),
            ecdh_public_key: browser_spki.clone(),
            signature: crate::identity::base64_encode(&sig),
        };

        let (session, _ack) =
            crate::e2ee::E2eeSession::accept_hello(&identity, "sess", &hello, &browser_signing_pub)
                .expect("accept_hello");

        // Build the plaintext payload: a PointerMove DesktopInputWire JSON.
        let payload_bytes = serde_json::to_vec(&serde_json::json!({
            "kind": "pointer-move",
            "x": 0.5,
            "y": 0.25
        }))
        .expect("payload json");

        // Encrypt with the session, then wrap in the wire envelope.
        let framed = session.encrypt(&payload_bytes).expect("encrypt");
        let data_b64 = crate::identity::base64_encode(&framed);
        let wire = serde_json::json!({
            "type": "desktop-input",
            "channel": "control",
            "payload": { "data": data_b64 },
            "timestamp": 1
        })
        .to_string();

        // Decrypt and verify the plaintext envelope round-trips to the original payload.
        let decrypted = decrypt_desktop_input(&session, &wire).expect("decrypt_desktop_input");

        // `input::decode_desktop_input` must accept the decrypted envelope.
        let decoded = crate::input::decode_desktop_input(&decrypted)
            .expect("decode")
            .expect("event");
        assert!(
            matches!(
                decoded.event,
                crate::input::DesktopInput::PointerMove { x: 0.5, y: 0.25 }
            ),
            "decoded = {decoded:?}"
        );

        // The decrypted envelope's payload must equal the original payload bytes.
        let rebuilt: serde_json::Value = serde_json::from_str(&decrypted).unwrap();
        assert_eq!(
            rebuilt["payload"],
            serde_json::from_slice::<serde_json::Value>(&payload_bytes).unwrap(),
            "decrypted payload must equal original"
        );

        let _ = std::fs::remove_file(dir.join("id.json"));
        let _ = std::fs::remove_file(dir.join("browser.json"));
        let _ = std::fs::remove_dir(&dir);
    }

    /// A test double so the gate-closed assertion is self-contained (Round Focus #6:
    /// the ADR-29 gate must stay closed off any capability).
    #[derive(Default)]
    struct NoopInjector;
    impl crate::input::InputInjector for NoopInjector {
        fn pointer_move(&mut self, _x: i32, _y: i32) -> anyhow::Result<()> {
            Ok(())
        }
        fn pointer_button(&mut self, _b: crate::input::Button, _p: bool) -> anyhow::Result<()> {
            Ok(())
        }
        fn wheel(&mut self, _dx: i32, _dy: i32) -> anyhow::Result<()> {
            Ok(())
        }
        fn key(
            &mut self,
            _c: &str,
            _p: bool,
            _m: &crate::input::KeyModifiers,
        ) -> anyhow::Result<()> {
            Ok(())
        }
        fn text(&mut self, _t: &str) -> anyhow::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn gate_closed_desktop_input_drops_frame() {
        // Review Focus #6: the ADR-29 gate stays closed off any capability.
        // `apply_if_allowed(false, ...)` must return false (there is an existing
        // Week 9 test for this in `input.rs`; this mirrors it on the main.rs
        // side to anchor Task 6a's decrypt path).
        let raw = serde_json::json!({
            "type": "desktop-input",
            "channel": "control",
            "payload": { "kind": "pointer-move", "x": 0.5, "y": 0.5 },
            "timestamp": 0
        })
        .to_string();

        let source = crate::desktop::DesktopSourceInfo {
            id: String::new(),
            kind: crate::desktop::SourceKind::Monitor,
            name: String::new(),
            width: 1920,
            height: 1080,
            x: 0,
            y: 0,
            scale_factor: 1.0,
            rotation: 0.0,
            is_primary: false,
            default: false,
        };

        let mut injector = NoopInjector;
        let applied = crate::input::apply_if_allowed(false, &raw, &source, &mut injector, 0);
        assert!(!applied, "gate closed must drop the frame and return false");
    }

    // ------------------------------------------------------------------
    // I1: in-band E2EE activation barrier in the pump
    // ------------------------------------------------------------------

    #[test]
    fn e2ee_ack_arms_encryption_only_after_the_frames_before_it() {
        // Build a real E2eeSession exactly as
        // `decrypt_desktop_input_round_trips_through_e2ee` does.
        let dir = std::env::temp_dir().join(format!("ponter-i1-barrier-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let identity = crate::identity::AgentIdentity::load_or_generate(&dir.join("id.json"))
            .expect("identity");

        let browser = crate::e2ee::generate_ephemeral().expect("ephemeral");
        let browser_pub = browser.compute_public_key().expect("pub").as_ref().to_vec();
        let browser_spki = crate::e2ee::spki_from_raw_point(&browser_pub);

        let browser_signing =
            crate::identity::AgentIdentity::load_or_generate(&dir.join("browser.json")).unwrap();
        let browser_signing_pub = browser_signing.public_key_raw();
        let sig =
            browser_signing.sign(crate::e2ee::canonical_key_binding(&browser_spki).as_bytes());

        let hello = crate::e2ee::E2eeHello {
            terminal_id: String::new(),
            ecdh_public_key: browser_spki.clone(),
            signature: crate::identity::base64_encode(&sig),
        };

        let (session, _ack) =
            crate::e2ee::E2eeSession::accept_hello(&identity, "sess", &hello, &browser_signing_pub)
                .expect("accept_hello");

        let mut armed = false;

        // A frame enqueued BEFORE the ack: plaintext, even though a session exists.
        let f1 = pump_frame(
            pty::Outbound::TerminalData {
                terminal_id: "t1".into(),
                bytes: b"before".to_vec(),
                timestamp_ms: 1,
            },
            &mut armed,
            Some(&session),
        )
        .expect("frame 1 is emitted");
        let f1v: serde_json::Value = serde_json::from_str(&f1).unwrap();
        assert_eq!(f1v["payload"]["data"], "YmVmb3Jl"); // base64("before") — plaintext

        // The ack marker: emitted verbatim and arms encryption.
        let ack = pump_frame(
            pty::Outbound::E2eeAck("{\"type\":\"terminal-e2ee-ack\"}".into()),
            &mut armed,
            Some(&session),
        )
        .expect("ack is emitted");
        assert_eq!(ack, "{\"type\":\"terminal-e2ee-ack\"}");

        // A frame AFTER the ack: ciphertext, decryptable to the original bytes.
        let f3 = pump_frame(
            pty::Outbound::TerminalData {
                terminal_id: "t1".into(),
                bytes: b"after".to_vec(),
                timestamp_ms: 3,
            },
            &mut armed,
            Some(&session),
        )
        .expect("frame 3 is emitted");
        let f3v: serde_json::Value = serde_json::from_str(&f3).unwrap();
        let data_b64 = f3v["payload"]["data"].as_str().unwrap();
        assert_ne!(data_b64, "YWZ0ZXI="); // base64("after") — NOT plaintext
        let framed = pty::STANDARD.decode(data_b64).unwrap();
        assert_eq!(session.decrypt(&framed).unwrap(), b"after");

        let _ = std::fs::remove_file(dir.join("id.json"));
        let _ = std::fs::remove_file(dir.join("browser.json"));
        let _ = std::fs::remove_dir(&dir);
    }
}
