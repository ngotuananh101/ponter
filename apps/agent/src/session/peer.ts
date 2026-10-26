import type { RTCRtpSenderLike } from '@ponter/webrtc-core';

export interface PeerLike {
  /**
   * Attach the outbound track. Returns the sender — the SAME handle whose
   * `writeRtp` the desktop loop calls, which is why `answer()` returns it.
   * Plan 1 Task 2's `RTCRtpSenderLike` is the real type; this is the slice.
   * werift's `addTrack` is synchronous (`peerConnection.js:981`), so the
   * return is not awaited here — but a mock may return a promise, and `await`
   * covers both.
   */
  addTrack?(
    track: unknown,
    stream?: unknown,
  ): RTCRtpSenderLike | Promise<RTCRtpSenderLike>;
  setRemoteDescription(desc: { type: 'offer'; sdp: string }): Promise<void>;
  createAnswer(): Promise<{ type: 'answer'; sdp: string }>;
  setLocalDescription(desc: { type: 'answer'; sdp: string }): Promise<void>;
  close(): Promise<void>;
}

/**
 * **R-S3 is a method on the SENDER, not on the peer connection.**
 *
 * `RTCPeerConnectionLike` has no `selectNegotiatedCodec` (`types.ts:78-127`);
 * the adapter attaches it to the `RTCRtpSenderLike` its `addTrack` returns
 * (`adapters/werift.ts:338`). An earlier draft of this task put it on
 * `PeerLike` and called it as `this.peer.selectNegotiatedCodec(...)`, which
 * would have been `undefined` at runtime — the re-point silently skipped, the
 * sender left on the browser's mode-0 entry, and every frame depacketized
 * wrongly with no error anywhere. This is the third time a per-task seam in
 * this plan has been guessed at a layer above where it lives; the rule is to
 * read the adapter, never to infer the shape from the method's name.
 */

/**
 * Find the browser's H.264 `packetization-mode=1` entry in an offer.
 *
 * This is R-S3's input. It parses the offer's `a=rtpmap:`/`a=fmtp:` pairs and
 * returns the first H.264 entry whose fmtp explicitly carries
 * `packetization-mode=1`. Returns `null` when the browser offered no such
 * entry, in which case no re-point is possible and the caller treats that as a
 * hard failure for a desktop session: the packetizer emits mode-1 framing and a
 * mode-0-only peer cannot decode it.
 *
 * An **absent** `packetization-mode` is mode 0, not mode 1 — RFC 6184 §8.1
 * states the default is 0. Treating absence as mode 1 would silently select a
 * non-existent mode-1 entry and defeat R-S3 on exactly the peers it protects.
 */
export function h264Mode1Codec(offerSdp: string): {
  mimeType: string;
  payloadType: number;
  parameters?: string;
} | null {
  const lines = offerSdp.split(/\r\n|\n/);
  for (const line of lines) {
    const rtpmap = /^a=rtpmap:(\d+) (H264)\/90000$/i.exec(line);
    if (!rtpmap) continue;
    const payloadType = Number(rtpmap[1]);
    const fmtp = lines.find((l) => l.startsWith(`a=fmtp:${payloadType} `));
    const parameters = fmtp ? fmtp.slice(`a=fmtp:${payloadType} `.length) : '';
    // RFC 6184 §8.1: `packetization-mode` defaults to 0, but every real H.264
    // offer carries it explicitly. An absent key means mode 0 by the letter of
    // the RFC — do NOT treat absent as mode 1.
    const mode = /(?:^|;)packetization-mode=(\d+)/.exec(parameters);
    if (mode?.[1] === '1') {
      return { mimeType: 'video/H264', payloadType, parameters };
    }
  }
  return null;
}

export interface DataChannelLike {
  label(): Promise<string>;
  close(): Promise<void>;
}

export interface SessionPeerOptions {
  acceptedLabel: string;
}

/**
 * The answerer half of one session.
 *
 * **Track before `setRemoteDescription`, always** (B12). `addTrack` creates the
 * transceiver and therefore the m-line; adding it after the remote description
 * exists means the offer's video m-line is answered `inactive` and the browser
 * never receives a track. There is no error anywhere — the video is simply
 * black — which is why `answer()` enforces the order internally instead of
 * leaving it to the caller, and why the test asserts the call order rather than
 * the result.
 *
 * The data-channel gate (B13) closes a wrong-label channel immediately and
 * swallows the close error: the peer is hostile or buggy, and a failed close is
 * not something the agent can act on. A second channel with the *right* label is
 * also closed — one session has exactly one channel.
 *
 * `close()` takes no code. The Rust API had none either (DCEP teardown is
 * unparameterised), so inventing a 4000-series code here would be a protocol
 * claim the transport cannot honour.
 */
export class SessionPeer {
  channel: DataChannelLike | null = null;

  constructor(
    private readonly peer: PeerLike,
    private readonly options: SessionPeerOptions,
  ) {}

  async answer(
    offerSdp: string,
    opts: { desktop: boolean; track?: { track: unknown; stream?: unknown } },
  ): Promise<{ answerSdp: string; sender: RTCRtpSenderLike | null }> {
    // B12: the track is attached BEFORE setRemoteDescription. `addTrack` is what
    // creates the transceiver and therefore the offer's video m-line; doing it
    // after means the m-line is answered `inactive` and the browser gets no
    // video — silently, with no error anywhere.
    let sender: RTCRtpSenderLike | null = null;
    if (opts.desktop) {
      if (!opts.track) {
        throw new Error(
          'a desktop session was answered with no outbound track to send',
        );
      }
      sender =
        (await this.peer.addTrack?.(opts.track.track, opts.track.stream)) ??
        null;
      if (!sender) {
        throw new Error(
          'the peer connection has no addTrack; it cannot answer a desktop session',
        );
      }
    }
    await this.peer.setRemoteDescription({ type: 'offer', sdp: offerSdp });

    // R-S3: re-point the sender at the browser's H.264 `packetization-mode=1`
    // entry, and do it HERE — after `setRemoteDescription`, before
    // `createAnswer`.
    //
    //   - It must be after `setRemoteDescription`: that call is what runs
    //     `prepareSend` and assigns `transceiver.codecs` from the offer
    //     (transceiverManager.js:276-277), so before it there is nothing
    //     negotiated to select from and `selectNegotiatedCodec` would throw
    //     "was not negotiated".
    //   - It must be before `createAnswer`: that call builds the answer's
    //     `m=video` payload-type order from `transceiver.codecs`
    //     (sdpManager.js:90-100). Re-pointing afterwards leaves the emitted SDP
    //     advertising the old order while the sender writes the new payload
    //     type — a mismatch the browser resolves by dropping the packets.
    //
    // The entry comes from the OFFER, parsed by `h264Mode1Codec` — the adapter
    // exposes senders, not the transceiver's codec list, so there is no
    // accessor to ask.
    if (sender) {
      const mode1 = h264Mode1Codec(offerSdp);
      if (!mode1) {
        // The packetizer only emits mode-1 framing (single-NAL / STAP-A /
        // FU-A). A mode-0-only peer cannot decode any of it. Failing here is
        // the only place this is visible at all: the connection would come up
        // healthy and the video would simply be black.
        throw new Error(
          'the desktop offer carries no H.264 entry with packetization-mode=1; the packetizer cannot serve this peer',
        );
      }
      sender.selectNegotiatedCodec(mode1);
    }

    const answer = await this.peer.createAnswer();
    await this.peer.setLocalDescription(answer);
    return { answerSdp: answer.sdp, sender };
  }

  async handleDataChannel(channel: DataChannelLike): Promise<void> {
    let label: string;
    try {
      label = await channel.label();
    } catch {
      return;
    }
    if (label !== this.options.acceptedLabel) {
      await channel.close().catch(() => undefined);
      return;
    }
    if (this.channel !== null) {
      await channel.close().catch(() => undefined);
      return;
    }
    this.channel = channel;
  }
}
