import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { useH264 } from 'werift';
import type { MediaStreamTrack as WeriftTrack, RtpPacket } from 'werift';
import type {
  DataChannelMessage,
  DesktopSourceInfo,
  DesktopStats,
} from '@ponter/shared';
import { PeerConnection } from '../../src/connection';
import { WeriftAdapter } from '../../src/adapters/werift';
import { RESTPollingTransport } from '../../src/transport';
import {
  isLinux,
  BASE_URL,
  setupE2E,
  teardownE2E,
  seed,
  spawnAgent,
  waitForAgentOnline,
  connectTerminal,
  postJson,
  sendKeystrokes,
  waitFor,
  waitForTerminalOutput,
} from './harness';

/**
 * Whether an RTP payload contains an H.264 IDR (NAL type 5).
 *
 * rtc-rtp's H.264 payloader emits a STAP-A (SPS+PPS) before the first slice,
 * then a single NAL when it fits the MTU or FU-A fragments when it does not.
 * An IDR therefore shows up as: a single NAL of type 5, an FU-A/FU-B whose
 * *start* fragment carries type 5, or a STAP-A containing a type-5 NAL.
 */
function hasIdr(payload: Buffer): boolean {
  if (payload.length === 0) return false;
  const nalType = payload[0]! & 0x1f;
  if (nalType === 5) return true;
  if ((nalType === 28 || nalType === 29) && payload.length >= 2) {
    return (payload[1]! & 0x1f) === 5;
  }
  if (nalType === 24) {
    let offset = 1;
    while (offset + 2 <= payload.length) {
      const size = payload.readUInt16BE(offset);
      offset += 2;
      if (size === 0 || offset + size > payload.length) break;
      if ((payload[offset]! & 0x1f) === 5) return true;
      offset += size;
    }
  }
  return false;
}

/**
 * Layer 3 for desktop streaming: a Rust agent capturing/encoding H.264, a
 * werift offerer, the real backend, and real SRTP over DTLS.
 *
 * Linux-only, and headless by construction: the agent is spawned with
 * `--desktop-source test` (ADR-17), so no display, portal, or PipeWire session
 * is involved — the stream is a deterministic pattern.
 */
describe.skipIf(!isLinux)('cross-language desktop E2E', () => {
  beforeAll(async () => {
    await setupE2E();
  }, 120_000);

  afterAll(async () => {
    await teardownE2E();
  }, 60_000);

  /**
   * Open a desktop offerer: recvonly video, the `control` data channel, and
   * H.264 offered explicitly. werift's default video codec list is VP8-only
   * (`generateDefaultPeerConfig`), so without the override the offer would
   * advertise VP8 and the agent — which serves H.264 — would have no video
   * m-line to answer into.
   *
   * Week 8: the desktop session carries a `'control'` channel. The `control`
   * flag defaults to `true`, so every call site gets it; the parameter exists
   * so a future test can still open a bare media peer.
   */
  async function openDesktopPeer(
    sessionId: string,
    token: string,
    { control = true }: { control?: boolean } = {},
  ): Promise<{
    offerer: PeerConnection;
    tracks: WeriftTrack[];
    packets: RtpPacket[];
    controlFrames: Array<DataChannelMessage<unknown>>;
  }> {
    const transport = new RESTPollingTransport({
      baseUrl: BASE_URL,
      sessionId,
      token,
    });
    const offerer = new PeerConnection(
      new WeriftAdapter({ iceServers: [], codecs: { video: [useH264()] } }),
      transport,
      {
        role: 'offerer',
        // Week 8: the desktop session carries a `control` channel. The media
        // path is unchanged; the label rides the existing manager (spec §5.2).
        channelLabels: control ? ['control'] : [],
        capabilities: ['desktop'],
        media: { video: true },
      },
    );

    const tracks: WeriftTrack[] = [];
    const packets: RtpPacket[] = [];
    offerer.onRemoteTrack((track) => {
      const wt = track as unknown as WeriftTrack;
      tracks.push(wt);
      // Subscribe in the same turn the track is announced, so a packet that
      // arrives immediately after is not missed.
      wt.onReceiveRtp.subscribe((pkt) => packets.push(pkt));
    });

    // Register the control listener BEFORE `start()`: the agent sends
    // `desktop-sources` as soon as the channel opens, and the manager drops a
    // message that arrives with no typed listener registered (no replay —
    // `data-channel.ts` only fans out to listeners present at delivery time).
    // The channel itself is registered in the `PeerConnection` constructor
    // (the offerer pre-create block), so the listener must exist before the
    // offer goes out.
    const controlFrames: Array<DataChannelMessage<unknown>> = [];
    if (control) {
      offerer.dataChannels.onMessage('control', (msg) =>
        controlFrames.push(msg),
      );
    }

    await offerer.start();
    if (control) {
      const channel = await offerer.waitForChannel('control', 20_000);
      expect(channel.readyState).toBe('open');
    }
    return { offerer, tracks, packets, controlFrames };
  }

  /**
   * Seed a desktop session, spawn the agent against the deterministic test
   * source (ADR-17), open a control-carrying peer, and expose the received
   * `desktop-stats` frames as a lazy view. The control tests share this whole
   * prologue; keeping it in one place is what keeps them readable (and keeps
   * their bodies from being flagged as duplicate code).
   */
  async function openTestDesktopStream(): Promise<{
    offerer: PeerConnection;
    packets: RtpPacket[];
    controlFrames: Array<DataChannelMessage<unknown>>;
    stats: () => DesktopStats[];
  }> {
    const { token, agentId, credential, sessionId } = await seed({
      capabilities: ['desktop'],
    });
    spawnAgent(agentId, credential, ['--desktop-source', 'test']);
    await waitForAgentOnline(token, agentId);

    const { offerer, packets, controlFrames } = await openDesktopPeer(
      sessionId,
      token,
    );
    const stats = (): DesktopStats[] =>
      controlFrames
        .filter((f) => f.type === 'desktop-stats')
        .map((f) => f.payload as DesktopStats);
    return { offerer, packets, controlFrames, stats };
  }

  it('receives a real H.264 track with flowing RTP', async () => {
    const { token, agentId, credential, sessionId } = await seed({
      capabilities: ['desktop'],
    });

    spawnAgent(agentId, credential, ['--desktop-source', 'test']);
    await waitForAgentOnline(token, agentId);

    const { offerer, tracks, packets } = await openDesktopPeer(
      sessionId,
      token,
    );

    try {
      // If the answer's track were attached after `set_remote_description`
      // (ADR-15), no track would ever arrive — this is the order-of-operations
      // assertion from Review Focus #1.
      await waitFor(() => tracks.length > 0, 'a remote video track', 20_000);
      const track = tracks[0]!;
      expect(track.kind).toBe('video');

      // The floor is far below 15 fps × 15 s; it tolerates CI jitter while
      // still proving the stream is continuous rather than a lone packet.
      await waitFor(
        () => packets.length >= 30,
        'at least 30 RTP packets over the window',
        15_000,
      );

      // H.264, and every packet on the negotiated payload type. The literal PT
      // is deliberately NOT pinned: the agent answers with the PT it accepted
      // from the offer, and `track.codec` — built by werift from the answer
      // SDP — is the source of truth. The comparison is case-insensitive: RFC
      // 4566 leaves the MIME type case-insensitive and werift normalizes to
      // lowercase ("video/h264") at parse time, so a case-sensitive `.toBe`
      // would pin werift's normalization rather than the negotiated codec.
      expect(track.codec?.mimeType.toLowerCase()).toBe('video/h264');
      const pt = track.codec!.payloadType;
      expect(packets.every((p) => p.header.payloadType === pt)).toBe(true);

      // At least one keyframe in the window (ADR-16: periodic IDR).
      expect(packets.some((p) => hasIdr(p.payload))).toBe(true);
    } finally {
      await offerer.close();
    }
  }, 120_000);

  // Review Focus #5, the desktop half: a dead peer must not keep the ADR-14
  // slot. This is the desktop twin of the terminal `fix/agent-session-dead-peer`
  // bug. Week 7's desktop session had no data channel, so the close signal was
  // ICE silence; Week 8's carries a `control` channel, so the signal is now the
  // channel close (the same one the terminal path uses).
  it('ends the agent session on peer close and serves the next offer', async () => {
    const { token, agentId, credential, sessionId } = await seed({
      capabilities: ['desktop'],
    });

    const agent = spawnAgent(agentId, credential, ['--desktop-source', 'test']);
    await waitForAgentOnline(token, agentId);

    const first = await openDesktopPeer(sessionId, token);
    await waitFor(
      () => first.packets.length > 0,
      'the first RTP packet',
      20_000,
    );

    // werift's `pc.close()` tears down the SCTP association, so the agent sees
    // the `control` channel close and ends the session promptly (the same
    // signal the terminal path uses). Week 7 had no data channel here and
    // depended on the shortened media-only ICE timeouts; that path is gone —
    // a desktop peer with a control channel keeps the RFC-shaped defaults
    // (Task 4a), so the close must arrive through the channel, not ICE.
    await first.offerer.close();

    try {
      await waitFor(
        () => agent.output().includes('desktop session loop finished'),
        'the agent to end the desktop session after its peer closed',
        20_000,
      );
    } catch (error) {
      // The agent log is the evidence when this fails: a session that never
      // noticed the close shows no channel-close transition at all.
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\n` +
          `--- agent output ---\n${agent.output()}`,
      );
    }
    expect(agent.child.exitCode).toBeNull();

    // A fresh session for the same agent must connect: the dead peer must not
    // have swallowed the slot (ADR-14's "ready for the next offer").
    const session2 = await postJson<{ id: string }>(
      '/api/sessions',
      { agentId },
      token,
    );
    const second = await openDesktopPeer(session2.id, token);
    try {
      await waitFor(
        () => second.packets.length > 0,
        'the second session to receive RTP',
        20_000,
      );
    } finally {
      await second.offerer.close();
    }
  }, 120_000);

  // Review Focus: the control channel is the new inbound surface, so the first
  // thing to pin is that it opens and the agent enumerates onto it (spec §8.3).
  it('opens a control channel and enumerates the default test source', async () => {
    const { offerer, controlFrames } = await openTestDesktopStream();
    try {
      await waitFor(
        () => controlFrames.some((f) => f.type === 'desktop-sources'),
        'a desktop-sources frame on the control channel',
        20_000,
      );

      const frame = controlFrames.find((f) => f.type === 'desktop-sources')!;
      expect(frame.channel).toBe('control');
      const sources = (frame.payload as { sources: DesktopSourceInfo[] })
        .sources;

      // `--desktop-source test` enumerates exactly one entry, flagged default —
      // which is why CI never has to send `desktop-select` (ADR-22).
      expect(sources).toHaveLength(1);
      expect(sources[0]!.id).toBe('test:0');
      expect(sources[0]!.default).toBe(true);
      expect(sources[0]!.kind).toBe('monitor');
      // The geometry fields Week 9's input mapping will need are on the wire.
      expect(sources[0]!.width).toBe(1280);
      expect(sources[0]!.height).toBe(720);
      expect(sources[0]!.scaleFactor).toBe(1);
    } finally {
      await offerer.close();
    }
  }, 120_000);

  // The wire path and the stats echo, not the encoder internals (those are
  // Rust unit tests, Task 4b). Pins spec §2.3 step 6.
  it('applies a manual bitrate and reflects it in a later desktop-stats', async () => {
    const { offerer, stats } = await openTestDesktopStream();

    try {
      // The stream emits a first `desktop-stats` on its first encoded frame.
      await waitFor(
        () => stats().length > 0,
        'an initial desktop-stats',
        20_000,
      );

      offerer.dataChannels.sendJson('control', 'desktop-bitrate', {
        bitrateBps: 3_000_000,
      });

      await waitFor(
        () => stats().some((s) => s.targetBitrateBps === 3_000_000),
        'a desktop-stats echoing the 3 Mbps target',
        20_000,
      );
    } finally {
      await offerer.close();
    }
  }, 120_000);

  // The §2.2 error contract: an unknown id is refused, the stream keeps
  // running, and the refusal arrives as `status.kind = 'select-refused'` on a
  // `desktop-stats` — never as a dedicated error frame, and never as a source
  // the agent did not enumerate (spec §9).
  it('refuses an unknown desktop-select and keeps streaming', async () => {
    const { offerer, packets, controlFrames } = await openTestDesktopStream();
    try {
      await waitFor(
        () => controlFrames.some((f) => f.type === 'desktop-sources'),
        'the source enumeration',
        20_000,
      );

      const before = packets.length;
      offerer.dataChannels.sendJson('control', 'desktop-select', {
        sourceId: 'monitor:999999',
      });

      await waitFor(
        () =>
          controlFrames.some(
            (f) =>
              f.type === 'desktop-stats' &&
              (f.payload as DesktopStats).status?.kind === 'select-refused',
          ),
        'a select-refused status on desktop-stats',
        20_000,
      );

      // The refusal must not have killed the stream: RTP keeps flowing.
      await waitFor(
        () => packets.length > before,
        'continued RTP after a refused selection',
        15_000,
      );
    } finally {
      await offerer.close();
    }
  }, 120_000);

  // A source swap must report the *real* frame size, never the profile box.
  // `downscale` never upscales, so the test source (1280×720) stays 1280×720
  // under the 1080p30 default box (1920×1080) — the UI must be told the former.
  // Re-selecting the only test source is a real (non-refused) swap (ADR-22).
  it('reports the real frame size after a source swap, not the profile box', async () => {
    const { offerer, stats } = await openTestDesktopStream();

    try {
      await waitFor(
        () => stats().length > 0,
        'an initial desktop-stats',
        20_000,
      );
      const before = stats().length;

      offerer.dataChannels.sendJson('control', 'desktop-select', {
        sourceId: 'test:0',
      });

      // The first stats after the swap must carry the real frame size. With the
      // profile-box bug it carries 1920×1080 and never self-corrects, so this
      // wait times out — the regression the fix pins.
      await waitFor(
        () =>
          stats()
            .slice(before)
            .some((s) => s.width === 1280 && s.height === 720),
        'a post-swap desktop-stats with the real frame size',
        20_000,
      );
      expect(
        stats()
          .slice(before)
          .every((s) => s.width === 1280 && s.height === 720),
      ).toBe(true);
    } finally {
      await offerer.close();
    }
  }, 120_000);

  // Review Focus #4: desktop mode must not have altered the terminal answer
  // path. The agent is spawned with the desktop flag present but is offered a
  // terminal session, and the terminal frame contract must be unchanged.
  it('leaves the terminal flow unaffected', async () => {
    const { token, agentId, credential, sessionId } = await seed(); // default: terminal

    spawnAgent(agentId, credential, ['--desktop-source', 'test']);
    await waitForAgentOnline(token, agentId);

    const { offerer, frames } = await connectTerminal(sessionId, token);

    try {
      sendKeystrokes(offerer, sessionId, 'echo hello\n');
      await waitForTerminalOutput(frames, 'hello');

      expect(frames[0]?.channel).toBe('terminal');
      expect(frames[0]?.type).toBe('terminal-data');
    } finally {
      await offerer.close();
    }
  }, 90_000);
});
