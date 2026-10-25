// apps/agent/test/desktop/session.test.ts
import { describe, expect, it, vi } from 'vitest';
import { DesktopSession } from '../../src/desktop/session.js';

function deps() {
  return {
    capture: {
      sources: vi.fn(async () => ({
        monitors: [{ id: '1', primary: true }],
        windows: [],
      })),
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      nextFrame: vi.fn(async () => ({
        width: 4,
        height: 4,
        rgba: new Uint8Array(64).fill(7),
        seq: 1,
      })),
    },
    encode: {
      configure: vi.fn(),
      encode: vi.fn(async () => ({
        data: new Uint8Array([1, 2, 3]),
        keyframe: true,
      })),
      close: vi.fn(),
    },
    /**
     * The RTP sink. Left as a null sender by default so the existing
     * encode/skip/ladder tests are unaffected; the RTP path has its own tests
     * below, which install a real fake sender.
     */
    rtp: {
      sender: vi.fn(
        () => null as { writeRtp(packet: Uint8Array): void } | null,
      ),
      payloadType: vi.fn(() => null as number | null),
    },
    send: vi.fn(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    now: () => 0,
    rtpClock: () => 0,
  };
}

describe('DesktopSession', () => {
  it('configures the encoder with the profile gop before the first frame', async () => {
    const d = deps();
    const session = new DesktopSession(d as never);
    await session.start({ kind: 'test' }, '720p30', 1_000_000);
    expect(d.encode.configure).toHaveBeenCalledWith(
      expect.objectContaining({ gop: 60 }),
    );
    expect(d.capture.start).toHaveBeenCalled();
  });

  it('clamps the initial bitrate through the same decode path', async () => {
    const d = deps();
    const session = new DesktopSession(d as never);
    await session.start({ kind: 'test' }, '720p30', 1);
    expect(d.encode.configure).toHaveBeenCalledWith(
      expect.objectContaining({ bitrate: 250_000 }),
    );
  });

  it('stops capture before closing the encoder', async () => {
    const order: string[] = [];
    const d = deps();
    d.capture.stop = vi.fn(async () => {
      order.push('capture');
    });
    d.encode.close = vi.fn(() => {
      order.push('encoder');
    });
    const session = new DesktopSession(d as never);
    await session.start({ kind: 'test' }, '720p30', 1_000_000);
    await session.stop();
    expect(order).toEqual(['capture', 'encoder']);
  });

  // Task 26 removed the cell `re-configures the encoder on a quality change`.
  // It drove `control({kind:'quality'})`, a member the Rust's `StreamControl`
  // has never had (`desktop.rs:1938-1947` — `SetBitrate` and `SourceSwap`,
  // nothing else) and no producer sends. The behaviour it covered — the
  // encoder being reconfigured for a new profile — is real, but it is reached
  // from exactly one place, the sustain ladder inside `pump()`, and the cell
  // `downgrades on pump after 30 over-budget frames and resets the skip` below
  // asserts it there (`toHaveBeenLastCalledWith` `{profile:'720p60', gop:120}`).

  it('resets the static-skip on a bitrate change', async () => {
    // One of the three reset sites: a bitrate change invalidates nothing about
    // the pixels, but the encoder's quantiser just moved, so the next identical
    // frame must still be sent or the browser keeps the pre-retarget picture.
    const d = deps();
    const session = new DesktopSession(d as never);
    await session.start({ kind: 'test' }, '720p30', 1_000_000);
    const before = session.stats().skippedFrames;
    session.control({ kind: 'bitrate', bitrate: 2_000_000 });
    expect(session.stats().skippedFrames).toBe(before);
    expect(session.skipIsReset()).toBe(true);
  });

  it('applies a bitrate received before the first encode', async () => {
    // P5 contradiction #15: the Rust's apply_bitrate returned cmInitExpected
    // before the first frame and the production arm only warned, so the setting
    // was silently lost with no retry. The TS stores the value and applies it
    // when the encoder is configured, because losing it is a defect, not a
    // behaviour worth reproducing.
    const d = deps();
    const session = new DesktopSession(d as never);
    session.control({ kind: 'bitrate', bitrate: 3_000_000 });
    await session.start({ kind: 'test' }, '720p30', 1_000_000);
    expect(d.encode.configure).toHaveBeenCalledWith(
      expect.objectContaining({ bitrate: 3_000_000 }),
    );
  });

  it('retargets the encoder on a bitrate received while streaming', async () => {
    // The **live** half of the retarget, which the two cells around this one
    // miss between them: the "before the first encode" cell above only
    // exercises the `pendingBitrate` path, and the static-skip cell asserts
    // `skipIsReset()`/`skippedFrames`, which the reset sets independently of
    // the bitrate. A `control()` that forgot to record and apply the target
    // passed both. This asserts the two things a retarget actually is — the
    // encoder is reconfigured for the new target, and `stats()` reflects it,
    // which is what the "reflect the effective value to the UI" requirement
    // means (`desktop.rs:1580-1590`).
    const d = deps();
    const session = new DesktopSession(d as never);
    await session.start({ kind: 'test' }, '720p30', 1_000_000);
    session.control({ kind: 'bitrate', bitrate: 2_000_000 });
    expect(d.encode.configure).toHaveBeenLastCalledWith({
      profile: '720p30',
      bitrate: 2_000_000,
      gop: 60,
    });
    expect(session.stats().bitrate).toBe(2_000_000);
  });

  it('reports a stats frame with the sustained profile', async () => {
    const d = deps();
    const session = new DesktopSession(d as never);
    await session.start({ kind: 'test' }, '1080p60', 4_000_000);
    expect(session.stats().profile).toBe('1080p60');
  });

  it('encodes a changed frame on pump and writes it to RTP, not to a data channel', async () => {
    // The bug this pins: an earlier draft of this task sent the encoder's
    // The bug this pins: an earlier draft of this task sent the encoder's
    // Annex-B buffer to `deps.send('control', …)`, i.e. down a data channel.
    // That produces no error and a black video, because a data channel does not
    // carry RTP. The assertion that matters is therefore NOT "a frame was
    // delivered somewhere" — it is that the bytes reached `writeRtp` after
    // being packetized, and that `deps.send` was NOT used for them.
    const d = deps();
    // A real Annex-B access unit: 4-byte start code + one NAL (type 5, IDR).
    // The default mock returns `[1,2,3]`, which has no start code at all and
    // would make `packetizeAnnexB` throw — so this test installs its own.
    d.encode.encode = vi.fn(async () => ({
      data: new Uint8Array([0, 0, 0, 1, 0x65, 1, 2, 3]),
      keyframe: true,
    }));
    const written: Buffer[] = [];
    d.rtp.sender = vi.fn(() => ({
      writeRtp: (p: Uint8Array) => written.push(Buffer.from(p)),
    }));
    d.rtp.payloadType = vi.fn(() => 102);
    const session = new DesktopSession(d as never);
    session.setRtpIdentity(0x1234);
    await session.start({ kind: 'test' }, '720p30', 1_000_000);

    expect(await session.pump()).toBe(true);
    expect(d.encode.encode).toHaveBeenCalledTimes(1);

    // One NAL unit in one packet: a single type-5 slice under 1188 bytes
    // becomes one single-NAL-unit packet.
    expect(written).toHaveLength(1);
    const packet = written[0]!;
    // 12-byte RTP header + the 4 NAL bytes (start code stripped).
    expect(packet.length).toBe(12 + 4);
    expect(packet[0]! >> 6).toBe(2); // RTP version 2
    expect(packet[1]! & 0x7f).toBe(102); // the negotiated payload type
    expect(packet.readUInt32BE(8)).toBe(0x1234); // SSRC from setRtpIdentity
    // Annex-B framing is gone: the start code must not survive into the payload.
    expect([...packet.subarray(12, 16)]).not.toEqual([0, 0, 0, 1]);
    expect(packet[12]).toBe(0x65); // the NAL header byte

    // And the video did NOT go down a data channel.
    expect(d.send).not.toHaveBeenCalled();
  });

  it('drops a frame instead of throwing when no sender exists yet', async () => {
    // The zero-click path starts capture before the browser offers, so the
    // first frames have nowhere to go. Dropping is correct; buffering would
    // replay a stale picture the moment a peer connected.
    const d = deps();
    d.rtp.sender = vi.fn(() => null);
    const session = new DesktopSession(d as never);
    await session.start({ kind: 'test' }, '720p30', 1_000_000);
    await expect(session.pump()).resolves.toBe(true);
    expect(d.send).not.toHaveBeenCalled();
  });

  it('skips a repeated frame but keeps the keepalive', async () => {
    const d = deps();
    let n = 0;
    d.capture.nextFrame = vi.fn(async () => {
      n += 1;
      return { width: 4, height: 4, rgba: new Uint8Array(64).fill(7), seq: n };
    });
    const session = new DesktopSession(d as never);
    await session.start({ kind: 'test' }, '720p30', 1_000_000);
    expect(await session.pump()).toBe(true); // baseline
    expect(await session.pump()).toBe(false); // skipped
    expect(session.stats().skippedFrames).toBe(1);
  });

  it('downgrades on pump after 30 over-budget frames and resets the skip', async () => {
    const d = deps();
    let clock = 0;
    d.now = () => (clock += 40);
    // The default mock returns the same pixels every tick, which the
    // static-skip gate suppresses for 29 of these 30 pumps — the ladder would
    // see one sample and never reach SUSTAIN_FRAMES. Vary the CONTENT, not just
    // the seq: `frameSignature` hashes the pixels and excludes `seq`.
    let n = 0;
    d.capture.nextFrame = vi.fn(async () => {
      n += 1;
      return { width: 4, height: 4, rgba: new Uint8Array(64).fill(n), seq: n };
    });
    const session = new DesktopSession(d as never);
    await session.start({ kind: 'test' }, '1080p60', 4_000_000);
    for (let i = 0; i < 30; i += 1) await session.pump();
    expect(session.stats().profile).toBe('720p60');
    expect(session.skipIsReset()).toBe(true);
    expect(d.encode.configure).toHaveBeenLastCalledWith(
      expect.objectContaining({ profile: '720p60', gop: 120 }),
    );
  });
});
