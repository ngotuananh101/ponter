# Agent Node/TypeScript Rewrite — Plan 1: Spike, Foundations, and the Native Addon

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove that werift can send H.264 to a browser that decodes visible pixels, then lay the shared foundations (stream-profile table, TS API-access gate) and build the N-API native addon (capture, openh264 encode, input injection) with a fault-containment guarantee.

**Architecture:** Three deliverables, each independently testable. (1) A **spike** that drives a real werift answerer against a synthetic Chrome-shaped offer and a real Chromium peer, asserting decoded pixels — the viability gate that decides whether the whole rewrite proceeds. (2) **Foundations** — the shared stream-profile table moved into `@ponter/shared`, the cross-language parity test replaced by a same-language import, and the TypeScript API-access boundary gate. (3) The **native addon** — a small N-API surface (`frames in, Annex-B out`) over openh264 and the platform capture/input APIs, built against Electron's headers.

**Tech Stack:** Node.js 24, TypeScript, werift 0.24.4, `node-addon-api` ^7.1.0, node-gyp + binding.gyp, openh264 0.9.8 (BSD-2-Clause, Cisco), Vitest, Playwright (Chromium), Electron 35.7.5 headers.

**Spec:** `docs/superpowers/specs/2026-10-21-agent-node-ts-rewrite-design.md` — §3.3 (packetizer placement), §3.4 (reuse map), §3.5 and §3.5.1–§3.5.4 (the `PeerConnection` inversion and the four sender requirements), §6.1 (package layout), §6.3 (addon build), §6.4 (packaging), §8 (phases P0–P2), §9.2 (fault-containment gate), §9.3 (werift-as-sender gate), §11.1 (Q1–Q5, Q8, Q11).

**Plan series:** Plan 1 (this file) → Plan 2 (the core: signalling, E2EE, terminal, files, desktop session, packetizer) → Plan 3 (desktop integration, Rust retirement, CI, docs). Each plan ends with working, testable software. Plan 1 is a **prerequisite** for Plan 2 and Plan 3; they must not be executed in parallel.

## Global Constraints

These apply to every task in this plan. They are copied verbatim from the spec.

- **No Rust fallback.** The Rust tree is not maintained in parallel; it is deleted in Plan 3 (spec §4.7 R4, R5). Nothing in this plan may depend on `cargo`, on `apps/agent/target/`, or on the Rust agent binary.
- **All code, identifiers, comments, commit messages, and documentation are in English.** Zero Vietnamese characters in any diff.
- **Commit attribution:** author is `Ngo Tuan Anh <ngotuananh2101@gmail.com>`. **Never** add a `Co-authored-by` trailer of any kind.
- **No credentials in process lists (ADR-13).** The sidecar's config is env-var-only so the credential never appears in `ps`. In-process this is satisfied a fortiori, but the env-var *names* (`AGENT_ID`, `AGENT_SERVER`, `AGENT_CREDENTIAL`, `STUN_SERVER`, `AGENT_ALLOW_INPUT`, `AGENT_FILES_ROOT`, `AGENT_IDENTITY_PATH`, `AGENT_DESKTOP_PROFILE`) remain the desktop↔agent contract.
- **The identity file is written with mode `0o600`.** Non-negotiable; Plan 2 carries it, Plan 1 does not touch it.
- **The addon must never let a C++ exception cross the FFI boundary, must bounds-check every buffer, and must return errors as JS exceptions with a stable code — never as a crash.**
- **TEST-INTEGRITY:** never delete, skip, or weaken a test to make it green. Every test change declares the before→after `it()`/`expect()` counts and the rationale. An undeclared test change is BLOCKING.
- **`packages/ui-components/src/components/ui/**` is shadcn-vue generated.** Never edit it. Custom components wrap it from the outside.
- **Historical records are not edited.** `docs/superpowers/{specs,plans}/*`, `docs/demos/*`, `docs/spikes/*`, `docs/notes/*`, `docs/security/*` stay as written. This plan may *cite* them, never *edit* them.
- **The addon is built against Electron's headers** (spec D7): Electron 35.7.5 embeds Node 22 while the repo targets Node 24, so a Node-ABI addon will not load in the desktop app. Build with `node-gyp --target=<electron version>` or `electron-rebuild`.
- **The addon's surface stays narrow** (spec §6.3): capture in, resize to the profile size, RGBA8 → I420, encode, Annex-B out, input injection in. The RFC 6184 packetizer lives in TypeScript, not in the addon (spec O2 — a PM call, listed for the owner).
- **CI facts this plan must not forget** (all verified against the tree at `798e9df`):
  - `@ponter/shared`'s tests are **non-gating**: `ci-node.yml` runs them under `continue-on-error: true`. A green assertion in `packages/shared/test/**` cannot fail the build. Every shared-table assertion Task 5 adds is therefore *also* pinned from a gating package — that is what `agent-api-access-gate.test.ts` in `@ponter/api-client` is for.
  - `ci-node.yml`'s `paths:` filter lists `apps/server/**`, `apps/web/**`, `apps/mobile/**`, `packages/**` and the config files — **`apps/agent/**` is absent**. Until Plan 3 adds it, a commit that touches only `apps/agent/**` runs **no Node CI at all**. Task verification must run the suites locally and say so.
  - The three `--filter='!@ponter/agent'` exclusions in `ci-node.yml` (lines 73, 76, 98) are keyed on the *package name*. Renaming `apps/agent/package.json` to `@ponter/agent-node` turns all three into no-ops — the agent would be picked up by the standard gate as soon as the `paths:` filter lets it run. Do not rely on the exclusion; Plan 3 removes it.
  - `pnpm-workspace.yaml`'s `allowBuilds` is keyed on the **package name that owns the install script**. The addon must have its own `package.json` (`@ponter/agent-native`) for its entry to take effect; a bare `native/` subdirectory of `@ponter/agent-node` cannot be allowed separately.

## Review Focus

The five input classes or failure modes the spec implies but no task's tests exercise, most likely to bite first. Each line is pinned by a test in the task that owns the code, in that task's own step style.

1. **A browser offer whose first H.264 entry is `packetization-mode=0`.** werift filters the remote list by mime type only (`transceiverManager.js:244-260`) and never inspects `fmtp`, so the sender lands on the *first* H.264 entry — the mode-0 PT — while the packetizer emits mode-1 framing. The browser depacketizes it wrongly and the picture breaks with a healthy connection. Pinned in Task 1 (the mode-0-first negative case) and again in Task 2 (R-S3 re-pointing).
2. **A negotiated `fmtp` whose `profile-level-id` does not match the encoder's actual SPS.** The Rust agent shipped `42001f` while emitting `42c0XX` and nobody noticed because no test decodes pixels. Pinned in Task 1 (A4 detection) and Task 4 (the addon reports the encoder's real `profile_idc`/`level_idc`).
3. **A captured frame whose size does not match the encoder's configured size** (a display mode change between capture and encode). A naive encoder configuration produces garbage or a crash. Pinned in Task 4 (the addon's reconfiguration path).
4. **An OS or codec call that fails** (a capture device disappears, the encoder rejects a resolution). The addon must surface a typed JS error, not die. Pinned in Task 4 (the fault-containment gate).
5. **A `null` / zero-length / wrong-stride buffer handed to the addon.** Pinned in Task 4 (the deliberate-corruption test).

---

## File Structure

Locked here so the task implementers cannot disagree about what creates what.

| Path | Responsibility |
|---|---|
| `packages/shared/src/types/stream-profile.ts` | **New.** The `StreamProfile` type and the four presets (1080p30, 720p30, 1080p60, 720p60) plus the resolution table. Single source of truth for web, desktop, and agent. |
| `packages/shared/src/types/index.ts` | **Modify.** Re-export `StreamProfile` and the preset table. |
| `packages/shared/src/index.ts` | **Modify.** Re-export from the new module. |
| `packages/shared/test/stream-profile.test.ts` | **New.** Asserts the four presets' shape and that the table is the single source. |
| `packages/api-client/test/api-access-gate.test.ts` | **Already exists — do not recreate.** The TypeScript API-access boundary gate (spec D13). It walks `<root>/<pkg>/src/**` over `SCAN_ROOTS = ['apps','packages']`, so it already covers `apps/agent/src/**` the moment the agent is TypeScript. Task 5 verifies it catches the agent tree; it does not write a second copy of it. |
| `packages/api-client/test/agent-api-access-gate.test.ts` | **New.** The agent-specific half the generic gate cannot express: the three rules of `.github/workflows/build-agent.yml`'s Rust boundary gate that are *not* "no raw fetch" — no hand-rolled HTTP client, no literal server URL outside the sanctioned files, and no ad-hoc error envelope (spec R6, ADR-89 amendment). |
| `packages/webrtc-core/test/synthetic-offer.ts` | **New.** The Chrome-shaped offer builder. It lives here, not in `apps/agent/spike/`, because both the spike (Task 1) and the adapter tests (Task 2) need it and `apps/agent` is not a dependency of `@ponter/webrtc-core`. It is exported as `@ponter/webrtc-core/test/synthetic-offer`, exactly as `test/fake-websocket.ts` already is — an existing precedent, not a new pattern. |
| `packages/webrtc-core/src/types.ts` | **Modify.** Add `RTCRtpSenderLike`; extend `MediaStreamTrackLike` with `id`, `ssrc`; add the optional `addTrack?` seam to `RTCPeerConnectionLike`. |
| `packages/webrtc-core/src/adapters/werift.ts` | **Modify.** Implement `addTrack`; hold the created `MediaStreamTrack`; forward `writeRtp`. |
| `packages/webrtc-core/src/adapters/browser.ts` | **Modify.** Implement the same `addTrack` seam with the browser's `RTCRtpSender`. |
| `packages/webrtc-core/test/adapters/werift-sender.test.ts` | **New.** The R-S1/R-S2/R-S3/R-S4 unit-level tests. |
| `apps/desktop/src/main/__tests__/desktop-profile-parity.test.ts` | **Modify.** Spec D12. It currently reads `apps/agent/src/lib.rs` **as text** and regex-extracts the `StreamProfile` literals; that file is deleted in Plan 3, so the test must become a same-language import of `@ponter/shared`'s table. The parity guarantee survives; the mechanism changes. |
| `apps/agent/native/package.json` | **New.** `@ponter/agent-native`, `private: true`, an `install` script that runs `node-gyp rebuild` against Electron's headers, and `node-addon-api` + `node-gyp` as devDependencies. It exists so pnpm has a package identity to put in `allowBuilds` (spec D9) — a directory without a manifest cannot be allowed to build. |
| `apps/agent/native/binding.gyp` | **New.** node-gyp build definition: the addon sources + the vendored openh264, as four static libraries mirroring `openh264-sys2`'s own build, plus the NASM action target. |
| `apps/agent/native/openh264_asm.gypi` | **New.** The NASM `rule` shared by the four openh264 targets. A `rule` (not an action target) because gyp resolves `sources` at generation time, before any action runs — globbing an action's outputs into `sources` finds nothing on a clean tree. |
| `apps/agent/native/scripts/assemble.js` | **New.** One `nasm` invocation per `.asm` (23 objects from 24 files — `asm_inc.asm` is a macro include). Fails loudly when NASM is missing; `OPENH264_NO_ASM=1` opts into the scalar path deliberately. The Rust build silently skipped assembly instead, which is how a build ends up 2-3x slower than its author believes. |
| `apps/agent/native/index.d.ts` | **New.** The addon's public surface, exactly the Interfaces block of Task 4. |
| `apps/agent/native/src/addon.cc` | **New.** The N-API entry points. |
| `apps/agent/native/src/capture_windows.cc` | **New.** Windows capture: WGC → DXGI → GDI. |
| `apps/agent/native/src/capture_linux.cc` | **New.** Linux capture: `org.freedesktop.portal.ScreenCast` over D-Bus. |
| `apps/agent/native/src/encoder.cc` | **New.** The openh264 wrapper: RGBA8 → I420, Annex-B out, real `profile_idc`/`level_idc` reported. |
| `apps/agent/native/src/resize.cc` | **New.** The SIMD box-filter downscale (spec B16) and the even-dimension crop (spec B15) — the two pixel passes that must run before the colour conversion. |
| `apps/agent/native/src/input_windows.cc` | **New.** Windows input: `SendInput`. |
| `apps/agent/native/src/input_linux.cc` | **New.** Linux input: `org.freedesktop.portal.RemoteDesktop` D-Bus. |
| `apps/agent/native/src/error.h` | **New.** The one place that converts a C++ failure into a stable JS error code. |
| `apps/agent/native/vendor/openh264/` | **New.** The vendored openh264 0.9.8 source + its BSD-2-Clause licence. |
| `apps/agent/native/test/` | **New.** The C++-level unit tests (node-addon-api's test runner or a plain assert harness). |
| `apps/agent/test/native/smoke.test.ts` | **New.** The TS-side smoke test that loads the built `.node` and exercises the surface. |
| `apps/agent/test/native/fault-containment.test.ts` | **New.** The §9.2 gate. |
| `apps/agent/package.json` | **New.** `@ponter/agent-node`, `workspace:*`, `type: module`. |
| `apps/agent/tsconfig.json` | **New.** Extends the repo's base config. |
| `pnpm-workspace.yaml` | **Modify.** `allowBuilds` gains `@ponter/agent-native` so pnpm runs its install script (spec D9). |

**Not created in this plan** (they belong to Plan 2): `apps/agent/src/**` (the TS core), `apps/agent/src/session/packetizer.ts` — *except* for the minimal packetizer Task 1 needs to prove the spike, which Task 3 then promotes into the real module with the full table-driven test suite. `apps/agent/src/desktop/profiles.ts` in spec §6.1 is superseded: the table lives in `@ponter/shared` (Task 5), and the agent imports it.

**One cross-package placement to be explicit about:** the Chrome-shaped offer builder lives in **`packages/webrtc-core/test/synthetic-offer.ts`** from the start, created in **Task 1** and consumed by both Task 1's spike and Task 2's adapter tests. It cannot live under `apps/agent/spike/` and be imported from `packages/webrtc-core` — `@ponter/webrtc-core` declares only `@ponter/shared` as a dependency. The package already exports a test helper this way (`"./test/fake-websocket": "./test/fake-websocket.ts"` in `packages/webrtc-core/package.json`), so Task 1 adds one more `exports` entry in the same form rather than inventing a mechanism. Task 1's spike imports it as `@ponter/webrtc-core/test/synthetic-offer`.

---

### Task 1: P0 — the werift-as-sender viability spike

**This is the gate that decides whether the rewrite proceeds at all.** If the browser does not decode visible frames, stop and revisit the architecture before any other task.

**Files:**
- Create: `apps/agent/spike/` — a committed spike directory (it is the evidence, and Plan 3 deletes it with the rest)
- Create: `apps/agent/spike/fixtures/idr-1280x720.annexb` — a pre-encoded Annex-B H.264 IDR access unit
- Create: `packages/webrtc-core/test/synthetic-offer.ts` — the offer builders (VP8-first, mode-0-first). It lives in `@ponter/webrtc-core` because Task 2's adapter tests need it too; see the placement note above.
- Modify: `packages/webrtc-core/package.json` — add `"./test/synthetic-offer": "./test/synthetic-offer.ts"` to `exports`, beside the existing `"./test/fake-websocket"` entry.
- Create: `apps/agent/spike/negotiation.ts` — the SDP-only negotiation probe (no DTLS)
- Create: `apps/agent/spike/spike.ts` — the live browser spike
- Create: `apps/agent/spike/browser-peer.html` — the Playwright page that receives and decodes
- Test: `apps/agent/spike/spike.test.ts` — the A1–A4 assertions and the three runs

**Interfaces:**
- Consumes: werift 0.24.4 (`useH264`, `useVP8`, `RTCPeerConnection`, `MediaStreamTrack`), `@ponter/webrtc-core/test/synthetic-offer` (the offer builders this task creates), and Playwright's Chromium. The spike deliberately does not use the **adapter layer** (`WeriftAdapter`) — Task 2 builds that, and the spike is standalone so that its failure cannot be blamed on a seam that does not exist yet.
- Produces: `apps/agent/spike/report.json` — the machine-readable record of the three runs, consumed by Task 2 and by the plan's gate. The shape is fixed here so Task 2 can read it:

```ts
export interface SpikeRunResult {
  /** Which of the three §3.5.2 runs this was. */
  run: 'r-s1-list' | 'vp8-first-local' | 'mode-0-first-offer';
  /** A1 — the negotiated sender codec. */
  negotiatedCodec: { mimeType: string; payloadType: number; parameters?: string } | null;
  /** A2 — the payload type on the wire, and the negotiated packetization mode. */
  wirePayloadType: number | null;
  negotiatedPacketizationMode: number | null;
  /** A3 — the browser decoded visible frames. */
  decodedFrameCount: number;
  /** A4 — detection only, never a pass/fail. */
  encoderProfileLevelId: string | null;
  negotiatedProfileLevelId: string | null;
  profileMatches: boolean | null;
  /** Whether a PLI arrived at the sender and a keyframe came back. */
  pliObserved: boolean;
  keyframeAfterPli: boolean;
  /** The raw answer SDP, for the fmtp byte-identity assertion. */
  answerSdp: string;
  offerSdp: string;
}
```

> **Why the spike has two halves.** The spec's §3.5.2 step 2 says to *answer a synthetic offer*, and step 5 says to *assert the browser decodes*. Those two cannot be the same exchange: a synthetic offer carries a **made-up DTLS fingerprint**, and a browser will never complete a DTLS handshake against a certificate it cannot verify — the connection dies before a single RTP packet flows. So the spike is split:
>
> - **The negotiation half** (`negotiation.ts`) answers the synthetic offer. It never opens a transport. It exists to measure what werift *negotiates* — which payload type, which `fmtp`, which m-line order. This is where the D4b and D4d regressions live.
> - **The transport half** (`spike.ts`) uses a **real browser as the offerer**. Chromium generates its own certificate and a real ICE/DTLS/SRTP session, and the spike answers it. This is where A3 (decoded pixels) and the PLI round-trip live.
>
> Both halves are needed. The negotiation half alone cannot prove the pixels decode; the transport half alone cannot force the browser into the mode-0-first ordering, because Chromium's own offer always lists `packetization-mode=1` first. The negative cases are therefore **negotiation-only** assertions, and the plan says so explicitly — a reviewer must not read "the mode-0-first run" as "the mode-0-first run carried pixels".

- [ ] **Step 1: Write the failing test — the synthetic offer builders**

Create `packages/webrtc-core/test/synthetic-offer.ts`. It must produce offers whose shape matches a real Chrome offer, and it must be able to produce two orderings.

```ts
// packages/webrtc-core/test/synthetic-offer.ts
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

export const H264_MODE1 = 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f';
export const H264_MODE0 = 'level-asymmetry-allowed=1;packetization-mode=0;profile-level-id=42e01f';

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
    lines.push(`a=fmtp:${pt} ${pt === PT_H264_MODE1 ? H264_MODE1 : H264_MODE0}`);
  }
  lines.push('a=ssrc:1234567890 cname:chrome', '');
  return lines.join('\r\n');
}
```

Then create `apps/agent/spike/spike.test.ts` with the failing assertions. The test file must exist and fail before the spike bodies do:

```ts
// apps/agent/spike/spike.test.ts
import { describe, expect, it } from 'vitest';
import {
  buildOffer,
  PT_H264_MODE0,
  PT_H264_MODE1,
  PT_VP8,
} from '@ponter/webrtc-core/test/synthetic-offer';
import { probeNegotiation } from './negotiation';
import { runSpike } from './spike';

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

  it('the browser can ask for a keyframe and gets one (PLI round-trip)', async () => {
    const result = await runSpike('r-s1-list');
    expect(result.pliObserved).toBe(true);
    expect(result.keyframeAfterPli).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @ponter/agent-node exec vitest run spike/spike.test.ts`
Expected: FAIL — `Cannot find module './negotiation'` (the spike bodies do not exist yet).

- [ ] **Step 3: Write the negotiation half**

Create `apps/agent/spike/negotiation.ts`. It answers a synthetic offer and reports what was negotiated. **No transport is opened** — the peer is never connected, and the DTLS fingerprint in the offer is a placeholder that is never exercised.

```ts
// apps/agent/spike/negotiation.ts
import { RTCPeerConnection, useH264, useVP8 } from 'werift';
import { buildOffer, PT_H264_MODE1 } from '@ponter/webrtc-core/test/synthetic-offer';

/**
 * The codec list is R-S1's lever.
 *
 * With `[useH264()]` werift filters the browser's VP8 entry out and keeps
 * both H.264 entries. With `[useVP8(), useH264()]` the VP8 entry survives
 * the filter and — because werift takes `params.codecs[0]` as the sender's
 * codec (rtpSender.js:408) — the sender lands on VP8. That is the
 * black-video bug, measured.
 */
function localCodecs(run: 'r-s1-list' | 'vp8-first-local') {
  return run === 'vp8-first-local'
    ? { audio: [], video: [useVP8(), useH264()] }
    : { audio: [], video: [useH264()] };
}

export interface NegotiationResult {
  negotiatedCodec: { mimeType: string; payloadType: number; parameters?: string } | null;
  negotiatedPacketizationMode: number | null;
  answerSdp: string;
  offerSdp: string;
}

export async function probeNegotiation(
  run: 'r-s1-list' | 'vp8-first-local' | 'mode-0-first-offer',
  options: { applyR_S3?: boolean } = {},
): Promise<NegotiationResult> {
  const applyR_S3 = options.applyR_S3 ?? true;
  const offerSdp = buildOffer({
    h264Order: run === 'mode-0-first-offer' ? 'mode-0-first' : 'mode1-first',
  });

  const pc = new RTCPeerConnection({ codecs: localCodecs(run), iceServers: [] });

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
```

> **Note to the implementer.** `PT_H264_MODE1` is imported above to make the
> expected payload type explicit in the assertions; if the linter flags it as
> unused in this file, drop the import — the assertion lives in the test.

- [ ] **Step 4: Write the transport half**

Create `apps/agent/spike/spike.ts` and `apps/agent/spike/browser-peer.html`.

The browser is the **offerer**. Chromium generates its own certificate, its own ICE credentials, and its own candidates; the spike answers with werift and the two peers connect over the loopback interface with host candidates only (no STUN, no TURN, no network).

`browser-peer.html` must:

1. Create an `RTCPeerConnection` with **no** ICE servers.
2. `addTransceiver('video', { direction: 'recvonly' })` — the browser only receives.
3. Create the offer, post it to the page's exposed binding, wait for the answer, `setRemoteDescription(answer)`.
4. On `track`, attach the stream to a `<video>` element and count decoded frames with `requestVideoFrameCallback`.
5. Expose a way for the test to ask the browser to **send a PLI** — `receiver.getParameters()` / the `RTCRtpReceiver`'s `playoutDelayHint` is not it; the way to force a PLI from the browser side is to let the decoder lose sync (e.g. by not sending the first keyframe, or by calling `video.play()` after a gap). The implementer must find the mechanism their Chromium build supports and record it in the report; if no browser-driven PLI can be provoked, the PLI round-trip is asserted from the **sender** side instead — the spike watches `sender.onPictureLossIndication` (public, `rtpSender.d.ts:39`) and the test drives it from the browser by corrupting the stream.
6. Report the payload type it received, read from the RTP header of the incoming packets.

The Node side of `spike.ts` must:

1. Launch Chromium via Playwright, open `browser-peer.html`, and drive the exchange over `page.exposeBinding` / `page.evaluate`.
2. Answer the browser's offer with werift, using `codecs: { video: [useH264()] }` — R-S1.
3. **Assert the transceiver was created before `setRemoteDescription`** (R-S4) — the spike adds it first.
4. After the answer is set, read back the negotiated codec and **re-point the sender at the browser's `packetization-mode=1` entry** (R-S3), mutating in place.
5. Packetize the fixture with the new TS packetizer (Task 3 — until Task 3 lands, the spike uses a local copy of the packetizer and Task 3 replaces it; if Task 3 has not landed yet, the spike **must** carry a `spike/packetizer-copy.ts` that Task 3 deletes).
6. Push the packets through `track.writeRtp(...)` and watch what the browser receives.
7. **Read the payload type off the wire** — from the received packet's RTP header, not from the sender's config. That is the whole point of A2. werift's `MediaStreamTrack.writeRtp` overwrites the payload type with `this.codec?.payloadType` (`track.js:132-134`), so the value the browser sees is the *sender's*, and the assertion must compare the two.
8. Count the frames the browser decoded, and compare them against the fixture (a luma histogram or a per-region mean — the fixture is a synthetic pattern, so a coarse comparison is enough to prove "pixels, not black").

> **The RTP wire capture.** The browser's `RTCRtpReceiver.getStats()` reports the payload type it received; that is the simplest wire-level read and it is what the implementer should use first. If the stats do not expose it, fall back to `chrome://webrtc-internals` — no, do not: use `RTCRtpReceiver.getStats()`'s `inbound-rtp` entry's `payloadType` field, and if the Chromium build does not report it, wrap the fixture in a raw RTP receiver in the page (`RTCRtpReceiver` via `MediaStreamTrackProcessor`) and read the header there.

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @ponter/agent-node exec vitest run spike/spike.test.ts`
Expected: PASS — 8 tests green (2 offer-builder + 4 negotiation + 2 transport).

If the negotiation run 1 selects VP8, the R-S1 codec list is wrong. If run 3 with R-S3 still lands on pt104, the re-pointing did not take effect — check that `transceiver.codecs` was reordered **and** that `sender.codec` points at the same object. If `decodedFrameCount === 0`, the gate fails and the architecture is revisited — **do not proceed to Task 2**.

- [ ] **Step 6: Record the spike's result**

Write `apps/agent/spike/report.json` — the three `SpikeRunResult` objects, verbatim, plus the negotiation-only results for the two negative runs. Commit it. It is the evidence that the architecture was validated, and the §8 trail will cite it.

- [ ] **Step 7: Commit**

```bash
git add apps/agent/spike apps/agent/package.json apps/agent/tsconfig.json pnpm-workspace.yaml
git commit -m "feat(spike): prove werift can send H.264 that a browser decodes"
```


---

### Task 2: The `RTCRtpSenderLike` seam in `@ponter/webrtc-core`

**Files:**
- Modify: `packages/webrtc-core/src/types.ts`
- Modify: `packages/webrtc-core/src/adapters/werift.ts`
- Modify: `packages/webrtc-core/src/adapters/browser.ts`
- Test: `packages/webrtc-core/test/adapters/werift-sender.test.ts`
- Consumes: `packages/webrtc-core/test/synthetic-offer.ts` (created in Task 1)

**Interfaces:**
- Consumes: werift's `RTCPeerConnection.addTrack` (`peerConnection.d.ts:194`), `MediaStreamTrack.writeRtp` (`track.d.ts:28`), `RTCRtpTransceiver.codecs` (`rtpTransceiver.d.ts:23-25`), `RTCRtpSender.codec` (`rtpSender.d.ts:77`), and `@ponter/webrtc-core/test/synthetic-offer`.
- Produces: `RTCRtpSenderLike`, the `addTrack?` / `getSenders?` seams on `RTCPeerConnectionLike`, and the adapter's `createOutboundTrack(kind)` — the exact types Task 3 and Plan 2 consume.

```ts
// packages/webrtc-core/src/types.ts
/**
 * A sender handle for one outbound media track.
 *
 * Introduced by the agent rewrite (spec §3.5). It is deliberately read-only
 * on `codec` and write-only on `writeRtp`: the adapter owns the RTP
 * bookkeeping (SSRC, payload type, sequence number, timestamp) and the
 * caller supplies only the payload bytes.
 */
export interface RTCRtpSenderLike {
  /** The negotiated codec, read back after setRemoteDescription + createAnswer. */
  readonly codec?: { mimeType: string; payloadType: number; parameters?: string };
  /**
   * Point the sender at a specific negotiated codec.
   *
   * This is R-S3's mechanism (spec §3.5.1). werift filters the remote codec
   * list by mime type only and never inspects `fmtp`, so a browser whose
   * *first* H.264 entry is `packetization-mode=0` would otherwise be
   * negotiated onto a mode-0 payload type while the packetizer emits mode-1
   * framing. The caller re-points the sender at the browser's
   * `packetization-mode=1` entry; the answer's `a=fmtp:` line for that
   * payload type then stays byte-identical to the offer's.
   *
   * Throws when the codec is not one of the negotiated ones.
   */
  selectNegotiatedCodec(codec: {
    mimeType: string;
    payloadType: number;
    parameters?: string;
  }): void;
  /** Push one outbound RTP packet. The adapter stamps SSRC / PT / seq / timestamp. */
  writeRtp(packet: Uint8Array): void;
}
```

`MediaStreamTrackLike` (currently `kind` only, `types.ts:12`) must also grow `id` and `ssrc` — the sender path needs them to build a track.

`RTCPeerConnectionLike` gains two optional members, mirroring the existing optional-media-seam pattern (`addTransceiver?`, `onTrack?`, `getVideoReceiver?`):

```ts
  /**
   * Attach an outbound track and return its sender.
   *
   * Optional because every existing adapter and mock implements this
   * interface; a caller that asks for `media.video` and finds no `addTrack`
   * gets a descriptive error, exactly as `addTransceiver` does today.
   */
  addTrack?(track: MediaStreamTrackLike, stream?: MediaStreamLike): RTCRtpSenderLike;
  /**
   * The senders this peer holds, in transceiver order.
   *
   * Optional for the same reason as `addTrack`. A caller that needs a
   * sender but finds no `getSenders` gets a descriptive error.
   */
  getSenders?(): RTCRtpSenderLike[];
```

- [ ] **Step 1: Write the failing test**

Create `packages/webrtc-core/test/adapters/werift-sender.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { useH264, useVP8 } from 'werift';
import { WeriftAdapter } from '../../src/adapters/werift';
import {
  buildOffer,
  H264_MODE1,
  PT_H264_MODE0,
  PT_H264_MODE1,
  PT_VP8,
} from '@ponter/webrtc-core/test/synthetic-offer';

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

  it('R-S3: re-pointing at the mode-1 entry leaves the answer fmtp byte-identical to the offer', async () => {
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
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @ponter/webrtc-core exec vitest run test/adapters/werift-sender.test.ts`
Expected: FAIL — `createOutboundTrack is not a function` (the adapter has no sender surface today).

- [ ] **Step 3: Write the minimal implementation**

In `packages/webrtc-core/src/adapters/werift.ts`, add the sender surface. The adapter holds the werift `MediaStreamTrack` it created and forwards `writeRtp` to it.

```ts
  /**
   * Create an outbound track of the given kind.
   *
   * A werift `MediaStreamTrack` is the object the RTP packets are pushed
   * into; it is not a media source (there is no `srcObject` in Node), so it
   * is created empty and the agent writes RTP into it directly.
   */
  createOutboundTrack(kind: 'audio' | 'video'): MediaStreamTrackLike {
    const track = new WeriftMediaStreamTrack({ kind });
    return {
      kind,
      id: track.id,
      ssrc: track.ssrc,
    };
  }

  /**
   * Attach an outbound track.
   *
   * The transceiver is created HERE, before setRemoteDescription — adding it
   * afterwards yields a second, a=inactive m-line whose sender.codec is
   * undefined, and werift's sendRtp then silently no-ops (spec R-S4, D4e).
   *
   * Note that werift's `addTrack` reuses an existing sender-less transceiver
   * when one matches (`transceiverManager.js:110-152`), so calling this after
   * `addTransceiver('video', { direction: 'sendrecv' })` attaches the track to
   * that transceiver rather than creating a second m-line.
   */
  addTrack(track: MediaStreamTrackLike, stream?: MediaStreamLike): RTCRtpSenderLike {
    const weriftTrack = this.createWeriftTrack(track);
    const weriftStream = stream ? this.createWeriftStream(track) : undefined;

    // werift's `pc.addTrack` returns the SENDER, not the transceiver
    // (peerConnection.js:971-982 — `return transceiver.sender`). The
    // transceiver is the object that owns `codecs` and that the answer is
    // built from (sdpManager.js:90), so it has to be looked up separately.
    // `getTransceivers()` is ordered and `RTCRtpSender` holds no back-pointer
    // to its transceiver (rtpTransceiver.js:15-30), so identity comparison on
    // the sender is the only correct key.
    const weriftSender = this.peer.addTrack(
      weriftTrack,
      ...(weriftStream ? [weriftStream] : []),
    );
    const transceiver = this.peer
      .getTransceivers()
      .find((t) => t.sender === weriftSender);
    if (!transceiver) {
      throw new Error(
        'werift returned a sender that belongs to no transceiver; this adapter cannot manage its codecs.',
      );
    }

    const handle: RTCRtpSenderLike = {
      get codec() {
        return weriftSender.codec as RTCRtpSenderLike['codec'];
      },
      selectNegotiatedCodec(codec) {
        const negotiated = transceiver.codecs ?? [];
        const entry = negotiated.find(
          (c) =>
            c.mimeType.toLowerCase() === codec.mimeType.toLowerCase() &&
            c.payloadType === codec.payloadType,
        );
        if (!entry) {
          throw new Error(
            `Codec ${codec.mimeType}:${codec.payloadType} was not negotiated; ` +
              `the peer offered ${negotiated.map((c) => `${c.mimeType}:${c.payloadType}`).join(', ')}.`,
          );
        }
        // R-S3 — re-point the sender at the chosen entry.
        //
        // THREE objects have to be moved together, and missing any one of
        // them is a silent failure:
        //
        //  1. `transceiver.codecs` — reordered so the chosen entry leads.
        //     werift's answer is built from this list (sdpManager.js:90-100),
        //     so the m-line's payload-type order and the `a=fmtp:` lines
        //     follow it. This does NOT re-point the sender: `prepareSend` ran
        //     already, inside `setRemoteDescription`
        //     (transceiverManager.js:276-277).
        //  2. `sender.codec` — the sender stamps this payload type on the
        //     wire (rtpSender.js:544), and this is the assignment that
        //     actually moves the sender off the mode-0 entry.
        //  3. `track.codec` — `MediaStreamTrack.writeRtp` overwrites the
        //     packet's payload type with THIS value (track.js:132-134), and
        //     `track.codec` is a separate field from `sender.codec`. Setting
        //     only the sender leaves the track stamping the OLD payload type
        //     into the packet, and the browser depacketizes it wrongly.
        //
        // MUTATE the codec object in place, never replace it: `{...codec}`
        // drops the `name` prototype getter (parameters.js:54-56) and
        // sdpManager.js:107 then throws `TypeError: Cannot read properties of
        // undefined (reading 'toLowerCase')`.
        transceiver.codecs = [
          entry,
          ...negotiated.filter((c) => c !== entry),
        ];
        weriftSender.codec = entry;
        weriftTrack.codec = entry;
      },
      writeRtp(packet: Uint8Array) {
        weriftTrack.writeRtp(packet);
      },
    };
    this.senders.push(handle);
    return handle;
  }
```

**Four werift facts this implementation depends on**, all read from the vendored source and all load-bearing:

0. **`pc.addTrack` returns the sender, not the transceiver** (`peerConnection.js:971-982`: `return transceiver.sender`). The transceiver is recovered here by identity — `this.peer.getTransceivers().find((t) => t.sender === weriftSender)` — because `RTCRtpSender` holds no back-pointer to its transceiver (`rtpTransceiver.js:15-30`) and `getTransceivers()` is the only public enumerator (`peerConnection.d.ts:109`).
1. `RTCRtpSender.codec` is `writable: true` (`rtpSender.js:317-321`) and `MediaStreamTrack.codec` likewise (`track.js:67-71`), so re-pointing is public API, not an internals hack.
2. `MediaStreamTrack.writeRtp` **overwrites the payload type** with `this.codec?.payloadType` (`track.js:132-134`), and `RTCRtpSender.sendRtp` then overwrites SSRC, payload type, timestamp and sequence number (`rtpSender.js:539-552`). The packetizer stamps its own PT for readability, but the **authoritative** PT is the one the sender carries — which is exactly why R-S3's re-pointing must happen before any packet is sent, and why all three objects must move together.
3. `sender.codec` and `track.codec` are **separate fields**. `registerTrack` copies the sender's codec onto the track once (`rtpSender.js:425-445`, the `if (this.codec) track.codec = this.codec` at the end), and `prepareSend` does the same (`rtpSender.js:402-410`). But a later re-point of the sender does **not** update the track. This is the trap: a sender-only re-point leaves the track stamping the old payload type.

The browser adapter implements the same seam with the browser's `RTCRtpSender` (`pc.addTrack(track, stream)` → `sender`). The browser side has no `writeRtp` — a browser sender takes a `MediaStreamTrack`, not RTP packets — so the browser adapter's `writeRtp` must throw a descriptive error rather than silently doing nothing:

```ts
  writeRtp(_packet: Uint8Array): void {
    throw new Error(
      'BrowserPeerConnection.addTrack(...).writeRtp is not supported: a browser sender takes a MediaStreamTrack, not RTP packets.',
    );
  }
```

The browser adapter's `selectNegotiatedCodec` is likewise unsupported — a browser's sender codec is chosen by the browser, not by us — and must throw the same way.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @ponter/webrtc-core exec vitest run test/adapters/werift-sender.test.ts`
Expected: PASS — 6 tests green.

Then run the whole package to check for regressions:
Run: `pnpm --filter @ponter/webrtc-core exec vitest run`
Expected: PASS — no existing test changes status. If any existing test's `it()`/`expect()` count changes, declare the before→after counts in the report.

- [ ] **Step 5: Add the wire-level payload-type test**

Add one more test to `werift-sender.test.ts` that pins the trap from werift fact 3 — the *track's* payload type, not just the sender's:

```ts
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
```

The adapter therefore also needs a `getOutboundTrackCodec(trackId)` accessor — a small, honest seam for exactly this assertion.

- [ ] **Step 6: Commit**

```bash
git add packages/webrtc-core/src packages/webrtc-core/test
git commit -m "feat(webrtc-core): add the RTCRtpSenderLike seam and the werift adapter's sender surface"
```

---

### Task 3: The RFC 6184 packetizer, in TypeScript

**Files:**
- Create: `apps/agent/src/session/packetizer.ts`
- Create: `apps/agent/test/session/packetizer.test.ts`

**Interfaces:**
- Consumes: nothing beyond Node's `Buffer`.
- Produces:

```ts
// apps/agent/src/session/packetizer.ts
/**
 * The default RTP payload budget, in bytes.
 *
 * The Rust agent's outbound MTU was 1200 bytes *including* the 12-byte RTP
 * header, so the payload budget was 1200 - 12 = 1188
 * (`webrtc-0.21.0/src/media_stream/track_local/static_sample.rs:89`,
 * `rtc-rtp-0.21.0/src/packetizer/mod.rs:137`).
 */
export const DEFAULT_MAX_PAYLOAD_BYTES = 1188;

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
): PacketizeResult;

/**
 * Extract the NAL unit types present in an Annex-B buffer.
 * Used by the conformance fixtures and by the codec's own smoke tests.
 */
export function annexbNalTypes(annexB: Buffer): number[];
```

**The parity reference — this is a port, not a fresh implementation.** The Rust agent never wrote RTP itself: it handed Annex-B bytes to `TrackLocalStaticSample.sample_writer(ssrc, payload_type).write_sample(&sample)` (`apps/agent/src/desktop.rs:1767-1776`), and the `rtc-rtp` crate did the packetization. The TypeScript packetizer's behaviour is pinned to that implementation, not to the RFC's freedom. Every rule below was read out of the vendored crate:

| Rule | The Rust behaviour (the parity target) | Citation |
|---|---|---|
| NAL splitting | The Annex-B buffer is split at start codes. The 3-byte (`00 00 01`) and 4-byte (`00 00 00 01`) forms are both handled, and the zero run in front of a start code belongs to the start code, not to the preceding NAL. A buffer with no start code at all is one NAL. | `rtc-rtp-0.21.0/src/codec/h264/mod.rs:62-75` (`next_ind`), `:186-216` (`payload`) |
| AUD and filler | NAL types **9** and **12** are dropped — they never reach the wire. | `rtc-rtp-0.21.0/src/codec/h264/mod.rs:85-86`; the crate's own test feeds a type-9 payload and asserts zero packets (`h264_test.rs:65-70`, the `Nalu type 9 or 12` case) |
| SPS and PPS | NAL types **7** and **8** are cached, not emitted on their own. | `rtc-rtp-0.21.0/src/codec/h264/mod.rs:87-92` |
| STAP-A | The first non-SPS/PPS NAL that arrives **after both** the SPS and the PPS are cached triggers one STAP-A carrying **SPS + PPS** — and *not* the current NAL. The crate's comment says "Pack current NALU with SPS and PPS as STAP-A", but its code and its `with_capacity` computation (`1 + 2 + sps.len() + 2 + pps.len()`) do not include the current NAL. **The comment is wrong; the code is the contract.** The current NAL is then emitted separately, as a single NAL or as FU-A. | `rtc-rtp-0.21.0/src/codec/h264/mod.rs:93-107` |
| STAP-A shape | The header byte is `0x78`, then each NAL as a 2-byte big-endian length followed by the NAL's own bytes. | `rtc-rtp-0.21.0/src/codec/h264/mod.rs:59-63`, `:95-105` |
| Single NAL | A NAL that fits the budget is emitted **bare** — the Annex-B start code is stripped and never reaches the wire. | `rtc-rtp-0.21.0/src/codec/h264/mod.rs:109-113` |
| FU-A | A NAL larger than the budget becomes FU-A fragments. The FU indicator carries `F|NRI` and type 28; the FU header carries `S|E|R|Type`. The NAL's **first octet is skipped** — the fragment payload is `nalu[1..]`, because the F/NRI bits went into the indicator and the type went into the FU header. | `rtc-rtp-0.21.0/src/codec/h264/mod.rs:115-160` |
| The RTP marker bit | The marker marks the **partition tail** — the last packet of the access unit. | `rtc-rtp-0.21.0/src/codec/h264/mod.rs:325-340` (`is_partition_tail` returns the marker), and the packetizer sets `marker: i == payloads_len - 1` (`rtc-rtp-0.21.0/src/packetizer/mod.rs:143-150`) |
| The payload budget | The crate's MTU is 1200 bytes **including** the 12-byte RTP header, so the payload budget is **1188** bytes. | `webrtc-0.21.0/src/media_stream/track_local/static_sample.rs:89` (`RTP_OUTBOUND_MTU = 1200`), `rtc-rtp-0.21.0/src/packetizer/mod.rs:137` (`self.mtu - 12`) |

**The one deliberate divergence, and why.** The Rust payloader drops a cached SPS/PPS pair when the access unit ends before another NAL arrives — an SPS/PPS-only access unit emits **nothing** at all. The TypeScript packetizer **flushes** the pending pair as a STAP-A at the end of the access unit instead. Rationale: a STAP-A carrying only the parameter sets is valid RFC 6184 and every browser accepts it; in the normal path (openh264 emits SPS, PPS and the IDR in one access unit) the flush never fires, so the divergence is invisible in production and only changes the pathological case from "silently lose the parameter sets" to "send them". This is the only intentional behaviour difference from the Rust agent in the whole packetizer, and Task 6's matrix records it.

- [ ] **Step 1: Write the failing test**

Create `apps/agent/test/session/packetizer.test.ts`. Every assertion below is a **parity assertion against the Rust agent's behaviour**, and the §9.1 table-driven fixtures (Step 5) carry the literal expected bytes.

```ts
import { describe, expect, it } from 'vitest';
import {
  annexbNalTypes,
  DEFAULT_MAX_PAYLOAD_BYTES,
  packetizeAnnexB,
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
    expect(stap.subarray(5 + SPS.length, 5 + SPS.length + PPS.length)).toEqual(PPS);
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
    const { packets, nextSequenceNumber } = packetizeAnnexB(buildAnnexB([big]), {
      payloadType: PT,
      sequenceNumber: 100,
      timestamp: 0,
      ssrc: SSRC,
      maxPayloadBytes: 1200,
    });
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @ponter/agent-node exec vitest run test/session/packetizer.test.ts`
Expected: FAIL — `Cannot find module '../../src/session/packetizer'`.

- [ ] **Step 3: Write the minimal implementation**

Write `apps/agent/src/session/packetizer.ts`. The RTP header is 12 bytes (no extension, no CSRCs). The packetizer must:

1. Split the Annex-B buffer at start codes, handling both the 4-byte (`00 00 00 01`) and 3-byte (`00 00 01`) forms. The zero run in front of a start code belongs to the start code, not to the preceding NAL. A buffer with no start code is one NAL.
2. Drop NAL types **9** (AUD) and **12** (filler).
3. Cache NAL type **7** (SPS) and **8** (PPS) instead of emitting them.
4. When a NAL arrives and both the SPS and the PPS are cached, emit one **STAP-A** carrying the SPS and the PPS — header byte `0x78`, then each NAL behind its 2-byte big-endian length — and clear the cache. The STAP-A does **not** carry the current NAL.
5. Emit the current NAL as a **single-NAL packet** when it fits the payload budget, and as **FU-A** fragments when it does not: the FU indicator (`F|NRI|28`), the FU header (`S|E|R|Type`), then the fragment payload starting at the NAL's **second** octet.
6. At the end of the access unit, flush a still-pending SPS/PPS pair as a STAP-A (the one deliberate divergence from the Rust payloader).
7. Stamp the RTP header: version 2, the negotiated payload type, the sequence number, the timestamp, and the SSRC.
8. Set the marker bit on the **last** packet of the access unit only.

The module exposes `packetizeAnnexB`, `annexbNalTypes`, and `DEFAULT_MAX_PAYLOAD_BYTES`, exactly as the Interfaces block declares.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @ponter/agent-node exec vitest run test/session/packetizer.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the conformance fixtures**

Add table-driven cases to the same file, per §9.1: the exact expected bytes for a single-NAL packet, a STAP-A of SPS+PPS, a FU-A at the boundary sizes (a NAL exactly at `maxPayloadBytes`, one byte over), and the MTU split. The expected byte arrays are written literally, not computed by the implementation — a fixture that recomputes itself proves nothing.

The literal fixtures are taken from the **crate's own test vectors** where one exists, so the parity claim is checkable against the vendored source:

- The FU-A vector `rtc-rtp-0.21.0/src/codec/h264/h264_test.rs:15-21` — the fragmented payloads of `[0x00, 0x00, 0x01, 0x00, 0x01, …, 0x15]` at MTU 5 are `[0x1c, 0x80, 0x01, 0x02, 0x03]`, `[0x1c, 0x00, 0x04, 0x05, 0x06]`, `[0x1c, 0x00, 0x07, 0x08, 0x09]`, `[0x1c, 0x00, 0x10, 0x11, 0x12]`, `[0x1c, 0x40, 0x13, 0x14, 0x15]`.

- The STAP-A aggregate `rtc-rtp-0.21.0/src/codec/h264/h264_test.rs:97-100` —
  `0x78 0x00 0x0f 0x67 0x42 0xc0 0x1f 0x1a 0x32 0x35 0x01 0x40 0x7a 0x40 0x3c 0x22 0x11 0xa8 0x00 0x05 0x68 0x1a 0x34 0xe3 0xc8`.

  **Feed it the crate's own Annex-B, not its aggregate.** The literal at `:97-100`
  is a *depacketizer* input — the crate's unmarshal test feeds the aggregate and
  asserts it expands back to Annex-B. Our packetizer runs the other direction, so
  the fixture must be the Annex-B the same test names at `:101-104`:

  ```
  00 00 00 01 67 42 c0 1f 1a 32 35 01 40 7a 40 3c 22 11 a8
  00 00 00 01 68 1a 34 e3 c8
  ```

  and the assertion is that `packetizeAnnexB` **produces** the aggregate above —
  one packet, one STAP-A, with `0x78` as the payload header, `0x000f`/`0x0005` as
  the two 16-bit lengths, and both NAL bodies carried unmodified. That is the
  parity claim in the direction we actually ship. (SPS `67 42 c0 1f …` is also
  the profile/level the encoder half of this plan must reproduce — baseline 66,
  constraint `0xC0`, level `0x1f` — so this fixture pins two invariants at once.)

- [ ] **Step 6: Run the test to verify it still passes**

Run: `pnpm --filter @ponter/agent-node exec vitest run test/session/packetizer.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/agent/src/session apps/agent/test/session
git commit -m "feat(agent): add the RFC 6184 mode-1 packetizer with table-driven fixtures"
```

---

### Task 4: The N-API native addon

**Files:**
- Create: `apps/agent/native/binding.gyp`
- Create: `apps/agent/native/openh264_asm.gypi`
- Create: `apps/agent/native/package.json` (`@ponter/agent-native`)
- Create: `apps/agent/native/scripts/assemble.js`
- Create: `apps/agent/native/src/addon.cc`, `error.h`, `encoder.cc`, `resize.cc`, `capture_windows.cc`, `capture_linux.cc`, `input_windows.cc`, `input_linux.cc`
- Create: `apps/agent/native/index.d.ts`
- Create: `apps/agent/native/vendor/openh264/` (the vendored source + licence)
- Create: `apps/agent/native/test/`
- Create: `apps/agent/test/native/smoke.test.ts`, `fault-containment.test.ts`
- Modify: `pnpm-workspace.yaml` (`allowBuilds`)

**Interfaces:**
- Consumes: `node-addon-api` ^8.9.2 and `node-gyp` ^9.4.1 (both already resolved in the lockfile via `better-sqlite3`, so neither is a new resolution), openh264 0.9.8, the platform capture and input APIs.
- Produces — the **entire** public surface of the addon. It is deliberately narrow (spec §6.3: "frames in, Annex-B out"):

```ts
// apps/agent/native/index.d.ts
export interface EncoderProfile {
  /** The width the encoder is configured for, in pixels. */
  width: number;
  /** The height the encoder is configured for, in pixels. */
  height: number;
  /** The target frame rate. */
  fps: number;
  /** The target bitrate, in bits per second. */
  bitrate: number;
}

export interface EncodedFrame {
  /** The access unit in Annex-B framing. */
  annexB: Buffer;
  /** The SPS's profile_idc byte. */
  profileIdc: number;
  /** The SPS's level_idc byte. */
  levelIdc: number;
  /** The SPS's constraint byte. */
  constraintByte: number;
  /** True when this access unit contains an IDR. */
  isKeyframe: boolean;
}

export interface CaptureSource {
  /** The source id, as the agent refers to it. */
  id: string;
  /** 'display' | 'window' | 'primary'. */
  kind: 'display' | 'window' | 'primary';
  /** The human-readable name. */
  name: string;
  /** The source's native width, in pixels. */
  width: number;
  /** The source's native height, in pixels. */
  height: number;
}

export interface CapturedFrame {
  /** The frame's pixels, tightly packed RGBA. */
  pixels: Buffer;
  /** The frame's stride, in bytes. */
  stride: number;
  /** The frame's width, in pixels. */
  width: number;
  /** The frame's height, in pixels. */
  height: number;
  /** A monotonically increasing capture timestamp, in microseconds. */
  timestampUs: number;
}

export interface InputEvent {
  kind: 'pointer-move' | 'pointer-button' | 'wheel' | 'key' | 'text';
  /** Normalised 0..1 coordinates, for pointer events. */
  x?: number;
  y?: number;
  /** The button index, for pointer-button events. */
  button?: number;
  pressed?: boolean;
  /** The wheel delta, for wheel events. */
  deltaX?: number;
  deltaY?: number;
  /** The `KeyboardEvent.code`, for key events. */
  code?: string;
  /** The literal text, for text events. */
  text?: string;
}

/**
 * The colour conversion and the downscale happen inside `encode`, so the
 * pixels never take a round-trip through JavaScript between the capture and
 * the encoder.
 *
 * WHY the resize lives in the addon and not in TypeScript (spec B16): it is a
 * box filter over every captured pixel and it is the most expensive step in
 * the pipeline — measured at 7.07 ms/frame scalar against a ~4 ms encode on
 * the reference machine, i.e. more than the encoder it feeds. The Rust agent
 * used `fast_image_resize` (SIMD, 6.2x over its scalar path — PR #144); the
 * addon reproduces that box filter, and `src/resize.cc` is where it lives.
 *
 * The RGBA8 → I420 conversion has the same constraint: the Rust agent fed
 * `YUVBuffer::from_rgba8_source(RgbaSliceU8::new(..))` straight into openh264
 * (`apps/agent/src/desktop.rs:1862`). Sending 4 bytes/pixel across the FFI
 * and converting in JS would both duplicate the work and triple the copy.
 */

/** The addon's public surface. */
export interface NativeAddon {
  /** The encoders open on this platform. */
  readonly platform: 'win32' | 'linux';
  /** List the capturable sources. */
  listSources(): Promise<CaptureSource[]>;
  /** Open an encoder for the given profile. */
  createEncoder(profile: EncoderProfile): Promise<number>;
  /**
   * Encode one captured frame.
   *
   * `frame.pixels` is RGBA8, `frame.stride` bytes per row (which may exceed
   * `frame.width * 4` — a D3D11 staging texture's row pitch is the GPU's, not
   * ours). The addon crops to even dimensions (spec B15 — H.264 requires it,
   * and an odd capture width is normal on Windows with fractional scaling),
   * box-filters to the profile size (spec B16), converts RGBA8 → I420,
   * encodes, and returns the Annex-B access unit.
   */
  encode(handle: number, frame: CapturedFrame): Promise<EncodedFrame>;
  /**
   * Retarget the encoder's bitrate on a live handle (spec B19).
   *
   * Raising requires two openh264 calls in a specific order — `MAX_BITRATE` on
   * `SPATIAL_LAYER_0` first, then `BITRATE` on `SPATIAL_LAYER_ALL` — and
   * lowering needs only the second. Both are encoder-handle state, so this
   * cannot live in TypeScript: there is no way to reach `SetOption` from the
   * JS side without the addon exposing it.
   *
   * The Rust agent's ordering is `apps/agent/src/desktop.rs:1880-1905`. No
   * rebuild and no forced IDR on a retarget: the next frame simply encodes at
   * the new rate.
   *
   * `bps` is clamped by the caller, not here — the addon applies what it is
   * given and reports openh264's failure if the encoder rejects it.
   */
  setBitrate(handle: number, bps: number): Promise<void>;
  /** Release an encoder. */
  destroyEncoder(handle: number): Promise<void>;
  /** Inject one input event. */
  injectInput(event: InputEvent): Promise<void>;
  /** The stable error codes the addon can produce. */
  readonly errorCodes: readonly string[];
}
```

The error codes are the contract, and they are **stable** — the TS core matches on them:

```ts
export type NativeErrorCode =
  | 'NATIVE_INVALID_ARGUMENT'
  | 'NATIVE_BUFFER_OUT_OF_BOUNDS'
  | 'NATIVE_CAPTURE_FAILED'
  | 'NATIVE_ENCODER_FAILED'
  | 'NATIVE_INPUT_FAILED'
  | 'NATIVE_UNSUPPORTED_PLATFORM'
  | 'NATIVE_HANDLE_INVALID';
```

- [ ] **Step 1: Write the failing test — the smoke test**

Create `apps/agent/test/native/smoke.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const addon = require('../../native/build/Release/ponter_agent_native.node');

describe('the native addon smoke test', () => {
  it('loads and reports its platform', () => {
    expect(['win32', 'linux']).toContain(addon.platform);
  });

  it('exposes the stable error codes', () => {
    expect(addon.errorCodes).toContain('NATIVE_INVALID_ARGUMENT');
  });

  it('encodes a synthetic frame and reports the encoder profile', async () => {
    const handle = await addon.createEncoder({ width: 1280, height: 720, fps: 30, bitrate: 4_000_000 });
    const pixels = Buffer.alloc(1280 * 720 * 4, 0x40);
    const frame = await addon.encode(handle, {
      pixels,
      stride: 1280 * 4,
      width: 1280,
      height: 720,
      timestampUs: 0,
    });
    // The encoder emits Annex-B: it must start with a start code.
    expect(frame.annexB.subarray(0, 4)).toEqual(Buffer.from([0, 0, 0, 1]));
    // It must report the profile it actually chose.
    expect(frame.profileIdc).toBe(66); // openh264 resolves PRO_UNKNOWN to baseline
    expect(frame.constraintByte).toBe(0xc0);
    expect(frame.levelIdc).toBeGreaterThan(0);
    await addon.destroyEncoder(handle);
  });

  it('retargets the bitrate on a live handle (spec B19)', async () => {
    const handle = await addon.createEncoder({ width: 1280, height: 720, fps: 30, bitrate: 4_000_000 });
    // One frame first: openh264 rejects SetOption with cmInitExpected (rc 4)
    // until the encoder has encoded at least once.
    await addon.encode(handle, {
      pixels: Buffer.alloc(1280 * 720 * 4, 0x40),
      stride: 1280 * 4,
      width: 1280,
      height: 720,
      timestampUs: 0,
    });

    // Raise: both MAX_BITRATE (LAYER_0) and BITRATE (LAYER_ALL).
    await expect(addon.setBitrate(handle, 6_000_000)).resolves.toBeUndefined();
    // Lower: only BITRATE.
    await expect(addon.setBitrate(handle, 1_000_000)).resolves.toBeUndefined();

    // The stream keeps encoding at the new rate — a retarget must not
    // invalidate the handle or force a rebuild.
    const after = await addon.encode(handle, {
      pixels: Buffer.alloc(1280 * 720 * 4, 0x80),
      stride: 1280 * 4,
      width: 1280,
      height: 720,
      timestampUs: 33_333,
    });
    expect(after.annexB.length).toBeGreaterThan(0);
    await addon.destroyEncoder(handle);
  });

  it('rejects setBitrate on an unknown handle', async () => {
    await expect(addon.setBitrate(999_999, 2_000_000)).rejects.toThrow();
  });
});
```

> **What this test can and cannot see.** It proves `setBitrate` is exported, works on a live handle, and leaves the encoder usable. It **cannot** see the two-call order or the layer arguments — openh264 exposes no getter for them, which is the same wall as profile and level. The order is asserted in Step 12 at the C++ level, where the wrapper's `SetOption` calls can be intercepted. Do not delete the Step 12 test on the grounds that the JS test is green; they observe different things.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @ponter/agent-node exec vitest run test/native/smoke.test.ts`
Expected: FAIL — the `.node` file does not exist.

- [ ] **Step 3: Vendor openh264 and write `binding.gyp`**

Vendor openh264 0.9.8 into `apps/agent/native/vendor/openh264/`, together with its **BSD-2-Clause licence text and the Cisco copyright notice** — the licence must ship with the addon and be referenced in the repo's third-party notices (spec §6.3).

Take the source from the same crate the Rust agent built from, so the bitstream is byte-identical by construction: `openh264-sys2-0.9.8/upstream/` in the cargo registry is the pristine tree. Copy `codec/`, `LICENSE`, `VERSION` (records upstream commit `4a2615f`) and `README.md`. **Do not** try to regenerate it from a `.gyp` — upstream ships none.

The tree that lands in `vendor/openh264/` is:

```
codec/api/wels/                  codec_api.h  codec_app_def.h  codec_def.h  codec_ver.h
codec/common/{inc,src,x86,arm,arm64,mips,loongarch}
codec/processing/{build,interface,src}
codec/encoder/{core,plus}
codec/decoder/{core,plus}
codec/console/
```

Four facts about this tree that decide the whole gyp file, all verified against `build.rs:254-349` of `openh264-sys2-0.9.8`:

1. **The public headers are in `codec/api/wels/`, not `codec/api/svc/`.** `#include "codec_api.h"` must resolve there, and `WelsCreateSVCEncoder` is declared in `codec_api.h` at that path.
2. **`codec/encoder/plus/src/DllEntry.cpp` must be excluded.** It is the Windows DLL entry point and defines `DllMain`; compiling it into a Node addon collides with the process's own entry handling.
3. **Upstream is compiled as four static libraries, not one blob** — `common` (root `codec/common`, recurse all), `processing` (root `codec/processing/src`), `decoder` (root `codec/decoder/core`), `encoder` (root `codec/encoder/core`). The split exists because each needs a different include set. Mirror it: it is the only linkage configuration this source tree is known to build in.
4. **86 `.cpp` files are compiled and 24 `.asm` files are assembled.** Counted per library root at 0.9.8: `common` 16, `processing` 17, `encoder` 32 (`core` 31 + `plus/welsEncoderExt.cpp`), `decoder` 21 (`core` 20 + `plus/welsDecoderExt.cpp`). The tree holds 91 `.cpp` in total; the difference is `codec/console/` (4 — a CLI sample, not part of the library) and `DllEntry.cpp`. The `.asm` set is x86/x86_64 only — `codec/common/x86` 10, `codec/encoder/core/x86` 8, `codec/processing/src/x86` 3, `codec/decoder/core/x86` 2 — plus `codec/common/x86/asm_inc.asm`, which the `.asm` count includes but which is an *include*, not a translation unit, so 24 files become 23 objects.

   **The `plus/` directories matter.** `WelsCreateSVCEncoder` — the only entry point this addon calls — is implemented in `codec/encoder/plus/src/welsEncoderExt.cpp`, not in `core/`. A glob over `encoder/core` alone links cleanly and then fails at runtime with an undefined symbol. openh264-sys2 globs the *whole* `codec/encoder` tree, which is why it never hit this.

```python
# apps/agent/native/openh264_asm.gypi
#
# The assembler rule, included by each of the four openh264 targets whose root
# contains an x86/ directory. gyp has no way to share a rule between targets
# except by including it, so this file exists and each target `includes` it.
#
# WHY a rule and not an action target: gyp resolves a target's `sources` when
# it generates the build files, which is BEFORE any action would run. Globbing
# the assembler objects into `sources` from an action's output directory
# therefore finds nothing on a clean tree — it only appears to work on an
# incremental rebuild. A `rule` is the mechanism gyp has for "this source file
# with this extension is produced by this command".
{
  "rules": [
    {
      "rule_name": "openh264_nasm",
      "extension": "asm",
      "inputs": [],
      "outputs": ["<(INTERMEDIATE_DIR)/asm/<(RULE_INPUT_ROOT).o"],
      "action": [
        "node", "scripts/assemble.js",
        "<(RULE_INPUT_PATH)",
        "<(INTERMEDIATE_DIR)/asm/<(RULE_INPUT_ROOT).o",
        "<(OPENH264_ROOT)/codec/common/x86"
      ]
    }
  ]
}
```

```python
# apps/agent/native/binding.gyp
#
# The four openh264 sub-libraries mirror openh264-sys2 0.9.8's build.rs:315-355
# exactly. Each is a static_library target because each needs its own include
# set; merging them into one target changes which headers win and does not
# build.
{
  "variables": {
    "OPENH264_ROOT%": "vendor/openh264",
    # The assembler platform define. openh264's own build picks UNIX64 / WIN64
    # / X86_32; the script reads this to pass -D to nasm.
    "asm_platform%": "UNIX64"
  },
  "targets": [
    {
      "target_name": "openh264_common",
      "type": "static_library",
      "includes": ["openh264_asm.gypi"],
      "sources": [
        "<!@(find <(OPENH264_ROOT)/codec/common -name '*.cpp')",
        # Every .asm under common/x86. `asm_inc.asm` is a macro include, not a
        # translation unit, and is excluded here.
        "<!@(find <(OPENH264_ROOT)/codec/common/x86 -name '*.asm' ! -name 'asm_inc.asm')"
      ],
      "direct_dependent_settings": {
        "include_dirs": [
          "<(OPENH264_ROOT)/codec/api/wels",
          "<(OPENH264_ROOT)/codec/common/inc"
        ]
      },
      "include_dirs": [
        "<(OPENH264_ROOT)/codec/api/wels",
        "<(OPENH264_ROOT)/codec/common/inc"
      ],
      "defines": ["X86_ASM", "ASM_PLATFORM_<(asm_platform)"],
      "cflags_cc!": ["-fno-exceptions", "-fno-rtti"],
      "cflags_cc": ["-std=c++17", "-fno-strict-aliasing", "-fno-common"],
      "conditions": [
        # Upstream skips the stack protector on Windows-GNU only, where it
        # broke linking. Everywhere else it is on.
        ["OS!='win' or OS=='win' and target_arch!='x64'", {
          "cflags_cc": ["-fstack-protector-all"],
          "cflags": ["-fstack-protector-all"]
        }],
        ["OS=='win'", {
          "defines": ["WIN64"],
          "msvs_settings": {
            "VCCLCompilerTool": { "ExceptionHandling": 1 }
          }
        }],
        # Non-x86 hosts have no .asm to assemble; the rule finds no sources and
        # the scalar C path is complete on its own.
        ["target_arch!='x64' and target_arch!='ia32'", {
          "sources!": [
            "<!@(find <(OPENH264_ROOT)/codec/common/x86 -name '*.asm' ! -name 'asm_inc.asm')"
          ]
        }]
      ]
    },
    {
      "target_name": "openh264_processing",
      "type": "static_library",
      "includes": ["openh264_asm.gypi"],
      "dependencies": ["openh264_common"],
      "sources": [
        "<!@(find <(OPENH264_ROOT)/codec/processing -name '*.cpp')",
        "<!@(find <(OPENH264_ROOT)/codec/processing/src/x86 -name '*.asm')"
      ],
      "include_dirs": [
        "<(OPENH264_ROOT)/codec/api/wels",
        "<(OPENH264_ROOT)/codec/common/inc",
        "<(OPENH264_ROOT)/codec/processing/src/common",
        "<(OPENH264_ROOT)/codec/processing/interface"
      ],
      "defines": ["X86_ASM"],
      "cflags_cc!": ["-fno-exceptions", "-fno-rtti"],
      "cflags_cc": ["-std=c++17", "-fno-strict-aliasing", "-fno-common"],
      "conditions": [
        ["target_arch!='x64' and target_arch!='ia32'", {
          "sources!": [
            "<!@(find <(OPENH264_ROOT)/codec/processing/src/x86 -name '*.asm')"
          ]
        }]
      ]
    },
    {
      "target_name": "openh264_encoder",
      "type": "static_library",
      "includes": ["openh264_asm.gypi"],
      "dependencies": ["openh264_common", "openh264_processing"],
      "sources": [
        "<!@(find <(OPENH264_ROOT)/codec/encoder -name '*.cpp' ! -name 'DllEntry.cpp')",
        "<!@(find <(OPENH264_ROOT)/codec/encoder/core/x86 -name '*.asm')"
      ],
      "include_dirs": [
        "<(OPENH264_ROOT)/codec/api/wels",
        "<(OPENH264_ROOT)/codec/common/inc",
        "<(OPENH264_ROOT)/codec/processing/interface",
        "<(OPENH264_ROOT)/codec/encoder/core/inc",
        "<(OPENH264_ROOT)/codec/encoder/plus/inc"
      ],
      "defines": ["X86_ASM"],
      "cflags_cc!": ["-fno-exceptions", "-fno-rtti"],
      "cflags_cc": ["-std=c++17", "-fno-strict-aliasing", "-fno-common"],
      "conditions": [
        ["target_arch!='x64' and target_arch!='ia32'", {
          "sources!": [
            "<!@(find <(OPENH264_ROOT)/codec/encoder/core/x86 -name '*.asm')"
          ]
        }]
      ]
    },
    {
      # Not needed to encode, and kept because openh264-sys2 builds it and
      # that is the only linkage configuration proven for this tree. Dropping
      # it is a measured experiment for a later task, not a guess to make now.
      "target_name": "openh264_decoder",
      "type": "static_library",
      "includes": ["openh264_asm.gypi"],
      "dependencies": ["openh264_common"],
      "sources": [
        "<!@(find <(OPENH264_ROOT)/codec/decoder -name '*.cpp' ! -name 'DllEntry.cpp')",
        "<!@(find <(OPENH264_ROOT)/codec/decoder/core/x86 -name '*.asm')"
      ],
      "include_dirs": [
        "<(OPENH264_ROOT)/codec/api/wels",
        "<(OPENH264_ROOT)/codec/common/inc",
        "<(OPENH264_ROOT)/codec/decoder/core/inc",
        "<(OPENH264_ROOT)/codec/decoder/plus/inc"
      ],
      "defines": ["X86_ASM"],
      "cflags_cc!": ["-fno-exceptions", "-fno-rtti"],
      "cflags_cc": ["-std=c++17", "-fno-strict-aliasing", "-fno-common"],
      "conditions": [
        ["target_arch!='x64' and target_arch!='ia32'", {
          "sources!": [
            "<!@(find <(OPENH264_ROOT)/codec/decoder/core/x86 -name '*.asm')"
          ]
        }]
      ]
    },
    {
      "target_name": "ponter_agent_native",
      "dependencies": [
        "openh264_common",
        "openh264_processing",
        "openh264_encoder",
        "openh264_decoder"
      ],
      "sources": [
        "src/addon.cc",
        "src/encoder.cc",
        "src/resize.cc",
        "src/capture_windows.cc",
        "src/capture_linux.cc",
        "src/input_windows.cc",
        "src/input_linux.cc"
      ],
      "include_dirs": [
        "src",
        "<(OPENH264_ROOT)/codec/api/wels",
        "<(OPENH264_ROOT)/codec/common/inc",
        "<!(node -p \"require('node-addon-api').include\")"
      ],
      "defines": ["NAPI_VERSION=8", "NODE_ADDON_API_CPP_EXCEPTIONS"],
      "cflags_cc!": ["-fno-exceptions", "-fno-rtti"],
      "cflags_cc": ["-std=c++17", "-fexceptions", "-fno-strict-aliasing"],
      "conditions": [
        ["OS=='win'", {
          "defines": ["NOMINMAX", "WIN32_LEAN_AND_MEAN"],
          "libraries": ["-ldxgi", "-ld3d11", "-lole32", "-luser32", "-ldwmapi"],
          "msvs_settings": {
            "VCCLCompilerTool": {
              "ExceptionHandling": 1,
              "AdditionalOptions": ["/std:c++17"]
            }
          }
        }],
        ["OS=='linux'", {
          "libraries": ["-ldbus-1", "-lpthread", "-ldl"]
        }]
      ],
      "sources!": [
        # Per-OS source selection: the two Windows files must not be compiled
        # on Linux and vice versa.
        "<!(node -p \"process.platform === 'win32' ? 'src/capture_linux.cc src/input_linux.cc' : 'src/capture_windows.cc src/input_windows.cc'\")"
      ]
    }
  ]
}
```

`scripts/assemble.js` is a ~40-line Node script taking `(inputAsm, outputObj, includeDir)`. It:

1. Finds `nasm` on `PATH`. If absent: when `OPENH264_NO_ASM` is set, exit 0 and touch nothing (the `.asm` sources are already excluded from `sources` in that configuration — see the note below); otherwise **exit non-zero** with a message naming the package to install. The Rust build silently skipped assembly here, which is how a build ends up 2-3x slower than its author believes.
2. Runs `nasm -f <format> -I <includeDir>/ -D<ASM_PLATFORM> -DX86_ASM -o <outputObj> <inputAsm>`, where `<format>` is `elf64`/`win64`/`macho64` by host, and `<ASM_PLATFORM>` is `UNIX64`/`WIN64`/`X86_32` — the same trio openh264's own build uses.

**The `OPENH264_NO_ASM` path needs one more edit at the gyp level.** The four `sources!` conditions exclude the `.asm` globs on non-x86 hosts; the environment-variable path must exclude them on x86 hosts too. The implementer does this with a gyp variable rather than duplicating the conditions in five places:

```python
# add to "variables"
"no_asm%": "<!(node -p \"process.env.OPENH264_NO_ASM ? '1' : '0'\")"
```

then guard each `.asm` glob, e.g.

```python
"conditions": [
  ["<(no_asm)==1", { "sources!": [ "<!@(find <(OPENH264_ROOT)/codec/common/x86 -name '*.asm' ! -name 'asm_inc.asm')" ] }],
  ...
]
```

A scalar build is a **supported configuration**, not a workaround: openh264's C implementations are complete. What is not supported is a scalar build that nobody knows about.

`node-addon-api`'s include path must come from `require('node-addon-api').include` rather than a hard-coded `node_modules` path — pnpm's store layout is content-addressed and the addon's own `node_modules` is a symlink farm.

**Build-time note the implementer will hit:** `-fno-strict-aliasing` is not optional. openh264's own build sets it and its comments record that omitting it produced segmentation faults on Linux. `-fno-common` matters too — without it the four static libraries each define the same tentative definitions and the link picks arbitrarily.

**Two gyp traps to not trip over:**

- **Do not use `defines!` to drop `X86_ASM` on Windows.** An earlier draft of this gyp did exactly that, which silently disables the SIMD path on the platform where this addon spends most of its CPU budget. Windows defines `WIN64` **in addition to** `X86_ASM`, never instead of it.
- The `sources!` Windows/Linux split at the bottom of `ponter_agent_native` is evaluated when gyp generates the build, on the host — which is correct here because node-gyp never cross-compiles this target. It is called out so a later reader does not mistake it for a cross-compilation bug.

Then create the addon's package manifest. **It must exist as its own package** — `pnpm-workspace.yaml`'s `allowBuilds` is keyed on the name of the package that owns the `install` script, and a bare directory with a `binding.gyp` has no identity for pnpm to allow:

```json
// apps/agent/native/package.json
{
  "name": "@ponter/agent-native",
  "version": "0.0.0",
  "private": true,
  "main": "build/Release/ponter_agent_native.node",
  "types": "index.d.ts",
  "scripts": {
    "install": "node-gyp rebuild --target=35.7.5 --dist-url=https://electronjs.org/headers",
    "build": "node-gyp rebuild --target=35.7.5 --dist-url=https://electronjs.org/headers"
  },
  "devDependencies": {
    "node-addon-api": "^8.9.2",
    "node-gyp": "^9.4.1"
  }
}
```

Both versions are already in the lockfile (resolved transitively via `better-sqlite3`), so adding them here costs no new resolution: `node-addon-api@8.9.2` and `node-gyp@9.4.1`. `node-addon-api` 8.x defines `NAPI_CPP_EXCEPTIONS`/`NODE_ADDON_API_CPP_EXCEPTIONS` on its own (`napi.h:46-77`) once `NAPI_VERSION >= 4`, which is why the `defines` above also carry it explicitly — belt and braces, since a define set in a different target's scope is easy to lose.

The `--dist-url=https://electronjs.org/headers` is not optional (spec D7). The addon's N-API symbols must resolve against **Electron's** V8/Node headers, not the system Node's; a build against the wrong headers loads in `node` and crashes in the Electron main process. `--target=35.7.5` tracks `apps/desktop/package.json`'s `electron: ^35.0.0`; when that floor moves, this pin moves with it, and the `uses` field in `apps/desktop` is what will notice.

Finally write `apps/agent/native/index.d.ts` — the file is the Interfaces block above, verbatim, with the two JSDoc notes attached to `encode`.

- [ ] **Step 4: Write `error.h` — the one place a C++ failure becomes a JS error**

Every entry point in the addon routes its failures through this header. It is the mechanism that satisfies the Global Constraint "never let a C++ exception cross the FFI boundary":

```cpp
// apps/agent/native/src/error.h
#pragma once
#include <napi.h>
#include <exception>
#include <string>

namespace ponter {

/** The stable error codes. These are the contract the TS core matches on. */
inline const char* kErrorInvalidArgument   = "NATIVE_INVALID_ARGUMENT";
inline const char* kErrorBufferOutOfBounds = "NATIVE_BUFFER_OUT_OF_BOUNDS";
inline const char* kErrorCaptureFailed     = "NATIVE_CAPTURE_FAILED";
inline const char* kErrorEncoderFailed     = "NATIVE_ENCODER_FAILED";
inline const char* kErrorInputFailed       = "NATIVE_INPUT_FAILED";
inline const char* kErrorUnsupported       = "NATIVE_UNSUPPORTED_PLATFORM";
inline const char* kErrorHandleInvalid     = "NATIVE_HANDLE_INVALID";

/**
 * Throw a JS error carrying a stable code and a human-readable message.
 *
 * Every native failure goes through here, so the TS side can branch on
 * `error.code` rather than on a message string.
 */
inline void ThrowError(Napi::Env env, const char* code, const std::string& message) {
  Napi::Error error = Napi::Error::New(env, message);
  error.Set("code", Napi::String::New(env, code));
  error.ThrowAsJavaScriptException();
}

/**
 * Run `fn`, converting ANY C++ exception into a JS error.
 *
 * This is the boundary guard: an exception that escapes here would
 * terminate the process, which is exactly the crash the addon must never
 * cause (spec §9.2).
 */
template <typename Fn>
inline void Guard(Napi::Env env, const char* code, Fn&& fn) {
  try {
    fn();
  } catch (const Napi::Error& e) {
    e.ThrowAsJavaScriptException();
  } catch (const std::exception& e) {
    ThrowError(env, code, std::string("native failure: ") + e.what());
  } catch (...) {
    ThrowError(env, code, "native failure: unknown exception");
  }
}

}  // namespace ponter
```

- [ ] **Step 5: Write `encoder.cc` — the openh264 wrapper**

The encoder must:

- Configure openh264 through the C API (`WelsCreateSVCEncoder` / `Initialize` / `EncodeFrame` / `Uninitialize` / `WelsDestroySVCEncoder`).
- **Not** set a profile. Pin nothing, and let openh264 derive it — the derivation is what makes the assertion in Step 1 (`profileIdc === 66`) true for the right reason:

  `encoder_ext.cpp:653-667` maps `PRO_UNKNOWN` to `(iEntropyCodingModeFlag) ? PRO_HIGH : PRO_BASELINE`. And `param_svc.h:164`, in `FillDefault`, sets `iEntropyCodingModeFlag = 0` — **CAVLC**. So an unset profile resolves to **PRO_BASELINE, `profile_idc` 66**, with constraint byte `0xC0`. The Rust agent never set the entropy mode either (`openh264-0.9.8/src/encoder.rs:964-1044`, `reinit`, sets no such field), which is why the agent's own recorded Annex-B starts `00 00 00 01 67 42 c0 …` (`docs/spikes/2026-10-11-hardware-encode-h265.md:167`). Baseline is the behaviour to preserve; the plan pins it with a test rather than assuming it.

  Corollary for the implementer: if someone later sets `iEntropyCodingModeFlag = 1` for compression, the profile silently becomes **High (100)**, constraint byte `0x00`, and the browser must be offered `profile-level-id=64001f` instead. That is a different bitstream. The `profileIdc`/`constraintByte` assertions in the smoke test exist to make that change loud rather than silent.

- Report the encoder's **actual** `profile_idc`, `level_idc`, and constraint byte, read out of the SPS openh264 wrote — **not** a constant, and not a value read back from the encoder API. The Rust agent's hard-coded `profile-level-id=42001f` was wrong in both bytes (spec §3.3), which is the bug this closes.

  **You cannot ask openh264 for these.** Verified in 0.9.8:
  - `GetBaseParams` (`param_svc.h:286-293`) returns only `iUsageType`, `iPicWidth`, `iPicHeight`, `iTargetBitrate`, `iRCMode`, `fMaxFrameRate` — no profile, no level.
  - `GetOption` has **no** `ENCODER_OPTION_PROFILE` and no `ENCODER_OPTION_LEVEL` case; only `SetOption` has them (`param_svc.h:1114`, `:1129`).
  - `ENCODER_OPTION_SVC_ENCODE_PARAM_EXT` (`param_svc.h:1227-1231`) `memcpy`s back the whole `SEncParamExt` that was *requested*, not what the encoder resolved.

  So `encoder.cc` **parses the SPS out of the Annex-B it just produced.** Scan for the NAL with `(byte0 & 0x1f) == 7`, strip the emulation-prevention `00 00 03` sequences, then read: `profile_idc` at SPS byte 1, the constraint byte at byte 2, `level_idc` at byte 3. That is four lines of bitstream walking and it is the only honest source. Assert on the *parsed* values.

  `WelsGetLevelIdc` (`codec/encoder/core/src/au_set.cpp:187-193`) computes level from frame size, frame rate and bitrate against `g_ksLevelLimits` (`codec/common/src/common_tables.cpp:345-363`, **17** levels, 1.0 through 5.2 — a truncated table can only over-report). For the four shipped presets it yields 4.0 / 3.1 / 4.2 / 3.2 (spec §3.3). The level byte is `0x28`/`0x1f`/`0x2a`/`0x20` respectively; the smoke test only asserts `> 0`, and the preset-level table is Task 6's matrix.

- **Crop to even dimensions** before encoding (spec B15). A capture width of, say, 1367 px is ordinary on Windows at 125 % scaling, and H.264 requires even width and height. The crop is one row/column off the right and bottom edges.

- **Downscale to the profile size** in `src/resize.cc` (spec B16) — the SIMD box filter, not a nearest-neighbour sampler. Nearest-neighbour is visibly worse at the zoom levels a remote-desktop user works at, and a bilinear sample is the wrong filter for an exact integer ratio. When the source is smaller than the profile, reject with `NATIVE_INVALID_ARGUMENT` rather than upscaling.

- **Set every encoder parameter spec B17 names, and nothing else.** The Rust agent's list (`desktop.rs:1826-1850`) is the contract:

  | Field | Value | Observable from outside? |
  |---|---|---|
  | `usageType` | `SCREEN_CONTENT_REAL_TIME` | no |
  | `iRCMode` | `RC_BITRATE_MODE` | yes, via `GetBaseParams().iRCMode` |
  | `iComplexityMode` | `LOW_COMPLEXITY` | no |
  | `bEnableAdaptiveQuant` | `false` | no |
  | `bEnableBackgroundDetection` | `false` | no |
  | `uiIntraPeriod` | `gop_frames_for(profile)` — `(fps * 2).round().max(1)` | yes, indirectly: IDR cadence in the stream |
  | `sVuiParam` | `bt709()` | no |
  | `iTargetBitrate` | the profile's bitrate | yes, via `GetBaseParams()` and the SPS level |
  | `fMaxFrameRate` | the profile's fps | yes, via `GetBaseParams()` |

  The four "no" rows are internal openh264 state with no getter, so **the TS smoke test cannot see them** and neither can an SPS parse. Do not write a TypeScript assertion that pretends otherwise. The honest check lives in Step 12: build the `SEncParamExt` through the same code path the create call uses, and assert the struct's fields **before** handing it to `Initialize`. That is a pure function over a struct — no encoder, no frame, no GPU.

  This matters because three of those four change the bitstream a user would notice: `usageType` drives openh264's screen-content tuning (sharp text edges versus camera noise), `bt709` versus default BT.601 shifts every colour, and adaptive quantisation off is what keeps a static desktop from pulsing. A port that silently dropped them would still produce valid H.264 and would still decode — it would just look wrong, which is the hardest kind of regression to attribute later.

- **Convert RGBA8 → I420** and hand openh264 `I420Buffer` planes directly. The Rust agent did exactly this at `apps/agent/src/desktop.rs:1862` (`YUVBuffer::from_rgba8_source(RgbaSliceU8::new(..))`). Do not send 4 bytes/pixel across the FFI a second time just to convert in JS.

- Return the access unit in **Annex-B** framing. openh264 hands back `SFrameBSInfo`, whose `sLayerInfo[0]` carries `pBsBuf` — already Annex-B, start codes included. Copy it out; do not re-frame it.

- Set `isKeyframe` when the access unit contains an IDR (NAL type 5).

- **Implement `setBitrate` — the retarget order is the whole behaviour** (spec B19). The two-call sequence is not an optimisation, it is what openh264 requires:
  ```
  if (target > current) {
      SetOption(ENCODER_OPTION_MAX_BITRATE, { iLayer: SPATIAL_LAYER_0,   iBitrate: target });
  }
  SetOption(ENCODER_OPTION_BITRATE,     { iLayer: SPATIAL_LAYER_ALL, iBitrate: target });
  ```

  Raise issues **both**, in that order; lower issues **only** the second. Reference: `apps/agent/src/desktop.rs:1880-1905`, which bails with `"... MAX_BITRATE, LAYER_0 ... failed with rc"` on the first call and `"... BITRATE ... failed with rc"` on the second — keep both distinct failure paths rather than collapsing them into one error, because a raise that fails only the first call leaves the encoder at its old ceiling and the symptom (stream stalls at the old rate) is otherwise unattributable.

  `current` is the bitrate the create call was given, updated on every successful `setBitrate`. Track it on the handle; do not read it back from openh264 — `GetBaseParams` returns `iTargetBitrate` but it reflects the *requested* value, not what the rate controller settled on, which is exactly the same trap as profile and level above.

  **On a fresh encoder, openh264 rejects `SetOption` with `cmInitExpected` (rc 4) until one `encode()` has run** — verified in the Rust tests at `desktop.rs:3091-3105`. Production always retargets mid-stream so it never hits this, but a C++ unit test that calls `setBitrate` before the first frame will. Seed the test with one `encode()` call, and let a caller who retargets a fresh handle see the real openh264 error rather than papering over it.

- [ ] **Step 6: Write the capture and input backends**

`capture_windows.cc`: the existing 3-tier fallback — `Windows.Graphics.Capture` (WGC) → DXGI Output Duplication → GDI, including the `0x80070057` fix from PR #79. The `GDI_DEFAULT_POLL_INTERVAL` is a *fallback constant*; the runtime interval comes from `AGENT_DESKTOP_POLL_INTERVAL_MS` and defaults to the profile's frame budget (spec B60).

`capture_linux.cc`: `org.freedesktop.portal.ScreenCast` over D-Bus, with the PipeWire session-lifetime fix from `apps/agent/vendor/xcap/PATCH.md` carried over.

`input_windows.cc`: `SendInput`. `input_linux.cc`: `org.freedesktop.portal.RemoteDesktop` D-Bus calls — the exact method set in spec B31.

Every OS call's return value is checked; every failure becomes a `ThrowError` with the matching stable code.

- [ ] **Step 7: Build the addon**

First add `@ponter/agent-native` to `pnpm-workspace.yaml`'s `allowBuilds`, so pnpm does not skip its `install` script (spec D9). The entry is a **package name**, and it must be the name in `apps/agent/native/package.json` verbatim — pnpm matches on identity, not on path:

```yaml
allowBuilds:
  - esbuild
  - workerd
  - vue-demi
  - electron
  - '@ponter/agent-native'
```

Then build:

```bash
pnpm --filter @ponter/agent-native run build
```

Expected: a successful build producing `apps/agent/native/build/Release/ponter_agent_native.node`.

If NASM is not installed on the machine, this fails with the message `scripts/assemble.js` writes, naming the package to install. Set `OPENH264_NO_ASM=1` to build the scalar path — that is a supported configuration, not a workaround, and the CI matrix must cover both. **Do not** let a missing `nasm` silently produce a slower addon: the Rust build did exactly that (openh264-sys2 skips assembly when `nasm` is absent, printing one line), and it is how a developer ends up believing the pipeline is 2-3x faster than it is.

- [ ] **Step 8: Prove the assembler path actually linked**

An addon that builds and passes its smoke test can still be running the scalar C path — that is precisely the state the Rust build was in whenever `nasm` was missing. Pin it with a symbol check, not a "the `.a` exists" check.

```bash
# The assembler exports carry a WELS_EXTERN marker and a SIMD suffix.
# `WelsDctFourT4_sse2` is emitted by codec/common/x86/dct.asm:470 —
# a symbol that cannot exist unless NASM ran.
nm -g --defined-only apps/agent/native/build/Release/openh264_common.a \
  | grep -E 'WelsDctFourT4_(sse2|avx2)' || {
    echo "ASSEMBLER PATH NOT LINKED — this is a scalar build."; exit 1; }
```

Expected: two or more symbol lines.

If `OPENH264_NO_ASM=1` was set deliberately, the expected result is **the opposite** — and the build must say so. The implementer records which of the two configurations the gate observed; a silent scalar build is the failure this step exists to catch, not a neutral outcome.

- [ ] **Step 9: Run the test to verify it passes**

Run: `pnpm --filter @ponter/agent-node exec vitest run test/native/smoke.test.ts`
Expected: PASS — 5 tests green (platform, error codes, encode+profile, bitrate retarget, unknown-handle rejection).

- [ ] **Step 10: Write the failing test — the fault-containment gate**

Create `apps/agent/test/native/fault-containment.test.ts`. This is spec §9.2's gate:

```ts
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const addon = require('../../native/build/Release/ponter_agent_native.node');

/**
 * Read `pic_width_in_mbs_minus1` / `pic_height_in_map_units_minus1` out of an
 * SPS NAL body. This is the only way to prove the addon actually resized:
 * the SPS is where the encoder records the picture size, and the browser's
 * decoder obeys it. Asserting on the input length would prove nothing.
 *
 * `sps` is the NAL *body* — everything after `00 00 00 01 67`.
 */
function readSpsFrameSizeMbs(sps: Buffer): {
  widthMbs: number;
  heightMbs: number;
} {
  // Undo emulation prevention: `00 00 03` becomes `00 00`.
  const rbsp: number[] = [];
  for (let i = 0; i < sps.length; i += 1) {
    if (
      i >= 2 &&
      sps[i] === 0x03 &&
      sps[i - 1] === 0x00 &&
      sps[i - 2] === 0x00
    ) {
      continue;
    }
    rbsp.push(sps[i]);
  }

  let bitPos = 0;
  const u = (n: number): number => {
    let v = 0;
    for (let i = 0; i < n; i += 1) {
      const byte = rbsp[(bitPos >> 3) + 0] ?? 0;
      v = (v << 1) | ((byte >> (7 - (bitPos & 7))) & 1);
      bitPos += 1;
    }
    return v;
  };
  /** Unsigned exp-Golomb. */
  const ue = (): number => {
    let leadingZeros = 0;
    while (u(1) === 0) leadingZeros += 1;
    return (1 << leadingZeros) - 1 + u(leadingZeros);
  };

  u(8); // profile_idc
  u(8); // constraint flags
  u(8); // level_idc
  ue(); // seq_parameter_set_id

  // Baseline and main have no high-profile block; the guard is for
  // completeness, since a profile change would move every field after it.
  const profileIdc = rbsp[0];
  if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134].includes(profileIdc)) {
    const chromaFormatIdc = ue();
    if (chromaFormatIdc === 3) u(1); // separate_colour_plane_flag
    ue(); // bit_depth_luma_minus8
    ue(); // bit_depth_chroma_minus8
    u(1); // qpprime_y_zero_transform_bypass_flag
    if (u(1)) {
      // seq_scaling_matrix_present_flag
      const lists = chromaFormatIdc !== 3 ? 8 : 12;
      for (let i = 0; i < lists; i += 1) {
        if (u(1)) {
          let last = 8;
          let next = 8;
          for (let j = 0; j < (i < 6 ? 16 : 64); j += 1) {
            if (next !== 0) next = (last + ue() + 256) % 256;
            last = next === 0 ? last : next;
          }
        }
      }
    }
  }

  ue(); // log2_max_frame_num_minus4
  const picOrderCntType = ue();
  if (picOrderCntType === 0) {
    ue(); // log2_max_pic_order_cnt_lsb_minus4
  } else if (picOrderCntType === 1) {
    u(1); // delta_pic_order_always_zero_flag
    ue(); // offset_for_non_ref_pic (se)
    ue(); // offset_for_top_to_bottom_field (se)
    const numRefFramesInPicOrderCntCycle = ue();
    for (let i = 0; i < numRefFramesInPicOrderCntCycle; i += 1) ue();
  }
  ue(); // max_num_ref_frames
  u(1); // gaps_in_frame_num_value_allowed_flag
  const widthMbs = ue() + 1;
  const heightMbs = ue() + 1;
  return { widthMbs, heightMbs };
}

describe('the fault-containment gate (spec §9.2)', () => {
  it('rejects a zero-length pixel buffer with a typed error, and the process survives', async () => {
    const handle = await addon.createEncoder({ width: 1280, height: 720, fps: 30, bitrate: 4_000_000 });
    await expect(
      addon.encode(handle, { pixels: Buffer.alloc(0), stride: 0, width: 1280, height: 720, timestampUs: 0 }),
    ).rejects.toMatchObject({ code: 'NATIVE_INVALID_ARGUMENT' });
    await addon.destroyEncoder(handle);
  });

  it('rejects a stride that does not match the width', async () => {
    const handle = await addon.createEncoder({ width: 1280, height: 720, fps: 30, bitrate: 4_000_000 });
    await expect(
      addon.encode(handle, {
        pixels: Buffer.alloc(1280 * 720 * 4),
        stride: 7, // nonsense
        width: 1280,
        height: 720,
        timestampUs: 0,
      }),
    ).rejects.toMatchObject({ code: 'NATIVE_BUFFER_OUT_OF_BOUNDS' });
    await addon.destroyEncoder(handle);
  });

  it('rejects an invalid encoder handle', async () => {
    await expect(
      addon.encode(999_999, {
        pixels: Buffer.alloc(4),
        stride: 4,
        width: 1,
        height: 1,
        timestampUs: 0,
      }),
    ).rejects.toMatchObject({ code: 'NATIVE_HANDLE_INVALID' });
  });

  it('refuses to upscale a source smaller than the encoder profile', async () => {
    // This is the resize contract (spec B16), not a size-mismatch check: a
    // larger source is resized DOWN and encoded, but a smaller one is
    // rejected. Upscaling a small capture would ship a soft image and would
    // hide a capture misconfiguration behind a plausible-looking stream.
    const handle = await addon.createEncoder({ width: 1280, height: 720, fps: 30, bitrate: 4_000_000 });
    await expect(
      addon.encode(handle, {
        pixels: Buffer.alloc(640 * 480 * 4),
        stride: 640 * 4,
        width: 640,
        height: 480,
        timestampUs: 0,
      }),
    ).rejects.toMatchObject({ code: 'NATIVE_INVALID_ARGUMENT' });
    await addon.destroyEncoder(handle);
  });

  it('accepts a larger source and downscales it to the profile size', async () => {
    // The positive half: a 1920x1080 capture, an 1280x720 encoder. The
    // access unit must decode at the PROFILE size, not the source size —
    // asserted by the SPS, because the SPS is where the picture size is
    // recorded and it is what the browser's decoder actually reads.
    const handle = await addon.createEncoder({ width: 1280, height: 720, fps: 30, bitrate: 4_000_000 });
    const frame = await addon.encode(handle, {
      pixels: Buffer.alloc(1920 * 1080 * 4, 0x40),
      stride: 1920 * 4,
      width: 1920,
      height: 1080,
      timestampUs: 0,
    });
    expect(frame.annexB.subarray(0, 4)).toEqual(Buffer.from([0, 0, 0, 1]));
    // The SPS carries the encoder's frame size; read it back the same way
    // `encoder.cc` does, so a silent no-op resize fails here rather than on
    // a user's screen.
    const sps = frame.annexB.subarray(
      frame.annexB.indexOf(Buffer.from([0, 0, 0, 1, 0x67])) + 4,
    );
    const { widthMbs, heightMbs } = readSpsFrameSizeMbs(sps);
    expect(widthMbs * 16).toBeGreaterThanOrEqual(1280);
    expect(widthMbs * 16).toBeLessThan(1920);
    expect(heightMbs * 16).toBeGreaterThanOrEqual(720);
    expect(heightMbs * 16).toBeLessThan(1080);
    await addon.destroyEncoder(handle);
  });

  it('crops an odd source down to even dimensions instead of throwing', async () => {
    // Spec B15: H.264 requires even width and height, and 1367x769 is what a
    // 1920x1080 display reports at 140 % scaling. The encoder must crop, not
    // throw and not silently pad — and the SPS must still record the profile
    // size, because that is what the browser decodes into.
    const handle = await addon.createEncoder({ width: 1366, height: 768, fps: 30, bitrate: 4_000_000 });
    const frame = await addon.encode(handle, {
      pixels: Buffer.alloc(1367 * 769 * 4, 0x40),
      stride: 1367 * 4,
      width: 1367,
      height: 769,
      timestampUs: 0,
    });
    const sps = frame.annexB.subarray(
      frame.annexB.indexOf(Buffer.from([0, 0, 0, 1, 0x67])) + 4,
    );
    const { widthMbs, heightMbs } = readSpsFrameSizeMbs(sps);
    // The macroblock count is a round-up of the profile's frame size, so the
    // assertion is one-sided: the picture must be at least the profile size
    // and must NOT have grown to the odd source's size. Frame cropping
    // (`frame_cropping_flag`) is what trims the last macroblock back to 1366;
    // reading it is beyond what this gate needs to prove.
    expect(widthMbs * 16).toBeGreaterThanOrEqual(1366);
    expect(widthMbs * 16).toBeLessThan(1367 * 2);
    expect(heightMbs * 16).toBeGreaterThanOrEqual(768);
    expect(heightMbs * 16).toBeLessThan(769 * 2);
    await addon.destroyEncoder(handle);
  });

  it('the process is still alive after all of the above', () => {
    expect(process.exitCode ?? 0).toBe(0);
  });
});
```

- [ ] **Step 11: Run the test to verify it fails, then passes**

Run: `pnpm --filter @ponter/agent-node exec vitest run test/native/fault-containment.test.ts`
Expected: FAIL first (the addon does not yet validate its inputs), then PASS after the validation is added to `encoder.cc`.

- [ ] **Step 12: Add the C++-level unit tests**

Create `apps/agent/native/test/` — a plain `assert`-based harness for the pure functions (the Annex-B splitter, the RTP-independent helpers, the error-code mapping). These run without the addon being loaded.

**One of these must assert the B19 call order, because nothing above can.** Stub the encoder's `SetOption` entry point (a function pointer, or a thin `EncoderOps` struct the test substitutes) and record `(option, layer, bitrate)` for each call:

- **Raise** `4_000_000 → 6_000_000` must produce exactly two calls, **in this order**: `(ENCODER_OPTION_MAX_BITRATE, SPATIAL_LAYER_0, 6_000_000)` then `(ENCODER_OPTION_BITRATE, SPATIAL_LAYER_ALL, 6_000_000)`.
- **Lower** `4_000_000 → 1_000_000` must produce exactly **one** call: `(ENCODER_OPTION_BITRATE, SPATIAL_LAYER_ALL, 1_000_000)` — no `MAX_BITRATE`.

Asserting only "two calls happened" is not enough: the regression this guards is the order reversing, or the layer index being wrong on the raise. Both still produce two successful `SetOption` calls and a stream that encodes, so nothing downstream would fail.

**A second test here must pin the B17 encoder config**, for the same reason — four of its nine fields have no getter. Build the `SEncParamExt` through the create call's own code path and assert, before `Initialize`: `usageType == SCREEN_CONTENT_REAL_TIME`, `iRCMode == RC_BITRATE_MODE`, `iComplexityMode == LOW_COMPLEXITY`, `bEnableAdaptiveQuant == false`, `bEnableBackgroundDetection == false`, `sVuiParam` carries BT.709, and `uiIntraPeriod == (fps * 2).round().max(1)` for both 30 and 60 fps. Include the degenerate case: an `fps` below 0.5 must yield `uiIntraPeriod == 1`, not 0 — openh264 rejects 0 and the Rust agent's `.max(1.0)` is what prevents it.

- [ ] **Step 13: Commit**

```bash
git add apps/agent/native apps/agent/test/native pnpm-workspace.yaml
git commit -m "feat(agent): add the N-API native addon with a fault-containment guarantee"
```

---

### Task 5: The shared stream-profile table, the D12 replacement, and the TypeScript API-access gate

**Files:**
- Create: `packages/shared/src/types/stream-profile.ts`
- Modify: `packages/shared/src/types/index.ts`, `packages/shared/src/index.ts`
- Create: `packages/shared/test/stream-profile.test.ts`
- Create: `packages/api-client/test/agent-api-access-gate.test.ts`
- Modify: `apps/desktop/src/main/__tests__/desktop-profile-parity.test.ts`

> **`packages/api-client/test/api-access-gate.test.ts` is NOT created here — it already exists.** It is the TypeScript API-access boundary gate (spec D13), and it walks `<root>/<pkg>/src/**` over `SCAN_ROOTS = ['apps', 'packages']` with `RAW_FETCH = /(?<![.\w])fetch\s*\(/` and `RAW_AXIOS = /(?<![.\w])axios/`. It therefore already covers `apps/agent/src/**` the moment the agent is TypeScript — no second copy of it is needed or wanted. This task adds only the agent-specific half described in Step 5.

**Interfaces:**
- Consumes: the four presets from `apps/agent/src/lib.rs:445-490`; `DESKTOP_PROFILES` from `apps/desktop/src/shared/ipc-types.ts:7-10`; the existing `packages/api-client/test/api-access-gate.test.ts` as the model for the agent-specific gate.
- Produces:

```ts
// packages/shared/src/types/stream-profile.ts
export interface StreamProfile {
  /** The preset's stable id, as used in configuration and on the wire. */
  readonly id: string;
  /** The label shown in the UI. */
  readonly label: string;
  /** The maximum width, in pixels. */
  readonly maxWidth: number;
  /** The maximum height, in pixels. */
  readonly maxHeight: number;
  /** The target frame rate. */
  readonly fps: number;
  /** The target bitrate, in bits per second. */
  readonly bitrateBps: number;
  /** The H.264 profile-level-id the encoder is expected to produce. */
  readonly profileLevelId: string;
}

/** The four shipped presets, in ascending order of cost. */
export const STREAM_PROFILES: readonly StreamProfile[];

/** Look a preset up by its id. Throws when the id is unknown. */
export function streamProfileById(id: string): StreamProfile;
```

- [ ] **Step 1: Write the failing test**

Create `packages/shared/test/stream-profile.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { STREAM_PROFILES, streamProfileById } from '../src/types/stream-profile';

describe('the shared stream-profile table', () => {
  it('carries the four shipped presets', () => {
    expect(STREAM_PROFILES.map((p) => p.id)).toEqual(['1080p30', '720p30', '1080p60', '720p60']);
  });

  it('gives each preset the profile-level-id openh264 actually emits for it', () => {
    // Recomputed from openh264's g_ksLevelLimits table (spec §3.3):
    // 1080p30 -> 4.0, 720p30 -> 3.1, 1080p60 -> 4.2, 720p60 -> 3.2.
    expect(streamProfileById('1080p30').profileLevelId).toBe('42c028');
    expect(streamProfileById('720p30').profileLevelId).toBe('42c01f');
    expect(streamProfileById('1080p60').profileLevelId).toBe('42c02a');
    expect(streamProfileById('720p60').profileLevelId).toBe('42c020');
  });

  it('throws on an unknown id rather than returning a default', () => {
    expect(() => streamProfileById('nope')).toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @ponter/shared exec vitest run test/stream-profile.test.ts`
Expected: FAIL — `Cannot find module '../src/types/stream-profile'`.

- [ ] **Step 3: Write the implementation**

Create `packages/shared/src/types/stream-profile.ts` with the four presets, copied from `apps/agent/src/lib.rs:445-490`, and the `profileLevelId` values from spec §3.3.

Re-export from `packages/shared/src/types/index.ts` and `packages/shared/src/index.ts`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @ponter/shared exec vitest run test/stream-profile.test.ts`
Expected: PASS.

> **This pass does not gate CI.** `ci-node.yml` runs `@ponter/shared`'s tests under `continue-on-error: true` — the package is a type/library dependency, not a build producer, so its suite is informational. A green shared suite is therefore **not** evidence the table is right. The gating pin is Step 5, which lives in `@ponter/api-client` and reads the same table.

- [ ] **Step 5: Replace D12 — the desktop/agent profile parity test**

`apps/desktop/src/main/__tests__/desktop-profile-parity.test.ts` currently guarantees that the agent's Rust presets and the desktop's `DESKTOP_PROFILES` cannot drift: it reads `../agent/src/lib.rs` **as text** and regexes `/"([0-9]+p[0-9]+)"\s*=>/g` out of `impl std::str::FromStr for StreamProfile`.

That test's guarantee is right and its mechanism dies with Rust. It must be rewritten in the same task that moves the table, not deleted. Rewrite it to import both sides as values:

```ts
// apps/desktop/src/main/__tests__/desktop-profile-parity.test.ts
import { describe, expect, it } from 'vitest';
import { STREAM_PROFILES } from '@ponter/shared';
import { DESKTOP_PROFILES } from '../../shared/ipc-types';

describe('desktop/agent stream-profile parity (spec D12)', () => {
  it('exposes exactly the presets the shared table defines — no more, no fewer', () => {
    // The Rust version compared id strings extracted from source text. This
    // compares the same sets, as values. Zero loss: a preset added to one
    // side and not the other still fails here.
    expect([...DESKTOP_PROFILES].sort()).toEqual(
      STREAM_PROFILES.map((p) => p.id).sort(),
    );
  });

  it('agrees on every preset id', () => {
    for (const profile of STREAM_PROFILES) {
      expect(DESKTOP_PROFILES).toContain(profile.id);
    }
  });
});
```

The parity guarantee survives intact; only the mechanism changes — a same-language import instead of a regex over a foreign language. `apps/desktop` already depends on `@ponter/shared`, so no new dependency is introduced.

**TEST-INTEGRITY declaration:** the file goes from 1 `it()` (the regex comparison) to 2 `it()`. The old assertion compared *id sets*; the new pair compares the same id sets *and* adds the per-id direction that the regex silently tolerated (a preset present in the shared table but missing from `DESKTOP_PROFILES` failed the old test only by set inequality, with no message naming the missing id). No assertion is weakened, none is dropped.

- [ ] **Step 6: Write the failing test — the agent-specific API-access gate**

Create `packages/api-client/test/agent-api-access-gate.test.ts`. It carries the three rules of `.github/workflows/build-agent.yml`'s Rust boundary gate that are *not* "no raw fetch" — because those three are the ones the generic gate above cannot express:

| Rust gate | What it forbade | The TypeScript rule |
|---|---|---|
| R-G1 | a `details` field outside `src/api.rs` | the agent builds its error envelope through `@ponter/api-client`'s `ApiError`; no hand-rolled `{ error: ... }` shape outside the sanctioned module |
| R-G1b | `reqwest::`, `hyper::Client`, `ureq::` | no hand-rolled HTTP client — any `node:http`/`node:https`/`undici` import outside the sanctioned module |
| R-G2 | a literal `"https?://` or `"wss?://` outside `src/main.rs`/`src/api.rs` | no literal server URL outside the sanctioned module |

```ts
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const AGENT_SRC = join(
  fileURLToPath(import.meta.url),
  '../../../../apps/agent/src',
);

/** The one module allowed to know about transports, envelopes and URLs. */
const SANCTIONED = 'api/';

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('the agent API-access boundary gate (spec D13 / ADR-89)', () => {
  it('the agent source tree exists — this gate must never pass vacuously', () => {
    // A gate that finds nothing to guard is not a green gate. If this fails,
    // the agent has not been ported to TypeScript yet and the rest of this
    // file proves nothing.
    expect(() => statSync(AGENT_SRC)).not.toThrow();
  });

  it('no hand-rolled HTTP client outside the sanctioned module', () => {
    const offenders = walk(AGENT_SRC)
      .filter((f) => !relative(AGENT_SRC, f).startsWith(SANCTIONED))
      .filter((f) => /from\s+['"]node:(http|https)['"]|from\s+['"]undici['"]/.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('no literal server URL outside the sanctioned module', () => {
    const offenders = walk(AGENT_SRC)
      .filter((f) => !relative(AGENT_SRC, f).startsWith(SANCTIONED))
      .filter((f) => /['"`](https?|wss?):\/\//.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('no hand-rolled error envelope outside the sanctioned module', () => {
    const offenders = walk(AGENT_SRC)
      .filter((f) => !relative(AGENT_SRC, f).startsWith(SANCTIONED))
      .filter((f) => /\{\s*(error|code|message)\s*:/.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
```

- [ ] **Step 7: Run the gate to verify its status, honestly**

Run: `pnpm --filter @ponter/api-client exec vitest run test/agent-api-access-gate.test.ts`

Expected at this point in the plan: the **first** test FAILS (`apps/agent/src` does not exist yet — `apps/agent` is still the Rust crate, whose source is `.rs`). The other three would pass vacuously, and the first test exists precisely to make that impossible to report as green.

The implementer must state in the report which of these two it observed:
- **tree missing** — the gate is written but not exercised; record it as "gate written, not yet exercised" in the ledger, never as "gate green";
- **tree present** — the gate ran against a real tree and its verdict is meaningful.

Plan 2 replaces `apps/agent` with the TypeScript core; from that commit on, this gate is real.

- [ ] **Step 8: Commit**

```bash
git add packages/shared packages/api-client/test apps/desktop/src/main/__tests__
git commit -m "feat(shared): move the stream-profile table into @ponter/shared, replace D12, and add the agent API-access gate"
```

---

### Task 6: The plan's own gate — the behavioural-parity coverage matrix

**Files:**
- Create: `docs/superpowers/plans/2026-10-21-agent-node-ts-rewrite-plan-1-coverage-matrix.md`

**Interfaces:**
- Consumes: spec §4 (B1–B62), §4.7 (R1–R6).
- Produces: the coverage matrix that Plan 2 and Plan 3 extend. The gate is spec §9.4: *"Every row of §4 — all 62 of them, B1 through B62 — plus the six retirements of §4.7 (R1 through R6) — must be covered by at least one test in the ported suite."*

- [ ] **Step 1: Write the matrix**

Create the matrix file. One row per B-number, with columns: `B#`, `Behaviour (one line)`, `Owning task (Plan 1 / Plan 2 / Plan 3)`, `Test file`, `Status`.

The three side channels must be marked explicitly, because they are the ones a partial port drops silently (spec §9.4): **B56** (the cursor frame), **B61** (the `desktop-stats` telemetry), **B62** (the desktop control state machine).

The six retirements R1–R6 get their own rows, each with the rationale from spec §4.7.

- [ ] **Step 2: Verify the matrix is complete**

Run: `grep -c '^| B[0-9]' docs/superpowers/plans/2026-10-21-agent-node-ts-rewrite-plan-1-coverage-matrix.md`
Expected: `62`.

Run: `grep -c '^| R[0-9]' docs/superpowers/plans/2026-10-21-agent-node-ts-rewrite-plan-1-coverage-matrix.md`
Expected: `6`.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/plans/2026-10-21-agent-node-ts-rewrite-plan-1-coverage-matrix.md
git commit -m "docs(plan): add the behavioural-parity coverage matrix for the agent rewrite"
```

---

## Plan 1 Completion Criteria

The plan is done when **all** of these hold:

1. **P0's gate passes**: `apps/agent/spike/report.json` exists and shows run 1 with `decodedFrameCount > 0`, `negotiatedCodec.mimeType === 'video/H264'`, and `wirePayloadType === negotiatedCodec.payloadType`. The three runs are all present.
2. `@ponter/webrtc-core` exposes `RTCRtpSenderLike` and `addTrack`, with the werift adapter's D4b regression test green.
3. The packetizer's table-driven fixtures pass, and the fixture bytes are literal (not recomputed).
4. The addon builds against Electron's headers, the smoke test passes, and the fault-containment gate passes.
   **The addon's surface includes `setBitrate(handle, bps)`** — spec B19 names it as the port destination, and without it a `desktop-bitrate` frame would parse into nothing. The C++ test asserting the raise's two-call order and the lower's one-call shape is part of this criterion, and so is the B17 encoder-config test, because four of those nine fields have no getter and nothing else can observe them.
5. The shared stream-profile table lives in `@ponter/shared` with the four computed `profile-level-id` values, and `desktop-profile-parity.test.ts` imports both sides as values (D12 replaced, guarantee intact).
6. The agent API-access gate is written, and its status is stated as **exercised** or **written but not yet exercised** — never as "green" when the tree it guards does not exist.
7. The coverage matrix has 62 B-rows and 6 R-rows.
8. **Every test change declares its before→after `it()`/`expect()` counts and a rationale.**
9. All CI workflows that ran before this plan still pass.
10. The working tree is clean, every commit's author is `Ngo Tuan Anh <ngotuananh2101@gmail.com>`, and **no commit carries a `Co-authored-by` trailer**.

## What this plan does not decide

These are carried forward to Plan 2 and Plan 3, and are listed here so their absence is not mistaken for an oversight:

- **O7** — the `profile-level-id` mismatch policy (tolerate, mutate, or refuse). The owner decides. The spike's A4 gives the evidence; the policy is not this plan's to make. (Spec §11, O7.)
- **Q1** — the exact `WeriftAdapter.addTrack` return shape beyond the seam in Task 2. Task 2 lands a working seam; Plan 2 may refine it, and any refinement must not break Task 2's tests.
- **Q2** — the DTLS/SRTP boundary. If werift handles DTLS and SRTP internally (which the spike will show), the fallback in spec §3.5.2(c) is unreachable and is dropped.
- **Q3** — the openh264 linkage and the Annex-B confirmation. **Settled in Task 4**: vendored source → four static libraries → Annex-B straight out of `SFrameBSInfo.sLayerInfo[0].pBsBuf`, so no AVCC conversion is needed. What remains open is only whether `codec/decoder/` can be dropped from the link; Task 4 keeps it because that is upstream's proven configuration, and dropping it is a measured experiment for a later task.
- **Q4, Q5** — the capture source selection and the `capture_image` fallback detection. Task 4's backends must expose the seams; Plan 2 wires the policy.
- **Q8** — the Electron packaging mechanics. Task 4 builds the addon; Plan 3 packages it.
- **Q11** — the addon's profile/level reporting surface. Task 4's `EncodedFrame` is a candidate answer; if Plan 2 finds a better shape, it must change Task 4's `index.d.ts` and Task 4's tests **together**, with the before→after counts declared. Note the constraint Task 4 already proves: openh264 exposes **no** getter for profile or level (`GetOption` has no such case, `GetBaseParams` returns neither), so any shape change must still be sourced from SPS parsing.

### A known accounting hole in the spec's B-row inventory

The behaviour inventory is 62 rows (B1–B62), and the Rust agent carries **362**
anchored `#[test]`/`#[tokio::test]` attributes (spec §8.1). Those two numbers cannot be reconciled, because **29 of the 362 sit in modules the inventory never gives a row to**:

| Module | Tests | Spec §12's port destination |
|---|---|---|
| `desktop/warm_capture.rs` | 18 | "The native capture path" |
| `portal/remote_desktop.rs` | 7 | "The native addon (Linux)" |
| `portal/token_store.rs` | 4 | "The native addon (Linux)" |

(`portal/injector.rs`'s 5 tests *are* covered — B31 names `injector.rs:110-160` — so it is not in this list.)

This is a **spec gap, not a plan gap**, and this plan does not invent rows to close it. The consequence is concrete and should not be discovered at retirement time: §8.1's guarantee that "each retired Rust test maps to a TS test or to an explicit R-entry" has no home for these 29, so Plan 3's Rust removal would delete them without anything recording what behaviour went with them.

**Owner decision needed before Plan 3.** The two honest options:

1. **Amend the inventory** with rows for warm-capture session reuse, the persistent RemoteDesktop portal restore token, and the portal token store — 3 new rows (B63–B65), each with tests in the plan that owns its port. This is the accurate option and it is what the 29 tests deserve; it costs a spec amendment.
2. **Add 3 explicit R-entries** declaring those behaviours retired — defensible for `token_store.rs` if the addon handles persistence differently, less defensible for `warm_capture.rs`, whose 18 tests encode the ADR-90 phase-1 behaviour that is very much still a product requirement.

Recommendation: option 1 for `warm_capture.rs` and `remote_desktop.rs`, option 2 only for `token_store.rs` if the addon's own persistence makes it moot. **The plan does not decide this** — it is listed here so Plan 3 cannot silently drop the 29.
