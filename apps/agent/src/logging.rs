//! Log filtering policy for the agent.
//!
//! A healthy session still prints a few hundred lines at the default `info`
//! level, because the WebRTC stack's dependencies log through the `log` crate
//! (bridged into `tracing` by `LogTracer`). Nearly all of it is benign:
//! duplicated ICE discards, DTLS extensions the peer offers and this stack
//! ignores, and one upstream `libwayshot` message logged at `error` from a
//! branch that also matches every unrelated Wayland global.
//!
//! [`QuietNoise`] drops exactly those lines and nothing else. It matches the
//! rendered message text, so any unrecognised line — including a real error
//! from the same crate — still reaches the terminal.

use std::fmt;

use tracing::field::{Field, Visit};
use tracing::{Event, Metadata, Subscriber};
use tracing_subscriber::layer::{Context, Filter};
use tracing_subscriber::EnvFilter;

/// `(target prefix, message substring)` pairs dropped before formatting.
///
/// Both parts must match: the target keeps the rule scoped to the crate that
/// emits it, and the substring keeps it scoped to the known-benign case so a
/// neighbouring error from the same target is not swallowed.
const NOISE: &[(&str, &str)] = &[
    // libwayshot's `Dispatch<WlRegistry>` logs this at ERROR from the `else` of
    // a `wl_output` check, so it fires once for every unrelated Wayland global
    // (seat, shm, compositor, …) — a wall of identical lines each time capture
    // starts. Upstream: libwayshot-xcap 0.3.3, `src/dispatch.rs`.
    ("libwayshot_xcap", "Ignoring a wl_output with version < 4."),
    // Expected: the agent disables mDNS on purpose (see `rtc::build_peer`), so
    // a peer's `.local` candidate can never be resolved.
    (
        "rtc_ice",
        "remote mDNS candidate added, but mDNS is disabled",
    ),
    // Benign races on the ICE socket: a STUN success arrives after the pair it
    // belonged to is gone, or a peer sends with the `ufrag:ufrag` order
    // swapped. rtc-ice discards the packet either way; the session is
    // unaffected.
    ("rtc_ice", "no such remote"),
    ("rtc_ice", "ErrMismatchUsername"),
    // `rtc`'s handler re-logs the same two discards from the layer above.
    ("rtc::peer_connection::handler", "unhandled STUN packet"),
    ("rtc::peer_connection::handler", "ErrMismatchUsername"),
    // NOTE: the DTLS `DtlsHandler.handle_read got error: Alert is Fatal or
    // Close Notify` line is deliberately NOT suppressed, even though it fires on
    // an ordinary close_notify at the end of every session. `rtc` renders the
    // bare `Display` of `Error::ErrAlertFatalOrClose`, whose text is fixed and
    // shared by two different causes (rtc-dtls `conn/mod.rs`):
    //
    //     if alert.alert_level == AlertLevel::Fatal
    //         || alert.alert_description == AlertDescription::CloseNotify
    //     { return Err(Error::ErrAlertFatalOrClose); }
    //
    // A benign close and a genuine fatal alert (handshake failure, fingerprint
    // mismatch, insufficient security) therefore produce the *same* message, so
    // the rule cannot tell them apart — and `rtc` logs no DTLS transport state
    // (only `Connected`), so nothing else would surface the fatal case. Keeping
    // one extra line per session is the price of never hiding a real DTLS
    // failure. Revisit if a future `rtc` separates the two variants or logs the
    // alert level.
    //
    // Chrome offers DTLS extensions this stack does not implement. Ignoring
    // unknown extensions is correct (RFC 5246 §7.4.1.4) and the handshake
    // still completes.
    ("rtc_dtls", "Unsupported Extension Type"),
    // The loopback socket exists only to publish a loopback host candidate for
    // same-host peers (see `rtc::build_peer`). STUN/TURN gathering iterates
    // every socket, so it also tries to reach the external server *from*
    // 127.0.0.1 — which the kernel refuses with EINVAL. Only loopback writes are
    // dropped; a write failure on a real interface still shows.
    ("webrtc::peer_connection::driver", "from 127.0.0.1:"),
    // coturn's SSRF guard rejects `CreatePermission`/`ChannelBind` for loopback
    // (127.0.0.0/8) and IPv6 ULA (fc00::/7) peers with `403 Forbidden IP`. The
    // agent's loopback bind (see `rtc::build_peer`) and the WireGuard ULA
    // address both produce such candidates, so the relayed candidate pair is
    // dropped. Those peers are reachable over the loopback/WireGuard path
    // directly, so the session is unaffected — the relay is only the fallback.
    // Verified against the deploy coturn 4.18.0: peers 10.6.9.x and RFC 1918
    // succeed; only 127.0.0.1 returns `403: Forbidden IP`. `--allowed-peer-ip`
    // cannot override the guard; only `--allow-loopback-peers` does, and that
    // opens the relay to localhost services (SSRF).
    //
    // A 403 from coturn is always this guard (bad credentials surface as 401),
    // so suppressing it cannot hide an auth/config fault. The permission and
    // transaction *timeouts* it triggers are deliberately NOT suppressed: those
    // messages are also what a genuinely unreachable TURN/STUN server emits, and
    // they are rare enough to keep as a real diagnostic.
    (
        "webrtc::peer_connection::transport::turn_relayer",
        "CreatePermission error response (error 403",
    ),
    // quinn-udp (a webrtc dependency) reports UDP segmentation offload being
    // unavailable at INFO; it falls back to plain `sendmsg` and works.
    ("quinn_udp", "halting segmentation offload"),
];

/// Per-layer [`Filter`] that drops [`NOISE`] and admits everything else.
#[derive(Debug, Clone, Copy)]
pub struct QuietNoise;

impl QuietNoise {
    /// Whether `message` from `target` is one of the known-benign lines.
    fn is_noise(target: &str, message: &str) -> bool {
        NOISE.iter().any(|(noisy_target, noisy_message)| {
            target.starts_with(noisy_target) && message.contains(noisy_message)
        })
    }
}

impl<S: Subscriber> Filter<S> for QuietNoise {
    fn enabled(&self, _meta: &Metadata<'_>, _cx: &Context<'_, S>) -> bool {
        // Never gate on metadata: the decision needs the event's fields.
        true
    }

    fn event_enabled(&self, event: &Event<'_>, _cx: &Context<'_, S>) -> bool {
        let mut visitor = MessageVisitor::default();
        event.record(&mut visitor);
        let Some(message) = visitor.message else {
            // No `message` field: not a line this policy knows about.
            return true;
        };
        // A record bridged from `log` carries the constant target `"log"`; the
        // emitting module is in the `log.target` field instead. Records written
        // with `tracing`'s own macros have no such field and use the metadata
        // target directly.
        let target = visitor
            .log_target
            .as_deref()
            .unwrap_or_else(|| event.metadata().target());
        !Self::is_noise(target, &message)
    }
}

/// Extracts the `message` field, and the real target of a `log`-bridged record,
/// without formatting the other fields.
#[derive(Default)]
struct MessageVisitor {
    message: Option<String>,
    /// The `log` crate's target, present only on records that came through
    /// `LogTracer`. See [`QuietNoise::event_enabled`].
    log_target: Option<String>,
}

impl Visit for MessageVisitor {
    fn record_str(&mut self, field: &Field, value: &str) {
        if field.name() == "log.target" && self.log_target.is_none() {
            self.log_target = Some(value.to_owned());
        } else if field.name() == "message" && self.message.is_none() {
            self.message = Some(value.to_owned());
        }
    }

    fn record_debug(&mut self, field: &Field, value: &dyn fmt::Debug) {
        // `tracing` and `tracing-log` both record `message` as a
        // `fmt::Arguments` through `record_debug`; its `Debug` renders the same
        // text as `Display`.
        if field.name() == "message" && self.message.is_none() {
            self.message = Some(format!("{value:?}"));
        }
    }
}

/// Install the global subscriber: the usual `RUST_LOG` level policy, minus the
/// known-benign third-party lines.
///
/// `RUST_LOG` is honoured exactly as before (defaulting to `info`), so
/// `RUST_LOG=ponter_agent=debug` still turns on the agent's own diagnostics.
pub fn init() {
    use tracing_subscriber::filter::FilterExt;
    use tracing_subscriber::layer::{Layer, SubscriberExt};
    use tracing_subscriber::util::SubscriberInitExt;

    let env_filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));

    tracing_subscriber::registry()
        .with(
            tracing_subscriber::fmt::layer()
                .log_internal_errors(true)
                .with_filter(env_filter.and(QuietNoise)),
        )
        .init();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_noise_is_matched_by_target_and_message() {
        assert!(QuietNoise::is_noise(
            "libwayshot_xcap::dispatch",
            "Ignoring a wl_output with version < 4.",
        ));
        assert!(QuietNoise::is_noise(
            "rtc_ice::agent",
            "[controlled]: discard success message from (127.0.0.1:40952), no such remote",
        ));
        assert!(QuietNoise::is_noise(
            "rtc::peer_connection::handler",
            "IceHandler.handle_read got error: unhandled STUN packet",
        ));
        assert!(QuietNoise::is_noise(
            "webrtc::peer_connection::driver",
            "Failed to write packet to 157.66.24.183:3478 from 127.0.0.1:57357: \
             io error: Invalid argument (os error 22)",
        ));
    }

    #[test]
    fn the_same_message_from_another_target_is_kept() {
        // The substring alone must not be enough: a `ponter_agent` line that
        // happens to quote a suppressed phrase still has to reach the terminal.
        assert!(!QuietNoise::is_noise("ponter_agent", "no such remote",));
    }

    #[test]
    fn the_loopback_relay_rejection_is_suppressed() {
        // Confirmed against the deploy coturn 4.18.0: it answers `403: Forbidden
        // IP` for loopback/ULA peers. That is an expected consequence of the
        // agent's loopback bind and WireGuard ULA, not an actionable fault.
        assert!(QuietNoise::is_noise(
            "webrtc::peer_connection::transport::turn_relayer",
            "TURN permission request failed: CreatePermission error response (error 403: )",
        ));
    }

    #[test]
    fn real_errors_from_a_noisy_target_are_kept() {
        // Same crate as a suppressed rule, different (actionable) message: an
        // Allocate failure means the credentials/config really are wrong.
        assert!(!QuietNoise::is_noise(
            "webrtc::peer_connection::transport::turn_relayer",
            "TURN allocation failed from 0.0.0.0:0 to 157.66.24.183:3478: \
             Allocate error response (error 401: Unauthorized)",
        ));
        // The permission/transaction timeouts are kept: they are also what a
        // genuinely unreachable TURN/STUN server emits, so they must not be
        // hidden along with the 403 above.
        assert!(!QuietNoise::is_noise(
            "webrtc::peer_connection::transport::turn_relayer",
            "TURN transaction timed out: TransactionId([1, 2, 3])",
        ));
        assert!(!QuietNoise::is_noise(
            "webrtc::peer_connection::transport::stun_gatherer",
            "STUN error: TransactionTimeOut",
        ));
        // A write failure on a real interface is not the loopback artifact.
        assert!(!QuietNoise::is_noise(
            "webrtc::peer_connection::driver",
            "Failed to write packet to 10.0.0.5:5000 from 192.168.1.20:40000: io error",
        ));
    }

    #[test]
    fn the_dtls_alert_line_is_kept_even_though_it_usually_means_a_clean_close() {
        // The same message covers a benign close_notify and a fatal alert, so it
        // must not be suppressed: a real DTLS failure would otherwise be silent.
        assert!(!QuietNoise::is_noise(
            "rtc::peer_connection::handler",
            "DtlsHandler.handle_read got error: Alert is Fatal or Close Notify",
        ));
    }

    #[test]
    fn an_unknown_message_is_kept() {
        assert!(!QuietNoise::is_noise(
            "rtc_ice::agent",
            "[controlled]: Setting new connection state: Connected",
        ));
    }

    /// Captures formatted output in memory so a test can assert on it.
    #[derive(Clone, Default)]
    struct Capture(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);

    struct CaptureWriter<'a>(std::sync::MutexGuard<'a, Vec<u8>>);

    impl std::io::Write for CaptureWriter<'_> {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    impl<'a> tracing_subscriber::fmt::writer::MakeWriter<'a> for Capture {
        type Writer = CaptureWriter<'a>;
        fn make_writer(&'a self) -> Self::Writer {
            CaptureWriter(self.0.lock().expect("capture lock"))
        }
    }

    /// Proves the composed layer actually drops noise end-to-end — the unit
    /// tests above only exercise [`QuietNoise::is_noise`], not the
    /// `EnvFilter::and(QuietNoise)` wiring that decides whether the event is
    /// ever formatted.
    #[test]
    fn composed_filter_drops_noise_and_keeps_everything_else() {
        use tracing_subscriber::filter::FilterExt;
        use tracing_subscriber::layer::{Layer, SubscriberExt};

        let capture = Capture::default();
        let subscriber = tracing_subscriber::registry().with(
            tracing_subscriber::fmt::layer()
                .with_ansi(false)
                .with_writer(capture.clone())
                .with_filter(EnvFilter::new("info").and(QuietNoise)),
        );

        tracing::subscriber::with_default(subscriber, || {
            tracing::error!(
                target: "libwayshot_xcap::dispatch",
                "Ignoring a wl_output with version < 4."
            );
            tracing::error!(
                target: "webrtc::peer_connection::transport::turn_relayer",
                "TURN allocation failed from 0.0.0.0:0 to 157.66.24.183:3478: \
                 Allocate error response (error 401: Unauthorized)"
            );
            tracing::info!(target: "ponter_agent", "session starting");
        });

        let out = String::from_utf8(capture.0.lock().expect("capture lock").clone())
            .expect("utf-8 output");
        assert!(
            !out.contains("Ignoring a wl_output"),
            "the libwayshot error must be suppressed, got:\n{out}"
        );
        assert!(
            out.contains("Allocate error response (error 401"),
            "a real TURN error must survive, got:\n{out}"
        );
        assert!(
            out.contains("session starting"),
            "the agent's own info line must survive, got:\n{out}"
        );
    }

    /// The crates that actually emit the noise log through `log`, not
    /// `tracing`, and reach the subscriber via `LogTracer`. This test drives
    /// that exact path, so a regression in how the bridge shapes the event
    /// (target or `message` field) fails here rather than only in production.
    #[test]
    fn the_log_crate_bridge_is_filtered_too() {
        use tracing_subscriber::filter::FilterExt;
        use tracing_subscriber::layer::{Layer, SubscriberExt};

        // The `log` logger is process-global and install-once, so this runs in
        // its own test binary path: `LogTracer::init` returns an error if a
        // logger already exists, which the `let _ =` tolerates for repeat runs
        // while the assertions below stay valid for the first install.
        let capture = Capture::default();
        let subscriber = tracing_subscriber::registry().with(
            tracing_subscriber::fmt::layer()
                .with_ansi(false)
                .with_writer(capture.clone())
                .with_filter(EnvFilter::new("info").and(QuietNoise)),
        );

        let _ = tracing_log::LogTracer::init();
        log::set_max_level(log::LevelFilter::Info);
        tracing::subscriber::with_default(subscriber, || {
            log::error!(target: "libwayshot_xcap::dispatch", "Ignoring a wl_output with version < 4.");
            log::error!(
                target: "webrtc::peer_connection::transport::turn_relayer",
                "TURN allocation failed from 0.0.0.0:0 to 157.66.24.183:3478: \
                 Allocate error response (error 401: Unauthorized)"
            );
        });

        let out = String::from_utf8(capture.0.lock().expect("capture lock").clone())
            .expect("utf-8 output");
        assert!(
            !out.contains("Ignoring a wl_output"),
            "a bridged log record must be suppressed too, got:\n{out}"
        );
        assert!(
            out.contains("Allocate error response (error 401"),
            "a real error from the same bridge must survive, got:\n{out}"
        );
    }
}
