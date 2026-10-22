import { describe, expect, it } from 'vitest';
import {
  annexbNalTypes,
  DEFAULT_MAX_PAYLOAD_BYTES,
  packetizeAnnexB,
  splitAnnexB,
  spsProfileLevelId,
} from '../../src/session/packetizer';

const SSRC = 0x11223344;
const PT = 102;

function buildAnnexB(nals: Buffer[]): Buffer {
  return Buffer.concat(nals.flatMap((n) => [Buffer.from([0, 0, 0, 1]), n]));
}

/** The Rust payloader's own fixture: SPS + PPS + a 3-byte IDR. */
const SPS = Buffer.from([0x67, 0x42, 0xc0, 0x1f]);
const PPS = Buffer.from([0x68, 0xce]);
const IDR = Buffer.from([0x65, 0x88, 0x84]);

describe('packetizeAnnexB', () => {
  it('emits a single-NAL packet when the NAL fits', () => {
    const { packets } = packetizeAnnexB(buildAnnexB([IDR]), {
      payloadType: PT,
      sequenceNumber: 7,
      timestamp: 90000,
      ssrc: SSRC,
    });
    expect(packets).toHaveLength(1);
    // The Annex-B start code is stripped: the payload is the bare NAL.
    expect(packets[0]!.payload).toEqual(IDR);
    expect(packets[0]!.payload[0]! & 0x1f).toBe(5); // NAL type 5 = IDR
  });

  it('drops an AUD and a filler NAL entirely', () => {
    const aud = Buffer.from([0x09, 0x10]);
    const filler = Buffer.from([0x0c, 0xff, 0xff]);
    const { packets } = packetizeAnnexB(buildAnnexB([aud, filler, IDR]), {
      payloadType: PT,
      sequenceNumber: 0,
      timestamp: 0,
      ssrc: SSRC,
    });
    // The Rust payloader returns zero payloads for a type-9 buffer; the AUD
    // and the filler never reach the wire.
    expect(packets).toHaveLength(1);
    expect(packets[0]!.payload).toEqual(IDR);
  });

  it('caches the SPS and the PPS, then emits them as one STAP-A', () => {
    const { packets } = packetizeAnnexB(buildAnnexB([SPS, PPS, IDR]), {
      payloadType: PT,
      sequenceNumber: 0,
      timestamp: 0,
      ssrc: SSRC,
    });
    // Two packets: the STAP-A (SPS + PPS), then the IDR as a single NAL.
    expect(packets).toHaveLength(2);

    const stap = packets[0]!.payload;
    expect(stap[0]! & 0x1f).toBe(24); // STAP-A
    expect(stap[0]! & 0x60).toBe(0x60); // F|NRI from the SPS header (0x67)
    // The two NALs follow, each behind its 2-byte big-endian length.
    expect(stap.readUInt16BE(1)).toBe(SPS.length);
    expect(stap.subarray(3, 3 + SPS.length)).toEqual(SPS);
    expect(stap.readUInt16BE(3 + SPS.length)).toBe(PPS.length);
    expect(stap.subarray(5 + SPS.length, 5 + SPS.length + PPS.length)).toEqual(
      PPS,
    );
    // The STAP-A does NOT carry the IDR — the Rust payloader's code does not
    // include the current NAL in the aggregate, even though its comment says
    // it does. The code is the contract.
    expect(stap).toHaveLength(1 + 2 + SPS.length + 2 + PPS.length);

    expect(packets[1]!.payload).toEqual(IDR);
  });

  it('flushes a pending SPS/PPS pair as a STAP-A when the access unit ends', () => {
    const { packets } = packetizeAnnexB(buildAnnexB([SPS, PPS]), {
      payloadType: PT,
      sequenceNumber: 0,
      timestamp: 0,
      ssrc: SSRC,
    });
    // The Rust payloader emits NOTHING here (the pair is dropped). The TS
    // packetizer flushes it — the one deliberate divergence, and it is
    // recorded in the coverage matrix.
    expect(packets).toHaveLength(1);
    expect(packets[0]!.payload[0]! & 0x1f).toBe(24); // STAP-A
  });

  it('fragments a NAL larger than the max payload into FU-A', () => {
    const big = Buffer.alloc(3000, 0xaa);
    big[0] = 0x65; // IDR
    const { packets } = packetizeAnnexB(buildAnnexB([big]), {
      payloadType: PT,
      sequenceNumber: 0,
      timestamp: 0,
      ssrc: SSRC,
      maxPayloadBytes: 1200,
    });
    expect(packets.length).toBeGreaterThan(1);

    // The FU indicator carries F|NRI from the NAL header and type 28.
    const first = packets[0]!.payload;
    expect(first[0]! & 0x1f).toBe(28); // FU-A
    expect(first[0]! & 0x60).toBe(0x60); // F|NRI from 0x65
    // The FU header carries the type and the start bit.
    expect(first[1]! & 0x1f).toBe(5); // the fragmented NAL's type
    expect(first[1]! & 0x80).toBe(0x80); // start bit
    // The last fragment clears the start bit and sets the end bit.
    const last = packets[packets.length - 1]!.payload;
    expect(last[1]! & 0x80).toBe(0);
    expect(last[1]! & 0x40).toBe(0x40); // end bit
  });

  it('skips the NAL header octet inside the FU-A fragments', () => {
    // The Rust payloader starts the fragment payload at nalu[1]: the F/NRI
    // bits went into the indicator and the type went into the FU header, so
    // re-sending the header octet would duplicate it.
    const body = Buffer.alloc(64, 0xbb);
    const nalu = Buffer.concat([Buffer.from([0x65]), body]);
    const { packets } = packetizeAnnexB(buildAnnexB([nalu]), {
      payloadType: PT,
      sequenceNumber: 0,
      timestamp: 0,
      ssrc: SSRC,
      maxPayloadBytes: 32,
    });
    // 2 header bytes + 64 body bytes, budget 32 -> 3 fragments.
    expect(packets).toHaveLength(3);
    expect(packets[0]!.payload.subarray(2)).toEqual(body.subarray(0, 30));
    expect(packets[2]!.payload.subarray(2)).toEqual(body.subarray(60));
  });

  it('stamps the negotiated payload type, sequence number, and timestamp', () => {
    const { packets } = packetizeAnnexB(buildAnnexB([IDR]), {
      payloadType: PT,
      sequenceNumber: 4242,
      timestamp: 90000,
      ssrc: SSRC,
    });
    const header = packets[0]!.bytes;
    expect(header[0]! >> 6).toBe(2); // RTP version 2
    expect(header[1]! & 0x7f).toBe(PT);
    expect(header.readUInt16BE(2)).toBe(4242);
    expect(header.readUInt32BE(4)).toBe(90000);
    expect(header.readUInt32BE(8)).toBe(SSRC);
  });

  it('sets the marker bit on the last packet of the access unit only', () => {
    const big = Buffer.alloc(3000, 0xaa);
    big[0] = 0x65;
    const { packets } = packetizeAnnexB(buildAnnexB([big]), {
      payloadType: PT,
      sequenceNumber: 0,
      timestamp: 0,
      ssrc: SSRC,
      maxPayloadBytes: 1200,
    });
    // The marker marks the partition tail, not each fragment.
    expect(packets.slice(0, -1).every((p) => p.marker === false)).toBe(true);
    expect(packets[packets.length - 1]!.marker).toBe(true);
  });

  it('increments the sequence number across the packets of one access unit', () => {
    const big = Buffer.alloc(3000, 0xaa);
    big[0] = 0x65;
    const { packets, nextSequenceNumber } = packetizeAnnexB(
      buildAnnexB([big]),
      {
        payloadType: PT,
        sequenceNumber: 100,
        timestamp: 0,
        ssrc: SSRC,
        maxPayloadBytes: 1200,
      },
    );
    expect(packets[0]!.sequenceNumber).toBe(100);
    expect(packets[1]!.sequenceNumber).toBe(101);
    expect(nextSequenceNumber).toBe(100 + packets.length);
  });

  it('defaults the payload budget to 1188 bytes, the Rust MTU minus the header', () => {
    expect(DEFAULT_MAX_PAYLOAD_BYTES).toBe(1188);
  });

  it('rejects a buffer with no NAL unit', () => {
    expect(() =>
      packetizeAnnexB(Buffer.from([0, 0, 0, 1]), {
        payloadType: PT,
        sequenceNumber: 0,
        timestamp: 0,
        ssrc: SSRC,
      }),
    ).toThrow();
  });
});

describe('annexbNalTypes', () => {
  it('reads the NAL types of an SPS/PPS/IDR access unit', () => {
    const types = annexbNalTypes(buildAnnexB([SPS, PPS, IDR]));
    expect(types).toEqual([7, 8, 5]);
  });
});

describe('the helpers the spike consumes', () => {
  // Task 1's spike needs to strip parameter sets from a fixture (to provoke a
  // PLI) and to read the encoder's profile-level-id out of the SPS. Both used
  // to come from `spike/packetizer-copy.ts`; Step 8 deletes that file, so the
  // real module has to supply them or the spike test breaks on a live import.
  it('splitAnnexB returns the NAL units with their start codes stripped', () => {
    const nals = splitAnnexB(buildAnnexB([SPS, PPS, IDR]));
    expect(nals).toEqual([SPS, PPS, IDR]);
  });

  it('splitAnnexB keeps a bare buffer as a single NAL unit', () => {
    // No start code at all: the crate treats the whole buffer as one NAL
    // (`rtc-rtp-0.21.0/src/codec/h264/mod.rs:62-75`).
    expect(splitAnnexB(SPS)).toEqual([SPS]);
  });

  it('spsProfileLevelId reads the three bytes after the SPS header octet', () => {
    // 0x67 is the SPS NAL header; the next three bytes are profile, constraint
    // flags and level, which is exactly the `profile-level-id` an SDP quotes.
    expect(spsProfileLevelId(buildAnnexB([SPS, PPS, IDR]))).toBe('42c01f');
  });

  it('spsProfileLevelId returns null when the access unit carries no SPS', () => {
    expect(spsProfileLevelId(buildAnnexB([PPS, IDR]))).toBeNull();
  });
});

/**
 * The crate's own vectors, literal.
 *
 * Every expected byte array below is transcribed from
 * `rtc-rtp-0.21.0/src/codec/h264/h264_test.rs` rather than recomputed from the
 * implementation — a fixture that derives its own expectation proves only that
 * the code agrees with itself.
 */
describe("the crate's own conformance fixtures", () => {
  it('reproduces the FU-A vector from h264_test.rs:15-21', () => {
    // `large_payload`: a 3-byte start code, then a 16-byte NAL unit.
    const annexB = Buffer.from([
      0x00, 0x00, 0x01, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
      0x09, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15,
    ]);
    // `large_payload_packetized`, at MTU 5 — budgets are payload bytes here, so
    // the crate's 5 becomes maxPayloadBytes 5.
    const expected = [
      [0x1c, 0x80, 0x01, 0x02, 0x03],
      [0x1c, 0x00, 0x04, 0x05, 0x06],
      [0x1c, 0x00, 0x07, 0x08, 0x09],
      [0x1c, 0x00, 0x10, 0x11, 0x12],
      [0x1c, 0x40, 0x13, 0x14, 0x15],
    ].map((bytes) => Buffer.from(bytes));

    const { packets } = packetizeAnnexB(annexB, {
      payloadType: PT,
      sequenceNumber: 0,
      timestamp: 0,
      ssrc: SSRC,
      maxPayloadBytes: 5,
    });

    expect(packets.map((p) => p.payload)).toEqual(expected);
  });

  it('produces the STAP-A aggregate from the Annex-B the same test names at h264_test.rs:101-104', () => {
    // The literal at `:97-100` is a DEPACKETIZER input. Our packetizer runs the
    // other direction, so the fixture is the Annex-B the same test expands that
    // aggregate back into — and the assertion is that we produce the aggregate.
    const annexB = Buffer.from([
      0x00, 0x00, 0x00, 0x01, 0x67, 0x42, 0xc0, 0x1f, 0x1a, 0x32, 0x35, 0x01,
      0x40, 0x7a, 0x40, 0x3c, 0x22, 0x11, 0xa8, 0x00, 0x00, 0x00, 0x01, 0x68,
      0x1a, 0x34, 0xe3, 0xc8,
    ]);
    const aggregate = Buffer.from([
      0x78, 0x00, 0x0f, 0x67, 0x42, 0xc0, 0x1f, 0x1a, 0x32, 0x35, 0x01, 0x40,
      0x7a, 0x40, 0x3c, 0x22, 0x11, 0xa8, 0x00, 0x05, 0x68, 0x1a, 0x34, 0xe3,
      0xc8,
    ]);

    const { packets } = packetizeAnnexB(annexB, {
      payloadType: PT,
      sequenceNumber: 0,
      timestamp: 0,
      ssrc: SSRC,
    });

    // One packet: this access unit carries the parameter sets and nothing else,
    // so the flush at end-of-access-unit emits the aggregate and nothing more.
    expect(packets).toHaveLength(1);
    expect(packets[0]!.payload).toEqual(aggregate);
    // The two 16-bit lengths and both bodies, read back out of the aggregate.
    expect(packets[0]!.payload.readUInt16BE(1)).toBe(0x000f);
    expect(packets[0]!.payload.readUInt16BE(3 + 0x000f)).toBe(0x0005);
  });

  it('splits exactly at the payload budget: equal stays single-NAL, one byte over fragments', () => {
    const budget = 32;
    const atBudget = Buffer.concat([
      Buffer.from([0x65]),
      Buffer.alloc(budget - 1, 0xcc),
    ]);
    const overBudget = Buffer.concat([
      Buffer.from([0x65]),
      Buffer.alloc(budget, 0xcc),
    ]);

    const exact = packetizeAnnexB(buildAnnexB([atBudget]), {
      payloadType: PT,
      sequenceNumber: 0,
      timestamp: 0,
      ssrc: SSRC,
      maxPayloadBytes: budget,
    });
    expect(exact.packets).toHaveLength(1);
    expect(exact.packets[0]!.payload).toEqual(atBudget);

    const over = packetizeAnnexB(buildAnnexB([overBudget]), {
      payloadType: PT,
      sequenceNumber: 0,
      timestamp: 0,
      ssrc: SSRC,
      maxPayloadBytes: budget,
    });
    // 2 FU header bytes + 30 payload bytes, then the remaining 2 bytes.
    // The FU indicator carries F|NRI from the 0x65 header (0x60) and type 28,
    // so the octet is 0x7c; the FU header is the NAL type (5) plus the start
    // bit on the first fragment and the end bit on the last.
    expect(over.packets).toHaveLength(2);
    expect(over.packets[0]!.payload).toEqual(
      Buffer.concat([Buffer.from([0x7c, 0x85]), Buffer.alloc(30, 0xcc)]),
    );
    expect(over.packets[1]!.payload).toEqual(
      Buffer.concat([Buffer.from([0x7c, 0x45]), Buffer.alloc(2, 0xcc)]),
    );
  });
});
