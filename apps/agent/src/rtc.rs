//! WebRTC answerer. Owns one `RTCPeerConnection` for one session.

use std::sync::Arc;

use anyhow::{Context, Result};
use tokio::sync::mpsc;
use webrtc::api::interceptor_registry::register_default_interceptors;
use webrtc::api::media_engine::MediaEngine;
use webrtc::api::setting_engine::SettingEngine;
use webrtc::api::APIBuilder;
use webrtc::ice_transport::ice_candidate::RTCIceCandidateInit;
use webrtc::ice_transport::ice_server::RTCIceServer;
use webrtc::interceptor::registry::Registry;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;
use webrtc::peer_connection::RTCPeerConnection;

use crate::signal::{IceCandidateSignal, SignalAnswer, SignalMessage, SignalOffer};

/// The one channel label this agent accepts. ADR-09: exact label, nothing else.
pub const TERMINAL_LABEL: &str = "terminal";

/// Build the peer connection.
///
/// mDNS is disabled: headless hosts and containers frequently have no mDNS
/// responder, and leaving it on produces unresolvable `.local` candidates.
/// Loopback needs no ICE server at all (Week 4 F4); `stun_url` is configuration
/// with a public default, and an empty string is the loopback/air-gapped path.
pub async fn build_peer(stun_url: &str) -> Result<Arc<RTCPeerConnection>> {
    let mut media = MediaEngine::default();
    media
        .register_default_codecs()
        .context("register_default_codecs")?;
    let registry = register_default_interceptors(Registry::new(), &mut media)
        .context("register_default_interceptors")?;

    let mut setting = SettingEngine::default();
    setting.set_ice_multicast_dns_mode(webrtc::ice::mdns::MulticastDnsMode::Disabled);

    let api = APIBuilder::new()
        .with_media_engine(media)
        .with_interceptor_registry(registry)
        .with_setting_engine(setting)
        .build();

    let ice_servers = if stun_url.is_empty() {
        Vec::new()
    } else {
        vec![RTCIceServer {
            urls: vec![stun_url.to_string()],
            ..Default::default()
        }]
    };

    let config = RTCConfiguration {
        ice_servers,
        ..Default::default()
    };

    Ok(Arc::new(
        api.new_peer_connection(config)
            .await
            .context("new_peer_connection")?,
    ))
}

/// Narrow a wire `sdpMLineIndex` to the `u16` the crate uses.
///
/// Spec R7: a value outside `0..=65535` is rejected at the boundary rather than
/// truncated, because a truncated index makes the peer associate the candidate
/// with the wrong media section.
pub fn narrow_mline_index(raw: Option<i32>) -> Result<Option<u16>> {
    match raw {
        None => Ok(None),
        Some(v) if (0..=65535).contains(&v) => Ok(Some(v as u16)),
        Some(v) => anyhow::bail!("sdpMLineIndex {v} is outside 0..=65535"),
    }
}

/// Apply every buffered candidate, in arrival order, after the remote
/// description exists.
///
/// The buffering itself is the Week 4 F1 twin (spec R3): `add_ice_candidate`
/// returns `ErrNoRemoteDescription` when it is called too early, so a naive
/// implementation **loses** candidates and the connection fails with an
/// unhelpful error. Both peers must buffer or neither connects.
///
/// Called by `run_one_session` once `answer_offer` has set the remote
/// description; the buffer is filled by `apply_candidate`.
pub async fn flush_pending_candidates(
    peer: &Arc<RTCPeerConnection>,
    pending: &mut Vec<RTCIceCandidateInit>,
) -> Result<()> {
    for cand in pending.drain(..) {
        // Sequential, in arrival order.
        peer.add_ice_candidate(cand)
            .await
            .context("add_ice_candidate (flushed)")?;
    }
    Ok(())
}

/// Answer one offer: set the remote description, create the answer, send it.
///
/// **Candidate buffering is the caller's job, not this function's.** The
/// candidates that need buffering arrive on the inbound channel, and only
/// `run_one_session` reads that — so `answer_offer` deliberately takes no
/// buffer. It returns as soon as the answer is on the wire, and the caller
/// applies whatever arrived in the meantime via `flush_pending_candidates`.
///
/// `approved` is a policy check, not a prompt (§5.6.4): true when the offer's
/// capabilities contain `"terminal"`, false otherwise.
///
/// **A refusal still carries a real SDP.** `POST /api/signal/answer` rejects an
/// empty `sdp` with `400 VALIDATION_ERROR` (spec R19), so the refusal path calls
/// `create_answer` first and sends the real SDP with `approved: false`. A
/// refusal is therefore indistinguishable from a success at the transport layer
/// and visible only in the flag — honest, because the Worker does not act on the
/// flag today (`routes/signal.ts` stores `approved: body.approved !== false` and
/// nothing enforces it).
pub async fn answer_offer(
    peer: &Arc<RTCPeerConnection>,
    offer: &SignalOffer,
    outbound: &mpsc::Sender<SignalMessage>,
) -> Result<()> {
    let approved = offer.capabilities.iter().any(|c| c == TERMINAL_LABEL);
    send_answer(peer, offer, approved, outbound).await
}

/// Decline an offer while another session is live (ADR-14).
///
/// Still answers with a real SDP and `approved: false` — the browser's only
/// signal that the agent declined. `POST /api/signal/answer` rejects an empty
/// `sdp` (spec R19), so "refuse" cannot mean "send nothing".
pub async fn refuse_offer(
    peer: &Arc<RTCPeerConnection>,
    offer: &SignalOffer,
    outbound: &mpsc::Sender<SignalMessage>,
) -> Result<()> {
    send_answer(peer, offer, false, outbound).await
}

/// Set the remote description, produce an answer, send it with `approved`.
///
/// Shared by `answer_offer` and `refuse_offer` so the two cannot drift into
/// different SDP handling — the refusal path is the one that is never exercised
/// by the happy-path tests, and duplicated code there is how a refusal ends up
/// sending something the Worker rejects.
async fn send_answer(
    peer: &Arc<RTCPeerConnection>,
    offer: &SignalOffer,
    approved: bool,
    outbound: &mpsc::Sender<SignalMessage>,
) -> Result<()> {
    peer.set_remote_description(RTCSessionDescription::offer(offer.sdp.clone())?)
        .await
        .context("set_remote_description(offer)")?;

    let answer = peer.create_answer(None).await.context("create_answer")?;
    peer.set_local_description(answer.clone())
        .await
        .context("set_local_description")?;

    outbound
        .send(SignalMessage::Answer(SignalAnswer {
            session_id: offer.session_id.clone(),
            sdp: answer.sdp,
            approved,
        }))
        .await
        .context("send answer")?;

    Ok(())
}

/// Register the outbound candidate forwarder.
///
/// **This is what makes the connection work at all.** ICE needs a candidate
/// pair: the browser's candidates alone are not enough, and an agent that never
/// sends its own reaches `checking` and stops. Register it *before*
/// `answer_offer` — gathering starts when the local description is set, and a
/// handler registered afterwards misses the host candidates emitted in that
/// same tick.
///
/// `on_ice_candidate(None)` is the gathering-complete signal (spec R4): not an
/// error, and nothing to forward.
pub fn forward_candidates(
    peer: &Arc<RTCPeerConnection>,
    session_id: String,
    outbound: mpsc::Sender<SignalMessage>,
) {
    peer.on_ice_candidate(Box::new(move |candidate| {
        let outbound = outbound.clone();
        let session_id = session_id.clone();
        Box::pin(async move {
            let Some(candidate) = candidate else {
                return; // gathering complete
            };
            // `on_ice_candidate` hands us an `RTCIceCandidate`; the wire type is
            // `RTCIceCandidateInit` (serializable, spec R4). `to_json` is the
            // crate's bridge — it produces the `candidate:`-prefixed string and
            // the `sdpMid`/`sdpMLineIndex` pair the browser parses.
            let init = match candidate.to_json() {
                Ok(init) => prepare_outbound_candidate(init),
                Err(e) => {
                    tracing::warn!(error = %e, "dropping an unmappable candidate");
                    return;
                }
            };
            match candidate_to_wire(&session_id, init) {
                Ok(signal) => {
                    // Best-effort, like the Worker's push: a candidate that
                    // cannot be sent is a lost candidate, not a dead session —
                    // ICE retries and one lost candidate is rarely fatal.
                    if outbound
                        .send(SignalMessage::IceCandidate(signal))
                        .await
                        .is_err()
                    {
                        tracing::debug!("outbound closed while sending a candidate");
                    }
                }
                Err(e) => tracing::warn!(error = %e, "dropping an unmappable candidate"),
            }
        })
    }));
}

/// Apply one inbound candidate, buffering it if the remote description is not
/// set yet.
///
/// Returns `true` when the candidate was applied and `false` when it was
/// buffered. Buffering is not an optimisation: the browser trickles as soon as
/// it has the answer, so its first candidates routinely arrive before this side
/// has processed the offer, and `add_ice_candidate` fails outright with
/// `ErrNoRemoteDescription` (spec R3).
pub async fn apply_candidate(
    peer: &Arc<RTCPeerConnection>,
    pending: &mut Vec<RTCIceCandidateInit>,
    signal: IceCandidateSignal,
) -> Result<bool> {
    let index = narrow_mline_index(signal.sdp_mline_index)?;
    let init = RTCIceCandidateInit {
        candidate: signal.candidate,
        sdp_mid: signal.sdp_mid,
        sdp_mline_index: index,
        ..Default::default()
    };

    if peer.remote_description().await.is_none() {
        pending.push(init);
        return Ok(false);
    }

    peer.add_ice_candidate(init)
        .await
        .context("add_ice_candidate")?;
    Ok(true)
}

/// Fix up an outbound `RTCIceCandidateInit` for the wire.
///
/// webrtc 0.13's `to_json()` hardcodes `sdp_mid: Some("")` — a mid no m-line
/// has. The agent is a data-channel-only answerer with a single m-line, so the
/// candidate is addressed by `sdpMLineIndex` alone. Setting `sdp_mid` to
/// `None` makes the browser take the index path instead of searching for a
/// muxId of "". `sdpMLineIndex: Some(0)` (also from `to_json`) is correct
/// here: it is the one m-line.
fn prepare_outbound_candidate(mut init: RTCIceCandidateInit) -> RTCIceCandidateInit {
    init.sdp_mid = None;
    init
}

/// Convert an outbound crate candidate into the wire type.
///
/// `on_ice_candidate(None)` is the gathering-complete signal (spec R4) — not an
/// error, and not something to forward. Because the agent trickles,
/// `gathering_complete_promise()` is **not** used; that helper is for
/// non-trickle (blocking) gathering.
pub fn candidate_to_wire(
    session_id: &str,
    init: RTCIceCandidateInit,
) -> Result<IceCandidateSignal> {
    Ok(IceCandidateSignal {
        session_id: session_id.to_string(),
        candidate: init.candidate,
        sdp_mid: init.sdp_mid,
        sdp_mline_index: init.sdp_mline_index.map(i32::from),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn candidate_index_narrowing() {
        // Spec R7: out-of-range is rejected at the boundary, not truncated —
        // a truncated index associates the candidate with the wrong media
        // section, which surfaces as an ICE failure with no useful error.
        assert!(narrow_mline_index(Some(-1)).is_err());
        assert!(narrow_mline_index(Some(70000)).is_err());
        assert_eq!(narrow_mline_index(Some(0)).unwrap(), Some(0));
        assert_eq!(narrow_mline_index(Some(65535)).unwrap(), Some(65535));
        assert_eq!(narrow_mline_index(None).unwrap(), None);
    }

    #[test]
    fn candidate_wire_round_trip() {
        // `candidate_to_wire` is the outbound half of the interop contract, so
        // the field names are what the browser parses: `sdpMid`/`sdpMLineIndex`
        // in camelCase, `candidate` verbatim.
        let signal = candidate_to_wire(
            "s1",
            RTCIceCandidateInit {
                candidate: "candidate:1 1 udp 2130706431 127.0.0.1 54321 typ host".to_string(),
                sdp_mid: Some("0".to_string()),
                sdp_mline_index: Some(0),
                ..Default::default()
            },
        )
        .unwrap();

        let json = serde_json::to_value(SignalMessage::IceCandidate(signal)).unwrap();
        assert_eq!(json["type"], "ice-candidate");
        assert_eq!(json["data"]["sessionId"], "s1");
        assert_eq!(json["data"]["sdpMid"], "0");
        assert_eq!(json["data"]["sdpMLineIndex"], 0);
        assert!(json["data"].get("sdp_mid").is_none(), "must be camelCase");
    }

    #[test]
    fn outbound_candidate_has_no_empty_mid() {
        // webrtc 0.13's `to_json` produces `sdp_mid: Some("")` and
        // `sdp_mline_index: Some(0)` — the override in `prepare_outbound_candidate`
        // must strip the empty mid so the browser falls through to the
        // `sdpMLineIndex` path. This test pins that: remove the override and it
        // goes red (`sdpMid` would be `""` instead of `null`).
        let init = prepare_outbound_candidate(RTCIceCandidateInit {
            candidate: "candidate:1 1 udp 2130706431 127.0.0.1 54321 typ host".to_string(),
            sdp_mid: Some("".to_string()),
            sdp_mline_index: Some(0),
            ..Default::default()
        });

        let signal = candidate_to_wire("s1", init).unwrap();
        let json = serde_json::to_value(SignalMessage::IceCandidate(signal)).unwrap();
        // `sdp_mid` is `None` → JSON `null`, not `""`.
        assert_eq!(json["data"]["sdpMid"], serde_json::Value::Null);
        assert_eq!(json["data"]["sdpMLineIndex"], 0);
    }
}
