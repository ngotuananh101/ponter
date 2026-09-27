//! `remote-agent` — CLI, startup pipeline, Ctrl-C/SIGTERM teardown.
//!
//! Four flat modules, no `lib.rs`: this is a binary crate, and the unit tests
//! live in `#[cfg(test)] mod tests` inside each module. A `lib.rs` would exist
//! only to let integration tests import the modules, and the PTY echo test
//! needs the real binary path anyway (spec §5.4.1).

mod pty;
mod rtc;
mod signal;

use std::sync::{Arc, OnceLock};
use std::time::Duration;

use anyhow::{bail, Context, Result};
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
        .with_env_filter(EnvFilter::from_default_env())
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
            Ok((client, inbound_rx, outbound_tx)) => {
                tracing::info!("connected to the signaling server");
                delay = signal::BACKOFF_INITIAL;

                let sessions = supervise_sessions(inbound_rx, outbound_tx, cli, shell);
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
    cli: &Cli,
    shell: &str,
) -> Result<()> {
    let mut active: Option<String> = None;

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
                    let peer = rtc::build_peer(&cli.stun).await?;
                    rtc::refuse_offer(&peer, &offer, &outbound).await?;
                    let _ = peer.close().await;
                    continue;
                }

                active = Some(offer.session_id.clone());
                tracing::info!(session_id = %offer.session_id, "session starting");

                if let Err(e) = run_one_session(&offer, &mut inbound, &outbound, cli, shell).await {
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
    cli: &Cli,
    shell: &str,
) -> Result<()> {
    let peer = rtc::build_peer(&cli.stun).await?;

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

    // The input channel is created HERE, before the callback that will fill it.
    // A keystroke can arrive the instant the browser's channel reports `open` —
    // which is before `PtySession::spawn` runs — so the sending half must
    // already exist and be reachable from the callback. Creating it inside
    // `spawn` instead is a silent first-keystroke loss, not a visible error.
    let (pty_in_tx, pty_in_rx) = mpsc::channel::<Vec<u8>>(64);

    let channel: Arc<OnceLock<Arc<RTCDataChannel>>> = Arc::new(OnceLock::new());
    let (open_tx, mut open_rx) = tokio::sync::oneshot::channel::<()>();
    let open_tx = Arc::new(std::sync::Mutex::new(Some(open_tx)));

    let channel_for_cb = channel.clone();
    let pty_in_for_cb = pty_in_tx.clone();
    let open_tx_for_cb = open_tx.clone();

    peer.on_data_channel(Box::new(move |dc| {
        let channel = channel_for_cb.clone();
        let pty_in = pty_in_for_cb.clone();
        let open_tx = open_tx_for_cb.clone();

        Box::pin(async move {
            // ADR-09: the exact label, and nothing else. An unexpected channel
            // is closed rather than ignored — leaving it half-open would let a
            // peer keep a second channel alive past its welcome.
            if dc.label() != rtc::TERMINAL_LABEL {
                tracing::warn!(label = dc.label(), "refusing unexpected channel");
                let _ = dc.close().await;
                return;
            }

            // browser -> PTY. `decode_pty_input` rejects an oversize frame
            // before parsing. A decode failure is logged and dropped, never
            // fatal: the terminal stream has no retransmission, and one corrupt
            // frame must not kill the session.
            let pty_in_msg = pty_in.clone();
            dc.on_message(Box::new(move |msg| {
                let pty_in = pty_in_msg.clone();
                Box::pin(async move {
                    let Ok(text) = std::str::from_utf8(&msg.data) else {
                        tracing::debug!("ignoring a non-UTF-8 frame");
                        return;
                    };
                    match pty::decode_pty_input(text) {
                        Ok(Some(bytes)) => {
                            // Bounded send: the writer thread's queue is what
                            // applies backpressure to a peer that types faster
                            // than the shell can read.
                            if pty_in.send(bytes).await.is_err() {
                                tracing::debug!("pty writer is gone");
                            }
                        }
                        Ok(None) => {} // not a terminal-data frame on `terminal`
                        Err(e) => tracing::debug!(error = %e, "dropping malformed frame"),
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

    let session = pty::PtySession::spawn(shell, cli.cols, cli.rows, pty_in_rx)?;
    let mut frames = session.start_reader(offer.session_id.clone())?;

    let dc = channel
        .get()
        .context("the terminal channel vanished after opening")?
        .clone();

    // PTY -> browser. One sequential loop, not a task per frame: the order of a
    // terminal's output is part of its meaning, and a task per frame lets the
    // runtime reorder it. `send_text` is the only send method used — the frame
    // is JSON text carrying base64, never a binary frame (ADR-10).
    let mut pump = tokio::spawn(async move {
        while let Some(frame) = frames.recv().await {
            if let Err(e) = dc.send_text(frame).await {
                // A closed channel is an ordinary end-of-session condition, not
                // an error worth tearing the process down for.
                tracing::debug!(error = %e, "data channel send failed");
                break;
            }
        }
    });

    // The pump ending means the child exited and the slave closed — the normal
    // terminator. Candidates keep being applied until then, which is what lets
    // a relay candidate arrive late and still be used. The 1 h cap exists
    // because a session whose peer vanished silently would otherwise linger
    // until the process is killed.
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

    // Dropping the input sender is what ends the writer thread (and with it the
    // shell's stdin), so it must happen before `close` waits on the child.
    drop(pty_in_tx);
    session.close().await?;
    let _ = peer.close().await;
    Ok(())
}

/// Apply an inbound message if it is a candidate; ignore anything else.
///
/// An `offer` here would be a second offer for the session already running —
/// ADR-14 refuses those at the supervisor, and reaching this point with one
/// would mean the routing above is wrong, so it is logged rather than silently
/// dropped.
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
