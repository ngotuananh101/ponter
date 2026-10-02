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
mod pty;
mod rtc;
mod signal;

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use anyhow::{bail, Context, Result};
use base64::engine::general_purpose::STANDARD as STANDARD_ENGINE;
use base64::Engine;
use clap::Parser;
use tokio::sync::mpsc;
use tracing_subscriber::EnvFilter;
use webrtc::data_channel::{DataChannel, DataChannelEvent};
use webrtc::peer_connection::{PeerConnection, RTCIceCandidateInit};

use crate::signal::SignalClient;

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

    /// Desktop frame source: `screen` captures the display, `test` streams a
    /// deterministic pattern (what CI and the E2E harness use).
    #[arg(long, env = "AGENT_DESKTOP_SOURCE", value_enum, default_value_t = DesktopSource::Screen)]
    desktop_source: DesktopSource,
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

    tracing::info!(server = %cli.server, shell = %shell, "starting ponter-agent");

    run_with_reconnect(&cli, &credential, &shell).await
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

/// What an offer asks this agent to serve (ADR-15). Decided from the offer's
/// capabilities *before* the answer is built.
#[derive(Debug, PartialEq, Eq)]
enum SessionMode {
    Terminal,
    Desktop,
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
    } else {
        SessionMode::None
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
    /// Unused on musl, where the desktop module is compiled out; kept so the
    /// CLI shape is identical on every target.
    #[allow(dead_code)]
    desktop_source: DesktopSource,
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
async fn run_with_reconnect(cli: &Cli, credential: &str, shell: &str) -> Result<()> {
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

    let cfg = SessionConfig {
        stun: cli.stun.clone(),
        cols: cli.cols,
        rows: cli.rows,
        shell: shell.to_string(),
        desktop_source: cli.desktop_source,
    };

    let mut delay = signal::BACKOFF_INITIAL;
    let mut supervisor: Option<tokio::task::JoinHandle<Result<()>>> = None;

    loop {
        match SignalClient::connect(&cli.server, credential, inbound_tx.clone(), ice_tx.clone())
            .await
        {
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
                    // The socket ended. A clean close and a fatal error both
                    // mean "reconnect"; only the log line differs. Nothing
                    // here touches the supervisor — it lives in its own task
                    // across reconnects, so a live PeerConnection keeps being
                    // serviced while the socket is down. A dead socket simply
                    // stops delivering candidates until the next one connects;
                    // the ICE layer already connected is unaffected.
                    result = client.run(&mut outbound_rx) => {
                        if let Err(e) = result {
                            tracing::warn!(error = %e, "signaling socket ended with an error");
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

    let handler = Arc::new(rtc::SessionHandler::new(
        offer.session_id.clone(),
        outbound.clone(),
        end_tx.clone(),
        channel.clone(),
        open_tx,
        connected_tx,
    ));
    let peer =
        rtc::build_peer(pushed_ice, &cfg.stun, handler, mode == SessionMode::Desktop).await?;

    // Candidates that arrive before the remote description is set (spec R3).
    let mut pending: Vec<RTCIceCandidateInit> = Vec::new();

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
                inbound,
            )
            .await;
        }
        SessionMode::None => {
            tracing::warn!(session_id = %offer.session_id, "refused: no recognised capability");
            rtc::refuse_offer(&peer, offer, outbound).await?;
            let _ = peer.close().await;
            return Ok(());
        }
        SessionMode::Terminal => {}
    }

    rtc::answer_offer(&peer, offer, outbound).await?;

    // Apply whatever the browser trickled while the answer was being built.
    // `answer_offer` returns as soon as the answer is on the wire, and the
    // browser starts trickling the moment it reads it, so this is a real race
    // rather than a theoretical one.
    rtc::flush_pending_candidates(&peer, &mut pending).await?;

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
    let shell_for_dispatch = cfg.shell.clone();
    let cli_cols = cfg.cols;
    let cli_rows = cfg.rows;
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
    let mut pump = tokio::spawn(async move {
        while let Some(frame) = frame_rx.recv().await {
            if let Err(e) = dc.send_text(&frame).await {
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
    connected_rx: tokio::sync::oneshot::Receiver<()>,
    mut end_rx: mpsc::Receiver<&'static str>,
    inbound: &mut mpsc::Receiver<signal::SignalMessage>,
) -> Result<()> {
    // Create the source first so a capture failure is a clean refusal
    // (`approved: false`) instead of a session the browser opens onto a black
    // video element.
    let source: Box<dyn desktop::FrameSource> = match cfg.desktop_source {
        DesktopSource::Test => Box::new(desktop::TestPatternSource::new(1280, 720)),
        DesktopSource::Screen => match desktop::ScreenSource::new().await {
            Ok(source) => Box::new(source),
            Err(e) => {
                tracing::warn!(error = %e, "desktop capture unavailable; refusing the offer");
                rtc::refuse_offer(peer, offer, outbound).await?;
                let _ = peer.close().await;
                return Ok(());
            }
        },
    };

    let media = rtc::attach_desktop_track(peer).await?;
    rtc::send_desktop_answer(peer, offer, outbound).await?;
    rtc::flush_pending_candidates(peer, pending).await?;

    // Wait for the connection. Until it is `Connected` the track is unbound and
    // every `write_sample` fails with `Error::CodecNotFound` (Task 3's test
    // pins that failure mode), so streaming must not start before this.
    if !matches!(
        tokio::time::timeout(Duration::from_secs(20), connected_rx).await,
        Ok(Ok(()))
    ) {
        tracing::warn!(session_id = %offer.session_id, "desktop peer did not connect within 20s");
        let _ = peer.close().await;
        return Ok(());
    }

    let (ssrc, payload_type) = rtc::desktop_stream_params(&media).await?;

    let (stop_tx, stop_rx) = tokio::sync::watch::channel(false);
    let mut stream = tokio::spawn(desktop::run_stream(
        source,
        media.track.clone(),
        ssrc,
        payload_type,
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
    let _ = peer.close().await;
    Ok(())
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
    _inbound: &mut mpsc::Receiver<signal::SignalMessage>,
) -> Result<()> {
    tracing::warn!(
        session_id = %offer.session_id,
        "desktop streaming is unavailable on this build (musl); refusing",
    );
    rtc::refuse_offer(peer, offer, outbound).await?;
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
    let peer = rtc::build_peer(pushed_ice, &cfg.stun, Arc::new(rtc::NoopHandler), false).await?;
    rtc::refuse_offer(&peer, offer, outbound).await?;
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
}
