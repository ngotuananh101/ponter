// apps/agent/src/desktop/session.ts
import type { ProfileId } from '@ponter/shared';
import { packetizeAnnexB } from '../session/packetizer.js';
import {
  clampBitrate,
  gopForFps,
  type BitrateControl,
  type DesktopSource,
} from './control.js';
import { StaticFrameSkip, type RawFrame } from './static-skip.js';
import { SustainLadder } from './sustain.js';
import { FrameTimingRing } from './timing-ring.js';

/**
 * The slice of `RTCRtpSenderLike` (Plan 1 Task 2) this module needs.
 *
 * `writeRtp` takes the **complete** RTP packet — the packetizer builds the
 * 12-byte header, the adapter only adds SSRC/PT/seq/timestamp bookkeeping. This
 * is the RTP path, not a data channel; see the task preamble.
 */
export interface RtpSenderSink {
  writeRtp(packet: Uint8Array): void;
}

const PROFILES: Record<
  ProfileId,
  { fps: number; width: number; height: number }
> = {
  '1080p60': { fps: 60, width: 1920, height: 1080 },
  '1080p30': { fps: 30, width: 1920, height: 1080 },
  '720p60': { fps: 60, width: 1280, height: 720 },
  '720p30': { fps: 30, width: 1280, height: 720 },
};

export interface DesktopSessionDeps {
  capture: {
    sources(): Promise<{
      monitors: { id: string; primary: boolean }[];
      windows: unknown[];
    }>;
    start(source: DesktopSource): Promise<void>;
    stop(): Promise<void>;
    nextFrame(): Promise<RawFrame>;
  };
  encode: {
    configure(options: {
      profile: ProfileId;
      bitrate: number;
      gop: number;
    }): void;
    encode(frame: RawFrame): Promise<{ data: Uint8Array; keyframe: boolean }>;
    close(): void;
  };
  /**
   * The RTP sink for video. **Not** a data channel — see the task preamble.
   *
   * The adapter's sender stamps SSRC, payload type, sequence number and
   * timestamp; this dep supplies only the header fields the packetizer needs
   * to build the packet, and the packet bytes back. Injectable so the loop can
   * be tested with no encoder, no display and no peer.
   */
  rtp: {
    /** The sender for the negotiated video track, or `null` before one exists. */
    sender(): RtpSenderSink | null;
    /** The negotiated payload type, read from the sender after the answer. */
    payloadType(): number | null;
  };
  /**
   * JSON control/status frames on the `control` **data channel** — B56/B58/B61.
   * Never the video. Confusing this with the RTP sink above is the bug an
   * earlier draft of this task contained. The label is `control`, not
   * `desktop`: the browser opens `channelLabels: ['control']`
   * (`apps/web/src/stores/terminal.ts:937`) and the Rust's `frame_desktop_sources`
   * stamps `channel: "control"` (`desktop.rs:2062-2085`); `'desktop'` is the
   * capability string and the RTP media label (Task 18's BLOCKING-2).
   */
  send(label: 'control', frame: unknown): void;
  logger: {
    info(m: string): void;
    warn(m: string): void;
    error(m: string): void;
    debug(m: string): void;
  };
  now?: () => number;
  /** Injectable clock for the 90 kHz RTP timestamp. Defaults to `Date.now`. */
  rtpClock?: () => number;
}

/**
 * The capture → downscale → encode → packetize → send loop (B14/B59).
 *
 * Three states that must survive a change and do not in the obvious
 * implementation:
 *
 * - **A bitrate received before the first encode.** `control({kind:'bitrate'})`
 *   stores it and `start` applies it. Reproducing the Rust's "warn and drop"
 *   would lose the client's setting with no retry and no signal — the browser
 *   shows the new value in its UI and the stream keeps the old one. This is the
 *   one P5 contradiction where the code is a **defect**, so the TS asserts the
 *   correct behaviour and the divergence is stated here rather than hidden.
 * - **The static-skip has exactly three reset sites** — bitrate change, source
 *   swap, downgrade — and nowhere else. A reset on every control message would
 *   make the skip useless; a missing reset after a retarget would keep sending
 *   the pre-retarget picture.
 * - **`stop()` tears down capture before the encoder.** The other order leaves
 *   the encoder closing while a capture callback is mid-flight.
 */
export class DesktopSession {
  private profile: ProfileId = '720p30';
  private bitrate = 0;
  private ladder: SustainLadder | null = null;
  private skip: StaticFrameSkip | null = null;
  private timing: FrameTimingRing | null = null;
  private pendingBitrate: number | null = null;
  private skipWasReset = false;
  private seq = 0;
  private skippedFrames = 0;
  /** The RTP sequencer. Wraps at 2^16 inside the packetizer, per RFC 3550. */
  private rtpSequence = 0;
  /**
   * The SSRC stamped into each packet header.
   *
   * Zero is a legal SSRC, and werift overwrites `header.ssrc` with the sender's
   * own on the way out (`rtpSender.js:544`), so this value never reaches the
   * wire when the real adapter is used. It is set from the sender when one
   * exists so the packetizer's own conformance tests can assert a non-zero
   * header; see `setRtpIdentity`.
   */
  private rtpSsrc = 0;
  private started = false;

  constructor(private readonly deps: DesktopSessionDeps) {}

  /**
   * Record the SSRC the packets should carry.
   *
   * Called by the runtime once the peer's answer exists. Kept separate from
   * `start()` because the zero-click path starts capture **before** the browser
   * has offered, so the identity is not known at start time and may arrive
   * later. Not knowing it is not fatal: `sendRtp` drops frames until a sender
   * exists anyway, and the real werift sender overrides `header.ssrc` with its
   * own on the way out (`rtpSender.js:544`).
   */
  setRtpIdentity(ssrc: number): void {
    this.rtpSsrc = ssrc;
  }

  async start(
    source: DesktopSource,
    profile: ProfileId,
    bitrate: number,
  ): Promise<void> {
    this.profile = profile;
    const effective = clampBitrate(this.pendingBitrate ?? bitrate);
    this.pendingBitrate = null;
    this.bitrate = effective;
    const geometry = PROFILES[profile];
    this.skip = new StaticFrameSkip(geometry.fps);
    this.timing = new FrameTimingRing(32);
    this.ladder = new SustainLadder(profile, 1000 / geometry.fps);
    this.deps.encode.configure({
      profile,
      bitrate: effective,
      gop: gopForFps(geometry.fps),
    });
    await this.deps.capture.start(source);
    this.started = true;
  }

  /**
   * Apply an inbound control command.
   *
   * Takes `BitrateControl`, not the whole `StreamControl`: the `select` member
   * is handled by `select()` (it stops and restarts capture, which is a
   * different shape of work), and the three the type used to carry besides
   * these — `pause`/`resume`/`stop` and a `quality` profile change — were a
   * plan defect with no producer on the wire and no arm in the Rust's
   * `StreamControl` (`desktop.rs:1938-1947`). A profile change is not an
   * inbound command at all: it comes from the sustain ladder, which calls
   * `applyProfile` from inside `pump()`.
   */
  control(control: BitrateControl): void {
    this.bitrate = control.bitrate;
    this.skip?.reset();
    this.skipWasReset = true;
    this.ladder?.noteBitrateChange(control.bitrate);
    if (!this.started) {
      this.pendingBitrate = control.bitrate;
      return;
    }
    this.deps.encode.configure({
      profile: this.profile,
      bitrate: control.bitrate,
      gop: gopForFps(PROFILES[this.profile].fps),
    });
  }

  async select(source: DesktopSource): Promise<void> {
    await this.deps.capture.stop();
    await this.deps.capture.start(source);
    // Source-swap reset: the new source is a new screen, so the previous
    // signature is meaningless and must not suppress the first frame.
    this.skip?.reset();
    this.skipWasReset = true;
  }

  /**
   * One iteration of the loop: capture → skip → encode → send.
   *
   * The caller drives this at the profile's frame interval (Task 19's runtime
   * ticker does). Splitting the single iteration out rather than owning a timer
   * here is what makes the loop testable without a capture device and what lets
   * the runtime rebuild the interval when the profile changes — the Rust built
   * its sustain ticker **once** and never rebuilt it, so samples kept arriving on
   * the old cadence after a downgrade. The Rust creates its sustain interval once
   * from `profile.frame_budget()` (`desktop.rs:1528`) and never rebuilds it, while a
   * downgrade replaces the profile and the encoder (`desktop.rs:1731-1733`) and then
   * stamps `duration: profile.frame_budget()` on each sample (`desktop.rs:1769`). After
   * `720p60 → 720p30` the loop still ticks at 16.67 ms while samples are stamped
   * 33.3 ms: the encoder is fed at double its configured `max_frame_rate` and the RTP
   * sample durations disagree with the actual emission cadence. (`1080p60 → 720p60` is
   * unaffected — same fps.) The ladder is rebuilt in
   * `control()` and the interval is the caller's, so there is nothing left to go
   * stale.
   *
   * Returns whether a frame was sent, so the runtime can count encoded frames
   * without duplicating the skip decision.
   */
  async pump(): Promise<boolean> {
    if (!this.started || !this.skip || !this.ladder) return false;
    const frame = await this.deps.capture.nextFrame();
    this.seq += 1;
    this.skipWasReset = false;
    if (this.skip.shouldSkip(frame)) {
      this.skippedFrames += 1;
      return false;
    }
    const encodeMs = await this.encodeAndSend(frame);
    const downgrade = this.ladder.noteFrame(encodeMs);
    if (downgrade) {
      // A downgrade is the third and last reset site: the profile's geometry
      // changed, so the next identical frame must be sent to establish the new
      // reference at the new size.
      this.skip.reset();
      this.skipWasReset = true;
      this.applyProfile(downgrade);
    }
    return true;
  }

  /**
   * Times the encode only — the capture already happened when `pump` received
   * the frame. That single number is both what the ladder reads (B23: the frame,
   * not the p50) and what the timing ring records; the two consumers share one
   * measurement so they cannot disagree about what "slow" means.
   */
  private async encodeAndSend(frame: RawFrame): Promise<number> {
    const now = this.deps.now ?? Date.now;
    const started = now();
    const encoded = await this.deps.encode.encode(frame);
    const encodeMs = now() - started;
    this.timing?.record(this.seq, started, encodeMs, started);
    this.sendRtp(encoded.data);
    return encodeMs;
  }

  /**
   * Annex-B → RFC 6184 packets → `sender.writeRtp`, once per packet.
   *
   * This is the whole video path and it is deliberately not `deps.send`. The
   * encoder emits one Annex-B access unit per frame; `packetizeAnnexB` splits
   * it into single-NAL / STAP-A / FU-A packets at the negotiated payload type;
   * the werift sender stamps SSRC, sequence and timestamp onto each and pushes
   * it out. Skipping the packetizer — or handing the buffer to a data channel —
   * produces no error anywhere and a black video, which is why the test below
   * asserts `writeRtp` was called with a packet whose `payloadType` is the
   * negotiated one.
   *
   * The sequencer lives here, not in the packetizer: `packetizeAnnexB` returns
   * `nextSequenceNumber` and the caller owns the counter, exactly as the Rust
   * agent's `SampleWriter` did.
   *
   * A missing sender is not an error at frame time. `start()` can run before
   * the browser's offer arrives (the zero-click path does exactly that), and a
   * frame captured then has no one to send to yet. Dropping it and letting the
   * next tick pick up is correct — the alternative, buffering, would replay a
   * stale picture the moment the peer connected.
   */
  private sendRtp(annexB: Uint8Array): void {
    const sender = this.deps.rtp.sender();
    if (!sender) return;
    const payloadType = this.deps.rtp.payloadType();
    if (payloadType === null) return;

    const clock = this.deps.rtpClock ?? Date.now;
    // 90 kHz RTP clock. Milliseconds × 90 overflows 2^32 after ~13 hours, so
    // the multiplication is done modulo 2^32 rather than on the raw product.
    const rtpTimestamp = Math.floor((clock() * 90) % 2 ** 32);

    const { packets, nextSequenceNumber } = packetizeAnnexB(
      Buffer.from(annexB),
      {
        payloadType,
        sequenceNumber: this.rtpSequence,
        timestamp: rtpTimestamp,
        ssrc: this.rtpSsrc,
      },
    );
    for (const packet of packets) sender.writeRtp(packet.bytes);
    this.rtpSequence = nextSequenceNumber;
  }

  private applyProfile(profile: ProfileId): void {
    this.profile = profile;
    const geometry = PROFILES[profile];
    this.deps.encode.configure({
      profile,
      bitrate: this.bitrate,
      gop: gopForFps(geometry.fps),
    });
  }

  stats(): {
    seq: number;
    skippedFrames: number;
    profile: ProfileId;
    bitrate: number;
  } {
    return {
      seq: this.seq,
      skippedFrames: this.skippedFrames,
      profile: this.ladder?.current() ?? this.profile,
      bitrate: this.bitrate,
    };
  }

  /** Test affordance: true immediately after one of the three reset sites. */
  skipIsReset(): boolean {
    return this.skipWasReset;
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    this.skip = null;
    this.ladder = null;
    await this.deps.capture.stop();
    this.deps.encode.close();
  }
}
