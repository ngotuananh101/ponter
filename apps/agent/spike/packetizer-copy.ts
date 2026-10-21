// apps/agent/spike/packetizer-copy.ts
/**
 * A LOCAL COPY of the RFC 6184 packetizer, carried only for the P0 spike.
 *
 * Task 3 builds the real module at `apps/agent/src/session/packetizer.ts` and
 * deletes this file. It exists because the spike must not wait for Task 3 —
 * and because the spike's job is to test werift as a sender, not to test the
 * packetizer, so a small faithful copy keeps the two concerns separable.
 *
 * The behaviour follows the Rust agent's own payloader (the `rtc-rtp` crate's
 * H.264 packetizer), which is the parity target:
 *
 * - the buffer is split at Annex-B start codes (3- and 4-byte forms);
 * - NAL types 9 (AUD) and 12 (filler) are dropped;
 * - NAL types 7 (SPS) and 8 (PPS) are cached and emitted as one STAP-A;
 * - the STAP-A is emitted before the first non-parameter NAL and carries the
 *   parameter sets ONLY — the current NAL follows it as its own packet;
 * - a NAL that fits the budget is emitted bare (start code stripped);
 * - a larger NAL becomes FU-A fragments, the NAL's first octet skipped;
 * - the marker bit is set on the last packet of the access unit.
 */

export const DEFAULT_MAX_PAYLOAD_BYTES = 1188;

const NAL_TYPE_AUD = 9;
const NAL_TYPE_FILLER = 12;
const NAL_TYPE_SPS = 7;
const NAL_TYPE_PPS = 8;
const NAL_TYPE_FU_A = 28;

export interface H264RtpPacket {
  /** The RTP payload — the H.264 bytes the browser will depacketize. */
  payload: Buffer;
  /** The payload type stamped in the header. */
  payloadType: number;
  /** The RTP sequence number stamped in the header. */
  sequenceNumber: number;
  /** The RTP timestamp stamped in the header (90 kHz). */
  timestamp: number;
  /** The marker bit — true on the last packet of the access unit. */
  marker: boolean;
}

export interface PacketizeOptions {
  payloadType: number;
  sequenceNumber: number;
  timestamp: number;
  /**
   * The SSRC for this stream. Carried for interface parity with the real
   * module (plan Task 3) — the RTP header's SSRC is stamped by the caller's
   * own `RtpHeader`, since `H264RtpPacket` carries only the payload.
   */
  ssrc: number;
  maxPayloadBytes?: number;
}

export interface PacketizeResult {
  packets: H264RtpPacket[];
  nextSequenceNumber: number;
}

/** Split an Annex-B buffer into NAL units, start codes stripped. */
export function splitAnnexB(annexB: Buffer): Buffer[] {
  const starts: Array<{ start: number; length: number }> = [];
  for (let i = 0; i + 2 < annexB.length; i++) {
    if (annexB[i] === 0 && annexB[i + 1] === 0 && annexB[i + 2] === 1) {
      starts.push({ start: i, length: 3 });
      i += 2;
    }
  }
  if (starts.length === 0) {
    return annexB.length > 0 ? [annexB] : [];
  }
  const nals: Buffer[] = [];
  for (let i = 0; i < starts.length; i++) {
    const begin = starts[i]!.start + starts[i]!.length;
    const end = i + 1 < starts.length ? starts[i + 1]!.start : annexB.length;
    if (end > begin) {
      nals.push(annexB.subarray(begin, end));
    }
  }
  return nals;
}

/** The NAL unit types present in an Annex-B buffer. */
export function annexbNalTypes(annexB: Buffer): number[] {
  return splitAnnexB(annexB).map((nal) => nal[0]! & 0x1f);
}

function stapA(sps: Buffer, pps: Buffer): Buffer {
  const header = Buffer.from([0x78]);
  const len = (n: Buffer) => {
    const b = Buffer.alloc(2);
    b.writeUInt16BE(n.length, 0);
    return b;
  };
  return Buffer.concat([header, len(sps), sps, len(pps), pps]);
}

function fuA(nal: Buffer, budget: number): Buffer[] {
  const indicatorBase = (nal[0]! & 0xe0) | NAL_TYPE_FU_A;
  const nalType = nal[0]! & 0x1f;
  const body = nal.subarray(1);
  const maxChunk = budget - 2;
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < body.length; offset += maxChunk) {
    const chunk = body.subarray(offset, offset + maxChunk);
    const start = offset === 0;
    const end = offset + maxChunk >= body.length;
    const fuHeader = (start ? 0x80 : 0) | (end ? 0x40 : 0) | (nalType & 0x1f);
    chunks.push(Buffer.concat([Buffer.from([indicatorBase, fuHeader]), chunk]));
  }
  return chunks;
}

/**
 * Packetize one Annex-B access unit.
 *
 * `sequenceNumber` is the first packet's sequence number; the caller owns the
 * sequencer and reads the next one from `nextSequenceNumber`.
 */
export function packetizeAnnexB(
  annexB: Buffer,
  options: PacketizeOptions,
): PacketizeResult {
  const budget = options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
  const nals = splitAnnexB(annexB);
  if (nals.length === 0) {
    throw new Error('packetizeAnnexB: the buffer contains no NAL unit');
  }

  let sps: Buffer | undefined;
  let pps: Buffer | undefined;
  let stapAEmitted = false;
  const payloads: Buffer[] = [];

  for (const nal of nals) {
    const type = nal[0]! & 0x1f;
    if (type === NAL_TYPE_AUD || type === NAL_TYPE_FILLER) {
      continue;
    }
    if (type === NAL_TYPE_SPS) {
      sps = nal;
      continue;
    }
    if (type === NAL_TYPE_PPS) {
      pps = nal;
      continue;
    }
    if (!stapAEmitted && sps && pps) {
      payloads.push(stapA(sps, pps));
      stapAEmitted = true;
    }
    if (nal.length <= budget) {
      payloads.push(nal);
    } else {
      payloads.push(...fuA(nal, budget));
    }
  }

  const packets = payloads.map((payload, index) => ({
    payload,
    payloadType: options.payloadType,
    sequenceNumber: (options.sequenceNumber + index) & 0xffff,
    timestamp: options.timestamp,
    marker: index === payloads.length - 1,
  }));

  return {
    packets,
    nextSequenceNumber: (options.sequenceNumber + packets.length) & 0xffff,
  };
}

/**
 * Parse the `profile-level-id` out of the first SPS in an Annex-B buffer.
 *
 * Used by A4: it reports what the encoder ACTUALLY emits, so the spike can
 * compare it against the `profile-level-id` the SDP negotiated. The Rust agent
 * shipped `42001f` while emitting `42c0XX` and no test noticed, because no test
 * looked at decoded pixels (spec A4, Review Focus #2).
 */
export function spsProfileLevelId(annexB: Buffer): string | null {
  for (const nal of splitAnnexB(annexB)) {
    if ((nal[0]! & 0x1f) !== NAL_TYPE_SPS) {
      continue;
    }
    if (nal.length < 4) {
      return null;
    }
    return nal.subarray(1, 4).toString('hex');
  }
  return null;
}
