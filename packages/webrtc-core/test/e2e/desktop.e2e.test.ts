import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { useH264 } from 'werift';
import type { MediaStreamTrack as WeriftTrack, RtpPacket } from 'werift';
import type {
  DataChannelMessage,
  DesktopCursorPayload,
  DesktopSourceInfo,
  DesktopStats,
} from '@ponter/shared';
import { PeerConnection } from '../../src/connection';
import { WeriftAdapter } from '../../src/adapters/werift';
import { RESTPollingTransport } from '../../src/transport';
import type { PeerConnectionIdentity } from '../../src/types';
import {
  isLinux,
  BASE_URL,
  setupE2E,
  teardownE2E,
  seed,
  spawnAgent,
  waitForAgentOnline,
  waitForAgentSigningKey,
  buildPeerIdentity,
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
 * The `--desktop-source test` pattern's geometry (agent `test_source_info`).
 * The cursor poller maps the X11 root pointer into this box and normalizes to
 * 0..1, so the E2E converts a reported normalized coordinate back to pixels
 * with these dims to assert the ±2 px round-trip tolerance (spec §6).
 */
const TEST_SOURCE_WIDTH = 1280;
const TEST_SOURCE_HEIGHT = 720;

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
    identity?: PeerConnectionIdentity,
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
        sessionId,
        ...(identity ? { identity } : {}),
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
   *
   * Phase 6b (ADR-45/47) extends this additively: `allowInput` opens the input
   * gate, `display` gives the agent an X server (needed by the cursor poller and
   * by input injection), `env` adds extra agent env, and the agent handle is
   * returned so a test can assert its logs. Every default preserves the pre-6b
   * behaviour, so the existing call sites are unchanged.
   */
  async function openTestDesktopStream({
    allowInput = false,
    display = false,
    env = {},
  }: {
    allowInput?: boolean;
    display?: boolean;
    env?: NodeJS.ProcessEnv;
  } = {}): Promise<{
    offerer: PeerConnection;
    packets: RtpPacket[];
    controlFrames: Array<DataChannelMessage<unknown>>;
    stats: () => DesktopStats[];
    agent: { output: () => string };
  }> {
    const { token, agentId, credential, sessionId, userSigning } = await seed({
      capabilities: ['desktop'],
    });
    const args = [
      '--desktop-source',
      'test',
      ...(allowInput ? ['--allow-input'] : []),
    ];
    const agent = spawnAgent(agentId, credential, args, {
      ...(display ? { DISPLAY: process.env.DISPLAY ?? ':99' } : {}),
      ...env,
    });
    await waitForAgentOnline(token, agentId);
    const agentSigningPublicKey = await waitForAgentSigningKey(token, agentId);
    const identity = buildPeerIdentity(
      userSigning.privateKey,
      userSigning.publicKeyRawBase64,
      agentSigningPublicKey,
    );

    const { offerer, packets, controlFrames } = await openDesktopPeer(
      sessionId,
      token,
      identity,
    );
    const stats = (): DesktopStats[] =>
      controlFrames
        .filter((f) => f.type === 'desktop-stats')
        .map((f) => f.payload as DesktopStats);
    return { offerer, packets, controlFrames, stats, agent };
  }

  /** The `inputEnabled` flag the agent last reported on `desktop-sources`. */
  const inputEnabled = (
    frames: Array<DataChannelMessage<unknown>>,
  ): boolean | undefined => {
    const frame = frames.findLast((f) => f.type === 'desktop-sources');
    return (frame?.payload as { inputEnabled?: boolean } | undefined)
      ?.inputEnabled;
  };

  /** The received `desktop-cursor` payloads, in arrival order (oldest first). */
  const cursorFrames = (
    frames: Array<DataChannelMessage<unknown>>,
  ): DesktopCursorPayload[] =>
    frames
      .filter((f) => f.type === 'desktop-cursor')
      .map((f) => f.payload as DesktopCursorPayload);

  /**
   * Send one pointer-move at a known normalized point.
   *
   * Phase 6b (ADR-47) added an optional browser-assigned `seq`: the agent caches
   * the last applied seq and echoes it on the next `desktop-cursor` frame, which
   * is the round-trip signal the cursor E2E pins. Omitting it (the pre-6b call
   * sites) leaves the field off the wire, so those callers are unchanged.
   */
  const sendPointerMove = (
    offerer: PeerConnection,
    x: number,
    y: number,
    seq?: number,
  ): void => {
    offerer.dataChannels.sendJson('control', 'desktop-input', {
      kind: 'pointer-move',
      x,
      y,
      ...(seq === undefined ? {} : { seq }),
    });
  };

  it('receives a real H.264 track with flowing RTP', async () => {
    const { token, agentId, credential, sessionId, userSigning } = await seed({
      capabilities: ['desktop'],
    });

    spawnAgent(agentId, credential, ['--desktop-source', 'test']);
    await waitForAgentOnline(token, agentId);
    const agentSigningPublicKey = await waitForAgentSigningKey(token, agentId);
    const identity = buildPeerIdentity(
      userSigning.privateKey,
      userSigning.publicKeyRawBase64,
      agentSigningPublicKey,
    );

    const { offerer, tracks, packets } = await openDesktopPeer(
      sessionId,
      token,
      identity,
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
    const { token, agentId, credential, sessionId, userSigning } = await seed({
      capabilities: ['desktop'],
    });

    const agent = spawnAgent(agentId, credential, ['--desktop-source', 'test']);
    await waitForAgentOnline(token, agentId);
    const agentSigningPublicKey = await waitForAgentSigningKey(token, agentId);
    const identity = buildPeerIdentity(
      userSigning.privateKey,
      userSigning.publicKeyRawBase64,
      agentSigningPublicKey,
    );

    const first = await openDesktopPeer(sessionId, token, identity);
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
    const second = await openDesktopPeer(session2.id, token, identity);
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
    const { token, agentId, credential, sessionId, userSigning } = await seed(); // default: terminal
    spawnAgent(agentId, credential, ['--desktop-source', 'test']);
    await waitForAgentOnline(token, agentId);
    const agentSigningPublicKey = await waitForAgentSigningKey(token, agentId);
    const identity = buildPeerIdentity(
      userSigning.privateKey,
      userSigning.publicKeyRawBase64,
      agentSigningPublicKey,
    );

    const { offerer, frames } = await connectTerminal(
      sessionId,
      token,
      identity,
    );

    try {
      sendKeystrokes(offerer, sessionId, 'echo hello\n');
      await waitForTerminalOutput(frames, 'hello');

      expect(frames[0]?.channel).toBe('terminal');
      expect(frames[0]?.type).toBe('terminal-data');
    } finally {
      await offerer.close();
    }
  }, 90_000);

  // Review Focus #1, spec §8.3: the default build is INERT. This is the test
  // that protects the shipped behaviour.
  it('receives a desktop-input frame and drops it when the gate is closed', async () => {
    const { token, agentId, credential, sessionId, userSigning } = await seed({
      capabilities: ['desktop'],
    });

    // No --allow-input: the default. RUST_LOG=debug so the drop is observable.
    const agent = spawnAgent(
      agentId,
      credential,
      ['--desktop-source', 'test'],
      {
        RUST_LOG: 'debug',
      },
    );
    await waitForAgentOnline(token, agentId);
    const agentSigningPublicKey = await waitForAgentSigningKey(token, agentId);
    const identity = buildPeerIdentity(
      userSigning.privateKey,
      userSigning.publicKeyRawBase64,
      agentSigningPublicKey,
    );

    const { offerer, packets, controlFrames } = await openDesktopPeer(
      sessionId,
      token,
      identity,
    );
    try {
      await waitFor(
        () => controlFrames.some((f) => f.type === 'desktop-sources'),
        'the source enumeration',
        20_000,
      );
      expect(inputEnabled(controlFrames)).toBe(false);

      const before = packets.length;
      sendPointerMove(offerer, 0.5, 0.5);

      // (a) the agent logged the drop — proves the frame ARRIVED and was dropped,
      // not that the wire is broken.
      await waitFor(
        () => agent.output().includes('dropping desktop-input'),
        'the agent to log the drop',
        15_000,
      );
      // (b) the session is unharmed: RTP keeps flowing.
      await waitFor(
        () => packets.length > before,
        'continued RTP after a dropped input frame',
        15_000,
      );
      // (c) the gate is still reported closed.
      expect(inputEnabled(controlFrames)).toBe(false);
    } finally {
      await offerer.close();
    }
  }, 120_000);

  // Review Focus #1/#4, spec §8.3: with --allow-input, a pointer-move reaches
  // the real seat. Asserted via `xdotool` (XTest under Xvfb), NEVER via enigo's
  // return value — a Wayland/GNOME no-op returns Ok (ADR-27 finding).
  it('injects a pointer-move when the gate is open under Xvfb', async () => {
    const { token, agentId, credential, sessionId, userSigning } = await seed({
      capabilities: ['desktop'],
    });

    // The display is provided by the CI step (Step 5); DISPLAY=:99 by convention.
    const agent = spawnAgent(
      agentId,
      credential,
      ['--desktop-source', 'test', '--allow-input'],
      { DISPLAY: process.env.DISPLAY ?? ':99', RUST_LOG: 'debug' },
    );
    void agent;
    await waitForAgentOnline(token, agentId);
    const agentSigningPublicKey = await waitForAgentSigningKey(token, agentId);
    const identity = buildPeerIdentity(
      userSigning.privateKey,
      userSigning.publicKeyRawBase64,
      agentSigningPublicKey,
    );

    const { offerer, controlFrames } = await openDesktopPeer(
      sessionId,
      token,
      identity,
    );
    try {
      await waitFor(
        () => controlFrames.some((f) => f.type === 'desktop-sources'),
        'the source enumeration',
        20_000,
      );
      expect(inputEnabled(controlFrames)).toBe(true);

      // Pin the seat to a known origin FIRST. Xvfb's pointer starts at the
      // screen centre (spike: x:960 y:540 on 1920x1080), so a bare
      // "did it leave the origin?" assert would pass even if the injector did
      // nothing — a false green on the one test that proves real injection.
      execFileSync('xdotool', ['mousemove', '0', '0']);

      // Forward a normalized point and assert the EXACT mapped pixel, not just
      // "somewhere". The `test` source is 1280x720 at origin 0,0, so
      // to_absolute(0.25, 0.25) = (round(0.25*1280), round(0.25*720)) =
      // (320, 180). A small tolerance absorbs X11 pointer rounding.
      const [wantX, wantY] = [320, 180];
      sendPointerMove(offerer, 0.25, 0.25);
      await waitFor(
        () => {
          const out = execFileSync('xdotool', ['getmouselocation']).toString();
          // `xdotool getmouselocation` prints `x:NNN y:NNN ...`.
          const x = Number(/x:(\d+)/.exec(out)?.[1]);
          const y = Number(/y:(\d+)/.exec(out)?.[1]);
          return Math.abs(x - wantX) <= 2 && Math.abs(y - wantY) <= 2;
        },
        `the OS pointer to land near (${wantX}, ${wantY})`,
        15_000,
      );
    } finally {
      await offerer.close();
    }
  }, 120_000);

  // ADR-41 (Phase 6a): before the hoist, the Desktop arm returned at
  // `main.rs:970` — upstream of the terminal-only `verify_offer_identity` at
  // `:1025` — so a proof-less offer opened a desktop session. Now the verify
  // is an admission gate: the agent bails with NO answer, the channel never
  // opens, and the agent log names the missing proof.
  it('refuses a proof-less desktop offer (ADR-41 admission gate)', async () => {
    const { token, agentId, credential, sessionId } = await seed({
      capabilities: ['desktop'],
    });

    const agent = spawnAgent(agentId, credential, ['--desktop-source', 'test']);
    await waitForAgentOnline(token, agentId);
    await waitForAgentSigningKey(token, agentId);

    // No `identity` argument → no proof on the offer.
    await expect(openDesktopPeer(sessionId, token, undefined)).rejects.toThrow(
      /refus|declin|timeout/i,
    );

    const agentLog = agent.output();
    expect(agentLog).toMatch(/identity proof|no identity proof|refused/i);
  }, 90_000);

  // ADR-43 (Phase 6a): a flooding peer is capped at the agent. The exact
  // 120/window math is pinned in the Rust unit tests; this test proves the cap
  // is WIRED (drops appear) and the session SURVIVES (a later frame lands).
  it('caps a flooding peer at 120 Hz and keeps the session alive', async () => {
    const { token, agentId, credential, sessionId, userSigning } = await seed({
      capabilities: ['desktop'],
    });

    const agent = spawnAgent(
      agentId,
      credential,
      ['--desktop-source', 'test', '--allow-input'],
      { DISPLAY: process.env.DISPLAY ?? ':99', RUST_LOG: 'debug' },
    );
    await waitForAgentOnline(token, agentId);
    const agentSigningPublicKey = await waitForAgentSigningKey(token, agentId);
    const identity = buildPeerIdentity(
      userSigning.privateKey,
      userSigning.publicKeyRawBase64,
      agentSigningPublicKey,
    );

    const { offerer, controlFrames } = await openDesktopPeer(
      sessionId,
      token,
      identity,
    );
    try {
      await waitFor(
        () => controlFrames.some((f) => f.type === 'desktop-sources'),
        'the source enumeration',
        20_000,
      );
      // ADR-42: the live frame carries the verified fact (Task 4's literal).
      const sourcesFrame = controlFrames.findLast(
        (f) => f.type === 'desktop-sources',
      );
      expect(
        (sourcesFrame?.payload as { peerVerified?: boolean } | undefined)
          ?.peerVerified,
      ).toBe(true);
      expect(inputEnabled(controlFrames)).toBe(true);

      // Burst: 300 frames, all within one window (well above the 120 cap).
      for (let i = 0; i < 300; i++) {
        sendPointerMove(offerer, 0.5, 0.5);
      }

      // (a) at least one frame was applied and at least one was capped —
      // which frames landed is timing-dependent, so the assertion is >= 1.
      await waitFor(
        () => agent.output().includes('desktop-input applied'),
        'the agent to apply at least one burst frame',
        15_000,
      );
      await waitFor(
        () => agent.output().includes('rate cap exceeded'),
        'the agent to log at least one capped frame',
        15_000,
      );

      // (b) the session SURVIVES: a frame in the NEXT window still injects
      // (the cap is a per-window counter, not a session kill).
      execFileSync('xdotool', ['mousemove', '0', '0']);
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      const appliedBefore = agent
        .output()
        .split('desktop-input applied').length;
      sendPointerMove(offerer, 0.25, 0.25);
      await waitFor(
        () =>
          agent.output().split('desktop-input applied').length > appliedBefore,
        'a post-burst frame to be applied in the next window',
        15_000,
      );
      await waitFor(
        () => {
          const out = execFileSync('xdotool', ['getmouselocation']).toString();
          const x = Number(/x:(\d+)/.exec(out)?.[1]);
          const y = Number(/y:(\d+)/.exec(out)?.[1]);
          return Math.abs(x - 320) <= 2 && Math.abs(y - 180) <= 2;
        },
        'the post-burst pointer to land near (320, 180)',
        15_000,
      );
    } finally {
      await offerer.close();
    }
  }, 120_000);

  // ADR-44 (Phase 6a): the control-path latency baseline Phase 6b needs.
  // 10 pointer-moves, 100 ms apart, gate open under Xvfb; every `delta_ms`
  // (agent receive − browser send) must be ≤ 1000 ms — a loose CI guard —
  // and the summary is logged for the demo doc to record.
  it('measures the input-latency baseline (ADR-44)', async () => {
    const { token, agentId, credential, sessionId, userSigning } = await seed({
      capabilities: ['desktop'],
    });

    const agent = spawnAgent(
      agentId,
      credential,
      ['--desktop-source', 'test', '--allow-input'],
      { DISPLAY: process.env.DISPLAY ?? ':99' }, // default RUST_LOG=info: the log is info
    );
    await waitForAgentOnline(token, agentId);
    const agentSigningPublicKey = await waitForAgentSigningKey(token, agentId);
    const identity = buildPeerIdentity(
      userSigning.privateKey,
      userSigning.publicKeyRawBase64,
      agentSigningPublicKey,
    );

    const { offerer, controlFrames } = await openDesktopPeer(
      sessionId,
      token,
      identity,
    );
    try {
      await waitFor(
        () => controlFrames.some((f) => f.type === 'desktop-sources'),
        'the source enumeration',
        20_000,
      );

      for (let i = 0; i < 10; i++) {
        sendPointerMove(offerer, 0.1 + i * 0.05, 0.5);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      // The 10 applied lines must be visible before parsing.
      await waitFor(
        () =>
          (agent.output().match(/desktop-input applied/g)?.length ?? 0) >= 10,
        '10 applied input frames in the agent log',
        20_000,
      );

      // tracing-subscriber::fmt emits ANSI styling by default; strip it so the
      // field-render boundary (`delta_ms=123`) is matched verbatim.
      const agentLog = agent.output().replace(/\x1b\[[0-9;]*m/g, '');
      const deltas = [...agentLog.matchAll(/delta_ms=(\d+)/g)].map((m) =>
        Number(m[1]),
      );
      expect(deltas.length).toBeGreaterThanOrEqual(10);
      for (const delta of deltas) {
        expect(delta).toBeLessThanOrEqual(1000);
      }

      const sorted = [...deltas].sort((a, b) => a - b);
      const min = sorted[0]!;
      const median = sorted[Math.floor(sorted.length / 2)]!;
      const p90 =
        sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))]!;
      console.log(
        `[ADR-44 baseline] n=${deltas.length} min=${min}ms median=${median}ms p90=${p90}ms max=${sorted[sorted.length - 1]!}ms`,
      );
    } finally {
      await offerer.close();
    }
  }, 120_000);

  // ADR-45 (Phase 6b): the cursor is a first-class streamed layer, not part of
  // the video frame. With the input gate OPEN, an injected pointer-move carries
  // a browser-assigned `seq`; the agent caches the last applied seq and echoes
  // it on the next `desktop-cursor` frame. This test pins the full round-trip:
  // the cursor frame echoes the exact seq AND lands at the injected point.
  it('streams cursor position and echoes the applied input sequence under Xvfb', async () => {
    const { offerer, controlFrames } = await openTestDesktopStream({
      allowInput: true,
      display: true,
    });
    try {
      await waitFor(
        () => controlFrames.some((f) => f.type === 'desktop-sources'),
        'the source enumeration',
        20_000,
      );
      expect(inputEnabled(controlFrames)).toBe(true);

      // The poller emits its first frame on the initial sample; wait for the
      // cursor layer to be live before injecting, so the echo below is a fresh
      // frame rather than a pre-injection one.
      await waitFor(
        () => cursorFrames(controlFrames).length > 0,
        'an initial desktop-cursor frame',
        20_000,
      );

      // Inject with a browser-assigned seq and read the echo back. The poller
      // only emits on a position/shape CHANGE, so each attempt nudges the point;
      // retrying (bounded) absorbs the tiny window where the poller could sample
      // the moved pointer before the agent stores the applied seq.
      const seq = 777;
      let echoed: DesktopCursorPayload | undefined;
      for (let attempt = 0; attempt < 6 && echoed === undefined; attempt++) {
        const x = 0.4 + attempt * 0.02;
        sendPointerMove(offerer, x, 0.4, seq);
        try {
          await waitFor(
            () => {
              echoed = cursorFrames(controlFrames).findLast(
                (c) =>
                  c.lastInputSeq === seq &&
                  Math.abs(c.x - x) <= 2 / TEST_SOURCE_WIDTH,
              );
              return echoed !== undefined;
            },
            `a desktop-cursor frame echoing seq ${seq} at x≈${x.toFixed(2)}`,
            2_000,
          );
        } catch {
          // Retry with the next point.
        }
      }

      expect(echoed).toBeDefined();
      // Position round-trips through the source box: 0.4 → round(0.4*1280)=512
      // px → 512/1280 = 0.4. The ±2 px tolerance absorbs X11 pointer rounding.
      expect(Math.abs(echoed!.y - 0.4)).toBeLessThanOrEqual(
        2 / TEST_SOURCE_HEIGHT,
      );
    } finally {
      await offerer.close();
    }
  }, 120_000);

  it('keeps streaming cursor frames in view-only mode while dropping input', async () => {
    const { offerer, controlFrames, agent } = await openTestDesktopStream({
      display: true,
      env: { RUST_LOG: 'debug' },
    });
    try {
      await waitFor(
        () => controlFrames.some((f) => f.type === 'desktop-sources'),
        'the source enumeration',
        20_000,
      );
      // The gate is closed: this is the shipped, inert default.
      expect(inputEnabled(controlFrames)).toBe(false);

      // (a) Cursor frames stream even with the gate closed.
      await waitFor(
        () => cursorFrames(controlFrames).length > 0,
        'an initial desktop-cursor frame in view-only mode',
        20_000,
      );

      // A viewer may still move the cursor frame it sees; drive the OS pointer
      // directly (bypassing the gated input path) and assert the layer keeps up.
      const beforeMove = cursorFrames(controlFrames).length;
      execFileSync('xdotool', ['mousemove', '400', '300']);
      await waitFor(
        () => cursorFrames(controlFrames).length > beforeMove,
        'a further desktop-cursor frame while the gate is closed',
        20_000,
      );

      // (b) The input path is genuinely inert: a forwarded move is dropped, and
      // the drop is observable in the agent log (it arrived, then was refused).
      sendPointerMove(offerer, 0.5, 0.5);
      await waitFor(
        () => agent.output().includes('dropping desktop-input'),
        'the agent to log the dropped input',
        15_000,
      );

      // (c) The session is unharmed: cursor frames still stream after the drop.
      const beforeDrop = cursorFrames(controlFrames).length;
      execFileSync('xdotool', ['mousemove', '500', '350']);
      await waitFor(
        () => cursorFrames(controlFrames).length > beforeDrop,
        'cursor frames to keep streaming after the dropped input',
        20_000,
      );
      expect(inputEnabled(controlFrames)).toBe(false);
    } finally {
      await offerer.close();
    }
  }, 120_000);

  // ADR-47 (Phase 6b): `desktop-stats` carries a rolling ring of per-frame
  // timing — `frameSamples` = [{ seq, captureEpochMs, encodeMs }] — plus the
  // capture/encode p50s. The ring is filled in capture order, so on the wire the
  // seqs must strictly increase and the capture timestamps must not go backwards.
  it('publishes rolling frame timing samples in desktop-stats (ADR-47)', async () => {
    const { offerer, stats } = await openTestDesktopStream();
    try {
      await waitFor(
        () => stats().some((s) => s.frameSamples !== undefined),
        'a desktop-stats carrying frameSamples',
        20_000,
      );

      // The first stats frame carries a single sample; let the stream accumulate
      // more frames, then force a fresh snapshot via a bitrate retarget (which
      // re-emits stats with the current ring — spec §2.3 step 6).
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      const before = stats().length;
      offerer.dataChannels.sendJson('control', 'desktop-bitrate', {
        bitrateBps: 3_000_000,
      });
      await waitFor(
        () =>
          stats()
            .slice(before)
            .some((s) => (s.frameSamples?.length ?? 0) >= 2),
        'a fresh desktop-stats with at least two frame samples',
        20_000,
      );

      const sample = stats()
        .slice(before)
        .findLast((s) => (s.frameSamples?.length ?? 0) >= 2)!;
      expect(sample.captureMsP50).toBeGreaterThanOrEqual(0);
      expect(sample.encodeMsP50).toBeGreaterThanOrEqual(0);

      const frames = sample.frameSamples!;
      for (let i = 1; i < frames.length; i++) {
        // Capture order is monotonic: seqs strictly increase, timestamps do not
        // go backwards, and every encode duration is a real non-negative number.
        expect(frames[i]!.seq).toBeGreaterThan(frames[i - 1]!.seq);
        expect(frames[i]!.captureEpochMs).toBeGreaterThanOrEqual(
          frames[i - 1]!.captureEpochMs,
        );
        expect(frames[i]!.encodeMs).toBeGreaterThanOrEqual(0);
      }
    } finally {
      await offerer.close();
    }
  }, 120_000);

  // ADR-47 (Phase 6b): the input-echo round-trip is the latency the browser
  // measures (Task 16's `desktopEchoMs`). Each injected move carries a DISTINCT
  // browser-assigned seq; the agent echoes the last applied seq on the next
  // cursor frame, so send-time → echo-receive-time is a full round-trip. The
  // summary line is recorded for the demo doc.
  it('measures the cursor input-echo round-trip and prints a summary (ADR-47)', async () => {
    const { offerer, controlFrames } = await openTestDesktopStream({
      allowInput: true,
      display: true,
    });
    try {
      await waitFor(
        () => controlFrames.some((f) => f.type === 'desktop-sources'),
        'the source enumeration',
        20_000,
      );
      expect(inputEnabled(controlFrames)).toBe(true);

      // Wait for cursor stream to be active before sending moves so the echo
      // loop samples against an active poller.
      await waitFor(
        () => cursorFrames(controlFrames).length > 0,
        'an initial desktop-cursor frame',
        20_000,
      );

      const sentAt = new Map<number, number>();
      const echoed = new Set<number>();
      const echoMs: number[] = [];
      // Re-scan all frames each tick so an echo is never missed between polls;
      // `echoed` keeps each seq counted exactly once.
      const collect = (): void => {
        for (const c of cursorFrames(controlFrames)) {
          if (c.lastInputSeq === undefined || echoed.has(c.lastInputSeq)) {
            continue;
          }
          const t = sentAt.get(c.lastInputSeq);
          if (t === undefined) continue;
          echoed.add(c.lastInputSeq);
          echoMs.push(Date.now() - t);
        }
      };

      const N = 12;
      const needed = Math.ceil(N / 2);
      // The poller emits only on a position/shape change, and the control task
      // stores the applied seq on its own schedule — so a move whose emit lands
      // BEFORE the store is stamped with a stale/None seq and lost for good (the
      // position then settles and the poller never re-emits). Give every seq a
      // bounded retry: re-send the SAME seq at a nudged point so the change-only
      // poller gets another emit opportunity, now that the seq is stored. This is
      // the same bounded-retry pattern the sibling cursor-echo test above uses,
      // made bounded in rounds so the whole test stays inside its timeout.
      const RETRY_WINDOW_MS = 500;
      const MAX_ROUNDS = 6;
      for (let round = 0; round < MAX_ROUNDS && echoed.size < needed; round++) {
        for (let i = 0; i < N; i++) {
          if (echoed.size >= needed) break;
          const seq = 1000 + i;
          if (echoed.has(seq)) continue;
          // A distinct x per seq, plus a per-round y nudge, makes every re-send
          // a position change — the poller emits only on change, so each seq
          // gets its own emit opportunity on every round.
          const x = 0.3 + i * 0.03;
          const y = 0.5 + round * 0.02;
          // Refresh the send time: the echo measured below corresponds to THIS
          // send, so the round-trip stays honest across retries.
          sentAt.set(seq, Date.now());
          sendPointerMove(offerer, x, y, seq);
          try {
            await waitFor(
              () => {
                collect();
                return echoed.has(seq);
              },
              `a desktop-cursor frame echoing seq ${seq}`,
              RETRY_WINDOW_MS,
            );
          } catch {
            // Retry this seq on the next round with a fresh nudge.
          }
        }
      }

      const sorted = [...echoMs].sort((a, b) => a - b);
      const min = sorted[0]!;
      const median = sorted[Math.floor(sorted.length / 2)]!;
      const max = sorted[sorted.length - 1]!;
      console.log(
        `[6b echo] n=${echoMs.length} min=${min}ms median=${median}ms max=${max}ms`,
      );

      // A seq that never comes back is the failure this pins; the timing bound
      // stays loose (the poller cadence + control-channel RTT dominate it).
      expect(echoMs.length).toBeGreaterThan(0);
      // At least half the distinct seqs must have round-tripped — the retry loop
      // above only exits early once this is met, so state it explicitly rather
      // than relying on the loop's implicit bound.
      expect(echoMs.length).toBeGreaterThanOrEqual(needed);
      for (const ms of echoMs) {
        expect(ms).toBeLessThanOrEqual(5_000);
      }
    } finally {
      await offerer.close();
    }
  }, 120_000);
});
