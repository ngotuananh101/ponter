# Plan 1 Task 3 — test-count declaration for `apps/agent/test/session/packetizer.test.ts`

Plan 1's Global Constraints make an undeclared `it()`/`expect()` change
BLOCKING. This file is that declaration for Task 3, which shipped without one.

## Counts

```
12 it() / 39 expect()  →  19 it() / 53 expect()
```

The left side is Plan 1 Task 3's own fence (`plan-1-spike-foundation-addon.md`,
the `packetizer.test.ts` fence inside Task 3, lines 1192-1658): 12 `it()` and
39 `expect()`. The right side is the file as delivered at `a9d97a1`.

**Nothing was deleted, skipped, or weakened.** All twelve fence tests are
present with their assertions intact and account for exactly 39 `expect()`
(measured: lines 1-206 of the file, the original twelve plus their helpers). The
seven additions account for the other 14.

## The seven additions

Every one is additive: a new `it()` block, no existing test touched.

| # | Test name | `expect()` | Why it exists |
|---|---|---|---|
| 1 | `splitAnnexB returns the NAL units with their start codes stripped` | 1 | `spike/spike.ts` imports `splitAnnexB` to strip parameter sets out of its fixture and provoke a PLI. Its previous source was `spike/packetizer-copy.ts`, which Step 8 deletes, so the real module must supply it — and step 8's import repoint is only safe if this behaviour is pinned. |
| 2 | `splitAnnexB keeps a bare buffer as a single NAL unit` | 1 | The crate treats a buffer with no start code as one NAL (`rtc-rtp-0.21.0/src/codec/h264/mod.rs:62-75`). This also records a real difference from the deleted copy, which scanned 3-byte start codes only. |
| 3 | `spsProfileLevelId reads the three bytes after the SPS header octet` | 1 | The spike compares the encoder's SPS `profile-level-id` against what the browser negotiated (spec R-S1/A3). Same source migration as #1. |
| 4 | `spsProfileLevelId returns null when the access unit carries no SPS` | 1 | The spike's `slicesOnly()` path sends access units with no SPS at all, so the null branch is the one that path actually takes. |
| 5 | `reproduces the FU-A vector from h264_test.rs:15-21` | 1 | The fence's own tests are hand-computed. This one transcribes the crate's literal expected byte array instead, so the port is pinned to Rust behaviour rather than to itself. |
| 6 | `produces the STAP-A aggregate from the Annex-B the same test names at h264_test.rs:101-104` | 4 | Same rationale for the aggregation path. The crate's literal is a depacketizer input, so the fixture is the Annex-B that test expands it from. Four expects: the packet count, the whole aggregate, and both 16-bit length fields read back out. |
| 7 | `splits exactly at the payload budget: equal stays single-NAL, one byte over fragments` | 5 | The off-by-one at the FU-A threshold. `emitNalUnit` compares `nalu.length <= maxPayloadBytes`, and the fence never exercised the boundary in either direction. Five expects: single-NAL at the budget, both exact FU-A fragment bytes over it, and the fragment count. |

Additions #5-#7 belong to the `describe("the crate's own conformance fixtures")`
block, which is the Task 3 fence's own "transcribed from the crate" instruction
applied to cases the fence did not write out; #1-#4 are the two helper exports
that Task 3's step 8 requires and its Interfaces block omitted.

## Fence defect this declaration records

Plan 1 Task 3's Interfaces block declared only `packetizeAnnexB` and
`annexbNalTypes`, while `spike/spike.ts` imports `packetizeAnnexB`,
`splitAnnexB` and `spsProfileLevelId`. The plan was amended at `44d5099` to
record the ruling; this file records the consequence for the test counts.
