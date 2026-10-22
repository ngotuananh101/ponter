/**
 * Synthetic Chrome-shaped SDP offers for the P0 spike and the adapter tests.
 *
 * The shape mirrors a real Chrome 154 offer: VP8 (pt96) first, then the
 * RTX pair, then TWO H.264 entries — pt102 with packetization-mode=1 and
 * pt104 with packetization-mode=0. Chrome's ordering is the interesting
 * case, because werift filters the remote list by mime type only and never
 * inspects the fmtp (spec D4d).
 *
 * These offers are used for the NEGOTIATION half only. The fingerprint below
 * is a placeholder: nothing ever completes a DTLS handshake against it, and
 * the spike never tries.
 */

export const FINGERPRINT =
  'sha-256 AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99';

export const H264_MODE1 =
  'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f';
export const H264_MODE0 =
  'level-asymmetry-allowed=1;packetization-mode=0;profile-level-id=42e01f';

/** The payload types Chrome uses for the two H.264 entries. */
export const PT_H264_MODE1 = 102;
export const PT_H264_MODE0 = 104;
export const PT_VP8 = 96;

export interface OfferOptions {
  /**
   * The order the H.264 entries appear in the m-line. `mode1-first` is
   * Chrome's ordering; `mode-0-first` is the negative case (spec §3.5.2).
   */
  h264Order?: 'mode1-first' | 'mode-0-first';
  /** Include the VP8 entry at all. Chrome always offers it. */
  includeVp8?: boolean;
}

export function buildOffer(options: OfferOptions = {}): string {
  const { h264Order = 'mode1-first', includeVp8 = true } = options;
  const payloadTypes: number[] = [];
  if (includeVp8) payloadTypes.push(PT_VP8, 97);
  const h264Pts =
    h264Order === 'mode1-first'
      ? [PT_H264_MODE1, PT_H264_MODE0]
      : [PT_H264_MODE0, PT_H264_MODE1];
  payloadTypes.push(...h264Pts);

  const lines = [
    'v=0',
    'o=- 4611731400430051336 2 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'a=group:BUNDLE 0',
    'a=extmap-allow-mixed',
    'a=msid-semantic: WMS',
    `m=video 9 UDP/TLS/RTP/SAVPF ${payloadTypes.join(' ')}`,
    'c=IN IP4 0.0.0.0',
    'a=rtcp:9 IN IP4 0.0.0.0',
    'a=ice-ufrag:abcd',
    'a=ice-pwd:0123456789abcdef01234567',
    'a=ice-options:trickle',
    `a=fingerprint:${FINGERPRINT}`,
    'a=setup:actpass',
    'a=mid:0',
    'a=recvonly',
    'a=rtcp-mux',
  ];
  if (includeVp8) {
    lines.push(
      'a=rtpmap:96 VP8/90000',
      'a=rtcp-fb:96 nack',
      'a=rtcp-fb:96 nack pli',
      'a=rtpmap:97 rtx/90000',
      'a=fmtp:97 apt=96',
    );
  }
  for (const pt of h264Pts) {
    lines.push(
      `a=rtpmap:${pt} H264/90000`,
      `a=rtcp-fb:${pt} nack`,
      `a=rtcp-fb:${pt} nack pli`,
    );
    lines.push(
      `a=fmtp:${pt} ${pt === PT_H264_MODE1 ? H264_MODE1 : H264_MODE0}`,
    );
  }
  lines.push('a=ssrc:1234567890 cname:chrome', '');
  return lines.join('\r\n');
}
