//! `remote-agent` — CLI, startup pipeline, Ctrl-C/SIGTERM teardown.
//!
//! Four flat modules, no `lib.rs`: this is a binary crate, and the unit tests
//! live in `#[cfg(test)] mod tests` inside each module. A `lib.rs` would exist
//! only to let integration tests import the modules, and the PTY echo test
//! needs the real binary path anyway (spec §5.4.1).

mod pty;
mod rtc;
mod signal;

use std::collections::HashMap;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use anyhow::{bail, Context, Result};
use base64::engine::general_purpose::STANDARD as STANDARD_ENGINE;
use base64::Engine;
use clap::Parser;
use tokio::sync::mpsc;
use tracing_subscriber::EnvFilter;
use webrtc::data_channel::RTCDataChannel;
use webrtc::ice_transport::ice_candidate::RTCIceCandidateInit;
use webrtc::peer_connection::RTCPeerConnection;

use crate::signal::SignalClient;

#[derive(Parser, Debug)]
#[command(name = "remote-agent", version, about = "Ponta remote desktop agent")]
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

    /// Shell to spawn. Defaults to $SHELL (unix) or cmd.exe (windows).
    #[arg(long, env = "AGENT_SHELL")]
    shell: Option<String>,

    /// Agent credential (ag_...). Prefer AGENT_CREDENTIAL: argv is visible via
    /// ps (ADR-13).
    #[arg(long, env = "AGENT_CREDENTIAL")]
    credential: Option<String>,

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

/// `--shell` -> `AGENT_SHELL` -> platform default.
///
/// The path is passed through to `CommandBuilder::new` unmodified — no shell
/// interpolation of user input, because the value is the executable, not a
/// command line.
fn resolve_shell(cli: &Cli) -> Result<String> {
    if let Some(s) = &cli.shell {
        return Ok(s.clone());
    }
    #[cfg(unix)]
    {
        Ok(std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into()))
    }
    #[cfg(windows)]
    {
        Ok("cmd.exe".into())
    }
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
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    let cli = Cli::parse();
    let credential = resolve_credential(&cli)?;
    let shell = resolve_shell(&cli)?;

    tracing::info!(server = %cli.server, shell = %shell, "starting remote-agent");

    run_with_reconnect(&cli, &credential, &shell).await
}

/// Connect, serve, and reconnect with exponential backoff until told to stop.
///
/// The agent is a long-lived daemon, so a dropped socket is an ordinary event:
/// a laptop that slept, a Worker isolate recycled, a flaky link. Exiting on the
/// first disconnect would mean a user has to re-run the agent by hand after
/// every hiccup, which is the behaviour §5.5.5 exists to prevent.
///
/// The backoff resets on a successful connect rather than on a successful
/// session, because the failure being backed off from is the handshake itself —
/// a server that is down would otherwise be hammered at the maximum rate.
async fn run_with_reconnect(cli: &Cli, credential: &str, shell: &str) -> Result<()> {
    let mut delay = signal::BACKOFF_INITIAL;

    loop {
        match SignalClient::connect(&cli.server, credential, &cli.agent_id).await {
            Ok((client, inbound_rx, outbound_tx, ice_rx)) => {
                tracing::info!("connected to the signaling server");
                delay = signal::BACKOFF_INITIAL;

                let sessions = supervise_sessions(inbound_rx, outbound_tx, ice_rx, cli, shell);
                tokio::select! {
                    // The socket ended. A clean close and a fatal error both
                    // mean "reconnect"; only the log line differs.
                    result = client.run() => {
                        if let Err(e) = result {
                            tracing::warn!(error = %e, "signaling socket ended with an error");
                        }
                    }
                    // The supervisor only returns on a fatal internal error.
                    result = sessions => result?,
                    _ = shutdown_signal() => {
                        tracing::info!("shutdown signal received");
                        return Ok(());                              // ADR-12 teardown
                    }
                }
            }
            Err(e) => tracing::warn!(error = %e, "could not connect to the signaling server"),
        }

        tracing::info!(delay_ms = delay.as_millis() as u64, "reconnecting");
        tokio::select! {
            _ = tokio::time::sleep(delay) => {}
            _ = shutdown_signal() => {
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

/// The ADR-14 loop: take an `offer`; if a session is active, answer
/// `approved: false` and drop it; otherwise run one session to completion.
///
/// **Candidates are routed here, not in `run_one_session`.** The channel is a
/// single stream, so exactly one task can own it. `run_one_session` therefore
/// receives a fresh per-session channel that this loop forwards into, which
/// also means the loop can drop a candidate addressed to a session that is not
/// live without the session ever seeing it.
async fn supervise_sessions(
    mut inbound: tokio::sync::mpsc::Receiver<signal::SignalMessage>,
    outbound: tokio::sync::mpsc::Sender<signal::SignalMessage>,
    mut ice_rx: tokio::sync::mpsc::Receiver<Vec<signal::IceServerEntry>>,
    cli: &Cli,
    shell: &str,
) -> Result<()> {
    let mut active: Option<String> = None;

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
    loop {
        let Some(message) = inbound.recv().await else {
            // The socket closed. Nothing to supervise any more.
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
                if active.is_some() {
                    // ADR-14: refuse, but with a real SDP — `POST
                    // /api/signal/answer` rejects an empty one (spec R19).
                    tracing::warn!(
                        session_id = %offer.session_id,
                        "refusing a second concurrent session (ADR-14)",
                    );
                    let peer = rtc::build_peer(&pushed_ice, &cli.stun).await?;
                    rtc::refuse_offer(&peer, &offer, &outbound).await?;
                    let _ = peer.close().await;
                    continue;
                }

                active = Some(offer.session_id.clone());
                tracing::info!(session_id = %offer.session_id, "session starting");

                if let Err(e) =
                    run_one_session(&offer, &mut inbound, &outbound, &pushed_ice, cli, shell).await
                {
                    tracing::warn!(
                        error = %e,
                        session_id = %offer.session_id,
                        "session ended with an error",
                    );
                }

                // `take()` consumes the `Some` so the assignment is visible to
                // the compiler — the value tracks across `run_one_session` to
                // the `active.is_some()` check at the top of the next loop.
                let ended = active.take();
                tracing::info!(
                    session_id = %offer.session_id,
                    ended = ended.is_some(),
                    "session ended",
                );
            }
        }
    }
}

/// One session: answer, wait for the `terminal` channel, spawn the PTY, pump.
///
/// Borrows `inbound` for the session's whole lifetime, so every candidate the
/// peer trickles lands here rather than in the idle loop above. That is the
/// point: the buffer below must be the same object that receives them.
async fn run_one_session(
    offer: &signal::SignalOffer,
    inbound: &mut tokio::sync::mpsc::Receiver<signal::SignalMessage>,
    outbound: &tokio::sync::mpsc::Sender<signal::SignalMessage>,
    pushed_ice: &[signal::IceServerEntry],
    cli: &Cli,
    shell: &str,
) -> Result<()> {
    let peer = rtc::build_peer(pushed_ice, &cli.stun).await?;

    // Register the outbound forwarder BEFORE the local description exists:
    // gathering starts the moment `set_local_description` runs, and a handler
    // registered after it misses the host candidates emitted in that tick.
    // Without this the agent never sends a candidate and ICE never completes —
    // the browser alone cannot form a pair.
    rtc::forward_candidates(&peer, offer.session_id.clone(), outbound.clone());

    // Candidates that arrive before the remote description is set (spec R3).
    let mut pending: Vec<RTCIceCandidateInit> = Vec::new();

    rtc::answer_offer(&peer, offer, outbound).await?;

    // Apply whatever the browser trickled while the answer was being built.
    // `answer_offer` returns as soon as the answer is on the wire, and the
    // browser starts trickling the moment it reads it, so this is a real race
    // rather than a theoretical one.
    rtc::flush_pending_candidates(&peer, &mut pending).await?;

    if !offer.capabilities.iter().any(|c| c == rtc::TERMINAL_LABEL) {
        tracing::warn!(session_id = %offer.session_id, "refused: no terminal capability");
        let _ = peer.close().await;
        return Ok(());
    }

    // PtyManager multiplexes up to 10 concurrent sessions over this one
    // terminal DataChannel. The manager is created before the data-channel
    // callback is registered.
    let manager = PtyManager::new(10);

    // The outbound frame channel sits between PtyManager's pump tasks and the
    // data-channel send loop. PtyManager writes framed JSON here; the loop
    // sends each frame over the wire.
    let (frame_tx, mut frame_rx) = mpsc::channel::<String>(64);

    // The inbound dispatch channel sits between the data-channel `on_message`
    // callback and the dispatcher task. The callback must be `Fn + Send + Sync`,
    // but PtyManager holds Arc<PtySession> whose inner MasterPty is not Sync — so
    // we forward raw text through this channel instead of capturing the manager.
    let (dispatch_tx, mut dispatch_rx) = mpsc::channel::<String>(64);
    let manager_for_dispatch = manager.clone();
    let frame_tx_for_dispatch = frame_tx.clone();
    let shell_for_dispatch = shell.to_string();
    let cli_cols = cli.cols;
    let cli_rows = cli.rows;
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
                "terminal-create" => {
                    let create: pty::TerminalCreateMessage =
                        match serde_json::from_value(envelope.payload) {
                            Ok(c) => c,
                            Err(e) => {
                                tracing::debug!(error = %e, "bad terminal-create payload");
                                continue;
                            }
                        };
                    let sh = create.shell.unwrap_or_else(|| shell_for_dispatch.clone());
                    let spawn = manager_for_dispatch
                        .spawn_session(
                            create.terminal_id.clone(),
                            &sh,
                            create.cols,
                            create.rows,
                            frame_tx_for_dispatch.clone(),
                        )
                        .await;
                    tracing::warn!(
                        error = ?spawn.as_ref().err().map(|e| e.to_string()),
                        "spawn terminal session finished"
                    );
                    // A refused spawn must reach the browser, not just the log.
                    if let Some(frame) = spawn_failure_frame(&create.terminal_id, spawn) {
                        let _ = frame_tx_for_dispatch.send(frame).await;
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
                    let bytes = match STANDARD_ENGINE.decode(payload.data.as_bytes()) {
                        Ok(b) => b,
                        Err(e) => {
                            tracing::debug!(error = %e, "payload.data is not valid base64");
                            continue;
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

    let channel: Arc<OnceLock<Arc<RTCDataChannel>>> = Arc::new(OnceLock::new());
    let (open_tx, mut open_rx) = tokio::sync::oneshot::channel::<()>();
    let open_tx = Arc::new(std::sync::Mutex::new(Some(open_tx)));

    let channel_for_cb = channel.clone();
    let open_tx_for_cb = open_tx.clone();

    peer.on_data_channel(Box::new(move |dc| {
        let channel = channel_for_cb.clone();
        let open_tx = open_tx_for_cb.clone();
        let dispatch_tx = dispatch_tx.clone();

        Box::pin(async move {
            // ADR-09: the exact label, and nothing else. An unexpected channel
            // is closed rather than ignored — leaving it half-open would let a
            // peer keep a second channel alive past its welcome.
            if dc.label() != rtc::TERMINAL_LABEL {
                tracing::warn!(label = dc.label(), "refusing unexpected channel");
                let _ = dc.close().await;
                return;
            }

            // browser -> dispatch channel. The callback is Fn+Send+Sync, so it
            // only forwards raw text; the spawned task above does the decoding
            // and routing.
            dc.on_message(Box::new(move |msg| {
                let dispatch_tx = dispatch_tx.clone();
                Box::pin(async move {
                    let Ok(text) = std::str::from_utf8(&msg.data) else {
                        tracing::debug!("ignoring a non-UTF-8 frame");
                        return;
                    };
                    if dispatch_tx.send(text.to_string()).await.is_err() {
                        tracing::debug!("dispatcher task is gone");
                    }
                })
            }));

            // `on_open` is `FnOnce` (spec R8), so the sender is taken out of the
            // `Mutex` exactly once — which is right, because ADR-09 allows one
            // channel.
            let channel_open = channel.clone();
            let dc_open = dc.clone();
            dc.on_open(Box::new(move || {
                let _ = channel_open.set(dc_open);
                if let Some(tx) = open_tx.lock().unwrap().take() {
                    let _ = tx.send(());
                }
                Box::pin(async {})
            }));
        })
    }));

    // The handshake: wait for the channel to open, draining candidates the
    // whole time. Candidates must keep flowing here — a peer that trickled
    // slowly would otherwise stall behind this wait, because nothing else is
    // reading `inbound` while it runs.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    loop {
        tokio::select! {
            // Candidates first: they are what the handshake is waiting on, and
            // `biased` keeps the order deterministic rather than random.
            biased;

            candidate = inbound.recv() => {
                match candidate {
                    Some(message) => apply_if_candidate(&peer, &mut pending, message).await?,
                    None => anyhow::bail!(
                        "the signaling socket closed before the terminal channel opened"
                    ),
                }
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

    // PTY -> browser. One sequential loop drains the shared frame channel and
    // sends each frame over the data channel. This is the single send point for
    // all sessions, preserving frame ordering per-session (each pump task is
    // single-threaded) and keeping backpressure on a slow consumer.
    let mut pump = tokio::spawn(async move {
        while let Some(frame) = frame_rx.recv().await {
            if let Err(e) = dc.send_text(frame).await {
                // A closed channel is an ordinary end-of-session condition, not
                // an error worth tearing the process down for.
                tracing::debug!(error = %e, "data channel send failed");
                break;
            }
        }
    });

    let manager_for_teardown = manager.clone();
    let session_deadline = tokio::time::Instant::now() + Duration::from_secs(3600);
    let reason = loop {
        tokio::select! {
            _ = &mut pump => break "the pty pump ended",
            message = inbound.recv() => {
                match message {
                    Some(message) => apply_if_candidate(&peer, &mut pending, message).await?,
                    None => break "the signaling socket closed",
                }
            }
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
    let _ = peer.close().await;
    Ok(())
}

/// Apply an inbound message if it is a candidate; ignore anything else.
///
/// An `offer` here would be a second offer for the session already running —
/// ADR-14 refuses those at the supervisor, and reaching this point with one
/// would mean the routing above is wrong, so it is logged rather than silently
/// dropped.
///
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

async fn apply_if_candidate(
    peer: &Arc<RTCPeerConnection>,
    pending: &mut Vec<RTCIceCandidateInit>,
    message: signal::SignalMessage,
) -> Result<()> {
    match message {
        signal::SignalMessage::IceCandidate(candidate) => {
            let applied = rtc::apply_candidate(peer, pending, candidate).await?;
            tracing::trace!(applied, "inbound candidate");
        }
        other => tracing::debug!(?other, "ignoring a non-candidate frame during a session"),
    }
    Ok(())
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
        outbound: mpsc::Sender<String>,
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
            let exit_frame = pty::frame_pty_exit(&tid, exit_code, pty::now_ms());
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
        outbound: mpsc::Sender<String>,
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
    async fn pty_manager_rejects_duplicate_spawn() {
        let manager = PtyManager::new(10);
        let (out_tx, _out_rx) = mpsc::channel(16);

        #[cfg(unix)]
        {
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
    }

    #[tokio::test]
    async fn pty_manager_enforces_max_sessions() {
        let manager = PtyManager::new(1);
        let (out_tx, _out_rx) = mpsc::channel::<String>(16);

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
                .spawn_session("s1".to_string(), "x", 80, 24, out_tx)
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
}
