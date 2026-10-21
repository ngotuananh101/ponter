/**
 * The RFC 6184 mode-1 H.264 packetizer.
 *
 * This is a port, not a fresh implementation. The Rust agent never wrote RTP
 * itself: it handed Annex-B bytes to
 * `TrackLocalStaticSample.sample_writer(ssrc, payload_type).write_sample(..)`
 * (`apps/agent/src/desktop.rs:1767-1776`) and the `rtc-rtp` crate did the
 * packetization. Every rule below was read out of that crate, and the
 * behaviour is pinned to it rather than to the RFC's freedom.
 */

/**
 * The default RTP payload budget, in bytes.
 *
 * The Rust agent's outbound MTU was 1200 bytes *including* the 12-byte RTP
 * header, so the payload budget was 1200 - 12 = 1188
 * (`webrtc-0.21.0/src/media_stream/track_local/static_sample.rs:89`,
 * `rtc-rtp-0.21.0/src/packetizer/mod.rs:137`).
 */
export const DEFAULT_MAX_PAYLOAD_BYTES = 1188;

/** The RTP header this packetizer writes: 12 bytes, no extension, no CSRCs. */
const RTP_HEADER_BYTES = 12;

/** NAL unit types the Rust payloader drops rather than sends. */
const AUD_NALU_TYPE = 9;
const FILLER_NALU_TYPE = 12;
const SPS_NALU_TYPE = 7;
const PPS_NALU_TYPE = 8;

/**
 * The STAP-A header byte the Rust payloader emits.
 *
 * This is `F|NRI|24` over the first aggregated NAL, which for the SPS/PPS pair
 * the payloader aggregates is always `0x78` (`0x60 | 24`). The bare NAL type
 * 24 is not named separately because nothing here branches on it: the
 * aggregate is built and stamped in one place.
 */
const STAP_A_HEADER_BYTE = 0x78;

/** The FU-A NAL unit type, and the two header octets it prepends. */
const FU_A_NALU_TYPE = 28;
const FU_A_HEADER_BYTES = 2;
const FU_START_BIT = 0x80;
const FU_END_BIT = 0x40;

/** Masks over a NAL unit's first octet. */
const NALU_TYPE_MASK = 0x1f;
const NALU_REF_IDC_MASK = 0x60;

/** The RTP marker bit lives in the top bit of the second header octet. */
const RTP_MARKER_BIT = 0x80;

/**
 * One outbound RTP packet: the header fields the caller must supply, and
 * the payload the browser will depacketize.
 */
export interface H264RtpPacket {
  /** The complete RTP packet: the 12-byte header, then the payload. */
  bytes: Buffer;
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
  /** The negotiated payload type. */
  payloadType: number;
  /**
   * The sequence number of the FIRST packet of the access unit. Every later
   * packet in the same access unit is the previous one plus one, wrapping at
   * 2^16 — the Rust sequencer's behaviour
   * (`rtc-rtp-0.21.0/src/packetizer/mod.rs:144-149`).
   */
  sequenceNumber: number;
  /** The RTP timestamp for this access unit, in 90 kHz ticks. */
  timestamp: number;
  /** The SSRC to stamp. */
  ssrc: number;
  /**
   * The maximum RTP **payload** size, in bytes, excluding the 12-byte RTP
   * header. Defaults to `DEFAULT_MAX_PAYLOAD_BYTES` (1188).
   */
  maxPayloadBytes?: number;
}

export interface PacketizeResult {
  /** The packets, in wire order. */
  packets: H264RtpPacket[];
  /**
   * The sequence number the NEXT access unit must start at — the caller owns
   * the sequencer, exactly as the Rust agent's `SampleWriter` did.
   */
  nextSequenceNumber: number;
}

/**
 * Split an Annex-B buffer into NAL units.
 *
 * The 3-byte (`00 00 01`) and 4-byte (`00 00 00 01`) start codes are both
 * handled, and the zero run in front of a start code belongs to the start
 * code, not to the preceding NAL — the same accounting as the crate's
 * `next_ind` (`rtc-rtp-0.21.0/src/codec/h264/mod.rs:62-75`). A buffer with no
 * start code at all is one NAL unit.
 *
 * Exported because the spike strips parameter sets out of a fixture to
 * provoke a PLI, and there is no second Annex-B parser in this package to do
 * it with — `spike/packetizer-copy.ts` used to be that parser and is gone.
 */
export function splitAnnexB(annexB: Buffer): Buffer[] {
  const nalUnits: Buffer[] = [];
  let nalStart = -1;
  let zeroCount = 0;

  for (let i = 0; i < annexB.length; i += 1) {
    const byte = annexB[i]!;
    if (byte === 0) {
      zeroCount += 1;
      continue;
    }
    if (byte === 1 && zeroCount >= 2) {
      if (nalStart !== -1) {
        const nalEnd = i - zeroCount;
        if (nalEnd > nalStart) {
          nalUnits.push(annexB.subarray(nalStart, nalEnd));
        }
      }
      nalStart = i + 1;
    }
    zeroCount = 0;
  }

  if (nalStart === -1) {
    // No start code: the whole buffer is one NAL unit.
    if (annexB.length > 0) {
      nalUnits.push(annexB);
    }
  } else if (nalStart < annexB.length) {
    nalUnits.push(annexB.subarray(nalStart));
  }

  return nalUnits;
}

/** Build the STAP-A aggregate the Rust payloader emits for SPS + PPS. */
function buildStapA(sps: Buffer, pps: Buffer): Buffer {
  const aggregate = Buffer.allocUnsafe(1 + 2 + sps.length + 2 + pps.length);
  aggregate[0] = STAP_A_HEADER_BYTE;
  aggregate.writeUInt16BE(sps.length, 1);
  sps.copy(aggregate, 3);
  aggregate.writeUInt16BE(pps.length, 3 + sps.length);
  pps.copy(aggregate, 5 + sps.length);
  return aggregate;
}

/**
 * Emit one NAL unit as a single-NAL payload, or as FU-A fragments when it does
 * not fit the budget.
 *
 * The FU indicator carries `F|NRI` from the NAL header and type 28; the FU
 * header carries `S|E|R|Type`. The NAL's first octet is skipped — the fragment
 * payload starts at `nalu[1]`, because the `F`/`NRI` bits went into the
 * indicator and the type went into the FU header
 * (`rtc-rtp-0.21.0/src/codec/h264/mod.rs:115-160`).
 */
function emitNalUnit(nalu: Buffer, maxPayloadBytes: number): Buffer[] {
  if (nalu.length <= maxPayloadBytes) {
    return [nalu];
  }

  const maxFragmentBytes = maxPayloadBytes - FU_A_HEADER_BYTES;
  if (maxFragmentBytes <= 0) {
    // The crate returns without emitting anything at this budget.
    return [];
  }

  const refIdc = nalu[0]! & NALU_REF_IDC_MASK;
  const naluType = nalu[0]! & NALU_TYPE_MASK;
  const indicator = FU_A_NALU_TYPE | refIdc;

  const fragments: Buffer[] = [];
  const bodyLength = nalu.length - 1;
  let offset = 1;
  let remaining = bodyLength;

  while (remaining > 0) {
    const fragmentBytes = Math.min(maxFragmentBytes, remaining);
    const fragment = Buffer.allocUnsafe(FU_A_HEADER_BYTES + fragmentBytes);
    fragment[0] = indicator;

    let header = naluType;
    if (remaining === bodyLength) {
      header |= FU_START_BIT;
    } else if (remaining - fragmentBytes === 0) {
      header |= FU_END_BIT;
    }
    fragment[1] = header;

    nalu.copy(fragment, FU_A_HEADER_BYTES, offset, offset + fragmentBytes);
    fragments.push(fragment);

    offset += fragmentBytes;
    remaining -= fragmentBytes;
  }

  return fragments;
}

/** Stamp the 12-byte RTP header in front of one payload. */
function buildPacket(
  payload: Buffer,
  payloadType: number,
  sequenceNumber: number,
  timestamp: number,
  ssrc: number,
  marker: boolean,
): H264RtpPacket {
  const header = Buffer.allocUnsafe(RTP_HEADER_BYTES);
  header[0] = 0x80; // version 2, no padding, no extension, no CSRCs
  header[1] = (payloadType & 0x7f) | (marker ? RTP_MARKER_BIT : 0);
  header.writeUInt16BE(sequenceNumber & 0xffff, 2);
  header.writeUInt32BE(timestamp >>> 0, 4);
  header.writeUInt32BE(ssrc >>> 0, 8);

  return {
    bytes: Buffer.concat([header, payload]),
    payload,
    payloadType,
    sequenceNumber: sequenceNumber & 0xffff,
    timestamp: timestamp >>> 0,
    marker,
  };
}

/**
 * Packetize one Annex-B access unit into RFC 6184 mode-1 RTP packets.
 *
 * Mode 1 is single-NAL-unit / STAP-A / FU-A. The caller MUST have
 * negotiated a payload type whose `fmtp` carries `packetization-mode=1`
 * (spec R-S3).
 *
 * @param annexB The access unit in Annex-B framing: zero or more
 *   `00 00 00 01` / `00 00 01` start codes followed by NAL units.
 * @throws If the buffer contains no NAL unit.
 */
export function packetizeAnnexB(
  annexB: Buffer,
  options: PacketizeOptions,
): PacketizeResult {
  const maxPayloadBytes = options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
  const nalUnits = splitAnnexB(annexB);

  if (nalUnits.length === 0) {
    throw new Error('packetizeAnnexB: the buffer contains no NAL unit');
  }

  const payloads: Buffer[] = [];
  let pendingSps: Buffer | null = null;
  let pendingPps: Buffer | null = null;

  for (const nalu of nalUnits) {
    const naluType = nalu[0]! & NALU_TYPE_MASK;

    if (naluType === AUD_NALU_TYPE || naluType === FILLER_NALU_TYPE) {
      continue;
    }
    if (naluType === SPS_NALU_TYPE) {
      pendingSps = nalu;
      continue;
    }
    if (naluType === PPS_NALU_TYPE) {
      pendingPps = nalu;
      continue;
    }

    if (pendingSps !== null && pendingPps !== null) {
      // The Rust payloader's comment says it packs the current NAL into the
      // aggregate; its code does not. The code is the contract.
      const aggregate = buildStapA(pendingSps, pendingPps);
      if (aggregate.length <= maxPayloadBytes) {
        payloads.push(aggregate);
      }
      pendingSps = null;
      pendingPps = null;
    }

    payloads.push(...emitNalUnit(nalu, maxPayloadBytes));
  }

  // The one deliberate divergence from the Rust payloader: a pending SPS/PPS
  // pair is flushed at the end of the access unit instead of being dropped.
  if (pendingSps !== null && pendingPps !== null) {
    const aggregate = buildStapA(pendingSps, pendingPps);
    if (aggregate.length <= maxPayloadBytes) {
      payloads.push(aggregate);
    }
  }

  const packets: H264RtpPacket[] = [];
  let sequenceNumber = options.sequenceNumber;

  for (let i = 0; i < payloads.length; i += 1) {
    packets.push(
      buildPacket(
        payloads[i]!,
        options.payloadType,
        sequenceNumber,
        options.timestamp,
        options.ssrc,
        i === payloads.length - 1,
      ),
    );
    sequenceNumber = (sequenceNumber + 1) & 0xffff;
  }

  return { packets, nextSequenceNumber: sequenceNumber };
}

/**
 * Extract the NAL unit types present in an Annex-B buffer.
 * Used by the conformance fixtures and by the codec's own smoke tests.
 */
export function annexbNalTypes(annexB: Buffer): number[] {
  return splitAnnexB(annexB).map((nalu) => nalu[0]! & NALU_TYPE_MASK);
}

/**
 * Read the `profile-level-id` out of an access unit's SPS, if it carries one.
 *
 * The three bytes after the SPS's own header octet are profile_idc,
 * constraint flags and level_idc — exactly the hex the SDP's `profile-level-id`
 * parameter quotes, so the spike can compare what the encoder emits against
 * what the browser negotiated. Returns null when there is no SPS, or when the
 * SPS is too short to carry a level.
 *
 * Exported for the same reason as `splitAnnexB`: the spike used to read this
 * off `spike/packetizer-copy.ts`.
 */
export function spsProfileLevelId(annexB: Buffer): string | null {
  for (const nalu of splitAnnexB(annexB)) {
    if ((nalu[0]! & NALU_TYPE_MASK) !== SPS_NALU_TYPE) {
      continue;
    }
    if (nalu.length < 4) {
      return null;
    }
    return nalu.subarray(1, 4).toString('hex');
  }
  return null;
}
