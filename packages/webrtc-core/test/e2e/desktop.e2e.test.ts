import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { useH264 } from 'werift';
import type { MediaStreamTrack as WeriftTrack, RtpPacket } from 'werift';
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
   * Open a desktop offerer: recvonly video, no data channels, and H.264 offered
   * explicitly. werift's default video codec list is VP8-only
   * (`generateDefaultPeerConfig`), so without the override the offer would
   * advertise VP8 and the agent — which serves H.264 — would have no video
   * m-line to answer into.
   */
  async function openDesktopPeer(
    sessionId: string,
    token: string,
  ): Promise<{
    offerer: PeerConnection;
    tracks: WeriftTrack[];
    packets: RtpPacket[];
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
        channelLabels: [],
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

    await offerer.start();
    return { offerer, tracks, packets };
  }

  it('receives a real H.264 track with flowing RTP', async () => {
    const { token, agentId, credential, sessionId } = await seed({
      capabilities: ['desktop'],
    });

    spawnAgent(agentId, credential, ['--desktop-source', 'test']);
    await waitForAgentOnline(token, agentId);

    const { offerer, tracks, packets } = await openDesktopPeer(sessionId, token);

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
  // bug — but the desktop session has no data channel, so the close signal is
  // ICE silence rather than an SCTP reset.
  it('ends the agent session on peer close and serves the next offer', async () => {
    const { token, agentId, credential, sessionId } = await seed({
      capabilities: ['desktop'],
    });

    const agent = spawnAgent(agentId, credential, ['--desktop-source', 'test']);
    await waitForAgentOnline(token, agentId);

    const first = await openDesktopPeer(sessionId, token);
    await waitFor(() => first.packets.length > 0, 'the first RTP packet', 20_000);

    // werift's `pc.close()` on a media-only connection sends neither a DTLS
    // close_notify nor an ICE packet — the socket simply goes quiet. The agent
    // detects that through ICE: with the media-only timeouts from Task 4
    // (disconnected 3s + failed 5s), it reaches `Failed` ~8s after the last
    // packet and ends the session. The bound must exceed 8s; 20s leaves room
    // for CI scheduling without hiding a genuinely hung session.
    await first.offerer.close();

    try {
      await waitFor(
        () => agent.output().includes('desktop session loop finished'),
        'the agent to end the desktop session after its peer closed',
        20_000,
      );
    } catch (error) {
      // The agent log is the evidence when this fails: a session that never
      // noticed the close shows no ICE transition at all.
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
