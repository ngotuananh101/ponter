import { describe, expect, it, vi } from 'vitest';
import { h264Mode1Codec, SessionPeer } from '../../src/session/peer.js';

/**
 * Minimal Chrome-shaped H.264 offers. Only the lines `h264Mode1Codec` reads are
 * here — `a=rtpmap:` and `a=fmtp:` — because these tests exercise THIS task's
 * parsing, not werift's negotiation. Package-internal, so the offers are
 * inlined rather than imported from `@ponter/webrtc-core`'s test fixtures.
 */
const MODE1_FIRST = [
  'v=0',
  'm=video 9 UDP/TLS/RTP/SAVPF 96 102 104',
  'a=rtpmap:96 VP8/90000',
  'a=rtpmap:102 H264/90000',
  'a=fmtp:102 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f',
  'a=rtpmap:104 H264/90000',
  'a=fmtp:104 level-asymmetry-allowed=1;packetization-mode=0;profile-level-id=42e01f',
  '',
].join('\r\n');

const MODE0_FIRST = [
  'v=0',
  'm=video 9 UDP/TLS/RTP/SAVPF 96 104 102',
  'a=rtpmap:96 VP8/90000',
  'a=rtpmap:104 H264/90000',
  'a=fmtp:104 level-asymmetry-allowed=1;packetization-mode=0;profile-level-id=42e01f',
  'a=rtpmap:102 H264/90000',
  'a=fmtp:102 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f',
  '',
].join('\r\n');

/** An offer with H.264, but no mode-1 entry at all. */
const MODE0_ONLY = [
  'v=0',
  'm=video 9 UDP/TLS/RTP/SAVPF 104',
  'a=rtpmap:104 H264/90000',
  'a=fmtp:104 level-asymmetry-allowed=1;packetization-mode=0;profile-level-id=42e01f',
  '',
].join('\r\n');

describe('h264Mode1Codec', () => {
  it('picks the mode-1 entry even when the mode-0 entry comes first', () => {
    expect(h264Mode1Codec(MODE0_FIRST)).toEqual({
      mimeType: 'video/H264',
      payloadType: 102,
      parameters:
        'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f',
    });
  });

  it('returns the whole fmtp string as parameters, so the caller can echo it', () => {
    expect(h264Mode1Codec(MODE1_FIRST)?.parameters).toBe(
      'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f',
    );
  });

  it('treats an ABSENT packetization-mode as mode 0 and returns null', () => {
    const offer = [
      'v=0',
      'm=video 9 UDP/TLS/RTP/SAVPF 102',
      'a=rtpmap:102 H264/90000',
      'a=fmtp:102 profile-level-id=42e01f',
      '',
    ].join('\r\n');
    // RFC 6184 §8.1: the default is 0. Reading absence as mode 1 would select
    // an entry the browser is not depacketizing as mode 1 — R-S3 defeated on
    // exactly the peers it exists to protect.
    expect(h264Mode1Codec(offer)).toBeNull();
  });

  it('returns null for an H.264 entry with no fmtp line at all', () => {
    const offer = [
      'v=0',
      'm=video 9 UDP/TLS/RTP/SAVPF 102',
      'a=rtpmap:102 H264/90000',
      '',
    ].join('\r\n');
    expect(h264Mode1Codec(offer)).toBeNull();
  });

  it('returns null when the offer carries no H.264', () => {
    const offer = [
      'v=0',
      'm=video 9 UDP/TLS/RTP/SAVPF 96',
      'a=rtpmap:96 VP8/90000',
      '',
    ].join('\r\n');
    expect(h264Mode1Codec(offer)).toBeNull();
  });

  it('parses an LF-only offer as well as a CRLF one', () => {
    expect(
      h264Mode1Codec(MODE0_FIRST.replace(/\r\n/g, '\n'))?.payloadType,
    ).toBe(102);
  });

  it('does not match a non-90000 H.264 clock rate as video/H264', () => {
    const offer = [
      'v=0',
      'm=video 9 UDP/TLS/RTP/SAVPF 102',
      'a=rtpmap:102 H264/45000',
      'a=fmtp:102 packetization-mode=1',
      '',
    ].join('\r\n');
    expect(h264Mode1Codec(offer)).toBeNull();
  });
});

function fakePeerFactory() {
  const calls: string[] = [];
  const sender = {
    codec: undefined,
    selectNegotiatedCodec: vi.fn(() => {
      calls.push('selectNegotiatedCodec');
    }),
    writeRtp: vi.fn(),
  };
  const peer = {
    addTrack: vi.fn(() => {
      calls.push('addTrack');
      return sender;
    }),
    setRemoteDescription: vi.fn(async () => {
      calls.push('setRemoteDescription');
    }),
    createAnswer: vi.fn(async () => {
      calls.push('createAnswer');
      return { sdp: 'v=0 answer', type: 'answer' as const };
    }),
    setLocalDescription: vi.fn(async () => {
      calls.push('setLocalDescription');
    }),
    close: vi.fn(async () => {}),
  };
  return { peer, sender, calls };
}

const TRACK = { track: { id: 'video' } };

describe('SessionPeer.answer', () => {
  it('attaches the desktop track before setRemoteDescription', async () => {
    const { peer, calls } = fakePeerFactory();
    const session = new SessionPeer(peer as never, {
      acceptedLabel: 'control',
    });
    await session.answer(MODE0_FIRST, { desktop: true, track: TRACK });
    expect(calls.indexOf('addTrack')).toBeLessThan(
      calls.indexOf('setRemoteDescription'),
    );
  });

  /**
   * The ordering that R-S3 depends on, and the reason this test asserts the
   * call sequence rather than the result: `selectNegotiatedCodec` throws
   * "was not negotiated" before `setRemoteDescription` has populated the
   * transceiver's codec list, and does nothing useful for the emitted SDP
   * after `createAnswer` has already built the m-line from it.
   */
  it('re-points the sender after setRemoteDescription and before createAnswer', async () => {
    const { peer, calls } = fakePeerFactory();
    const session = new SessionPeer(peer as never, {
      acceptedLabel: 'control',
    });
    await session.answer(MODE0_FIRST, { desktop: true, track: TRACK });
    expect(calls).toEqual([
      'addTrack',
      'setRemoteDescription',
      'selectNegotiatedCodec',
      'createAnswer',
      'setLocalDescription',
    ]);
  });

  it('re-points at the payload type parsed out of the offer', async () => {
    const { peer, sender } = fakePeerFactory();
    const session = new SessionPeer(peer as never, {
      acceptedLabel: 'control',
    });
    await session.answer(MODE0_FIRST, { desktop: true, track: TRACK });
    expect(sender.selectNegotiatedCodec).toHaveBeenCalledWith({
      mimeType: 'video/H264',
      payloadType: 102,
      parameters:
        'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f',
    });
  });

  it('returns the sender, so the desktop loop has something to write RTP to', async () => {
    const { peer, sender } = fakePeerFactory();
    const session = new SessionPeer(peer as never, {
      acceptedLabel: 'control',
    });
    const result = await session.answer(MODE0_FIRST, {
      desktop: true,
      track: TRACK,
    });
    expect(result.sender).toBe(sender);
    expect(result.answerSdp).toBe('v=0 answer');
  });

  it('throws rather than answering when the offer has no mode-1 H.264 entry', async () => {
    const { peer, sender } = fakePeerFactory();
    const session = new SessionPeer(peer as never, {
      acceptedLabel: 'control',
    });
    await expect(
      session.answer(MODE0_ONLY, { desktop: true, track: TRACK }),
    ).rejects.toThrow(/no H\.264 entry with packetization-mode=1/);
    // The re-point must NOT have happened: selecting the mode-0 entry would
    // make the failure invisible instead of loud.
    expect(sender.selectNegotiatedCodec).not.toHaveBeenCalled();
  });

  it('throws when a desktop session is answered with no track', async () => {
    const { peer } = fakePeerFactory();
    const session = new SessionPeer(peer as never, {
      acceptedLabel: 'control',
    });
    await expect(
      session.answer(MODE0_FIRST, { desktop: true }),
    ).rejects.toThrow(/no outbound track/);
  });

  it('answers a non-desktop session without attaching a track or re-pointing', async () => {
    const { peer, sender, calls } = fakePeerFactory();
    const session = new SessionPeer(peer as never, {
      acceptedLabel: 'terminal',
    });
    const result = await session.answer(MODE1_FIRST, { desktop: false });
    expect(calls).not.toContain('addTrack');
    expect(sender.selectNegotiatedCodec).not.toHaveBeenCalled();
    expect(result.sender).toBeNull();
  });
});

describe('SessionPeer.handleDataChannel', () => {
  it('closes a data channel with the wrong label', async () => {
    const { peer } = fakePeerFactory();
    const session = new SessionPeer(peer as never, {
      acceptedLabel: 'terminal',
    });
    const wrong = {
      label: async () => 'control',
      close: vi.fn(async () => {}),
    };
    await session.handleDataChannel(wrong);
    expect(wrong.close).toHaveBeenCalled();
  });

  it('accepts a data channel with the expected label', async () => {
    const { peer } = fakePeerFactory();
    const session = new SessionPeer(peer as never, {
      acceptedLabel: 'terminal',
    });
    const right = {
      label: async () => 'terminal',
      close: vi.fn(async () => {}),
    };
    await session.handleDataChannel(right);
    expect(right.close).not.toHaveBeenCalled();
    expect(session.channel).toBe(right);
  });

  it('closes a SECOND channel even when its label is right', async () => {
    const { peer } = fakePeerFactory();
    const session = new SessionPeer(peer as never, {
      acceptedLabel: 'terminal',
    });
    await session.handleDataChannel({
      label: async () => 'terminal',
      close: vi.fn(async () => {}),
    });
    const second = {
      label: async () => 'terminal',
      close: vi.fn(async () => {}),
    };
    await session.handleDataChannel(second);
    expect(second.close).toHaveBeenCalled();
  });

  it('drops an unlabelled channel without closing it', async () => {
    const { peer } = fakePeerFactory();
    const session = new SessionPeer(peer as never, {
      acceptedLabel: 'terminal',
    });
    const bad = {
      label: async () => {
        throw new Error('no label');
      },
      close: vi.fn(async () => {}),
    };
    await expect(session.handleDataChannel(bad)).resolves.toBeUndefined();
    expect(bad.close).not.toHaveBeenCalled();
  });

  it('closes a channel with no code argument, as this API has none', async () => {
    const { peer } = fakePeerFactory();
    const session = new SessionPeer(peer as never, {
      acceptedLabel: 'terminal',
    });
    const wrong = { label: async () => 'nope', close: vi.fn(async () => {}) };
    await session.handleDataChannel(wrong);
    expect(wrong.close).toHaveBeenCalledWith();
  });
});
