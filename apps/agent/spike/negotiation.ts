// apps/agent/spike/negotiation.ts
import { RTCPeerConnection, useH264, useVP8 } from 'werift';
import { buildOffer } from '@ponter/webrtc-core/test/synthetic-offer';

/**
 * The codec list is R-S1's lever.
 *
 * With `[useH264()]` werift filters the browser's VP8 entry out and keeps
 * both H.264 entries. With `[useVP8(), useH264()]` the VP8 entry survives
 * the filter and — because werift takes `params.codecs[0]` as the sender's
 * codec (rtpSender.js:408) — the sender lands on VP8. That is the
 * black-video bug, measured.
 */
function localCodecs(
  run: 'r-s1-list' | 'vp8-first-local' | 'mode-0-first-offer',
) {
  return run === 'vp8-first-local'
    ? { audio: [], video: [useVP8(), useH264()] }
    : { audio: [], video: [useH264()] };
}

export interface NegotiationResult {
  negotiatedCodec: {
    mimeType: string;
    payloadType: number;
    parameters?: string;
  } | null;
  negotiatedPacketizationMode: number | null;
  answerSdp: string;
  offerSdp: string;
}

export async function probeNegotiation(
  run: 'r-s1-list' | 'vp8-first-local' | 'mode-0-first-offer',
  options: { applyR_S3?: boolean } = {},
): Promise<NegotiationResult> {
  // R-S3 is the fix for the mime-type-only filter, so it is deliberately NOT
  // applied to `vp8-first-local`: that run exists to MEASURE the bug, and
  // re-pointing its sender would erase the very thing it reports. Every other
  // run wants H.264 and therefore wants the re-point.
  const applyR_S3 = options.applyR_S3 ?? run !== 'vp8-first-local';
  const offerSdp = buildOffer({
    h264Order: run === 'mode-0-first-offer' ? 'mode-0-first' : 'mode1-first',
  });

  const pc = new RTCPeerConnection({
    codecs: localCodecs(run),
    iceServers: [],
  });

  // The transceiver MUST exist before setRemoteDescription (R-S4, D4e).
  // Adding it afterwards yields a second, a=inactive m-line whose
  // sender.codec is undefined, which D4c then turns into a silent no-op.
  pc.addTransceiver('video', { direction: 'sendrecv' });

  await pc.setRemoteDescription({ type: 'offer', sdp: offerSdp });

  const transceiver = pc.getTransceivers()[0]!;
  const sender = transceiver.sender as unknown as {
    codec?: { mimeType: string; payloadType: number; parameters?: string };
  };

  if (applyR_S3) {
    const mode1Entry = (transceiver.codecs ?? []).find(
      (c) =>
        c.mimeType.toLowerCase() === 'video/h264' &&
        (c.parameters ?? '').includes('packetization-mode=1'),
    );
    if (!mode1Entry) {
      throw new Error(
        'R-S3: the browser offered no H.264 entry with packetization-mode=1.',
      );
    }
    // Move the chosen entry to the front so the answer's m-line leads with it
    // and its `a=fmtp:` line is the first H.264 one (sdpManager.js:90-100
    // builds the payload-type order from `transceiver.codecs`).
    //
    // TIMING MATTERS: `prepareSend` — which takes `params.codecs[0]` as the
    // sender's codec (rtpSender.js:402-410) — already ran inside
    // `setRemoteDescription` (transceiverManager.js:276-277). Reordering the
    // list afterwards does NOT re-run it, so `sender.codec` would stay on the
    // mode-0 entry the mime-type-only filter happened to put first. That is
    // why `sender.codec` is assigned explicitly just below, and why all three
    // objects move together.
    //
    // MUTATE in place, never replace: `{...codec}` drops the `name` prototype
    // getter (parameters.js:54-56) and sdpManager.js:107 then throws
    // `TypeError: Cannot read properties of undefined (reading 'toLowerCase')`.
    transceiver.codecs = [
      mode1Entry,
      ...(transceiver.codecs ?? []).filter((c) => c !== mode1Entry),
    ];
    sender.codec = mode1Entry as typeof sender.codec;
  }

  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);

  const negotiatedCodec = sender.codec ?? null;
  return {
    negotiatedCodec,
    negotiatedPacketizationMode: negotiatedCodec?.parameters?.includes(
      'packetization-mode=1',
    )
      ? 1
      : negotiatedCodec
        ? 0
        : null,
    answerSdp: answer.sdp ?? '',
    offerSdp,
  };
}
