import { describe, expect, it } from 'vitest';
import {
  buildOffer,
  PT_H264_MODE0,
  PT_H264_MODE1,
  PT_VP8,
} from '@ponter/webrtc-core/test/synthetic-offer';
import { probeNegotiation } from './negotiation.ts';
import { runSpike } from './spike.ts';

describe('P0 spike — the offer builders', () => {
  it('lists VP8 before H.264 in the Chrome ordering', () => {
    const sdp = buildOffer();
    expect(sdp.indexOf('a=rtpmap:96 VP8')).toBeLessThan(
      sdp.indexOf('a=rtpmap:102 H264'),
    );
  });

  it('lists the mode-0 H.264 entry first in the mode-0-first offer', () => {
    const sdp = buildOffer({ h264Order: 'mode-0-first' });
    expect(sdp.indexOf(`a=rtpmap:${PT_H264_MODE0} H264`)).toBeLessThan(
      sdp.indexOf(`a=rtpmap:${PT_H264_MODE1} H264`),
    );
  });
});

describe('P0 spike — the negotiation half (no transport)', () => {
  it('run 1 (R-S1 list) negotiates H.264 on the mode-1 payload type', async () => {
    const result = await probeNegotiation('r-s1-list');
    // A1
    expect(result.negotiatedCodec?.mimeType.toLowerCase()).toBe('video/h264');
    // A2 — the negotiated PT is the browser's mode-1 entry
    expect(result.negotiatedCodec?.payloadType).toBe(PT_H264_MODE1);
    expect(result.negotiatedPacketizationMode).toBe(1);
  });

  it('run 2 (VP8-first local list) is the D4b regression: it selects VP8', async () => {
    const result = await probeNegotiation('vp8-first-local');
    expect(result.negotiatedCodec?.mimeType).toBe('video/VP8');
    expect(result.negotiatedCodec?.payloadType).toBe(PT_VP8);
  });

  it('run 3 (mode-0-first offer) is the D4d regression: R-S3 re-points at the mode-1 entry', async () => {
    const result = await probeNegotiation('mode-0-first-offer');
    expect(result.negotiatedCodec?.payloadType).toBe(PT_H264_MODE1);
    expect(result.negotiatedPacketizationMode).toBe(1);
  });

  it('run 3 without R-S3 would land on the mode-0 entry — the regression is real', async () => {
    // The negative of the negative: prove the bug exists, so a green
    // run-3 means R-S3 works rather than the bug not being there.
    const result = await probeNegotiation('mode-0-first-offer', {
      applyR_S3: false,
    });
    expect(result.negotiatedCodec?.payloadType).toBe(PT_H264_MODE0);
  });
});

describe('P0 spike — the transport half (a real browser)', () => {
  it('run 1 (R-S1 list) carries H.264 that the browser decodes into pixels', async () => {
    const result = await runSpike('r-s1-list');
    expect(result.negotiatedCodec?.mimeType.toLowerCase()).toBe('video/h264');
    expect(result.wirePayloadType).toBe(result.negotiatedCodec?.payloadType);
    expect(result.negotiatedPacketizationMode).toBe(1);
    // A3 — pixels, not packets
    expect(result.decodedFrameCount).toBeGreaterThan(0);
  });

  it('A3 is pixels, not a black picture: the presented luma matches the fixture', async () => {
    // `decodedFrameCount > 0` means the decoder produced *a* picture — a
    // stream of valid all-black frames satisfies it, and that is exactly the
    // failure A3 exists to catch. This compares what the compositor actually
    // presented against the fixture's own luma, decoded with
    // `ffmpeg -pix_fmt gray` (see fixtures/expected-grid.json).
    const result = await runSpike('r-s1-list');
    expect(result.lumaGrid).not.toBeNull();

    // A uniform picture — black, white, or anything in between — has zero
    // spread. The fixture spans ~145 luma levels.
    expect(result.lumaSpread).toBeGreaterThan(40);

    // And the picture is the fixture's, not merely non-uniform.
    expect(result.maxGridDeviation).toBeLessThan(40);
  });

  it('the browser can ask for a keyframe and gets one (PLI round-trip)', async () => {
    const result = await runSpike('r-s1-list');
    expect(result.pliObserved).toBe(true);
    expect(result.keyframeAfterPli).toBe(true);
  });
});
