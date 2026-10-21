import { describe, expect, it } from 'vitest';
import { useH264, useVP8 } from 'werift';
import { WeriftAdapter } from '../../src/adapters/werift';
import {
  buildOffer,
  H264_MODE1,
  PT_H264_MODE0,
  PT_H264_MODE1,
  PT_VP8,
} from '../../test/synthetic-offer';

/** Pull the `a=fmtp:<pt> <params>` line for one payload type out of an SDP. */
function fmtpLine(sdp: string, payloadType: number): string | undefined {
  return sdp
    .split(/\r\n|\n/)
    .find((line) => line.startsWith(`a=fmtp:${payloadType} `));
}

describe('WeriftAdapter.addTrack', () => {
  it('R-S1: with an H.264-only local list the negotiated sender is H.264', async () => {
    const adapter = new WeriftAdapter({
      iceServers: [],
      codecs: { audio: [], video: [useH264()] },
    });
    adapter.addTrack(adapter.createOutboundTrack('video'));
    await adapter.setRemoteDescription({ type: 'offer', sdp: buildOffer() });
    await adapter.createAnswer();
    const sender = adapter.getSenders()[0]!;
    expect(sender.codec?.mimeType).toBe('video/H264');
  });

  it('D4b regression: with a VP8-first local list the sender is VP8 — the black-video bug', async () => {
    const adapter = new WeriftAdapter({
      iceServers: [],
      codecs: { audio: [], video: [useVP8(), useH264()] },
    });
    adapter.addTrack(adapter.createOutboundTrack('video'));
    await adapter.setRemoteDescription({ type: 'offer', sdp: buildOffer() });
    await adapter.createAnswer();
    const sender = adapter.getSenders()[0]!;
    expect(sender.codec?.mimeType).toBe('video/VP8');
    expect(sender.codec?.payloadType).toBe(PT_VP8);
  });

  it('D4d regression: a mode-0-first offer lands the sender on the mode-0 payload type', async () => {
    const adapter = new WeriftAdapter({
      iceServers: [],
      codecs: { audio: [], video: [useH264()] },
    });
    adapter.addTrack(adapter.createOutboundTrack('video'));
    await adapter.setRemoteDescription({
      type: 'offer',
      sdp: buildOffer({ h264Order: 'mode-0-first' }),
    });
    await adapter.createAnswer();
    const sender = adapter.getSenders()[0]!;
    // werift matched by mime type only, so it took the FIRST H.264 entry —
    // which the browser offered with packetization-mode=0.
    expect(sender.codec?.payloadType).toBe(PT_H264_MODE0);
  });

  it('R-S3: re-pointing at the mode-1 entry moves the sender', async () => {
    const offer = buildOffer({ h264Order: 'mode-0-first' });
    const adapter = new WeriftAdapter({
      iceServers: [],
      codecs: { audio: [], video: [useH264()] },
    });
    adapter.addTrack(adapter.createOutboundTrack('video'));
    await adapter.setRemoteDescription({ type: 'offer', sdp: offer });
    await adapter.createAnswer();

    const sender = adapter.getSenders()[0]!;
    sender.selectNegotiatedCodec({
      mimeType: 'video/H264',
      payloadType: PT_H264_MODE1,
      parameters: H264_MODE1,
    });

    expect(sender.codec?.payloadType).toBe(PT_H264_MODE1);
    expect(sender.codec?.parameters).toBe(H264_MODE1);
  });

  it('R-S3: the answer still echoes the browser fmtp verbatim, byte for byte', async () => {
    const offer = buildOffer({ h264Order: 'mode-0-first' });
    const adapter = new WeriftAdapter({
      iceServers: [],
      codecs: { audio: [], video: [useH264()] },
    });
    adapter.addTrack(adapter.createOutboundTrack('video'));
    await adapter.setRemoteDescription({ type: 'offer', sdp: offer });
    await adapter.createAnswer();

    const sender = adapter.getSenders()[0]!;
    sender.selectNegotiatedCodec({
      mimeType: 'video/H264',
      payloadType: PT_H264_MODE1,
      parameters: H264_MODE1,
    });

    const answer = await adapter.createAnswer();
    expect(fmtpLine(answer.sdp ?? '', PT_H264_MODE1)).toBe(
      fmtpLine(offer, PT_H264_MODE1),
    );
  });

  it('R-S3: selecting a codec that was never negotiated throws', async () => {
    const adapter = new WeriftAdapter({
      iceServers: [],
      codecs: { audio: [], video: [useH264()] },
    });
    adapter.addTrack(adapter.createOutboundTrack('video'));
    await adapter.setRemoteDescription({ type: 'offer', sdp: buildOffer() });
    await adapter.createAnswer();
    const sender = adapter.getSenders()[0]!;
    expect(() =>
      sender.selectNegotiatedCodec({
        mimeType: 'video/H264',
        payloadType: 127,
        parameters: 'packetization-mode=1',
      }),
    ).toThrow(/not negotiated/i);
  });

  it('R-S3: the track stamps the re-pointed payload type, not the old one', async () => {
    const adapter = new WeriftAdapter({
      iceServers: [],
      codecs: { audio: [], video: [useH264()] },
    });
    const track = adapter.createOutboundTrack('video');
    adapter.addTrack(track);
    await adapter.setRemoteDescription({
      type: 'offer',
      sdp: buildOffer({ h264Order: 'mode-0-first' }),
    });
    await adapter.createAnswer();
    const sender = adapter.getSenders()[0]!;
    sender.selectNegotiatedCodec({
      mimeType: 'video/H264',
      payloadType: PT_H264_MODE1,
      parameters: H264_MODE1,
    });
    // The track's own codec must have moved with the sender's. A sender-only
    // re-point leaves the track stamping pt104 into every packet.
    expect(sender.codec?.payloadType).toBe(PT_H264_MODE1);
    expect(adapter.getOutboundTrackCodec(track.id!)?.payloadType).toBe(
      PT_H264_MODE1,
    );
  });
});
