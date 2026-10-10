# Phase 3 Week 8 — Desktop Stream Quality & Source Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the Week 7 view-only ~720p15 desktop stream into a usable one: a resolved quality profile (default 1080p30, safe floor 720p30), a browser-driven manual bitrate control applied in place (no rebuild, no keyframe blip), a screen/window source picker that switches the live stream, a best-effort `desktop-stats` telemetry line, and GCC-driven auto-ABR — all over one new `'control'` data channel, with the terminal flow byte-identical.

**Architecture:** Week 7 already ships the media path (`attach_desktop_track` → `run_stream` → openh264 → SRTP). Week 8 adds a *control plane* beside it: a new `'control'` data channel carries four frame types (`desktop-sources`, `desktop-select`, `desktop-bitrate`, `desktop-stats`); the Rust agent enumerates sources via `xcap` and streams the **default** source immediately (preserving the Week 7 clean-refusal invariant), a dispatcher task forwards control frames into `run_stream`, and `run_stream` retargets the encoder in place via openh264's `unsafe raw_api().set_option`. On the browser side `packages/desktop-core` grows a DOM-free control surface and `apps/web` renders picker + bitrate + stats chrome (no input handling — that is Week 9).

**Tech Stack:** TypeScript (`@ponter/shared`, `@ponter/webrtc-core`, `@ponter/desktop-core`, Vue 3 + Pinia), vitest; Rust (`webrtc`/`rtc` 0.21, `openh264` 0.9.8, `xcap` 0.9.8, tokio), `cargo test`/`cargo clippy`; werift (unit + E2E offerer); GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-03-phase3-week8-stream-quality-design.md` (ADR-21..25, merged on `main` as `f8c2c97`)

> **Reading order:** read the spec's §2 (wire protocol), §3.7 (the ADR-23 spike result — the mechanism this plan ships), §6 (agent design) and §10.4 (review focus) before starting. This plan argues from the spec; where they disagree, the spec wins and the plan is wrong.

## Global Constraints

Copied verbatim from the spec's project-wide requirements. Every task's requirements implicitly include this section.

- **Precondition — open the branch from a fresh `origin/main` in a separate worktree:** `feat/phase3-week8-stream-quality`, e.g. `.claude/worktrees/phase3-week8`. Week 7 (`feat/phase3-week7-desktop-streaming`) and the Week 8 spec PR (#24, merged `f8c2c97`) must already be on `main`. Never `git checkout` in the shared working directory.
- **No new shared surface beyond one module:** `packages/shared/src/types/desktop.ts` (source/stats types) + its re-export in `types/index.ts` is the **only** `@ponter/shared` change. `WebRTCChannelType` already includes `'control'` (`packages/shared/src/types/webrtc.ts:7`) — do not re-add it.
- **`packages/webrtc-core` gains no new code.** The control channel rides the existing `DataChannelManager` and the pre-create/auto-register machinery in `connection.ts` (spec §5.2). Do not add a desktop-specific seam here.
- **Terminal path stays byte-identical:** `channelLabels: ['terminal']`, one `'terminal'` channel, `terminal-*` frames. The `'control'` label is desktop-only; the terminal path never sees it (spec §2.4).
- **No server-side changes:** no new endpoints, no schema changes. The server relays only SDP/ICE; data-channel bytes are peer-to-peer (spec §1.2, §9).
- **Rust deps — exactly one addition:** `openh264 = "0.9.8"`, `xcap = "0.9.8"`, `bytes = "1"` stay under `[target.'cfg(not(target_env = "musl"))'.dependencies]`; `webrtc`/`rtc = "0.21"` and `rust-version = "1.85"` unchanged. **Add `openh264-sys2 = "0.9.8"` to that same non-musl section** — `openh264` re-exports only `OpenH264API` (`lib.rs:17`), *not* the raw-API constants, so `ENCODER_OPTION_BITRATE`/`ENCODER_OPTION_MAX_BITRATE`/`SPATIAL_LAYER_0`/`SPATIAL_LAYER_ALL`/`SBitrateInfo` must be imported from `openh264_sys2` directly (exactly as the ADR-23 spike did). Same version line, same musl gate; the musl artifact stays terminal-only.
- **Quality values (ADR-21, ADR-24):** `StreamProfile::DEFAULT_1080P30 = { 1920, 1080, 30.0, 6_000_000 }`, `StreamProfile::SAFE_720P30 = { 1280, 720, 30.0, 4_000_000 }`. Named `const`s, never inline literals. Default profile is 1080p30; 720p30 is the guaranteed floor.
- **Config names (exact, env + CLI):** `--desktop-profile <1080p30|720p30>` / `AGENT_DESKTOP_PROFILE` (default `1080p30`); `--desktop-default-source <primary|ID>` / `AGENT_DESKTOP_DEFAULT_SOURCE` (default `primary`, the `DESKTOP_DEFAULT_SOURCE` constant — `primary` means the primary monitor, any other value is an explicit source id validated against the enumeration); `--desktop-select-timeout-ms <N>` / `AGENT_DESKTOP_SELECT_TIMEOUT_MS` (default `5000`, the `DESKTOP_SELECT_APPLY_TIMEOUT`). No inline magic numbers in the pipeline.
- **Bitrate retarget mechanism (ADR-23, spike §3.7):** apply via `unsafe raw_api().set_option`. **Raising** the target needs `ENCODER_OPTION_MAX_BITRATE` on `SPATIAL_LAYER_0` **first**, then `ENCODER_OPTION_BITRATE` on `SPATIAL_LAYER_ALL`; **lowering** needs only the single `ENCODER_OPTION_BITRATE` call. Neither path forces an IDR/SPS/PPS. `desktop-bitrate` is clamped to `MIN..MAX_BITRATE_BPS`.
- **Auto-ABR is a goal, not an acceptance criterion** (ADR-23, spec §10.2). It shapes scope; it gates nothing. Acceptance criteria follow spec §10.2 exactly.
- **Platform scope:** Linux is the runnable platform; macOS/Windows must compile and pass unit tests only; musl stays terminal-only (spec §1.2). No input handling anywhere — `DesktopView`'s `<video>` keeps no `controls` and no pointer/keyboard handlers (Week 9).
- **Repo rules:** `apps/server` must NOT runtime-value-import `@ponter/shared` (type-only is fine). GitHub URLs use `ngotuananh101`; Docker Hub namespace is `ngtuananh2011`.
- **English for all repo artifacts:** code, comments, commit messages, and docs stay English (repo technical-docs convention).
- **CI gate names (current, post `ci.yml`-split):** `Build Agent / Verify`, `Build Agent / Linux/x64-musl`, `CI (Node) / Lint, Typecheck, Format & Node Tests`, `CI (E2E) / Cross-language terminal E2E`. There is no `ci.yml`.

## Review Focus

The spec's six highest-risk behaviours (§10.4), each pinned to the test in the task that owns the code:

1. **Default-source ordering.** The default source is created **before** the answer, so a capture failure is a clean `approved: false` refusal rather than a live session with a black video element (ADR-22; the Week 7 invariant at `main.rs:1000-1014`). A *swap* happens only afterwards, inside `run_stream`. Pinned in **Task 3, Step 7** (the pre-answer `source_for(&default_id, ..)` match refuses on error, before `attach_desktop_track`) and structurally in **Task 4c, source-swap unit test** (the swap path never runs before the stream starts).
2. **Retarget correctness.** `apply_bitrate` uses the spike-confirmed `ENCODER_OPTION_BITRATE` path with the raise-order trap handled (`ENCODER_OPTION_MAX_BITRATE` on `SPATIAL_LAYER_0` first). Acceptance never references the spike (ADR-23). Pinned in **Task 4b, `apply_bitrate` unit test** (both the raise and the lower path; raise issues MAX_BITRATE before BITRATE).
3. **No input handling.** `DesktopView` gains control *chrome* only; the `<video>` keeps no `controls` and no pointer/keyboard handlers. Pinned in **Task 5, `DesktopView.test.ts`** (the existing "no `controls`" assertion stays green alongside the new picker/stats assertions).
4. **Validation.** `desktop-select` ids are checked against the agent's own enumeration (unknown id → `select-refused`, never used to build a source); `desktop-bitrate` is clamped. Pinned in **Task 4a, control-decode test** (unknown type / wrong channel dropped) and **Task 4b/4c** (`apply_bitrate` clamp; `source_for` unknown id → `Err`).
5. **Backward compatibility.** Terminal bytes unchanged; the Week 7 desktop media E2E passes unchanged. Pinned in **Task 6, `desktop.e2e.test.ts`** (the three Week 7 assertions are kept, not replaced) and the untouched terminal suite.
6. **Leak check.** A source swap stops the previous `FrameSource`; teardown closes the peer and every channel. Pinned in **Task 4c, source-swap unit test** (the old source's `stop()` is called) and **Task 6, E2E** (peer close ends the session; a second session connects).

---

### Task 1: `packages/shared` — desktop wire types (D1)

**Files:**
- Create: `packages/shared/src/types/desktop.ts`
- Modify: `packages/shared/src/types/index.ts` (add the re-export block)
- Test: `packages/shared/test/desktop-types.test.ts`

**Interfaces:**
- Consumes: `DataChannelMessage<T>` (already exported from `types/webrtc.ts`); nothing else.
- Produces (relied on by Tasks 2, 5, 6):
  - `DesktopSourceInfo { id: string; kind: 'monitor' | 'window'; name: string; width: number; height: number; x: number; y: number; scaleFactor: number; rotation: number; isPrimary: boolean; default: boolean }`
  - `DesktopStats { width: number; height: number; fps: number; targetBitrateBps: number; status?: { kind: 'select-refused' | 'quality-downgraded'; detail: string } }`

- [ ] **Step 1: Write the failing type tests**

Create `packages/shared/test/desktop-types.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import type { DesktopSourceInfo, DesktopStats } from '../src';

describe('Desktop wire types', () => {
  it('instantiates a valid DesktopSourceInfo', () => {
    const source: DesktopSourceInfo = {
      id: 'monitor:1',
      kind: 'monitor',
      name: 'eDP-1',
      width: 1920,
      height: 1080,
      x: 0,
      y: 0,
      scaleFactor: 1,
      rotation: 0,
      isPrimary: true,
      default: true,
    };
    expect(source.kind).toBe('monitor');
    expect(source.default).toBe(true);
  });

  it('instantiates a valid DesktopStats without status', () => {
    const stats: DesktopStats = {
      width: 1920,
      height: 1080,
      fps: 30,
      targetBitrateBps: 6_000_000,
    };
    expect(stats.status).toBeUndefined();
  });

  it('carries a select-refused status when the agent refuses a selection', () => {
    const stats: DesktopStats = {
      width: 1920,
      height: 1080,
      fps: 30,
      targetBitrateBps: 6_000_000,
      status: { kind: 'select-refused', detail: 'unknown source id' },
    };
    expect(stats.status?.kind).toBe('select-refused');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @ponter/shared test desktop-types`
Expected: FAIL — the `../src` import resolves but `DesktopSourceInfo`/`DesktopStats` are not exported (TS2305 / unresolved named export).

- [ ] **Step 3: Create the types module**

Create `packages/shared/src/types/desktop.ts`:

```typescript
/**
 * Desktop control-channel wire types (Week 8, spec §2.2/§5.1).
 *
 * These are payload shapes only. The envelope is the existing
 * `DataChannelMessage<T>` (`types/webrtc.ts`): `{ type, channel: 'control',
 * payload: T, timestamp }`. The four frame types are `desktop-sources`,
 * `desktop-select`, `desktop-bitrate`, `desktop-stats`.
 */

/** One capture source the agent can stream (a monitor or a window). */
export interface DesktopSourceInfo {
  /** Stable per enumeration: `monitor:<id>` / `window:<id>`. */
  id: string;
  kind: 'monitor' | 'window';
  /** `Monitor::name()`/`friendly_name()` or `Window::title()`. */
  name: string;
  width: number;
  height: number;
  /** Source geometry — needed by Week 9 input mapping. */
  x: number;
  y: number;
  scaleFactor: number;
  rotation: number;
  isPrimary: boolean;
  /** The entry the agent is streaming right now. */
  default: boolean;
}

/** Best-effort telemetry the agent pushes for the UI (spec §2.2). */
export interface DesktopStats {
  width: number;
  height: number;
  fps: number;
  targetBitrateBps: number;
  /** Optional agent→browser note; absent on ordinary telemetry. */
  status?: { kind: 'select-refused' | 'quality-downgraded'; detail: string };
}
```

- [ ] **Step 4: Re-export from the types barrel**

In `packages/shared/src/types/index.ts`, add after the `webrtc.js` block (the types are all type-only — no value export):

```typescript
export type { DesktopSourceInfo, DesktopStats } from './desktop.js';
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @ponter/shared test desktop-types && pnpm --filter @ponter/shared typecheck`
Expected: PASS (3 tests), typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/types/desktop.ts packages/shared/src/types/index.ts packages/shared/test/desktop-types.test.ts
git commit -m "feat(shared): add desktop control-channel wire types"
```

---

### Task 2: `packages/desktop-core` — `DesktopClient` control surface (D2)

**Files:**
- Modify: `packages/desktop-core/src/types.ts` (`DesktopClientOptions` gains `controlTimeoutMs?`)
- Modify: `packages/desktop-core/src/client.ts` (`onSources`, `onStats`, `selectSource`, `setBitrate`)
- Test: `packages/desktop-core/test/client.test.ts` (extend the existing `mockPeer` + add a `control` describe block)

**Interfaces:**
- Consumes: `DesktopSourceInfo`, `DesktopStats` (Task 1); `PeerConnection.dataChannels` (a `DataChannelManager` with `onMessage<T>(label, handler): () => void`, `sendJson<T>(label, type, payload): void`, `hasChannel(label): boolean`); the existing `DesktopClient` constructor/`start`/`close`.
- Produces (relied on by Task 5):
  - `DesktopClientOptions { trackTimeoutMs?: number; controlTimeoutMs?: number }` (`controlTimeoutMs` default `5_000`)
  - `DesktopClient.onSources(handler: (sources: DesktopSourceInfo[]) => void): () => void`
  - `DesktopClient.onStats(handler: (stats: DesktopStats) => void): () => void`
  - `DesktopClient.selectSource(sourceId: string): void`
  - `DesktopClient.setBitrate(bitrateBps: number): void`

> **Why the guards.** `DataChannelManager.sendJson` **throws** `Data channel "control" is not registered` when the label is absent (`data-channel.ts:75-77`). `selectSource`/`setBitrate` are called from UI handlers that only enable after `onSources` fires, so an absent channel is a defensive path — they must warn and return, never throw into a Vue event handler (spec §5.3).

- [ ] **Step 1: Extend `DesktopClientOptions`**

In `packages/desktop-core/src/types.ts`, add the option:

```typescript
export interface DesktopClientOptions {
  /** How long `start()` waits for the first remote track. Default 20_000. */
  trackTimeoutMs?: number;
  /** How long to wait for the control channel to open after the track. Default 5_000. */
  controlTimeoutMs?: number;
}
```

- [ ] **Step 2: Write the failing control-surface tests**

In `packages/desktop-core/test/client.test.ts`, extend `mockPeer()` so the returned peer carries a `dataChannels` stub, then add a `describe('control surface', …)` block. Add to the existing `mockPeer` return object (inside `peer`, beside `onConnectionStateChange`):

```typescript
      dataChannels: {
        hasChannel: vi.fn((_label: string) => controlOpen),
        onMessage: vi.fn((_label: string, handler: (msg: unknown) => void) => {
          controlHandler = handler;
          return removeControlHandler;
        }),
        sendJson: vi.fn(),
      },
      // `subscribeControl` fires a best-effort `waitForChannel`; without this
      // stub the call would throw inside `start()` and break every existing
      // test. Default: resolve (the channel opened).
      waitForChannel: vi.fn(async (_label: string, _timeoutMs?: number) => ({
        label: 'control',
        readyState: 'open',
      })),
```

and in the function body add the state those close over, plus emitters returned beside `emitTrack`:

```typescript
  let controlOpen = false;
  let controlHandler: ((msg: unknown) => void) | null = null;
  const removeControlHandler = vi.fn();
  const sendJson = vi.fn();
  // Default: the control channel opens. A test can re-point this to a rejecting
  // mock to exercise the never-opens warning path.
  const waitForChannel = vi.fn(async (_label: string, _timeoutMs?: number) => ({
    label: 'control',
    readyState: 'open',
  }));

  return {
    peer: {
      /* …existing members… */
      dataChannels: {
        hasChannel: vi.fn(() => controlOpen),
        onMessage: vi.fn((_label: string, handler: (msg: unknown) => void) => {
          controlHandler = handler;
          return removeControlHandler;
        }),
        sendJson,
      },
      waitForChannel,
    } as unknown as PeerConnection,
    emitTrack: (t: MediaStreamTrackLike, s: MediaStreamLike[]) => trackHandler?.(t, s),
    emitState: (state: string) => stateHandler?.(state),
    emitControl: (msg: unknown) => controlHandler?.(msg),
    setControlOpen: (open: boolean) => {
      controlOpen = open;
    },
    sendJson,
    waitForChannel,
    removeTrackHandler,
    removeStateHandler,
    removeControlHandler,
  };
```

> The mock's `waitForChannel` is exposed so a test can assert the best-effort wait was attempted, and — by re-pointing it to a rejecting `vi.fn` — that a never-opening channel warns instead of failing `start()`.

Then the new tests:

```typescript
describe('DesktopClient control surface', () => {
  /** A connected client: start() resolved, so the control subscription is live. */
  async function connected() {
    const mock = mockPeer();
    const client = new DesktopClient('agent-1', mock.peer);
    const started = client.start();
    mock.emitTrack(fakeTrack, fakeStreams);
    await started;
    return { ...mock, client };
  }

  const oneSource = {
    id: 'monitor:1',
    kind: 'monitor' as const,
    name: 'eDP-1',
    width: 1920,
    height: 1080,
    x: 0,
    y: 0,
    scaleFactor: 1,
    rotation: 0,
    isPrimary: true,
    default: true,
  };

  it('dispatches desktop-sources to onSources and re-fires on a second frame', async () => {
    const { client, emitControl } = await connected();
    const seen: unknown[] = [];
    client.onSources((sources) => seen.push(sources));

    emitControl({
      type: 'desktop-sources',
      channel: 'control',
      payload: { sources: [oneSource] },
      timestamp: 1,
    });
    emitControl({
      type: 'desktop-sources',
      channel: 'control',
      payload: { sources: [] },
      timestamp: 2,
    });

    expect(seen).toEqual([[oneSource], []]);
    client.close();
  });

  it('stops delivering onSources after unsubscribe', async () => {
    const { client, emitControl } = await connected();
    const seen: unknown[] = [];
    const off = client.onSources((sources) => seen.push(sources));

    off();
    emitControl({
      type: 'desktop-sources',
      channel: 'control',
      payload: { sources: [oneSource] },
      timestamp: 1,
    });

    expect(seen).toEqual([]);
    client.close();
  });

  it('dispatches desktop-stats to onStats', async () => {
    const { client, emitControl } = await connected();
    const seen: unknown[] = [];
    client.onStats((stats) => seen.push(stats));

    emitControl({
      type: 'desktop-stats',
      channel: 'control',
      payload: { width: 1920, height: 1080, fps: 30, targetBitrateBps: 6_000_000 },
      timestamp: 1,
    });

    expect(seen).toEqual([
      { width: 1920, height: 1080, fps: 30, targetBitrateBps: 6_000_000 },
    ]);
    client.close();
  });

  it('ignores an unknown control type without error', async () => {
    const { client, emitControl } = await connected();
    const sources: unknown[] = [];
    client.onSources((s) => sources.push(s));

    expect(() =>
      emitControl({ type: 'desktop-future', channel: 'control', payload: {}, timestamp: 1 }),
    ).not.toThrow();
    expect(sources).toEqual([]);
    client.close();
  });

  it('selectSource sends a desktop-select frame when the channel is open', async () => {
    const { client, sendJson, setControlOpen } = await connected();
    setControlOpen(true);

    client.selectSource('window:0x4a00007');

    expect(sendJson).toHaveBeenCalledWith('control', 'desktop-select', {
      sourceId: 'window:0x4a00007',
    });
    client.close();
  });

  it('setBitrate sends a desktop-bitrate frame when the channel is open', async () => {
    const { client, sendJson, setControlOpen } = await connected();
    setControlOpen(true);

    client.setBitrate(2_500_000);

    expect(sendJson).toHaveBeenCalledWith('control', 'desktop-bitrate', {
      bitrateBps: 2_500_000,
    });
    client.close();
  });

  it('selectSource and setBitrate warn instead of throwing when the channel is absent', async () => {
    const { client, sendJson, setControlOpen } = await connected();
    setControlOpen(false);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(() => client.selectSource('monitor:1')).not.toThrow();
    expect(() => client.setBitrate(1_000_000)).not.toThrow();
    expect(sendJson).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();

    warn.mockRestore();
    client.close();
  });

  it('warns when the control channel never opens, without failing start()', async () => {
    const mock = mockPeer();
    // A channel that never opens: `waitForChannel` rejects after the timeout.
    mock.waitForChannel.mockRejectedValueOnce(
      new Error('timeout waiting for channel "control"'),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client = new DesktopClient('agent-1', mock.peer);

    const started = client.start();
    mock.emitTrack(fakeTrack, fakeStreams);
    // Media must still resolve — a missing control channel is not fatal.
    await expect(started).resolves.toEqual({
      track: fakeTrack,
      streams: fakeStreams,
    });
    // Let the fire-and-forget rejection settle.
    await Promise.resolve();

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('control channel did not open'),
    );
    warn.mockRestore();
    client.close();
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --filter @ponter/desktop-core test client`
Expected: FAIL — `client.onSources is not a function` (and the other new methods are missing).

- [ ] **Step 4: Implement the control surface in `client.ts`**

Add the imports and fields, subscribe after the track resolves, and add the four methods. The subscription must go **inside `start()` after `trackPromise` resolves** (spec §5.3 step 2), so the control channel — which the agent opens after the track — is registered by then.

At the top of `packages/desktop-core/src/client.ts`:

```typescript
import type { DesktopSourceInfo, DesktopStats } from '@ponter/shared';
import type { PeerConnection } from '@ponter/webrtc-core';
import type { DesktopClientOptions, DesktopStream } from './types';

const DEFAULT_TRACK_TIMEOUT_MS = 20_000;
const DEFAULT_CONTROL_TIMEOUT_MS = 5_000;
```

Add fields beside the existing ones:

```typescript
  private readonly controlTimeoutMs: number;
  private readonly sourceListeners: Array<(sources: DesktopSourceInfo[]) => void> = [];
  private readonly statsListeners: Array<(stats: DesktopStats) => void> = [];
  /** Unsubscribes from the control channel's typed messages. Set after start(). */
  private controlUnsubscribe: (() => void) | null = null;
```

Set the timeout in the constructor (beside `trackTimeoutMs`):

```typescript
    this.controlTimeoutMs =
      options?.controlTimeoutMs ?? DEFAULT_CONTROL_TIMEOUT_MS;
```

In `start()`, immediately after `const stream = await trackPromise;` and before `cleanup(true); return stream;`, register the control subscription:

```typescript
      const stream = await trackPromise;
      this.subscribeControl();
      cleanup(true);
      return stream;
```

Add the private subscribe + the four public methods:

```typescript
  /**
   * Subscribe to the control channel once the media track has resolved.
   *
   * The agent sends `desktop-sources` when the control channel opens, which is
   * after the answer, so the listener is registered here rather than in the
   * constructor. It must still be in place before any frame can arrive (the
   * manager does not replay). The wait below is best-effort: the channel
   * opening late must not fail the stream (media already flows), so a missing
   * channel is logged, not thrown.
   */
  private subscribeControl(): void {
    this.controlUnsubscribe = this.peer.dataChannels.onMessage<unknown>(
      'control',
      (msg) => this.dispatchControl(msg),
    );
    // Fire-and-forget liveness check: a control channel that never opens leaves
    // the picker empty, which is worth one warning — but it must never reject
    // `start()`. `controlTimeoutMs` bounds the wait; the `closed` guard keeps a
    // normal teardown from logging a spurious warning.
    void this.peer
      .waitForChannel('control', this.controlTimeoutMs)
      .catch((error: unknown) => {
        if (this.closed) return;
        console.warn(`[desktop] control channel did not open: ${String(error)}`);
      });
  }

  private dispatchControl(msg: { type?: string; payload?: unknown }): void {
    switch (msg.type) {
      case 'desktop-sources': {
        const payload = msg.payload as { sources?: DesktopSourceInfo[] } | undefined;
        for (const listener of this.sourceListeners.slice()) {
          listener(payload?.sources ?? []);
        }
        break;
      }
      case 'desktop-stats': {
        const payload = msg.payload as DesktopStats | undefined;
        if (payload) {
          for (const listener of this.statsListeners.slice()) {
            listener(payload);
          }
        }
        break;
      }
      default:
        // Forward-compatible: an unknown control type is ignored, never an error.
        break;
    }
  }

  /** Capture-source enumeration pushed by the agent (once, after connect). */
  onSources(handler: (sources: DesktopSourceInfo[]) => void): () => void {
    this.sourceListeners.push(handler);
    return () => {
      const idx = this.sourceListeners.indexOf(handler);
      if (idx >= 0) this.sourceListeners.splice(idx, 1);
    };
  }

  /** Telemetry (resolution/fps/effective bitrate), best-effort. */
  onStats(handler: (stats: DesktopStats) => void): () => void {
    this.statsListeners.push(handler);
    return () => {
      const idx = this.statsListeners.indexOf(handler);
      if (idx >= 0) this.statsListeners.splice(idx, 1);
    };
  }

  /**
   * Ask the agent to switch to `sourceId`.
   *
   * `sendJson` throws when the `'control'` label is not registered
   * (`data-channel.ts:75-77`), so this is guarded: a click before the channel
   * opens warns and returns rather than throwing into the UI handler.
   */
  selectSource(sourceId: string): void {
    this.sendControl('desktop-select', { sourceId });
  }

  /** Set the target bitrate. Same guard as `selectSource`. */
  setBitrate(bitrateBps: number): void {
    this.sendControl('desktop-bitrate', { bitrateBps });
  }

  private sendControl(type: string, payload: unknown): void {
    if (!this.peer.dataChannels.hasChannel('control')) {
      console.warn(
        `[desktop] control channel not open; dropping ${type}`,
      );
      return;
    }
    this.peer.dataChannels.sendJson('control', type, payload);
  }
```

Finally, detach the control subscription in `close()` (beside `this.peerStateUnsubscribe?.()`):

```typescript
    this.controlUnsubscribe?.();
    this.controlUnsubscribe = null;
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @ponter/desktop-core test && pnpm --filter @ponter/desktop-core typecheck`
Expected: PASS — the 8 existing tests plus the 7 new control tests; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add packages/desktop-core/src/types.ts packages/desktop-core/src/client.ts packages/desktop-core/test/client.test.ts
git commit -m "feat(desktop-core): add DesktopClient control surface (sources, stats, select, bitrate)"
```

---

### Task 3: Agent — `StreamProfile`, source enumeration, `WindowSource` (D3a)

**Files:**
- Modify: `apps/agent/src/main.rs` (`StreamProfile` + its `FromStr`, beside `DesktopSource` — **unconditional**, see Step 1; `--desktop-profile`/`AGENT_DESKTOP_PROFILE` and `--desktop-default-source`/`AGENT_DESKTOP_DEFAULT_SOURCE`; `SessionConfig` fields; build the pre-answer default source from the resolved id; thread `profile` into `run_desktop_session`)
- Modify: `apps/agent/src/desktop.rs` (`DesktopSourceInfo`, `enumerate_sources`, `source_for`, `default_source_id`, `ScreenSource::for_monitor` replacing `ScreenSource::new`, new `WindowSource`, `DesktopEncoder::new(profile)`, `run_stream` signature — profile only in this task; **delete `MAX_WIDTH`/`MAX_HEIGHT`, `ScreenSource::new`, `primary_recorder`**, `use crate::StreamProfile`)
- Test: `apps/agent/src/main.rs` (`StreamProfile` parse + `frame_budget` tests) and `apps/agent/src/desktop.rs` (`#[cfg(test)] mod tests`)

**Interfaces:**
- Consumes: `xcap` — `Monitor::{all, from_point, id, name, friendly_name, x, y, width, height, rotation, scale_factor, is_primary, video_recorder}`, `Window::{all, id, title, x, y, width, height, is_minimized, capture_image}`; the existing `RawFrame`, `FrameSource`, `downscale`, `crop_to_even`, `TestPatternSource`, `ScreenSource`, `DesktopEncoder`.
- Produces (relied on by Task 4):
  - `pub struct StreamProfile { pub max_width: u32, pub max_height: u32, pub fps: f32, pub bitrate_bps: u32 }` with `pub const DEFAULT_1080P30: Self`, `pub const SAFE_720P30: Self`, and `impl std::str::FromStr` (`"1080p30"`/`"720p30"`, else `Err`). **Defined in `main.rs` (unconditional), not `desktop.rs`** — `SessionConfig` holds one, and a type named only inside the musl-gated `desktop` module is E0433 on musl.
  - `pub struct DesktopSourceInfo { pub id: String, pub kind: SourceKind, pub name: String, pub width: u32, pub height: u32, pub x: i32, pub y: i32, pub scale_factor: f32, pub rotation: f32, pub is_primary: bool, pub default: bool }` with `#[derive(Clone, Debug, Serialize)]`.
  - `pub fn enumerate_sources() -> Result<Vec<DesktopSourceInfo>>` — **sync**: it only reads xcap accessors.
  - `pub async fn source_for(id: &str, profile: StreamProfile) -> Result<Box<dyn FrameSource>>` — **async** because `ScreenSource::for_monitor` waits on the first-frame handshake (the Week 7 `ScreenSource::new` was already `async` for the same reason). A sync `source_for` could not build a monitor source without blocking the runtime. Handles the `monitor:`, `window:`, and `test:` schemes.
  - `pub fn default_source_id(test: bool, preference: &str) -> Result<String>` (the source streamed before any selection, resolved from `AGENT_DESKTOP_DEFAULT_SOURCE`; `test` → the synthetic id, `"primary"` → the primary monitor, any other value → an explicit id validated against the enumeration)
  - `ScreenSource::for_monitor(monitor: xcap::Monitor) -> Result<Self>` (async). **The Week 7 `ScreenSource::new` and `primary_recorder` are deleted** — see Step 6 for why keeping them fails `-D warnings`.
  - `WindowSource::new(window: xcap::Window) -> Result<Self>` (sync — window capture has no recorder and no first-frame handshake, so there is nothing to await) and `pub struct WindowSource` implementing `FrameSource`
  - `DesktopEncoder::new(profile: StreamProfile) -> Result<Self>`
  - `run_stream(source, track, ssrc, payload_type, profile: StreamProfile, stop)` (the `control` receiver is added in Task 4a)

> **The `ScreenContentRealTime` watch item (spec §3.7).** The ADR-23 spike used `CameraVideoRealTime` because `UsageType::ScreenContentRealTime` **forces scene-change detection on**, which emits an IDR *every frame* and would have masked the spike's blip detector. The agent's production encoder uses `ScreenContentRealTime` (spec §3.1, §6.1). So this task must **empirically re-check** whether the production config emits an IDR per frame — because ADR-24's 720p30 fallback assumes a resolution change forces *one* IDR, and if the encoder is already emitting IDRs continuously that assumption is void. Add the `screen_content_usage_emits_an_idr_only_on_the_first_frame` test in Step 9; if it fails, record the finding in the PR body and raise it to the PM *before* Task 4b (it changes the fallback's blip analysis, not its correctness). Do **not** silently switch the usage type — `ScreenContentRealTime` is the right choice for screen content.

- [ ] **Step 1: Add the `StreamProfile` and its parsing**

**Where it lives matters — it goes in `main.rs`, next to `DesktopSource`, not in `desktop.rs`.** `StreamProfile` is *pure data*: it names no `xcap` type and calls no capture API. `SessionConfig` (in `main.rs`, unconditional) holds a `desktop_profile: StreamProfile` field, and a struct field whose type is named only inside a `#[cfg]`-gated module is an **E0433 name-resolution error** on the target where that module is compiled out — `#[allow(dead_code)]` cannot fix it, because the *type* is not in scope at all. `mod desktop;` is `#[cfg(not(target_env = "musl"))]`, so a `StreamProfile` defined in `desktop.rs` would break `Build Agent / Linux/x64-musl` (the musl leg runs `cargo build --release` only, but E0433 is a build error, not a lint). `DesktopSource` already lives unconditionally in `main.rs` for exactly this reason; `StreamProfile` joins it. The musl artifact accepts and validates the profile like any other CLI value, then refuses the desktop offer — the same shape `DesktopSource` has today.

In `apps/agent/src/main.rs`, beside `enum DesktopSource`, replace the `MAX_WIDTH`/`MAX_HEIGHT` constants (deleted from `apps/agent/src/desktop.rs` lines 26-28) with the profile:

```rust
/// The resolved quality for one desktop session (ADR-21).
///
/// Resolved once at session start from the CLI/env, then read by the downscale
/// box, the ticker cadence, and the encoder config. `bitrate_bps` is the only
/// member adjustable after start (ADR-23).
///
/// Defined here, beside `DesktopSource`, rather than in `desktop.rs`: it is pure
/// data, and `SessionConfig` (which is unconditional) holds one. A type named
/// only inside the `#[cfg(not(target_env = "musl"))]` `desktop` module would be
/// E0433 on musl.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct StreamProfile {
    pub max_width: u32,
    pub max_height: u32,
    pub fps: f32,
    pub bitrate_bps: u32,
}

impl StreamProfile {
    /// Default: 1080p30 at 6 Mbps (ADR-24's conditional target).
    pub const DEFAULT_1080P30: Self = Self {
        max_width: 1920,
        max_height: 1080,
        fps: 30.0,
        bitrate_bps: 6_000_000,
    };
    /// The guaranteed floor: 720p30 at 4 Mbps (ADR-24).
    pub const SAFE_720P30: Self = Self {
        max_width: 1280,
        max_height: 720,
        fps: 30.0,
        bitrate_bps: 4_000_000,
    };

    /// The frame budget in seconds — `1 / fps`.
    pub fn frame_budget(&self) -> Duration {
        Duration::from_secs_f32(1.0 / self.fps)
    }
}

/// Parse `--desktop-profile` / `AGENT_DESKTOP_PROFILE`.
///
/// Only the two named profiles exist; anything else is an error rather than a
/// silent default, so a typo in a deployment fails loudly at startup.
impl std::str::FromStr for StreamProfile {
    type Err = anyhow::Error;

    fn from_str(value: &str) -> Result<Self> {
        match value {
            "1080p30" => Ok(Self::DEFAULT_1080P30),
            "720p30" => Ok(Self::SAFE_720P30),
            other => bail!("unknown desktop profile {other:?}; expected 1080p30 or 720p30"),
        }
    }
}
```

`main.rs` already has `use std::time::Duration;` and `use anyhow::{bail, Context, Result};`, so this compiles as-is.

In `apps/agent/src/desktop.rs`, delete `MAX_WIDTH`/`MAX_HEIGHT` and bring the type into scope so the pipeline can name it:

```rust
use crate::StreamProfile;
```

Update `downscale`'s doc (it no longer mentions `MAX_WIDTH`), and change `run_stream`'s body to use the profile (signature change is Step 4). The `FRAME_INTERVAL` const (line 481) is deleted; `Sample.duration` becomes `profile.frame_budget()`.

- [ ] **Step 2: Write the failing `StreamProfile` tests**

The type now lives in `main.rs`, so its tests live in `main.rs`'s `#[cfg(test)] mod tests` too (append after the existing tests). `main.rs`'s test module has `use super::*;`, so `StreamProfile` is already in scope:

```rust
    #[test]
    fn stream_profile_parses_the_two_named_profiles() {
        assert_eq!(
            "1080p30".parse::<StreamProfile>().unwrap(),
            StreamProfile::DEFAULT_1080P30
        );
        assert_eq!(
            "720p30".parse::<StreamProfile>().unwrap(),
            StreamProfile::SAFE_720P30
        );
    }

    #[test]
    fn stream_profile_rejects_an_unknown_name() {
        let err = "1080p60".parse::<StreamProfile>().unwrap_err();
        assert!(format!("{err:#}").contains("expected 1080p30 or 720p30"));
    }

    #[test]
    fn stream_profile_frame_budget_matches_fps() {
        let budget = StreamProfile::DEFAULT_1080P30.frame_budget();
        assert!((budget.as_secs_f32() - 1.0 / 30.0).abs() < 1e-6);
    }
```

`desktop.rs`'s tests reach `StreamProfile` through the `use crate::StreamProfile;` added in Step 1, so the downscale/encoder tests in later steps can keep naming it directly.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cargo test --manifest-path apps/agent/Cargo.toml stream_profile`
Expected: FAIL to compile. Two reasons, both intended at this point: `frame_budget` is not yet called by the pipeline (Step 4), and — because Step 1 deleted `MAX_WIDTH`/`MAX_HEIGHT` while `downscale`'s production call site and the three downscale tests still read them — the crate does not build until Step 4 repoints every reader. (Compile failure is the failing test here.)

- [ ] **Step 4: Implement `StreamProfile` in the pipeline**

Change `DesktopEncoder::new` to take the profile:

```rust
    pub fn new(profile: StreamProfile) -> Result<Self> {
        let config = EncoderConfig::new()
            .bitrate(BitRate::from_bps(profile.bitrate_bps))
            .max_frame_rate(FrameRate::from_hz(profile.fps))
            .usage_type(UsageType::ScreenContentRealTime)
            .adaptive_quantization(false)
            .background_detection(false)
            .rate_control_mode(RateControlMode::Bitrate)
            .complexity(Complexity::Low)
            .intra_frame_period(IntraFramePeriod::from_num_frames(60))
            .vui(VuiConfig::bt709());
        let encoder = Encoder::with_api_config(OpenH264API::from_source(), config)
            .context("creating the H.264 encoder")?;
        Ok(Self { encoder })
    }
```

Change `run_stream`'s signature and body (profile only; the control receiver lands in Task 4a):

```rust
pub async fn run_stream(
    mut source: Box<dyn FrameSource>,
    track: Arc<TrackLocalStaticSample>,
    ssrc: SSRC,
    payload_type: PayloadType,
    profile: StreamProfile,
    mut stop: watch::Receiver<bool>,
) -> Result<()> {
    if *stop.borrow() {
        source.stop();
        return Ok(());
    }

    let mut encoder = DesktopEncoder::new(profile)?;
    let mut ticker = tokio::time::interval(profile.frame_budget());
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    // …loop unchanged except:
    //   let frame = crop_to_even(downscale(&frame, profile.max_width, profile.max_height));
    //   duration: profile.frame_budget()
}
```

Update the two existing `run_stream` call sites in tests (`run_stream_stops_cleanly_without_a_bound_track`, `run_stream_honours_a_pre_set_stop_signal`) to pass `StreamProfile::SAFE_720P30`, and `encoder_emits_annex_b_and_an_idr_first` to call `DesktopEncoder::new(StreamProfile::SAFE_720P30)`.

**Do not stop there — Step 1 deleted `MAX_WIDTH`/`MAX_HEIGHT`, so every reader of them no longer compiles.** There are four: the production call in `run_stream`'s loop (desktop.rs:528 — Step 4 above already repoints it at `profile.max_width`/`profile.max_height`), plus three tests. `cargo test` (and therefore `Build Agent / Verify`, which runs the test target) fails with `cannot find value MAX_WIDTH in this scope` until all four are repointed. Rewrite each test's arguments to `StreamProfile::SAFE_720P30.max_width, StreamProfile::SAFE_720P30.max_height` (the same box the deleted consts held), keeping every assertion identical:

```rust
    #[test]
    fn downscale_fits_1080p_into_the_720p_box() {
        let frame = downscale(
            &solid(1920, 1080),
            StreamProfile::SAFE_720P30.max_width,
            StreamProfile::SAFE_720P30.max_height,
        );
        assert_eq!((frame.width, frame.height), (1280, 720));
        assert_eq!(frame.rgba.len(), (1280 * 720 * 4) as usize);
    }

    #[test]
    fn downscale_preserves_aspect_for_an_ultrawide() {
        let frame = downscale(
            &solid(2560, 1080),
            StreamProfile::SAFE_720P30.max_width,
            StreamProfile::SAFE_720P30.max_height,
        );
        assert_eq!((frame.width, frame.height), (1280, 540));
        assert_eq!(frame.width % 2, 0);
        assert_eq!(frame.height % 2, 0);
    }

    #[test]
    fn downscale_never_upscales_a_small_screen() {
        let source = solid(800, 600);
        let frame = downscale(
            &source,
            StreamProfile::SAFE_720P30.max_width,
            StreamProfile::SAFE_720P30.max_height,
        );
        assert_eq!((frame.width, frame.height), (800, 600));
        assert_eq!(frame.rgba, source.rgba);
    }
```

These three stay *in addition to* Step 5's `downscale_uses_the_profile_box`: that new test only checks 1080p passthrough and the 720p box, so it does **not** cover the ultrawide aspect or the no-upscale case. Deleting them instead of repointing them would silently drop that coverage. `grep -rn 'MAX_WIDTH\|MAX_HEIGHT' apps/agent/src` must print nothing after this step.

- [ ] **Step 5: Write the failing enumeration + `source_for` + `WindowSource` tests**

```rust
    /// An id with an unknown scheme is refused without touching the display, so
    /// this runs in headless CI (unlike the enumeration-miss case below).
    #[tokio::test]
    async fn source_for_rejects_an_unknown_scheme() {
        let err = source_for("bogus:1", StreamProfile::SAFE_720P30)
            .await
            .unwrap_err();
        assert!(format!("{err:#}").contains("unknown source"));
    }

    /// A well-formed id that names no live monitor is refused too. Enumeration
    /// runs first, so this needs a live display; run manually on the dev machine.
    #[tokio::test]
    #[ignore = "needs a live display; run manually on the dev machine"]
    async fn source_for_rejects_an_id_absent_from_the_enumeration() {
        let err = source_for("monitor:999999", StreamProfile::SAFE_720P30)
            .await
            .unwrap_err();
        assert!(format!("{err:#}").contains("unknown source"));
    }

    #[test]
    fn downscale_uses_the_profile_box() {
        // 1080p passthrough under the 1080p30 profile; boxed under 720p30.
        let frame = downscale(&solid(1920, 1080), 1920, 1080);
        assert_eq!((frame.width, frame.height), (1920, 1080));
        let boxed = downscale(&solid(1920, 1080), 1280, 720);
        assert_eq!((boxed.width, boxed.height), (1280, 720));
    }

    /// `enumerate_sources` needs a live display; run manually on the dev machine.
    #[test]
    #[ignore = "needs a live display; run manually on the dev machine"]
    fn enumerate_sources_lists_at_least_one_monitor() {
        let sources = enumerate_sources().expect("a live display");
        assert!(sources.iter().any(|s| s.kind == SourceKind::Monitor));
        // `id` is stable across two calls (spec §6.5).
        let again = enumerate_sources().expect("a live display");
        let ids: Vec<_> = sources.iter().map(|s| s.id.clone()).collect();
        let ids_again: Vec<_> = again.iter().map(|s| s.id.clone()).collect();
        assert_eq!(ids, ids_again);
    }

    /// `WindowSource` is a `FrameSource` with real teardown, so it needs the same
    /// headless seam `ScreenSource` has (`from_parts_for_test`, line 390): the
    /// capture thread is the only platform-specific part, and the channel
    /// plumbing on either side of it is what this test pins — a queued frame is
    /// returned once, the queue then drains, and `stop` takes the sender so a
    /// subsequent call is a clean `None` (never a panic on a dead thread).
    #[test]
    fn window_source_forwards_frames_and_stops_cleanly() {
        let (request_tx, request_rx) = std::sync::mpsc::channel::<()>();
        let (frame_tx, frame_rx) = std::sync::mpsc::channel::<xcap::Frame>();
        // Pre-queue the frame the capture thread would produce, so `next_frame`'s
        // drain is deterministic: the real thread pushes asynchronously, but the
        // request/reply plumbing is the part this test pins.
        frame_tx.send(xcap::Frame::new(4, 4, vec![7u8; 64])).unwrap();
        // A stub responder standing in for the capture thread: it drains requests
        // and ends when `stop` drops the request sender.
        let responder = std::thread::spawn(move || {
            while request_rx.recv().is_ok() {}
        });
        let mut source = WindowSource::from_parts_for_test(request_tx, frame_rx, responder);

        let frame = source.next_frame().unwrap().expect("one queued frame");
        assert_eq!((frame.width, frame.height), (4, 4));
        assert_eq!(frame.rgba.len(), 64);
        assert!(source.next_frame().unwrap().is_none(), "queue drained");

        // `stop` drops the request sender, so the responder's `recv` returns Err
        // and the thread ends; the join in `stop` must complete rather than hang.
        source.stop();
        assert!(source.next_frame().unwrap().is_none(), "stopped source yields nothing");
    }
```

- [ ] **Step 6: Implement enumeration, `source_for`, and `WindowSource`**

```rust
/// A capture source's kind. Serialises as the wire string (§5.1).
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SourceKind {
    Monitor,
    Window,
}

/// One capture source the agent can stream (spec §5.1).
#[derive(Clone, Debug, serde::Serialize)]
pub struct DesktopSourceInfo {
    pub id: String,
    pub kind: SourceKind,
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub x: i32,
    pub y: i32,
    #[serde(rename = "scaleFactor")]
    pub scale_factor: f32,
    pub rotation: f32,
    #[serde(rename = "isPrimary")]
    pub is_primary: bool,
    pub default: bool,
}

/// Enumerate every monitor and window the agent could stream (spec §6.2).
///
/// A source whose accessor fails is skipped rather than failing the whole
/// enumeration: one window that vanished between listing and reading its
/// geometry must not cost the picker every other entry.
pub fn enumerate_sources() -> Result<Vec<DesktopSourceInfo>> {
    let mut sources = Vec::new();
    for monitor in xcap::Monitor::all().context("listing monitors")? {
        let Ok(id) = monitor.id() else { continue };
        sources.push(DesktopSourceInfo {
            id: format!("monitor:{id}"),
            kind: SourceKind::Monitor,
            name: monitor
                .friendly_name()
                .or_else(|_| monitor.name())
                .unwrap_or_else(|_| format!("Monitor {id}")),
            width: monitor.width().unwrap_or(0),
            height: monitor.height().unwrap_or(0),
            x: monitor.x().unwrap_or(0),
            y: monitor.y().unwrap_or(0),
            scale_factor: monitor.scale_factor().unwrap_or(1.0),
            rotation: monitor.rotation().unwrap_or(0.0),
            is_primary: monitor.is_primary().unwrap_or(false),
            default: false,
        });
    }
    for window in xcap::Window::all().context("listing windows")? {
        let Ok(id) = window.id() else { continue };
        if window.is_minimized().unwrap_or(false) {
            continue;
        }
        sources.push(DesktopSourceInfo {
            id: format!("window:{id}"),
            kind: SourceKind::Window,
            name: window.title().unwrap_or_else(|_| format!("Window {id}")),
            width: window.width().unwrap_or(0),
            height: window.height().unwrap_or(0),
            x: window.x().unwrap_or(0),
            y: window.y().unwrap_or(0),
            scale_factor: 1.0,
            rotation: 0.0,
            is_primary: false,
            default: false,
        });
    }
    Ok(sources)
}

/// Build the `FrameSource` for an enumerated id (spec §6.2).
///
/// Async because the monitor arm awaits `ScreenSource::for_monitor`'s
/// first-frame handshake — a monitor source that is not actually delivering is
/// an error the caller can refuse on, not a black stream (the Week 7 invariant).
/// The id is validated by *lookup against the enumeration*, never parsed into a
/// platform handle directly: an unknown id is an error, so a hostile
/// `desktop-select` can never name a source the agent did not offer (§9).
pub async fn source_for(id: &str, _profile: StreamProfile) -> Result<Box<dyn FrameSource>> {
    let (kind, raw) = id
        .split_once(':')
        .ok_or_else(|| anyhow::anyhow!("unknown source id {id:?}"))?;
    match kind {
        "monitor" => {
            let wanted: u32 = raw
                .parse()
                .map_err(|_| anyhow::anyhow!("unknown source id {id:?}"))?;
            let monitor = xcap::Monitor::all()
                .context("listing monitors")?
                .into_iter()
                .find(|m| m.id().map(|mid| mid == wanted).unwrap_or(false))
                .ok_or_else(|| anyhow::anyhow!("unknown source id {id:?}"))?;
            Ok(Box::new(ScreenSource::for_monitor(monitor).await?))
        }
        "window" => {
            let wanted: u32 = raw
                .parse()
                .map_err(|_| anyhow::anyhow!("unknown source id {id:?}"))?;
            let window = xcap::Window::all()
                .context("listing windows")?
                .into_iter()
                .find(|w| w.id().map(|wid| wid == wanted).unwrap_or(false))
                .ok_or_else(|| anyhow::anyhow!("unknown source id {id:?}"))?;
            Ok(Box::new(WindowSource::new(window)?))
        }
        // The synthetic pattern (spec §2.3): the only source that exists under
        // `--desktop-source test`, and the id `default_source_id` returns there.
        // It is built here, not in a caller-side match, so the pre-answer
        // source, a swap, and the E2E path all go through one factory.
        "test" => Ok(Box::new(TestPatternSource::new(1280, 720))),
        _ => bail!("unknown source id {id:?}"),
    }
}
```

Generalise `ScreenSource`: **delete `new()`** and add `for_monitor`.

Deleting `new()` is not cosmetic — it is required for `Build Agent / Verify` to stay green. Step 7 routes the pre-answer source through `source_for`, so a surviving `new()` would be reached only from `#[cfg(test)]` code. `cargo build --release` and the bin half of `cargo clippy --all-targets` compile without `cfg(test)`, so `new()` would be dead code there and `-D warnings` turns that into an error (verified with a standalone probe). `primary_recorder()` has the same fate — `for_monitor` calls `monitor.video_recorder()` directly and `primary_monitor()` now owns the monitor selection — so delete it too. Nothing is lost: `default_source_id("primary")` + `source_for` *is* the primary-monitor path, and the Week 7 smoke test is repointed at it (Step 8).

```rust
impl ScreenSource {
    /// Starts capture of a specific monitor (ADR-22 source selection).
    ///
    /// The recorder is created inside the same capture thread as Week 7 — the
    /// monitor is moved in, so no non-`Send` capture object crosses the thread
    /// boundary (spec §6.2, and the Week 7 `is_send` probes).
    pub async fn for_monitor(monitor: xcap::Monitor) -> Result<Self> {
        let (ready_tx, ready_rx) = oneshot::channel::<std::result::Result<(), String>>();
        let (stop_tx, stop_rx) = std::sync::mpsc::channel::<()>();
        let (frame_tx, frame_rx) = std::sync::mpsc::channel::<xcap::Frame>();

        let thread = std::thread::Builder::new()
            .name("desktop-capture".into())
            .spawn(move || {
                let recorder = match monitor.video_recorder() {
                    Ok(recorder) => recorder,
                    Err(e) => {
                        let _ = ready_tx.send(Err(e.to_string()));
                        return;
                    }
                };
                let (recorder, frames) = recorder;
                run_capture(recorder, frames, ready_tx, frame_tx, stop_rx, FIRST_FRAME_TIMEOUT);
            })
            .context("spawning the desktop capture thread")?;
        // …the same ready_rx match as Week 7's `new`…
    }
}

/// The monitor at the origin, else the explicitly primary one, else any
/// (Week 7's `primary_recorder` preference order, split out so both the default
/// source and `source_for` pick the same monitor).
fn primary_monitor() -> Result<xcap::Monitor> {
    if let Ok(monitor) = xcap::Monitor::from_point(0, 0) {
        return Ok(monitor);
    }
    let monitors = xcap::Monitor::all().context("listing monitors")?;
    monitors
        .iter()
        .find(|m| m.is_primary().unwrap_or(false))
        .or_else(|| monitors.first())
        .cloned()
        .ok_or_else(|| anyhow::anyhow!("no monitors found"))
}

/// The id of the source streamed before any selection (ADR-22).
///
/// Under `--desktop-source test` the default is the synthetic pattern; on a
/// real host it is the source `preference` names (spec §6.1's
/// `DESKTOP_DEFAULT_SOURCE`), so the enumeration's `default: true` entry and the
/// live stream always agree.
///
/// `preference` is `"primary"` (the shipped default) or an explicit source id.
/// An explicit id is validated against the live enumeration, so a typo is a
/// startup error rather than a black stream; `"primary"` resolves through the
/// same `primary_recorder` logic Week 7 used (`primary_monitor`).
pub fn default_source_id(test: bool, preference: &str) -> Result<String> {
    if test {
        return Ok("test:0".to_string());
    }
    if preference == "primary" {
        let monitor = primary_monitor()?;
        let id = monitor.id().context("reading the primary monitor id")?;
        return Ok(format!("monitor:{id}"));
    }
    // An explicit id must name a source the agent can actually stream.
    let known = enumerate_sources()?;
    if known.iter().any(|source| source.id == preference) {
        Ok(preference.to_string())
    } else {
        bail!(
            "AGENT_DESKTOP_DEFAULT_SOURCE={preference:?} is not an enumerated source; \
             use \"primary\" or one of: {}",
            known
                .iter()
                .map(|source| source.id.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        )
    }
}
```

`WindowSource` — capture a window's pixels on the tick. `xcap::Window` is not `Send` on every platform, so it lives on its own thread exactly like `ScreenSource`, but window capture has no recorder: the thread calls `capture_image()` on demand and pushes the newest frame:

```rust
/// A window's pixels, captured on demand (spec §6.2).
///
/// Window capture may include occluding windows depending on the platform
/// backend; the picker labels window entries accordingly (spec §6.2). Unlike
/// `ScreenSource` there is no recorder: the thread captures a fresh image per
/// request, so the drop-oldest policy is "keep the latest request".
pub struct WindowSource {
    // The window lives on a dedicated thread (it is not `Send` on every
    // platform — the same reason `ScreenSource` has one). A request channel
    // asks for a frame; a reply channel carries it back.
    request: Option<std::sync::mpsc::Sender<()>>,
    frames: Option<Receiver<xcap::Frame>>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl WindowSource {
    /// Starts a window-capture thread (spec §6.2).
    ///
    /// Sync, unlike `ScreenSource::for_monitor`: a window has no recorder to
    /// open and no first-frame handshake, so "started" is just "the thread is
    /// running". A window that fails to capture logs per tick and simply yields
    /// no frame — the caller keeps streaming the previous one (ADR-22).
    pub fn new(window: xcap::Window) -> Result<Self> {
        let (request_tx, request_rx) = std::sync::mpsc::channel::<()>();
        let (frame_tx, frame_rx) = std::sync::mpsc::channel::<xcap::Frame>();

        let thread = std::thread::Builder::new()
            .name("window-capture".into())
            .spawn(move || {
                // …the request/capture loop below…
            })
            .context("spawning the window capture thread")?;

        Ok(Self {
            request: Some(request_tx),
            frames: Some(frame_rx),
            thread: Some(thread),
        })
    }

    /// Test seam: wires an already-built request sender, frame channel, and
    /// responder thread, so `next_frame`/`stop` can be exercised without a
    /// window. Mirrors `ScreenSource::from_parts_for_test` (line 390) — the
    /// capture thread is the only platform-specific part of the type.
    #[cfg(test)]
    fn from_parts_for_test(
        request: std::sync::mpsc::Sender<()>,
        frames: Receiver<xcap::Frame>,
        thread: std::thread::JoinHandle<()>,
    ) -> Self {
        Self {
            request: Some(request),
            frames: Some(frames),
            thread: Some(thread),
        }
    }
}

impl FrameSource for WindowSource {
    fn next_frame(&mut self) -> Result<Option<RawFrame>> {
        let (Some(request), Some(frames)) = (self.request.as_ref(), self.frames.as_ref()) else {
            return Ok(None);
        };
        // Ask for one capture, then take the newest frame it produced: a tick
        // that ran late may have queued more than one, and the stream only ever
        // wants the latest (drop-oldest, mirroring `drain_latest`).
        if request.send(()).is_err() {
            return Ok(None);
        }
        Ok(drain_latest(frames).map(|frame| RawFrame {
            width: frame.width,
            height: frame.height,
            rgba: frame.raw,
        }))
    }

    fn stop(&mut self) {
        // Dropping the request sender makes `request_rx.recv()` return `Err`,
        // which breaks the thread loop; the join is bounded by the in-flight
        // capture finishing (exactly as `ScreenSource::stop`).
        self.request.take();
        self.frames.take();
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}
```

The thread loop (inside `WindowSource::new`'s closure above):

```rust
            loop {
                if request_rx.recv().is_err() {
                    break; // WindowSource dropped
                }
                match window.capture_image() {
                    Ok(image) => {
                        let frame = xcap::Frame::new(image.width(), image.height(), image.into_raw());
                        if frame_tx.send(frame).is_err() {
                            break;
                        }
                    }
                    Err(e) => tracing::debug!(error = %e, "window capture failed; skipping this tick"),
                }
            }
```

- [ ] **Step 7: Add the CLI flag and thread the profile through `main.rs`**

In `Cli` (after `desktop_source`):

```rust
    /// Desktop quality profile. `1080p30` is the default; `720p30` is the safe
    /// floor for a host that cannot sustain 1080p30 (ADR-24).
    #[arg(long, env = "AGENT_DESKTOP_PROFILE", default_value = "1080p30")]
    desktop_profile: String,

    /// Which source streams before any selection (spec §6.1). `primary` (the
    /// default) means the primary monitor; any other value is an explicit
    /// source id validated against the enumeration at startup.
    #[arg(
        long,
        env = "AGENT_DESKTOP_DEFAULT_SOURCE",
        default_value = "primary"
    )]
    desktop_default_source: String,
```

In `SessionConfig`, add two fields, both `#[allow(dead_code)]`-annotated for the musl build (they are read only by `run_desktop_session`, which is compiled out there — the same reason `desktop_source` carries the attribute today):

```rust
    /// Unused on musl, where the desktop module is compiled out; kept so the
    /// CLI shape is identical on every target.
    #[allow(dead_code)]
    desktop_profile: StreamProfile,
    /// Unused on musl for the same reason as `desktop_profile`.
    #[allow(dead_code)]
    desktop_default_source: String,
```

Resolve the profile in `run_with_reconnect` (so an invalid value fails at startup, before any connection):

```rust
    let desktop_profile: StreamProfile = cli
        .desktop_profile
        .parse()
        .context("--desktop-profile / AGENT_DESKTOP_PROFILE")?;
```

and carry the default-source preference straight through:

```rust
    desktop_default_source: cli.desktop_default_source,
```

> **Why this compiles on every target.** `StreamProfile` is defined in `main.rs` (Step 1), *unconditionally* — so `SessionConfig`'s field resolves on musl too, and the `.parse()` call is real code that runs there. Only the *field's reader* (`run_desktop_session`) is musl-gated, which is why the field needs `#[allow(dead_code)]`. Do **not** try to define `StreamProfile` in `desktop.rs`: a field whose type is named only inside the musl-gated module is an E0433 name-resolution error on musl, and `#[allow(dead_code)]` cannot repair a type that is not in scope.
>
> **Warnings you may see on musl only — they are not failures.** `StreamProfile`'s members are read almost entirely from `desktop.rs` (the downscale box, the ticker, `frame_budget`, the encoder config). On musl the `desktop` module is compiled out, so the musl build may report `frame_budget` (and possibly some fields) as never used. That is a *warning*, not an error: the musl leg runs `cargo build --release --locked --target …` with no `-D warnings` (see `build-agent.yml`), while `cargo clippy --all-targets --locked -- -D warnings` runs on the host target where every member *is* used. Leave the members as plain `pub` items — do not add cfg gates or `#[allow]`s, which would be dead weight on the target that matters.

In `run_desktop_session`, resolve the default source id, then build the source — **both** failures go through the same clean-refusal path. `default_source_id` can fail on a bad `AGENT_DESKTOP_DEFAULT_SOURCE` or an unreadable primary monitor, and that is a pre-answer refusal exactly like a capture failure: routing it through `?` would propagate out of `run_one_session` and skip the `approved: false` answer, leaving the browser on a hang instead of a refusal. So match it, and fall through to the same `refuse_offer` arm as `source_for`:

```rust
    // A bad default-source preference (or an unreadable primary monitor) is a
    // refusal, not a propagated error: the client must see `approved: false`,
    // the same as a capture failure, not a dropped signaling connection.
    let default_id = match desktop::default_source_id(
        cfg.desktop_source == DesktopSource::Test,
        &cfg.desktop_default_source,
    ) {
        Ok(id) => id,
        Err(e) => {
            tracing::warn!(error = ?e, "desktop default source unavailable; refusing the offer");
            rtc::refuse_offer(peer, offer, outbound).await?;
            let _ = peer.close().await;
            return Ok(());
        }
    };
    let source: Box<dyn desktop::FrameSource> = match desktop::source_for(&default_id, cfg.desktop_profile).await {
        Ok(source) => source,
        Err(e) => {
            tracing::warn!(error = ?e, "desktop capture unavailable; refusing the offer");
            rtc::refuse_offer(peer, offer, outbound).await?;
            let _ = peer.close().await;
            return Ok(());
        }
    };
    // …unchanged attach/answer/connect…
    let mut stream = tokio::spawn(desktop::run_stream(
        source,
        media.track.clone(),
        ssrc,
        payload_type,
        cfg.desktop_profile,
        stop_rx,
    ));
```

> `source_for` covers the test case too: `default_source_id` returns `"test:0"` under `--desktop-source test`, and Task 3's `source_for` must therefore handle the `test:` scheme by returning `TestPatternSource` (add the arm beside `monitor`/`window`). That keeps the "one factory" rule — the pre-answer source, a swap, and the E2E path all build sources the same way.

- [ ] **Step 8: Repoint the Week 7 smoke test, then run tests, fmt, and clippy**

`ScreenSource::new` is gone (Step 6), so the Week 7 `screen_source_smoke_on_a_live_display` test must build its source the new way. Replace its body's first line:

```rust
    #[tokio::test]
    #[ignore = "needs a live display; run manually on the dev machine"]
    async fn screen_source_smoke_on_a_live_display() {
        // The primary monitor via the new factory — the same path `main.rs`
        // takes, so this stays a real end-to-end regression for the Wayland
        // black-screen bug.
        let id = default_source_id(false, "primary").expect("a primary monitor");
        let mut source = source_for(&id, StreamProfile::SAFE_720P30)
            .await
            .expect("live display");
        let frame = source
            .next_frame()
            .unwrap()
            .expect("a live display must deliver at least one frame");
        assert_eq!(frame.rgba.len(), (frame.width * frame.height * 4) as usize);
        assert!(
            frame.width > 0 && frame.height > 0,
            "the delivered frame must have real dimensions"
        );
        source.stop();
    }
```

Run:
```bash
cargo test --manifest-path apps/agent/Cargo.toml --locked
cargo fmt --manifest-path apps/agent/Cargo.toml --check
cargo clippy --manifest-path apps/agent/Cargo.toml --all-targets --locked -- -D warnings
```
Expected: PASS. `enumerate_sources_lists_at_least_one_monitor`, `source_for_rejects_an_id_absent_from_the_enumeration`, and the Week 7 `screen_source_smoke_on_a_live_display` are `#[ignore]`d and do not run in CI. The new `window_source_forwards_frames_and_stops_cleanly` runs in CI (it uses the `from_parts_for_test` seam, no window needed) — it must be green, and it is what proves `WindowSource::stop` joins its thread rather than hanging. The clippy line is the one that would have caught the dead `ScreenSource::new`/`primary_recorder` — it must be clean.

- [ ] **Step 9: Add and run the `ScreenContentRealTime` watch-item test**

Add this test (it runs in CI — no display needed, the encoder is driven directly):

```rust
    /// Watch item from the ADR-23 spike (spec §3.7): the spike used
    /// `CameraVideoRealTime` because `ScreenContentRealTime` forces scene-change
    /// detection on, which the spike author expected to emit an IDR every frame.
    /// The production encoder uses `ScreenContentRealTime`, so this pins what it
    /// actually does — the ADR-24 fallback's one-IDR assumption depends on it.
    #[test]
    fn screen_content_usage_emits_an_idr_only_on_the_first_frame() {
        let mut encoder =
            DesktopEncoder::new(StreamProfile::SAFE_720P30).expect("encoder");
        // A moving frame each round, so a scene-change detector has something to
        // fire on. Count IDRs (NAL type 5) across rounds 1..=5.
        let mut idrs_after_first = 0;
        for round in 0..6 {
            let frame = solid(320, 240 + round); // odd height: encode() asserts even, so crop
            let frame = crop_to_even(frame);
            let data = encoder.encode(&frame).expect("encode");
            if round == 0 {
                continue; // the first access unit is allowed to be an IDR
            }
            let mut i = 0;
            while i + 5 <= data.len() {
                if data[i..i + 4] == [0, 0, 0, 1] && (data[i + 4] & 0x1F) == 5 {
                    idrs_after_first += 1;
                }
                i += 1;
            }
        }
        // If this fails, `ScreenContentRealTime` DOES emit an IDR per frame:
        // record it in the PR body and raise it to the PM before Task 4b, because
        // it invalidates ADR-24's "one IDR on a resolution change" analysis.
        assert_eq!(
            idrs_after_first, 0,
            "ScreenContentRealTime emitted {idrs_after_first} IDR(s) after frame 0"
        );
    }
```

Run: `cargo test --manifest-path apps/agent/Cargo.toml screen_content_usage`
Expected: PASS (0 IDRs after frame 0). If it FAILS, do not change the assertion — record the count and raise it to the PM as the watch item describes.

- [ ] **Step 10: Commit**

```bash
git add apps/agent/src/desktop.rs apps/agent/src/main.rs apps/agent/Cargo.toml apps/agent/Cargo.lock
git commit -m "feat(agent): resolve StreamProfile, enumerate capture sources, add WindowSource"
```

---

### Task 4a: Agent — the control channel and its dispatcher (D3b)

**Files:**
- Modify: `apps/agent/src/desktop.rs` (`StreamControl`, `decode_control`, `clamp_bitrate`, `MIN_BITRATE_BPS`/`MAX_BITRATE_BPS`, `test_source_info`, `frame_desktop_sources`, `run_stream` gains the control receiver)
- Modify: `apps/agent/src/rtc.rs` (`CONTROL_LABEL`, `SessionHandler::new` takes the accepted label, `build_peer`'s `media_only` split)
- Modify: `apps/agent/src/main.rs` (pass the accepted label; spawn the desktop control dispatcher; pass `open_rx` into `run_desktop_session`)
- Test: `apps/agent/src/desktop.rs` (`#[cfg(test)] mod tests`)

**Interfaces:**
- Consumes: Task 3's `StreamProfile`, `enumerate_sources`, `DesktopSourceInfo`, `SourceKind`, `primary_monitor`, `ScreenSource`; `crate::pty::DataChannelMessage<T>`; `webrtc::data_channel::{DataChannel, DataChannelEvent}`.
- Produces (relied on by Tasks 4b/4c/4d/4e):
  - `pub const MIN_BITRATE_BPS: u32 = 250_000;` / `pub const MAX_BITRATE_BPS: u32 = 20_000_000;`
  - `pub enum StreamControl { SetBitrate(u32), SourceSwap(String) }` (`#[derive(Debug, Clone, PartialEq, Eq)]`)
  - `pub fn decode_control(raw: &str) -> Result<Option<StreamControl>>`
  - `pub fn clamp_bitrate(bps: u32) -> u32`
  - `pub fn test_source_info() -> DesktopSourceInfo`
  - `pub fn frame_desktop_sources(sources: &[DesktopSourceInfo], timestamp_ms: i64) -> String`
  - `run_stream(source, track, ssrc, payload_type, profile, control: mpsc::Receiver<StreamControl>, stop)`
  - `rtc::CONTROL_LABEL: &str = "control"`
  - `rtc::build_peer(pushed, stun_url, handler, media_only: bool, has_control: bool)`

> **Why the label moves into `SessionHandler`.** Today `on_data_channel` (`rtc.rs:492-518`) hardcodes `TERMINAL_LABEL` and closes everything else. A desktop session now expects `'control'`, so the handler must be told which single label it accepts rather than assuming terminal. The `Arc<OnceLock<…>>` + `open_tx` publish path is reused verbatim — one channel per session, a second refused (spec §6.3, §9).
>
> **Why `build_peer` splits its flag.** Week 7 built the desktop peer with `media_only = true` to shorten ICE timeouts (desktop had no data channel, so ICE silence was the only close signal). A desktop peer now *has* a channel, whose close is a prompt close signal, so it must keep the RFC-shaped defaults. The shortened timeouts now apply only to a peer with **no** data channel at all (spec §6.3).

- [ ] **Step 1: Add `StreamControl` and the decoder to `desktop.rs`**

Below the `DesktopEncoder` impl in `apps/agent/src/desktop.rs` (`StreamProfile` itself lives in `main.rs` — see Task 3, Step 1):

```rust
/// The bitrate range a `desktop-bitrate` frame is clamped into (spec §9).
///
/// A hostile or buggy value must not drive the encoder to a degenerate config
/// (0 bps stalls the stream; a multi-gigabit target makes openh264 refuse the
/// retarget). The clamp happens at the wire boundary, in `decode_control`.
pub const MIN_BITRATE_BPS: u32 = 250_000;
pub const MAX_BITRATE_BPS: u32 = 20_000_000;

/// A command the control dispatcher forwards into `run_stream` (spec §6.3).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StreamControl {
    /// Manual bitrate target, already clamped to `MIN..=MAX_BITRATE_BPS`.
    SetBitrate(u32),
    /// Switch to another enumerated source (ADR-22). The id is validated
    /// against the enumeration inside `run_stream`'s swap path, never here.
    SourceSwap(String),
}

/// Clamp a requested bitrate into the sane range (spec §9).
pub fn clamp_bitrate(bps: u32) -> u32 {
    bps.clamp(MIN_BITRATE_BPS, MAX_BITRATE_BPS)
}

/// The `desktop-bitrate` payload (spec §2.2).
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopBitrateMessage {
    bitrate_bps: u32,
}

/// The `desktop-select` payload (spec §2.2).
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopSelectMessage {
    source_id: String,
}

/// Decode one inbound control frame into a `StreamControl`.
///
/// Returns `Ok(None)` for a frame on another channel (ADR-09: the agent ignores
/// any other channel) and for an unknown `type` (forward-compatible, spec §2.2);
/// returns `Err` only for a frame that claims to be `control` but is malformed.
/// Mirrors `pty::decode_pty_input`'s shape.
pub fn decode_control(raw: &str) -> Result<Option<StreamControl>> {
    let envelope: crate::pty::DataChannelMessage<serde_json::Value> =
        serde_json::from_str(raw).context("inbound frame is not a DataChannelMessage")?;

    if envelope.channel != "control" {
        return Ok(None);
    }

    match envelope.r#type.as_str() {
        "desktop-select" => {
            let message: DesktopSelectMessage = serde_json::from_value(envelope.payload)
                .context("payload is not a DesktopSelectMessage")?;
            Ok(Some(StreamControl::SourceSwap(message.source_id)))
        }
        "desktop-bitrate" => {
            let message: DesktopBitrateMessage = serde_json::from_value(envelope.payload)
                .context("payload is not a DesktopBitrateMessage")?;
            Ok(Some(StreamControl::SetBitrate(clamp_bitrate(
                message.bitrate_bps,
            ))))
        }
        // An unknown control type is dropped, never answered (spec §2.2).
        _ => Ok(None),
    }
}
```

- [ ] **Step 2: Add `test_source_info` and the `desktop-sources` frame**

Still in `desktop.rs` (`default_source_id` already landed in Task 3, Step 6 — it needs `primary_monitor`/`enumerate_sources`):

```rust
/// The single synthetic entry `--desktop-source test` enumerates (spec §2.3).
///
/// CI is headless, so the test path must not touch `xcap` enumeration at all:
/// it reports exactly one source, flagged `default: true`, so the browser
/// auto-selects it and E2E never blocks on a picker.
pub fn test_source_info() -> DesktopSourceInfo {
    DesktopSourceInfo {
        id: "test:0".to_string(),
        kind: SourceKind::Monitor,
        name: "Test pattern".to_string(),
        width: 1280,
        height: 720,
        x: 0,
        y: 0,
        scale_factor: 1.0,
        rotation: 0.0,
        is_primary: true,
        default: true,
    }
}

/// Frame the enumeration as a `desktop-sources` control message (spec §2.2).
///
/// Pure so the wire shape is unit-testable without a peer connection.
pub fn frame_desktop_sources(sources: &[DesktopSourceInfo], timestamp_ms: i64) -> String {
    let message = crate::pty::DataChannelMessage {
        r#type: "desktop-sources".to_string(),
        channel: "control".to_string(),
        payload: serde_json::json!({ "sources": sources }),
        timestamp: timestamp_ms,
    };
    serde_json::to_string(&message).expect("a frame of plain data cannot fail to serialize")
}
```

`enumerate_sources` stays as Task 3 wrote it (every entry `default: false`); the caller flags the streaming entry, because only the caller knows which source it actually opened.

- [ ] **Step 3: Write the failing decode + frame tests**

Append to `mod tests`:

```rust
    #[test]
    fn decode_control_reads_a_desktop_select() {
        let raw = serde_json::json!({
            "type": "desktop-select",
            "channel": "control",
            "payload": { "sourceId": "window:0x4a00007" },
            "timestamp": 1,
        })
        .to_string();
        assert_eq!(
            decode_control(&raw).unwrap(),
            Some(StreamControl::SourceSwap("window:0x4a00007".to_string()))
        );
    }

    #[test]
    fn decode_control_reads_and_clamps_a_desktop_bitrate() {
        let frame = |bps: u32| {
            serde_json::json!({
                "type": "desktop-bitrate",
                "channel": "control",
                "payload": { "bitrateBps": bps },
                "timestamp": 1,
            })
            .to_string()
        };
        assert_eq!(
            decode_control(&frame(3_000_000)).unwrap(),
            Some(StreamControl::SetBitrate(3_000_000))
        );
        assert_eq!(
            decode_control(&frame(1)).unwrap(),
            Some(StreamControl::SetBitrate(MIN_BITRATE_BPS))
        );
        assert_eq!(
            decode_control(&frame(u32::MAX)).unwrap(),
            Some(StreamControl::SetBitrate(MAX_BITRATE_BPS))
        );
    }

    #[test]
    fn decode_control_ignores_another_channel_and_an_unknown_type() {
        let wrong_channel = serde_json::json!({
            "type": "desktop-select",
            "channel": "terminal",
            "payload": { "sourceId": "monitor:1" },
            "timestamp": 1,
        })
        .to_string();
        assert_eq!(decode_control(&wrong_channel).unwrap(), None);

        let unknown = serde_json::json!({
            "type": "desktop-future",
            "channel": "control",
            "payload": {},
            "timestamp": 1,
        })
        .to_string();
        assert_eq!(decode_control(&unknown).unwrap(), None);
    }

    #[test]
    fn decode_control_rejects_a_malformed_select_payload() {
        let raw = serde_json::json!({
            "type": "desktop-select",
            "channel": "control",
            "payload": { "sourceId": 42 },
            "timestamp": 1,
        })
        .to_string();
        assert!(decode_control(&raw).is_err());
    }

    #[test]
    fn frame_desktop_sources_carries_the_envelope_and_the_default_flag() {
        let raw = frame_desktop_sources(&[test_source_info()], 7);
        let value: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(value["type"], "desktop-sources");
        assert_eq!(value["channel"], "control");
        assert_eq!(value["timestamp"], 7);
        assert_eq!(value["payload"]["sources"][0]["id"], "test:0");
        assert_eq!(value["payload"]["sources"][0]["default"], true);
        // The camelCase wire spelling, not the Rust field name.
        assert!(value["payload"]["sources"][0].get("scaleFactor").is_some());
        assert!(value["payload"]["sources"][0].get("scale_factor").is_none());
    }
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `cargo test --manifest-path apps/agent/Cargo.toml decode_control`
Expected: FAIL to compile — `decode_control`, `StreamControl`, `frame_desktop_sources`, `test_source_info`, `MIN_BITRATE_BPS` do not exist yet.

- [ ] **Step 5: Give `run_stream` the control receiver**

Change `run_stream`'s signature and add the arm. The arms are inert in this task — Task 4b fills `SetBitrate`, Task 4c fills `SourceSwap` — but the plumbing is complete and compiles:

```rust
pub async fn run_stream(
    mut source: Box<dyn FrameSource>,
    track: Arc<TrackLocalStaticSample>,
    ssrc: SSRC,
    payload_type: PayloadType,
    profile: StreamProfile,
    mut control: tokio::sync::mpsc::Receiver<StreamControl>,
    mut stop: watch::Receiver<bool>,
) -> Result<()> {
    if *stop.borrow() {
        source.stop();
        return Ok(());
    }

    let mut encoder = DesktopEncoder::new(profile)?;
    let mut ticker = tokio::time::interval(profile.frame_budget());
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    let mut skipped: u64 = 0;
    let mut encoded: u64 = 0;
    loop {
        tokio::select! {
            _ = stop.changed() => {
                if *stop.borrow() {
                    break;
                }
            }
            command = control.recv() => {
                let Some(command) = command else {
                    // The dispatcher is gone; the session loop is tearing down.
                    // Keep streaming on the last known profile until `stop`.
                    continue;
                };
                match command {
                    StreamControl::SetBitrate(bps) => {
                        // Task 4b implements this arm.
                        tracing::debug!(bps, "desktop: bitrate command received");
                    }
                    StreamControl::SourceSwap(id) => {
                        // Task 4c implements this arm.
                        tracing::debug!(source_id = %id, "desktop: source-swap command received");
                    }
                }
            }
            _ = ticker.tick() => {
                // …unchanged from Task 3, reading `profile.max_width`/`profile.max_height`…
            }
        }
    }

    source.stop();
    Ok(())
}
```

`control.recv()` returning `None` when the sender is dropped: the dispatcher task is dropped at session teardown, and a `continue` would then spin. Guard against that by breaking the loop's `select!` on a closed channel:

```rust
            command = control.recv(), if !control_closed => {
                match command {
                    Some(command) => { /* dispatch, see below */ }
                    None => control_closed = true,
                }
            }
```

with `let mut control_closed = false;` declared beside `skipped`/`encoded` — the `if !control_closed` guard disables the branch once the sender is gone, so the loop cannot spin on a closed channel.

- [ ] **Step 6: Split `build_peer`'s flag and add `CONTROL_LABEL`**

In `apps/agent/src/rtc.rs`:

```rust
/// The desktop control channel's label (Week 8, spec §2.1). Desktop-only.
pub const CONTROL_LABEL: &str = "control";
```

Change `build_peer`'s signature and the timeout condition:

```rust
pub async fn build_peer(
    pushed: &[IceServerEntry],
    stun_url: &str,
    handler: Arc<dyn PeerConnectionEventHandler>,
    media_only: bool,
    has_control: bool,
) -> Result<Arc<dyn PeerConnection>> {
```

```rust
    // A peer with a data channel — terminal's, or desktop's control channel —
    // treats a channel close as the end-of-session signal, so it keeps the
    // RFC-shaped ICE defaults. Only a peer with no channel at all relies on ICE
    // silence, and only that peer gets the shortened timeouts (spec §6.3).
    if media_only && !has_control {
        setting = setting.with_ice_timeouts(
            Some(Duration::from_secs(3)),
            Some(Duration::from_secs(5)),
            Some(Duration::from_secs(1)),
        );
    }
```

- [ ] **Step 7: Teach `SessionHandler` its accepted label**

`SessionHandler` gains a field; `new` gains a parameter; `on_data_channel` compares against it:

```rust
pub struct SessionHandler {
    session_id: String,
    outbound: mpsc::Sender<SignalMessage>,
    end_tx: mpsc::Sender<&'static str>,
    /// The one channel label this session accepts (ADR-09): `terminal` for a
    /// terminal session, `control` for a desktop session.
    accepted_label: String,
    channel: Arc<OnceLock<Arc<dyn DataChannel>>>,
    open_tx: Arc<Mutex<Option<oneshot::Sender<()>>>>,
    connected_tx: Arc<Mutex<Option<oneshot::Sender<()>>>>,
}

impl SessionHandler {
    pub fn new(
        session_id: String,
        outbound: mpsc::Sender<SignalMessage>,
        end_tx: mpsc::Sender<&'static str>,
        accepted_label: String,
        channel: Arc<OnceLock<Arc<dyn DataChannel>>>,
        open_tx: Arc<Mutex<Option<oneshot::Sender<()>>>>,
        connected_tx: Arc<Mutex<Option<oneshot::Sender<()>>>>,
    ) -> Self {
        Self {
            session_id,
            outbound,
            end_tx,
            accepted_label,
            channel,
            open_tx,
            connected_tx,
        }
    }
}
```

```rust
    async fn on_data_channel(&self, dc: Arc<dyn DataChannel>) {
        match dc.label().await {
            Ok(label) if label == self.accepted_label => {}
            Ok(label) => {
                tracing::warn!(label = %label, "refusing unexpected channel");
                let _ = dc.close().await;
                return;
            }
            Err(e) => {
                tracing::warn!(error = %e, "dropping an unlabelled channel");
                return;
            }
        }

        if let Err(second) = self.channel.set(dc) {
            tracing::warn!(label = %self.accepted_label, "refusing a second session channel");
            let _ = second.close().await;
            return;
        }
        if let Some(tx) = self.open_tx.lock().unwrap().take() {
            let _ = tx.send(());
        }
    }
```

- [ ] **Step 8: Wire the label through `run_one_session`**

In `apps/agent/src/main.rs`, before the peer is built:

```rust
    // The one channel label this session accepts. A terminal session accepts
    // `terminal`; a desktop session accepts `control` (spec §2.1). The `None`
    // mode never opens a session, so its label is never used.
    let accepted_label = match mode {
        SessionMode::Desktop => rtc::CONTROL_LABEL.to_string(),
        _ => rtc::TERMINAL_LABEL.to_string(),
    };
```

Pass it to the handler and split the peer flag:

```rust
    let handler = Arc::new(rtc::SessionHandler::new(
        offer.session_id.clone(),
        outbound.clone(),
        end_tx.clone(),
        accepted_label,
        channel.clone(),
        open_tx,
        connected_tx,
    ));
    // A desktop peer now carries a control channel, so it keeps the RFC-shaped
    // ICE defaults; `media_only` is false for every Week 8 session.
    let peer = rtc::build_peer(
        pushed_ice,
        &cfg.stun,
        handler,
        false,
        mode == SessionMode::Desktop,
    )
    .await?;
```

`build_peer` now takes five arguments, so the **other** call site must move with it. In `refuse_second_offer` (`main.rs:1256`) — the second-offer refusal path, which builds a throwaway peer with no session and therefore no control channel — add the trailing `false`:

```rust
    let peer = rtc::build_peer(
        pushed_ice,
        &cfg.stun,
        Arc::new(rtc::NoopHandler),
        false,
        false,
    )
    .await?;
```

(A missed call site here is a compile error, not a silent bug — `cargo build` catches it. Both sites must carry the new arity before Step 8's test run.)

- [ ] **Step 9: Spawn the desktop control dispatcher**

In `run_desktop_session` (non-musl), accept `mut open_rx: tokio::sync::oneshot::Receiver<()>` as a parameter (moved in from `run_one_session`, which passes `open_rx` only on the Desktop arm — the arm `return`s, so the move is legal), then after the `run_stream` spawn:

```rust
    let (control_tx, control_rx) = mpsc::channel::<desktop::StreamControl>(16);

    // The enumeration the picker shows. In test mode it is synthesised (CI is
    // headless and must not touch xcap); on a real host it is the live
    // enumeration. The streaming entry is flagged `default: true` so the
    // browser marks it selected without any interaction (ADR-22).
    //
    // `default_id` was resolved in Step 7 (it built the pre-answer source), so
    // it is reused here rather than re-derived — the picker's `default` flag and
    // the live stream must name the same source.
    let mut sources = match cfg.desktop_source {
        DesktopSource::Test => vec![desktop::test_source_info()],
        DesktopSource::Screen => desktop::enumerate_sources().unwrap_or_else(|e| {
            tracing::warn!(error = ?e, "source enumeration failed; the picker will be empty");
            Vec::new()
        }),
    };
    for source in &mut sources {
        source.default = source.id == default_id;
    }
    let sources_frame = desktop::frame_desktop_sources(&sources, crate::pty::now_ms());

    let channel_for_control = channel.clone();
    let end_tx_for_control = end_tx.clone();
    let session_id = offer.session_id.clone();
    let control_task = tokio::spawn(async move {
        // The control channel opens after the answer; wait for it, but never
        // block the stream on it — a viewer that never opens the picker still
        // gets video (ADR-22).
        let dc = tokio::select! {
            result = &mut open_rx => match result {
                Ok(()) => channel_for_control.get().cloned(),
                Err(_) => None,
            },
            _ = tokio::time::sleep(CONTROL_OPEN_TIMEOUT) => None,
        };
        let Some(dc) = dc else {
            tracing::debug!(session_id = %session_id, "no control channel opened; media-only session");
            return;
        };
        if let Err(e) = dc.send_text(&sources_frame).await {
            tracing::debug!(error = %e, "sending desktop-sources failed");
            return;
        }
        while let Some(event) = dc.poll().await {
            match event {
                DataChannelEvent::OnMessage(message) => {
                    let Ok(text) = std::str::from_utf8(&message.data) else {
                        tracing::debug!("ignoring a non-UTF-8 control frame");
                        continue;
                    };
                    match desktop::decode_control(text) {
                        Ok(Some(control)) => {
                            if control_tx.send(control).await.is_err() {
                                break;
                            }
                        }
                        Ok(None) => {}
                        Err(e) => tracing::debug!(error = %e, "dropping a malformed control frame"),
                    }
                }
                DataChannelEvent::OnClose => break,
                _ => {}
            }
        }
        // The control channel is this desktop session's only data channel, so
        // its close is the end-of-session signal — exactly as the terminal
        // channel's close is (the 2026-10-01 dead-peer fix). Without this the
        // session loop below would sit on `inbound`/`end_rx` until the 1h cap,
        // holding the single ADR-14 slot after the browser closed the tab.
        // Fires on an explicit `OnClose` and on `poll()` returning `None` (the
        // driver ended the channel) alike. `try_send` on a full channel is a
        // no-op: the first reason already won.
        let _ = end_tx_for_control.try_send("the control channel closed");
    });
```

with, at the top of the non-musl section of `main.rs`:

```rust
/// How long the dispatcher waits for the control channel before concluding the
/// browser never opened one. Streaming is already running by then, so this only
/// decides whether the picker is offered.
#[cfg(not(target_env = "musl"))]
const CONTROL_OPEN_TIMEOUT: Duration = Duration::from_secs(10);
```

> **`run_desktop_session` must now receive `end_tx`.** The dispatcher above is the desktop session's end-signal source, so `run_desktop_session` takes `end_tx: mpsc::Sender<&'static str>` in addition to the `end_rx` it already owns — add it to the signature and pass `end_tx.clone()` at the call site in `run_one_session` (`main.rs:626-637`), beside `end_rx`. It is a second clone of the same channel the handler already holds; capacity 1 with `try_send` keeps "the first reason wins".

> **Keep the musl twin in step.** `run_desktop_session` has two definitions — the real one under `#[cfg(not(target_env = "musl"))]` and a refusing stub under `#[cfg(target_env = "musl")]` (`main.rs:1147`) — and **one shared call site** in `run_one_session`. Every parameter this task and Tasks 4b–4e add (`open_rx`, `end_tx`, and later `abr_target`) must be added to **both** signatures, with the stub prefixing the name (`_open_rx`, `_end_tx`, …) and ignoring it. A missing parameter in the stub is a musl-only compile error that the Linux `Build Agent / Verify` gate will not catch — only `Build Agent / Linux/x64-musl` will. This mirrors the `refuse_second_offer` call site: whenever a shared call site changes arity, every definition it can reach must change with it.

Pass `control_rx` into `run_stream`, and add `control_task` to teardown (abort it after `stop_tx.send(true)`, alongside the existing bounded stream join):

```rust
    let mut stream = tokio::spawn(desktop::run_stream(
        source,
        media.track.clone(),
        ssrc,
        payload_type,
        cfg.desktop_profile,
        control_rx,
        stop_rx,
    ));
```

- [ ] **Step 10: Run the agent tests, fmt, and clippy**

Run:
```bash
cargo test --manifest-path apps/agent/Cargo.toml --locked
cargo fmt --manifest-path apps/agent/Cargo.toml --check
cargo clippy --manifest-path apps/agent/Cargo.toml --all-targets --locked -- -D warnings
```
Expected: PASS — the 5 new decode/frame tests plus everything from Task 3.

- [ ] **Step 11: Commit**

```bash
git add apps/agent/src/desktop.rs apps/agent/src/rtc.rs apps/agent/src/main.rs
git commit -m "feat(agent): accept a desktop control channel and dispatch control frames"
```

---

### Task 4b: Agent — in-place bitrate retarget + `desktop-stats` egress (D3c)

**Files:**
- Modify: `apps/agent/Cargo.toml` (add `openh264-sys2 = "0.9.8"` to the non-musl section)
- Modify: `apps/agent/src/desktop.rs` (`DesktopEncoder::apply_bitrate`, `DesktopStats`/`StatsStatus`/`StatsStatusKind`, `StreamEvent`, `frame_desktop_stats`, the `SetBitrate` arm, the events sender)
- Modify: `apps/agent/src/main.rs` (the dispatcher forwards `StreamEvent`s)
- Test: `apps/agent/src/desktop.rs` (`#[cfg(test)] mod tests`)

**Interfaces:**
- Consumes: Task 4a's `StreamControl::SetBitrate`, `clamp_bitrate`, the `run_stream` control receiver; `openh264-sys2` constants.
- Produces (relied on by Tasks 4c/4d):
  - `DesktopEncoder::apply_bitrate(&mut self, target_bps: u32) -> Result<()>`
  - `pub struct DesktopStats { width, height, fps, target_bitrate_bps, status: Option<StatsStatus> }` with `#[derive(Clone, Debug, Serialize)] #[serde(rename_all = "camelCase")]`
  - `pub struct StatsStatus { kind: StatsStatusKind, detail: String }`, `pub enum StatsStatusKind { SelectRefused, QualityDowngraded }` (serialises `kebab-case`)
  - `pub enum StreamEvent { Stats(DesktopStats) }`
  - `pub fn frame_desktop_stats(stats: &DesktopStats, timestamp_ms: i64) -> String`
  - `run_stream(source, track, ssrc, payload_type, profile, control, events: mpsc::Sender<StreamEvent>, stop)`

> **Why `run_stream` gains an `events` sender.** Spec §6.4's signature lists only the command receiver, but §6.4 also requires the stream to *emit* `desktop-stats` (the bitrate echo here, the downgrade note in Task 4d). The egress must come from somewhere, and keeping every wire send in the dispatcher (the terminal path's `frame_tx` → pump shape) is cleaner than handing `run_stream` a `DataChannel`. So the plan adds one parameter beyond the spec's illustrative signature; the spec's behaviour is unchanged.

> **Why the raise path needs two calls.** Measured in the ADR-23 spike (§3.7): raising the target above the configured maximum fails `WelsBitRateVerification` with `rc = 1` unless the per-layer max is raised first. `ENCODER_OPTION_MAX_BITRATE` must target `SPATIAL_LAYER_0` (the per-layer field the check reads), **not** `SPATIAL_LAYER_ALL` (which sets only the top-level `iMaxBitrate`). Lowering needs no such step. Neither path forces an IDR/SPS/PPS.

- [ ] **Step 1: Add `openh264-sys2` to the agent's non-musl dependencies**

In `apps/agent/Cargo.toml`, in the `[target.'cfg(not(target_env = "musl"))'.dependencies]` section, beside `openh264`:

```toml
openh264-sys2 = "0.9.8"
```

This is required, not optional: `openh264` re-exports only `OpenH264API` (`openh264-0.9.8/src/lib.rs:17`), so the raw-API constants and `SBitrateInfo` live only in `openh264-sys2`.

- [ ] **Step 2: Add the stats types and the egress frame builder**

In `apps/agent/src/desktop.rs`:

```rust
/// Telemetry the agent pushes for the UI (spec §2.2/§5.1).
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopStats {
    pub width: u32,
    pub height: u32,
    pub fps: f32,
    pub target_bitrate_bps: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<StatsStatus>,
}

/// An agent→browser note attached to a stats frame (spec §2.2).
#[derive(Clone, Debug, serde::Serialize)]
pub struct StatsStatus {
    pub kind: StatsStatusKind,
    pub detail: String,
}

/// The two note kinds on the wire (spec §2.2). `kebab-case` matches the
/// TypeScript union exactly.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum StatsStatusKind {
    SelectRefused,
    QualityDowngraded,
}

/// Something `run_stream` needs the dispatcher to put on the wire.
#[derive(Debug, Clone)]
pub enum StreamEvent {
    /// Forward as a `desktop-stats` control frame.
    Stats(DesktopStats),
}

/// Frame telemetry as a `desktop-stats` control message (spec §2.2).
pub fn frame_desktop_stats(stats: &DesktopStats, timestamp_ms: i64) -> String {
    let message = crate::pty::DataChannelMessage {
        r#type: "desktop-stats".to_string(),
        channel: "control".to_string(),
        payload: stats.clone(),
        timestamp: timestamp_ms,
    };
    serde_json::to_string(&message).expect("a stats frame cannot fail to serialize")
}
```

- [ ] **Step 3: Implement `apply_bitrate` and track the current target**

Add the imports at the top of `desktop.rs`:

```rust
use openh264_sys2::{
    ENCODER_OPTION_BITRATE, ENCODER_OPTION_MAX_BITRATE, SBitrateInfo, SPATIAL_LAYER_0,
    SPATIAL_LAYER_ALL,
};
use std::os::raw::c_int;
use std::ptr::addr_of_mut;
```

Give `DesktopEncoder` the current target and the retarget method:

```rust
pub struct DesktopEncoder {
    encoder: Encoder,
    /// The target the encoder is currently configured for; `apply_bitrate`
    /// compares against it to decide whether the raise path is needed.
    bitrate_bps: u32,
}
```

In `DesktopEncoder::new`, record it (the config already reads `profile.bitrate_bps`):

```rust
        Ok(Self {
            encoder,
            bitrate_bps: profile.bitrate_bps,
        })
```

```rust
    /// Retarget the encoder in place (ADR-23, spike §3.7).
    ///
    /// No rebuild, no keyframe blip. **Raising** above the current target needs
    /// `ENCODER_OPTION_MAX_BITRATE` on `SPATIAL_LAYER_0` first — setting the
    /// top-level max alone leaves the per-layer max below the new target and
    /// `WelsBitRateVerification` refuses the next call with `rc = 1`.
    /// **Lowering** needs only the single `ENCODER_OPTION_BITRATE` call.
    pub fn apply_bitrate(&mut self, target_bps: u32) -> Result<()> {
        let target = target_bps as c_int;
        unsafe {
            let raw = self.encoder.raw_api();
            if target > self.bitrate_bps as c_int {
                let mut max = SBitrateInfo {
                    iLayer: SPATIAL_LAYER_0,
                    iBitrate: target,
                };
                let rc = raw.set_option(ENCODER_OPTION_MAX_BITRATE, addr_of_mut!(max).cast());
                if rc != 0 {
                    bail!("set_option(MAX_BITRATE, LAYER_0, {target}) failed with rc = {rc}");
                }
            }
            let mut info = SBitrateInfo {
                iLayer: SPATIAL_LAYER_ALL,
                iBitrate: target,
            };
            let rc = raw.set_option(ENCODER_OPTION_BITRATE, addr_of_mut!(info).cast());
            if rc != 0 {
                bail!("set_option(BITRATE, ALL, {target}) failed with rc = {rc}");
            }
        }
        self.bitrate_bps = target_bps;
        Ok(())
    }

    /// The target the encoder reports for `SPATIAL_LAYER_ALL` (test-only probe).
    #[cfg(test)]
    fn reported_bitrate_bps(&mut self) -> i32 {
        unsafe {
            let mut info = SBitrateInfo {
                iLayer: SPATIAL_LAYER_ALL,
                iBitrate: 0,
            };
            let rc = self
                .encoder
                .raw_api()
                .get_option(ENCODER_OPTION_BITRATE, addr_of_mut!(info).cast());
            if rc == 0 {
                info.iBitrate
            } else {
                -1
            }
        }
    }
```

- [ ] **Step 4: Write the failing tests**

```rust
    #[test]
    fn apply_bitrate_raises_in_place_and_echoes_the_new_target() {
        let mut encoder = DesktopEncoder::new(StreamProfile::SAFE_720P30).expect("encoder");
        // 4 Mbps -> 6 Mbps is a raise, so this is also the ordering guard: with
        // the MAX_BITRATE-on-layer-0 step omitted, the BITRATE call fails with
        // rc = 1 (spike §3.7) and `apply_bitrate` returns Err.
        encoder.apply_bitrate(6_000_000).expect("raise");
        assert_eq!(encoder.reported_bitrate_bps(), 6_000_000);
    }

    #[test]
    fn apply_bitrate_lowers_in_place_with_the_single_call() {
        let mut encoder = DesktopEncoder::new(StreamProfile::DEFAULT_1080P30).expect("encoder");
        encoder.apply_bitrate(1_000_000).expect("lower");
        assert_eq!(encoder.reported_bitrate_bps(), 1_000_000);
    }

    #[test]
    fn apply_bitrate_does_not_add_an_idr_to_the_next_frame() {
        // ADR-23's whole point is "no blip". Whether the production usage type
        // emits an IDR per frame is the Task 3 watch item, so this asserts the
        // weaker, always-true property: the retarget does not make an IDR
        // *appear* on a frame that would otherwise have had none.
        let mut encoder = DesktopEncoder::new(StreamProfile::SAFE_720P30).expect("encoder");
        let frame = crop_to_even(solid(320, 240));
        let _ = encoder.encode(&frame).expect("first");
        let before = has_idr(&encoder.encode(&frame).expect("second"));
        encoder.apply_bitrate(6_000_000).expect("raise");
        let after = has_idr(&encoder.encode(&frame).expect("third"));
        assert!(
            before || !after,
            "apply_bitrate introduced an IDR on a frame that had none"
        );
    }

    /// True when the Annex-B byte stream contains an IDR NAL (type 5).
    fn has_idr(data: &[u8]) -> bool {
        let mut i = 0;
        while i + 5 <= data.len() {
            if data[i..i + 4] == [0, 0, 0, 1] && (data[i + 4] & 0x1F) == 5 {
                return true;
            }
            i += 1;
        }
        false
    }

    #[test]
    fn frame_desktop_stats_uses_the_camel_case_wire_shape() {
        let stats = DesktopStats {
            width: 1280,
            height: 720,
            fps: 30.0,
            target_bitrate_bps: 4_000_000,
            status: Some(StatsStatus {
                kind: StatsStatusKind::QualityDowngraded,
                detail: "720p (quality downgraded)".to_string(),
            }),
        };
        let value: serde_json::Value =
            serde_json::from_str(&frame_desktop_stats(&stats, 3)).unwrap();
        assert_eq!(value["type"], "desktop-stats");
        assert_eq!(value["channel"], "control");
        assert_eq!(value["timestamp"], 3);
        assert_eq!(value["payload"]["targetBitrateBps"], 4_000_000);
        assert_eq!(value["payload"]["status"]["kind"], "quality-downgraded");
    }

    #[test]
    fn frame_desktop_stats_omits_an_absent_status() {
        let stats = DesktopStats {
            width: 1920,
            height: 1080,
            fps: 30.0,
            target_bitrate_bps: 6_000_000,
            status: None,
        };
        let value: serde_json::Value =
            serde_json::from_str(&frame_desktop_stats(&stats, 1)).unwrap();
        assert!(value["payload"].get("status").is_none());
    }
```

- [ ] **Step 5: Run the tests to verify they fail**

Run: `cargo test --manifest-path apps/agent/Cargo.toml apply_bitrate`
Expected: FAIL to compile — `DesktopEncoder` has no `bitrate_bps`, `apply_bitrate`, or `reported_bitrate_bps`; `DesktopStats` does not exist.

- [ ] **Step 6: Fill the `SetBitrate` arm and emit stats**

`run_stream` gains the events sender and a small helper that pushes one stats frame. `profile` becomes `mut` (Task 4d mutates it too):

```rust
pub async fn run_stream(
    mut source: Box<dyn FrameSource>,
    track: Arc<TrackLocalStaticSample>,
    ssrc: SSRC,
    payload_type: PayloadType,
    mut profile: StreamProfile,
    mut control: tokio::sync::mpsc::Receiver<StreamControl>,
    events: tokio::sync::mpsc::Sender<StreamEvent>,
    mut stop: watch::Receiver<bool>,
) -> Result<()> {
    if *stop.borrow() {
        source.stop();
        return Ok(());
    }

    let mut encoder = DesktopEncoder::new(profile)?;
    let mut ticker = tokio::time::interval(profile.frame_budget());
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    let mut skipped: u64 = 0;
    let mut encoded: u64 = 0;
    // The last encoded frame's dimensions — what `desktop-stats` reports, so
    // the UI's "1920×1080" reflects what is actually on the wire.
    let mut encoded_size = (profile.max_width, profile.max_height);
    // Best-effort: a full events channel must never stall the stream.
    let send_stats = |events: &tokio::sync::mpsc::Sender<StreamEvent>,
                      size: (u32, u32),
                      profile: StreamProfile,
                      status: Option<StatsStatus>| {
        let stats = DesktopStats {
            width: size.0,
            height: size.1,
            fps: profile.fps,
            target_bitrate_bps: profile.bitrate_bps,
            status,
        };
        let _ = events.try_send(StreamEvent::Stats(stats));
    };
```

and the arm:

```rust
                    StreamControl::SetBitrate(bps) => {
                        match encoder.apply_bitrate(bps) {
                            Ok(()) => {
                                profile.bitrate_bps = bps;
                                // Reflect the effective value to the UI (spec §2.3 step 6).
                                send_stats(&events, encoded_size, profile, None);
                            }
                            Err(e) => {
                                tracing::warn!(error = %e, bps, "desktop: bitrate retarget failed");
                            }
                        }
                    }
```

In the ticker arm, after `encoded += 1;`, update `encoded_size = (frame.width, frame.height);` and emit the first stats frame once:

```rust
                if encoded == 1 {
                    send_stats(&events, encoded_size, profile, None);
                }
```

- [ ] **Step 7: Forward events in the dispatcher**

In `run_desktop_session`, create the events channel and hand its sender to `run_stream`, its receiver to the dispatcher:

```rust
    let (control_tx, control_rx) = mpsc::channel::<desktop::StreamControl>(16);
    let (events_tx, mut events_rx) = mpsc::channel::<desktop::StreamEvent>(16);
```

Change the dispatcher's read loop from a `while let` to a `select!` so it serves both directions:

```rust
        loop {
            tokio::select! {
                event = dc.poll() => match event {
                    Some(DataChannelEvent::OnMessage(message)) => {
                        let Ok(text) = std::str::from_utf8(&message.data) else {
                            tracing::debug!("ignoring a non-UTF-8 control frame");
                            continue;
                        };
                        match desktop::decode_control(text) {
                            Ok(Some(control)) => {
                                if control_tx.send(control).await.is_err() {
                                    break;
                                }
                            }
                            Ok(None) => {}
                            Err(e) => {
                                tracing::debug!(error = %e, "dropping a malformed control frame")
                            }
                        }
                    }
                    Some(DataChannelEvent::OnClose) | None => break,
                    _ => {}
                },
                // `Some(..)` pattern: once the stream drops its sender the
                // branch is disabled, so a closed channel cannot spin.
                Some(event) = events_rx.recv() => {
                    let frame = match event {
                        desktop::StreamEvent::Stats(stats) => {
                            desktop::frame_desktop_stats(&stats, crate::pty::now_ms())
                        }
                    };
                    if let Err(e) = dc.send_text(&frame).await {
                        tracing::debug!(error = %e, "sending a desktop-stats frame failed");
                        break;
                    }
                }
            }
        }
```

Pass `events_tx` into the `run_stream` spawn:

```rust
    let mut stream = tokio::spawn(desktop::run_stream(
        source,
        media.track.clone(),
        ssrc,
        payload_type,
        cfg.desktop_profile,
        control_rx,
        events_tx,
        stop_rx,
    ));
```

- [ ] **Step 8: Run the agent tests, fmt, and clippy**

Run:
```bash
cargo test --manifest-path apps/agent/Cargo.toml --locked
cargo fmt --manifest-path apps/agent/Cargo.toml --check
cargo clippy --manifest-path apps/agent/Cargo.toml --all-targets --locked -- -D warnings
```
Expected: PASS — the 6 new tests plus everything before.

> If `apply_bitrate_raises_in_place_and_echoes_the_new_target` fails with `rc = 1`, do **not** weaken the assertion: it means the `SPATIAL_LAYER_0`/`SPATIAL_LAYER_ALL` choice or the call order is wrong, which is exactly the trap §3.7 records.

- [ ] **Step 9: Commit**

```bash
git add apps/agent/Cargo.toml apps/agent/Cargo.lock apps/agent/src/desktop.rs apps/agent/src/main.rs
git commit -m "feat(agent): retarget the encoder bitrate in place and emit desktop-stats"
```

---

### Task 4c: Agent — the bounded source swap (D3d)

**Files:**
- Modify: `apps/agent/src/desktop.rs` (`SwapSource` trait seam, `swap_source`, the `SourceSwap` arm, `DEFAULT_SELECT_TIMEOUT`)
- Modify: `apps/agent/src/main.rs` (`AGENT_DESKTOP_SELECT_TIMEOUT_MS` → `cfg.desktop_select_timeout`)
- Test: `apps/agent/src/desktop.rs` (`#[cfg(test)] mod tests`)

**Interfaces:**
- Consumes: Task 3's `source_for`, `enumerate_sources`, `default_source_id`; Task 4a's `StreamControl::SourceSwap`; Task 4b's `DesktopStats`/`StreamEvent`/`send_stats` closure shape.
- Produces (relied on by Task 6's E2E):
  - `pub const DEFAULT_SELECT_TIMEOUT: Duration = Duration::from_secs(5);`
  - `trait SwapSource { fn source_ids(&self) -> Vec<String>; async fn build(&self, id: &str) -> Result<Box<dyn FrameSource>>; }` (with `#[async_trait::async_trait]`)
  - `struct LiveSources { test: bool }` implementing `SwapSource` (the production impl: `test` → `test_source_info`, else `enumerate_sources`; `build` → `test_source_info`/`source_for`)
  - `async fn swap_source<S: SwapSource>(current: Box<dyn FrameSource>, sources: &S, id: &str, profile: StreamProfile, timeout: Duration) -> Result<(Box<dyn FrameSource>, DesktopEncoder)>`

> **The order matters, and the bound is what makes it safe.** A requested id is validated against the **agent's own enumeration** (`source_ids`) before `build` is ever called, so a hostile `desktop-select` cannot name a source the agent never offered (spec §9). The build runs under `tokio::time::timeout(DEFAULT_SELECT_TIMEOUT)`; a source that fails to start (or starts too slowly) leaves the **current** source and encoder untouched — the stream never stops for a failed switch (ADR-22, spec §6.4). The old source is stopped only *after* the new one is in hand, so a failure is not a dead end.

- [ ] **Step 1: Add the swap seam and the production implementation**

In `apps/agent/src/desktop.rs`:

```rust
/// How long a requested source switch may take before the agent gives up and
/// keeps the current source (ADR-22; env `AGENT_DESKTOP_SELECT_TIMEOUT_MS`).
pub const DEFAULT_SELECT_TIMEOUT: Duration = Duration::from_secs(5);

/// The two source-factory operations a swap needs, behind a seam.
///
/// `enumerate_sources`/`source_for` touch a live display, so a unit test cannot
/// drive the real swap. This trait lets the test inject a fake enumeration and
/// a fake factory while `swap_source` — the ordering, the bound, the leak
/// discipline — stays the production code path.
///
/// `build` is async (it awaits `source_for`'s first-frame handshake), so the
/// trait carries `#[async_trait::async_trait]` — the same pattern `rtc.rs` uses
/// for `PeerConnectionEventHandler`. A bare `async fn` in a public trait would
/// also trip the warn-by-default `async_fn_in_trait` lint under `-D warnings`.
#[async_trait::async_trait]
pub trait SwapSource {
    /// The ids the agent is willing to switch to. A requested id not in this
    /// list is refused (spec §9).
    fn source_ids(&self) -> Vec<String>;
    /// Build the source for an id already validated by `source_ids`.
    async fn build(&self, id: &str) -> Result<Box<dyn FrameSource>>;
}

/// The production `SwapSource`: `xcap` enumeration on a real host, the single
/// synthetic entry under `--desktop-source test` (so a swap in test mode can
/// only ever re-select the test pattern).
pub struct LiveSources {
    pub test: bool,
}

#[async_trait::async_trait]
impl SwapSource for LiveSources {
    fn source_ids(&self) -> Vec<String> {
        if self.test {
            return vec![test_source_info().id];
        }
        enumerate_sources()
            .map(|sources| sources.into_iter().map(|s| s.id).collect())
            .unwrap_or_default()
    }

    async fn build(&self, id: &str) -> Result<Box<dyn FrameSource>> {
        // One factory for every path: `source_for` already handles the `test:`
        // scheme, so the test branch needs no special case here. `source_ids`
        // gates what can reach this, so in test mode `id` is always `test:0`.
        source_for(id, StreamProfile::DEFAULT_1080P30).await
    }
}
```

- [ ] **Step 2: Implement the bounded swap**

```rust
/// Build a replacement source + encoder, or fail without disturbing the live
/// one (ADR-22, spec §6.4).
///
/// Returns the new pair on success. The caller stops the old source and swaps
/// both only then, so a failure here is a no-op on the running stream. The id
/// is validated against `sources.source_ids()` **before** `build`, so the
/// factory never sees an unenumerated id.
async fn swap_source<S: SwapSource>(
    current: Box<dyn FrameSource>,
    sources: &S,
    id: &str,
    profile: StreamProfile,
    timeout: Duration,
) -> Result<(Box<dyn FrameSource>, DesktopEncoder)> {
    if !sources.source_ids().iter().any(|known| known == id) {
        bail!("unknown source id {id:?}");
    }

    // The build is the only part that can hang (a portal that never answers), so
    // it is the part that is bounded. On timeout the half-built source — if any
    // — is dropped inside the future, and `current` is still the live one.
    let built = tokio::time::timeout(timeout, async {
        let source = sources.build(id).await?;
        let encoder = DesktopEncoder::new(profile)?;
        Ok::<_, anyhow::Error>((source, encoder))
    })
    .await
    .map_err(|_| anyhow::anyhow!("source {id:?} did not start within {timeout:?}"))??;

    // Success: the new source is live, so the old one is stopped now — never
    // before, so a failed swap leaks nothing and kills nothing.
    drop(current);
    Ok(built)
}
```

`drop(current)` is `FrameSource::stop`'s contract only if the impl stops in `Drop`; `ScreenSource`/`WindowSource` do not implement `Drop`, so make the stop explicit instead:

```rust
    let mut current = current;
    current.stop();
    Ok(built)
```

- [ ] **Step 3: Write the failing swap tests**

```rust
    /// A `FrameSource` that records how often it was stopped.
    struct FakeSource {
        stopped: Arc<std::sync::atomic::AtomicUsize>,
    }
    impl FrameSource for FakeSource {
        fn next_frame(&mut self) -> Result<Option<RawFrame>> {
            Ok(None)
        }
        fn stop(&mut self) {
            self.stopped
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        }
    }

    /// A `SwapSource` whose enumeration and factory the test controls.
    struct FakeSources {
        ids: Vec<String>,
        fail: bool,
        hang: bool,
    }
    #[async_trait::async_trait]
    impl SwapSource for FakeSources {
        fn source_ids(&self) -> Vec<String> {
            self.ids.clone()
        }
        async fn build(&self, _id: &str) -> Result<Box<dyn FrameSource>> {
            if self.hang {
                // Never returns, so the timeout is the only way out. A blocking
                // sleep models a portal that accepts the request and never
                // answers — exactly the pathology the bound exists for.
                std::thread::sleep(Duration::from_secs(30));
            }
            if self.fail {
                bail!("the fake source refused to start");
            }
            Ok(Box::new(FakeSource {
                stopped: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
            }))
        }
    }

    #[tokio::test]
    async fn swap_source_stops_the_old_source_only_after_the_new_one_is_built() {
        let stopped = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let current: Box<dyn FrameSource> = Box::new(FakeSource {
            stopped: stopped.clone(),
        });
        let sources = FakeSources {
            ids: vec!["monitor:1".to_string()],
            fail: false,
            hang: false,
        };

        let (_new, _encoder) = swap_source(
            current,
            &sources,
            "monitor:1",
            StreamProfile::SAFE_720P30,
            DEFAULT_SELECT_TIMEOUT,
        )
        .await
        .expect("a valid swap");

        assert_eq!(stopped.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn swap_source_refuses_an_unenumerated_id_without_touching_the_current_source() {
        let stopped = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let current: Box<dyn FrameSource> = Box::new(FakeSource {
            stopped: stopped.clone(),
        });
        let sources = FakeSources {
            ids: vec!["monitor:1".to_string()],
            fail: false,
            hang: false,
        };

        let result = swap_source(
            current,
            &sources,
            "monitor:999999",
            StreamProfile::SAFE_720P30,
            DEFAULT_SELECT_TIMEOUT,
        )
        .await;

        assert!(result.is_err(), "an unenumerated id must be refused");
        assert_eq!(stopped.load(std::sync::atomic::Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn swap_source_keeps_the_current_source_when_the_new_one_fails_to_start() {
        let stopped = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let current: Box<dyn FrameSource> = Box::new(FakeSource {
            stopped: stopped.clone(),
        });
        let sources = FakeSources {
            ids: vec!["monitor:1".to_string()],
            fail: true,
            hang: false,
        };

        let result = swap_source(
            current,
            &sources,
            "monitor:1",
            StreamProfile::SAFE_720P30,
            DEFAULT_SELECT_TIMEOUT,
        )
        .await;

        assert!(result.is_err());
        assert_eq!(
            stopped.load(std::sync::atomic::Ordering::SeqCst),
            0,
            "a failed swap must not stop the live source"
        );
    }

    #[tokio::test]
    async fn swap_source_gives_up_on_a_slow_build_within_the_bound() {
        let stopped = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let current: Box<dyn FrameSource> = Box::new(FakeSource {
            stopped: stopped.clone(),
        });
        let sources = FakeSources {
            ids: vec!["monitor:1".to_string()],
            fail: false,
            hang: true,
        };

        let started = std::time::Instant::now();
        let result = swap_source(
            current,
            &sources,
            "monitor:1",
            StreamProfile::SAFE_720P30,
            Duration::from_millis(200),
        )
        .await;

        assert!(result.is_err());
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "the swap must be bounded by the timeout, not the build"
        );
        assert_eq!(stopped.load(std::sync::atomic::Ordering::SeqCst), 0);
    }
```

> The hang test runs `FakeSources::build` on the runtime worker, so it blocks that worker for 30 s — but the test's `timeout(200ms)` still fires because the blocking happens in the timeout's *polled future* on a multi-threaded runtime, where other workers keep the timer alive. `#[tokio::test]` defaults to a current-thread runtime, where a blocking `build` would deadlock the timer. Declare these four tests `#[tokio::test(flavor = "multi_thread", worker_threads = 2)]` so the timer has a thread to run on. (The production `source_for` is async-friendly in practice — it opens a recorder and waits on a `oneshot` — but the fake blocks, which is precisely the pathological case the bound exists for.)

- [ ] **Step 4: Run the tests to verify they fail**

Run: `cargo test --manifest-path apps/agent/Cargo.toml swap_source`
Expected: FAIL to compile — `SwapSource`, `swap_source`, `DEFAULT_SELECT_TIMEOUT` do not exist.

- [ ] **Step 5: Wire the swap into the `SourceSwap` arm**

In `run_stream`, the arm becomes:

```rust
                    StreamControl::SourceSwap(id) => {
                        match swap_source(
                            source,
                            &LiveSources { test: source_is_test },
                            &id,
                            profile,
                            select_timeout,
                        )
                        .await
                        {
                            Ok((new_source, new_encoder)) => {
                                source = new_source;
                                encoder = new_encoder;
                                encoded_size = (profile.max_width, profile.max_height);
                                // The new source may be a different size; the UI
                                // learns it from the next stats frame.
                                send_stats(&events, encoded_size, profile, None);
                            }
                            Err(e) => {
                                // The stream keeps running on the current source
                                // (ADR-22). Tell the UI, per spec §2.2.
                                tracing::warn!(source_id = %id, error = %e, "desktop: source swap refused");
                                send_stats(
                                    &events,
                                    encoded_size,
                                    profile,
                                    Some(StatsStatus {
                                        kind: StatsStatusKind::SelectRefused,
                                        detail: format!("could not switch source: {e}"),
                                    }),
                                );
                            }
                        }
                    }
```

`source` must be rebindable, so it is `mut source` (already is), and the whole `select!` body must be inside an `async` context that allows `.await` — it is, since `run_stream` is `async`.

Two parameters join the signature (they are captured once at session start, not per command):

```rust
pub async fn run_stream(
    mut source: Box<dyn FrameSource>,
    track: Arc<TrackLocalStaticSample>,
    ssrc: SSRC,
    payload_type: PayloadType,
    mut profile: StreamProfile,
    source_is_test: bool,
    select_timeout: Duration,
    mut control: tokio::sync::mpsc::Receiver<StreamControl>,
    events: tokio::sync::mpsc::Sender<StreamEvent>,
    mut stop: watch::Receiver<bool>,
) -> Result<()>
```

- [ ] **Step 6: Add the CLI/env timeout**

In `Cli` (beside `desktop_profile`):

```rust
    /// Bounded window to apply a requested source switch before keeping the
    /// current source (ADR-22).
    #[arg(
        long,
        env = "AGENT_DESKTOP_SELECT_TIMEOUT_MS",
        default_value_t = 5000
    )]
    desktop_select_timeout_ms: u64,
```

In `SessionConfig`:

```rust
    /// Unused on musl (the desktop module is compiled out); same shape on every
    /// target, mirroring `desktop_source`.
    #[allow(dead_code)]
    desktop_select_timeout: Duration,
```

Resolved in `run_with_reconnect`:

```rust
        desktop_select_timeout: Duration::from_millis(cli.desktop_select_timeout_ms),
```

and passed to `run_stream` in `run_desktop_session`:

```rust
    let mut stream = tokio::spawn(desktop::run_stream(
        source,
        media.track.clone(),
        ssrc,
        payload_type,
        cfg.desktop_profile,
        cfg.desktop_source == DesktopSource::Test,
        cfg.desktop_select_timeout,
        control_rx,
        events_tx,
        stop_rx,
    ));
```

- [ ] **Step 7: Run the agent tests, fmt, and clippy**

Run:
```bash
cargo test --manifest-path apps/agent/Cargo.toml --locked
cargo fmt --manifest-path apps/agent/Cargo.toml --check
cargo clippy --manifest-path apps/agent/Cargo.toml --all-targets --locked -- -D warnings
```
Expected: PASS — the 4 new swap tests plus everything before.

> `run_stream` now takes 10 parameters, which trips clippy's `too_many_arguments`. Add `#[allow(clippy::too_many_arguments)]` above it, exactly as `run_desktop_session` already does (`main.rs:981`) — the parameters are all distinct session-scoped values with no natural grouping, and bundling them into a struct would only move the same list one level down. If a reviewer objects, the alternative is a `StreamSetup` struct; say so in the PR rather than silently allowing it.

- [ ] **Step 8: Commit**

```bash
git add apps/agent/src/desktop.rs apps/agent/src/main.rs
git commit -m "feat(agent): bounded source swap that keeps the live stream on failure"
```

---

### Task 4d: Agent — the sustain fallback and its hysteresis (D3e)

**Files:**
- Modify: `apps/agent/src/desktop.rs` (`SustainMonitor`, `SustainAction`, `SUSTAIN_FRAMES_BEFORE_FALLBACK`, the ticker-arm fallback, the `SetBitrate` re-arm)
- Test: `apps/agent/src/desktop.rs` (`#[cfg(test)] mod tests`)

**Interfaces:**
- Consumes: Task 3's `StreamProfile::{DEFAULT_1080P30, SAFE_720P30, frame_budget}`; Task 4b's `send_stats`/`DesktopStats`/`StatsStatusKind::QualityDowngraded`.
- Produces: `pub const SUSTAIN_FRAMES_BEFORE_FALLBACK: u32 = 30;`, `pub enum SustainAction { Continue, Downgrade }`, `pub struct SustainMonitor` with `new(profile)`, `observe(encode_time) -> SustainAction`, `note_manual_bitrate(current_profile)`.

> **Why this is a separate value, not a test of the encoder.** ADR-24's fallback triggers on *encode wall time*, which no unit test can force on a real encoder (the §3.1 benchmark needed a synthetic 200-frame ring to make 1080p30 marginal). So the decision is a pure state machine — `SustainMonitor` — that the test drives with synthetic durations, and `run_stream` is the only caller that feeds it real `Instant::elapsed()` values. That is the seam the spec's §6.5 test row ("a synthetic slow-encode sequence downgrades once") requires.

> **The watch item interacts here.** ADR-24's fallback assumes a resolution change costs *one* IDR blip. If Task 3's `screen_content_usage_emits_an_idr_only_on_the_first_frame` failed — i.e. `ScreenContentRealTime` emits an IDR every frame — then the fallback's blip is invisible because blips are already continuous. That does **not** make the fallback wrong (it still buys encode headroom), but it changes what the demo should show. Confirm the Task 3 finding before recording the demo; do not gate this task on it.

- [ ] **Step 1: Add `SustainMonitor`**

In `apps/agent/src/desktop.rs`:

```rust
/// How many consecutive over-budget frames before the agent falls back to
/// 720p30. 30 frames is ~1 s at 30 fps — long enough to ride out a transient
/// stall (a GC pause, a scheduler hiccup), short enough that a host which truly
/// cannot sustain 1080p30 drops within a second (ADR-24).
pub const SUSTAIN_FRAMES_BEFORE_FALLBACK: u32 = 30;

/// What the sustain check wants to do next.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SustainAction {
    /// Stay on the current profile.
    Continue,
    /// Rebuild at `SAFE_720P30` — a resolution change, so an encoder rebuild.
    Downgrade,
}

/// The ADR-24 fallback decision, as a pure state machine.
///
/// `run_stream` feeds it one `Duration` per encoded frame; the test feeds it
/// synthetic durations. Keeping the decision out of the encode loop is what
/// makes "downgrade once, never oscillate" unit-testable without a real encoder
/// or a slow host.
pub struct SustainMonitor {
    /// The per-frame budget of the profile currently being encoded.
    budget: Duration,
    /// Consecutive over-budget frames seen so far.
    consecutive_over: u32,
    /// Set once a downgrade is requested (or immediately, at the floor) so the
    /// monitor can never ask twice — ADR-24's anti-oscillation hysteresis.
    latched: bool,
}

impl SustainMonitor {
    pub fn new(profile: StreamProfile) -> Self {
        Self {
            budget: profile.frame_budget(),
            // At the floor there is nowhere to fall back to, so the latch starts
            // closed and `observe` can never return `Downgrade`.
            latched: profile == StreamProfile::SAFE_720P30,
            consecutive_over: 0,
        }
    }

    /// One encoded frame took `encode_time`; decide whether to keep going.
    pub fn observe(&mut self, encode_time: Duration) -> SustainAction {
        if self.latched {
            return SustainAction::Continue;
        }
        if encode_time > self.budget {
            self.consecutive_over += 1;
        } else {
            // A single on-budget frame proves the stall was transient; the
            // streak resets so a jittery-but-sustainable host is never demoted.
            self.consecutive_over = 0;
        }
        if self.consecutive_over >= SUSTAIN_FRAMES_BEFORE_FALLBACK {
            self.latched = true;
            return SustainAction::Downgrade;
        }
        SustainAction::Continue
    }

    /// A manual bitrate change is the user asking for a fresh evaluation, so the
    /// latch re-opens — but only while there is a lower rung to fall to. At the
    /// floor, re-opening would only re-select the same profile, so it stays
    /// closed (ADR-24's "no oscillation").
    pub fn note_manual_bitrate(&mut self, current: StreamProfile) {
        if current != StreamProfile::SAFE_720P30 {
            self.latched = false;
            self.consecutive_over = 0;
        }
    }
}
```

- [ ] **Step 2: Write the failing tests**

```rust
    #[test]
    fn sustain_monitor_downgrades_once_and_never_oscillates() {
        let mut monitor = SustainMonitor::new(StreamProfile::DEFAULT_1080P30);
        let slow = Duration::from_millis(50); // > the 33.3 ms 1080p30 budget

        for _ in 0..SUSTAIN_FRAMES_BEFORE_FALLBACK - 1 {
            assert_eq!(monitor.observe(slow), SustainAction::Continue);
        }
        assert_eq!(
            monitor.observe(slow),
            SustainAction::Downgrade,
            "the 30th consecutive slow frame trips the fallback"
        );
        for _ in 0..200 {
            assert_eq!(
                monitor.observe(slow),
                SustainAction::Continue,
                "a downgraded monitor must never ask again"
            );
        }
    }

    #[test]
    fn sustain_monitor_resets_the_streak_on_an_on_budget_frame() {
        let mut monitor = SustainMonitor::new(StreamProfile::DEFAULT_1080P30);
        let slow = Duration::from_millis(50);
        let fast = Duration::from_millis(5);

        for _ in 0..SUSTAIN_FRAMES_BEFORE_FALLBACK - 1 {
            monitor.observe(slow);
        }
        monitor.observe(fast); // proves the host can keep up; reset
        for _ in 0..SUSTAIN_FRAMES_BEFORE_FALLBACK - 1 {
            assert_eq!(monitor.observe(slow), SustainAction::Continue);
        }
        assert_eq!(monitor.observe(slow), SustainAction::Downgrade);
    }

    #[test]
    fn sustain_monitor_never_downgrades_from_the_floor() {
        let mut monitor = SustainMonitor::new(StreamProfile::SAFE_720P30);
        let slow = Duration::from_millis(50);
        for _ in 0..SUSTAIN_FRAMES_BEFORE_FALLBACK * 4 {
            assert_eq!(monitor.observe(slow), SustainAction::Continue);
        }
    }

    #[test]
    fn sustain_monitor_reopens_only_above_the_floor() {
        let mut monitor = SustainMonitor::new(StreamProfile::DEFAULT_1080P30);
        let slow = Duration::from_millis(50);
        for _ in 0..SUSTAIN_FRAMES_BEFORE_FALLBACK {
            monitor.observe(slow); // trips and latches
        }
        assert_eq!(monitor.observe(slow), SustainAction::Continue, "latched");

        // A manual change above the floor re-arms exactly one more evaluation.
        monitor.note_manual_bitrate(StreamProfile::DEFAULT_1080P30);
        for _ in 0..SUSTAIN_FRAMES_BEFORE_FALLBACK - 1 {
            assert_eq!(monitor.observe(slow), SustainAction::Continue);
        }
        assert_eq!(monitor.observe(slow), SustainAction::Downgrade);

        // At the floor, a manual change does not re-arm.
        let mut at_floor = SustainMonitor::new(StreamProfile::SAFE_720P30);
        at_floor.note_manual_bitrate(StreamProfile::SAFE_720P30);
        for _ in 0..SUSTAIN_FRAMES_BEFORE_FALLBACK * 2 {
            assert_eq!(at_floor.observe(slow), SustainAction::Continue);
        }
    }
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cargo test --manifest-path apps/agent/Cargo.toml sustain_monitor`
Expected: FAIL to compile — `SustainMonitor`, `SustainAction`, `SUSTAIN_FRAMES_BEFORE_FALLBACK` do not exist.

- [ ] **Step 4: Drive the monitor from the encode loop**

In `run_stream`, declare the monitor beside the encoder and time the encode:

```rust
    let mut encoder = DesktopEncoder::new(profile)?;
    let mut sustain = SustainMonitor::new(profile);
```

In the ticker arm, replace the encode line with a timed encode plus the fallback:

```rust
                let frame = crop_to_even(downscale(&frame, profile.max_width, profile.max_height));
                let encode_start = Instant::now();
                let data = encoder.encode(&frame)?;
                let encode_time = encode_start.elapsed();

                if sustain.observe(encode_time) == SustainAction::Downgrade {
                    // ADR-24: the host cannot sustain the current profile's
                    // budget, so drop to the guaranteed floor. One rebuild, one
                    // IDR blip, and the monitor's latch is closed by construction
                    // (`SustainMonitor::new(SAFE_720P30)` starts latched).
                    tracing::warn!(
                        from = ?(profile.max_width, profile.max_height),
                        encode_ms = encode_time.as_secs_f64() * 1000.0,
                        "desktop: cannot sustain the profile; falling back to 720p30"
                    );
                    profile = StreamProfile::SAFE_720P30;
                    encoder = DesktopEncoder::new(profile)?;
                    sustain = SustainMonitor::new(profile);
                    encoded_size = (profile.max_width, profile.max_height);
                    // The stats' width/height already reflect the new size (§6.4).
                    send_stats(
                        &events,
                        encoded_size,
                        profile,
                        Some(StatsStatus {
                            kind: StatsStatusKind::QualityDowngraded,
                            detail: "720p30 (quality downgraded)".to_string(),
                        }),
                    );
                }
```

Then `encoded += 1;`, `encoded_size = (frame.width, frame.height);` and the first-frame stats stay as Task 4b wrote them.

- [ ] **Step 5: Re-arm on a manual bitrate change**

In the `SetBitrate` arm, after a successful `apply_bitrate`, let the monitor re-evaluate (it only re-arms above the floor):

```rust
                            Ok(()) => {
                                profile.bitrate_bps = bps;
                                sustain.note_manual_bitrate(profile);
                                send_stats(&events, encoded_size, profile, None);
                            }
```

- [ ] **Step 6: Run the agent tests, fmt, and clippy**

Run:
```bash
cargo test --manifest-path apps/agent/Cargo.toml --locked
cargo fmt --manifest-path apps/agent/Cargo.toml --check
cargo clippy --manifest-path apps/agent/Cargo.toml --all-targets --locked -- -D warnings
```
Expected: PASS — the 4 new sustain tests plus everything before. This completes D3.

- [ ] **Step 7: Commit**

```bash
git add apps/agent/src/desktop.rs
git commit -m "feat(agent): 1080p30->720p30 sustain fallback with an anti-oscillation latch"
```

---

### Task 4e: Agent — GCC auto-ABR wiring (D3f, the transport half)

**Files:**
- Modify: `apps/agent/src/rtc.rs` (`ABR_INITIAL_BPS`/`ABR_MIN_BPS`/`ABR_MAX_BPS`; an `abr` module with `ReportingEstimator` + `estimator()`; `build_peer` installs congestion control when `has_control` and returns `BuiltPeer`)
- Modify: `apps/agent/src/desktop.rs` (`abr_next_target`)
- Modify: `apps/agent/src/main.rs` (destructure `BuiltPeer` at both `build_peer` call sites; thread `abr_target` into both `run_desktop_session` twins; a dedicated auto-ABR task beside the Task 4a dispatcher; latch `manual` in the decode arm; abort the task at teardown)
- Test: `apps/agent/src/rtc.rs`, `apps/agent/src/desktop.rs` (`#[cfg(test)] mod tests`)

**Interfaces:**
- Consumes: Task 4a's dispatcher + `control_tx` and its `MIN_BITRATE_BPS`/`MAX_BITRATE_BPS`/`StreamControl`; Task 4b's `StreamControl::SetBitrate` handling in `run_stream`; Task 3's `StreamProfile`.
- Produces: `rtc::BuiltPeer { peer: Arc<dyn PeerConnection>, abr_target: Option<Arc<AtomicU64>> }`; `rtc::ABR_INITIAL_BPS`/`ABR_MIN_BPS`/`ABR_MAX_BPS`; `desktop::abr_next_target(estimate_bps: f64, current_bps: u32) -> Option<u32>`.

> **Why this task exists (spec §2.4, §3.3, §10.3 step 4).** The spike PASSED (§3.7), so ADR-23's PASS branch is the shipped design: the spec says GCC-driven auto-ABR *ships this week* alongside manual control (§2.4), D3 lists it in `apps/agent`'s deliverable (`design.md:546`), and §10.3 step 4 names "GCC auto-ABR wiring" in the delivery sequence. It stays a **goal, not an acceptance criterion** (§10.2) — nothing here is gated — but it is in scope, so the plan carries it. This task wires the *transport* half (estimator + pacer) and feeds the estimate into the **existing** retarget path (`StreamControl::SetBitrate` → Task 4b's `apply_bitrate`), so auto and manual share one code path.

> **The mechanism, and why it is a wrapper (spec §3.3).** `configure_congestion_control` takes the estimator **by value** and boxes it inside the interceptor chain, where the application cannot reach it — so the estimate must be *pushed* out, not pulled. The shipped example (`webrtc-0.21.0/examples/bandwidth-estimation-from-disk/bandwidth-estimation-from-disk.rs:126-166`) does exactly this: a `ReportingEstimator` that delegates every call and stores the target in an `AtomicU64` after each update. The plan copies that wrapper (~40 lines, the documented integration) rather than inventing one.

> **`RtpSender::set_parameters` is NOT load-bearing here — a recorded deviation from §3.3.** §3.3's sentence "feeding `RtpSender::set_parameters` and the encoder target" is aspirational; verified against the vendored rtc 0.21, `RTCRtpEncodingParameters::max_bitrate` is **never read at runtime** (`grep -rn max_bitrate rtc-0.21.0/src` finds only `0` initialisers and a doc comment). The pacer is driven by the estimator's `Attribute::TargetBitrateChanged` (`rtc-interceptor-0.21.0/src/pacing/sender.rs:186-191`), not by the sender's encoding parameters. So this task does **not** call `set_parameters`: the encoder target is the only knob the application must turn, and the pacer follows the estimator on its own.

> **⚠️ Desktop-SDP risk — read before implementing.** Installing congestion control registers `transport-cc` RTCP feedback and the `transport-cc` header extension on the desktop `MediaEngine` (spec §3.3), so the desktop SDP gains two attributes Week 7's did not carry. The terminal path is untouched (`has_control` gates it, spec §2.4), so this is desktop-only — but Task 6's werift E2E answers that SDP, and a werift offer that does not carry `transport-cc` could make the agent's answer include an un-offered attribute. **If Task 6 Step 3 fails on the answer's SDP, do not delete this task**: gate the install behind a CLI/env flag `--desktop-abr <on|off>` / `AGENT_DESKTOP_ABR` (default `on`) and pass `--desktop-abr off` in the E2E opener only — the real-browser demo keeps it on. Report the failure and the chosen fallback to the PM before committing.

- [ ] **Step 1: Add the ABR bounds and the estimator wrapper**

In `apps/agent/src/rtc.rs`, at module level — **gated to non-musl**, because the only readers are the `abr` module below and `desktop::abr_next_target`, both of which are compiled out on musl (an ungated `pub const` in a binary crate is still dead-code-checked, so it would fail `-D warnings` on the musl leg):

```rust
/// Where GCC starts (spec §3.3). Deliberately low — the safe floor, not the
/// 1080p30 target — because a path that opens congested should not open at
/// 6 Mbps. The dispatcher ignores the estimate until it *moves off* this seed,
/// so the stream still starts at the session profile (spec §2.3 step 2).
#[cfg(not(target_env = "musl"))]
pub const ABR_INITIAL_BPS: f64 = 4_000_000.0;
/// Never let GCC drive the encoder outside the wire boundary's clamp.
#[cfg(not(target_env = "musl"))]
pub const ABR_MIN_BPS: f64 = 250_000.0;
#[cfg(not(target_env = "musl"))]
pub const ABR_MAX_BPS: f64 = 20_000_000.0;
```

Below the `build_peer` imports, add the wrapper (desktop-only — musl has no desktop session):

```rust
/// GCC-driven auto-ABR (spec §3.3, ADR-23 PASS branch). Installed only on a
/// peer that carries a control channel, so the terminal SDP is untouched.
#[cfg(not(target_env = "musl"))]
mod abr {
    use rtc::interceptor::{BandwidthEstimator, EstimatorStats, Gcc, PacketReport};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::Arc;
    use std::time::Instant;

    /// Delegates to `inner` and publishes its target after every update.
    ///
    /// `configure_congestion_control` boxes the estimator inside the chain, so
    /// this wrapper is the one application-supplied object in the loop that can
    /// carry the number back out (spec §3.3). Copied from the shipped example
    /// `webrtc-0.21.0/examples/bandwidth-estimation-from-disk`.
    pub struct ReportingEstimator<E: BandwidthEstimator> {
        inner: E,
        target: Arc<AtomicU64>,
    }

    impl<E: BandwidthEstimator> ReportingEstimator<E> {
        pub fn new(inner: E) -> (Self, Arc<AtomicU64>) {
            let target = Arc::new(AtomicU64::new(inner.target_bitrate().to_bits()));
            let handle = Arc::clone(&target);
            (Self { inner, target }, handle)
        }

        fn publish(&self) {
            self.target
                .store(self.inner.target_bitrate().to_bits(), Ordering::Relaxed);
        }
    }

    impl<E: BandwidthEstimator> BandwidthEstimator for ReportingEstimator<E> {
        fn on_reports(&mut self, now: Instant, reports: &[PacketReport]) {
            self.inner.on_reports(now, reports);
            self.publish();
        }

        fn target_bitrate(&self) -> f64 {
            self.inner.target_bitrate()
        }

        fn handle_timeout(&mut self, now: Instant) {
            self.inner.handle_timeout(now);
            self.publish();
        }

        fn poll_timeout(&self) -> Option<Instant> {
            self.inner.poll_timeout()
        }

        fn stats(&self) -> EstimatorStats {
            self.inner.stats()
        }
    }

    /// A GCC estimator wrapped so its target is observable.
    pub fn estimator() -> (ReportingEstimator<Gcc>, Arc<AtomicU64>) {
        ReportingEstimator::new(Gcc::new(
            super::ABR_INITIAL_BPS,
            super::ABR_MIN_BPS,
            super::ABR_MAX_BPS,
        ))
    }
}
```

- [ ] **Step 2: Install congestion control in `build_peer` and return the handle**

Add `use std::sync::atomic::AtomicU64;` **ungated** near the top of `rtc.rs` — `BuiltPeer` carries `Option<Arc<AtomicU64>>` on every target, so the import is used on musl too (the musl peer simply always gets `None`).

Add `configure_congestion_control` and `CongestionFeedback` to the import list **under a non-musl gate**, because they are referenced only inside the `#[cfg(not(target_env = "musl"))]` block below — an ungated import would be unused on the musl leg and fail `-D warnings`:

```rust
#[cfg(not(target_env = "musl"))]
use webrtc::peer_connection::{configure_congestion_control, CongestionFeedback};
```

Define the return type just above `build_peer`:

```rust
/// A built peer plus the handles the session needs from it.
///
/// `abr_target` is `Some` only for a peer built with congestion control — a
/// desktop session. The terminal and refusal peers leave it `None`, so their
/// SDP is byte-identical to Week 7 (spec §2.4).
pub struct BuiltPeer {
    pub peer: Arc<dyn PeerConnection>,
    pub abr_target: Option<Arc<AtomicU64>>,
}
```

Change the signature's return type to `Result<BuiltPeer>` and replace the media/registry prologue:

```rust
    let mut media = MediaEngine::default();
    media
        .register_default_codecs()
        .context("register_default_codecs")?;

    // Congestion control is desktop-only: it registers `transport-cc` feedback
    // and a header extension on the media engine, which changes the SDP. The
    // terminal path must stay byte-identical (spec §2.4), so it is gated on
    // `has_control` — the same flag that decides the ICE timeouts below.
    #[cfg(not(target_env = "musl"))]
    let (registry, abr_target) = if has_control {
        let (estimator, handle) = abr::estimator();
        let registry = configure_congestion_control(
            Registry::new(),
            estimator,
            CongestionFeedback::Twcc,
            &mut media,
        )
        .context("configure_congestion_control")?;
        (registry, Some(handle))
    } else {
        (Registry::new(), None)
    };
    // musl has no desktop session, so `has_control` is never true there; the
    // peer still needs a registry, just without congestion control.
    #[cfg(target_env = "musl")]
    let (registry, abr_target): (Registry, Option<Arc<AtomicU64>>) = (Registry::new(), None);

    let registry = register_default_interceptors(registry, &mut media)
        .context("register_default_interceptors")?;
```

and the tail:

```rust
    Ok(BuiltPeer {
        peer: Arc::new(peer) as Arc<dyn PeerConnection>,
        abr_target,
    })
}
```

- [ ] **Step 3: Update the two `build_peer` call sites**

In `run_one_session` (`main.rs:616`), destructure instead of binding the peer:

```rust
    let rtc::BuiltPeer { peer, abr_target } = rtc::build_peer(
        pushed_ice,
        &cfg.stun,
        handler,
        false,
        mode == SessionMode::Desktop,
    )
    .await?;
```

and pass `abr_target` into the Desktop arm's `run_desktop_session(...)` call, beside `connected_rx`.

In `refuse_second_offer` (`main.rs:1256`):

```rust
    let rtc::BuiltPeer { peer, .. } =
        rtc::build_peer(pushed_ice, &cfg.stun, Arc::new(rtc::NoopHandler), false, false).await?;
```

- [ ] **Step 4: Add the pure auto-ABR decision to `desktop.rs`**

```rust
/// The auto-ABR decision (spec §3.3): clamp GCC's estimate and apply a 15%
/// dead-band so the encoder is not retargeted on every wobble. `None` means
/// "leave the encoder alone".
///
/// The estimate is ignored until it has **moved off** `ABR_INITIAL_BPS`, so a
/// path that has not yet reported anything keeps the session profile's target
/// rather than snapping to the seed (spec §2.3 step 2).
pub fn abr_next_target(estimate_bps: f64, current_bps: u32) -> Option<u32> {
    if !estimate_bps.is_finite() || estimate_bps <= 0.0 {
        return None;
    }
    let seed = crate::rtc::ABR_INITIAL_BPS;
    if (estimate_bps - seed).abs() < seed * 0.05 {
        return None;
    }
    let target = estimate_bps
        .round()
        .clamp(MIN_BITRATE_BPS as f64, MAX_BITRATE_BPS as f64) as u32;
    let delta = (target as i64 - current_bps as i64).unsigned_abs();
    if delta * 100 < current_bps as u64 * 15 {
        return None;
    }
    Some(target)
}
```

- [ ] **Step 5: Thread the handle in and run the auto-ABR task**

Give **both** `run_desktop_session` twins a new trailing parameter `abr_target: Option<Arc<std::sync::atomic::AtomicU64>>` — the same type in both, because the `SessionMode::Desktop` arm in `run_one_session` is shared code that calls whichever twin the target compiles, and a shared call site cannot pass two different types. The musl twin names it `_abr_target` and ignores it (that build never has an estimator). Note the type is written **fully qualified** in both signatures: `AtomicU64` is never named bare in `main.rs`, so it must not be imported. Add to `main.rs`'s imports only what the non-musl body names, **gated** so the musl leg does not see unused imports:

```rust
#[cfg(not(target_env = "musl"))]
use std::sync::atomic::{AtomicBool, Ordering};
```

and pass `abr_target` in from the Desktop arm's `run_desktop_session(...)` call in `run_one_session`, beside `connected_rx`.

> **Auto-ABR is its own task, not a branch in the dispatcher.** Task 4a's dispatcher loop is a `while let Some(event) = dc.poll().await` inside the spawned `control_task`; `control_rx` is owned by `run_stream`. So the auto-ABR loop cannot live in that loop without either (a) racing `dc.poll()` in a `select!`, which would drop a control frame if `poll()` is not cancel-safe, or (b) sharing `control_rx`. A dedicated task that only *sends* into a `control_tx` clone keeps Task 4a's poll loop byte-for-byte and needs no cancel-safety argument.

Spawn it in the **non-musl** `run_desktop_session`. The parameter is an `Option`, and a desktop session always has `Some` (the peer was built with `has_control`); the `None` arm simply skips the spawn and the stream runs at the profile target, so the function stays total without an `unwrap`.

> **Ordering matters: the `control_tx` clone must be taken *before* Task 4a's `control_task`.** That closure is `async move` and consumes `control_tx`, so a `control_tx.clone()` written after the spawn will not compile. Build `manual` and the ABR sender first, then `control_task`, then the ABR task:

```rust
    // Auto-ABR (spec §3.3, ADR-23 PASS branch): sample GCC's published target
    // twice a second and feed it into the same `SetBitrate` path manual control
    // uses, so both share one encoder-retarget code path. A manual
    // `desktop-bitrate` frame latches `manual` and stops auto for the rest of
    // the session, so the two never fight.
    //
    // This runs whenever congestion control is installed — i.e. whenever the
    // desktop peer was built with a control channel (`has_control`), including a
    // session where the viewer never opens the picker (ADR-22): the channel to
    // `run_stream` exists regardless, so the estimate still reaches the encoder.
    //
    // `manual` is created unconditionally: the decode arm below latches it even
    // when there is no estimator, which is harmless and keeps the arm simple.
    // This block goes *before* the Task 4a `control_task` spawn, which moves
    // `control_tx`.
    let manual = Arc::new(AtomicBool::new(false));
    let manual_for_decode = Arc::clone(&manual);
    let abr_sender = control_tx.clone();
    let abr_task = abr_target.map(|abr_target| {
        let abr_tx = abr_sender;
        let manual = Arc::clone(&manual);
        let seed_target = cfg.desktop_profile.bitrate_bps;
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_millis(500));
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            // What we last told the encoder, so the dead-band measures against
            // reality. Starts at the session profile: until GCC moves off its
            // seed, `abr_next_target` returns `None` and the stream keeps this
            // target (spec §2.3 step 2).
            let mut auto_target = seed_target;
            loop {
                tick.tick().await;
                if manual.load(Ordering::Relaxed) {
                    continue;
                }
                let estimate = f64::from_bits(abr_target.load(Ordering::Relaxed));
                if let Some(bps) = desktop::abr_next_target(estimate, auto_target) {
                    if abr_tx.send(desktop::StreamControl::SetBitrate(bps)).await.is_err() {
                        break;
                    }
                    auto_target = bps;
                }
            }
        })
    });
    // The Task 4a `control_task` spawn goes *after* this block: it consumes the
    // original `control_tx`, and its decode arm stores `manual_for_decode` (see
    // the next snippet). Everything else in the function is unchanged.
```

Latch `manual` in Task 4a Step 9's decode arm (the `Ok(Some(control))` case), so a manual frame stops auto for good:

```rust
                        Ok(Some(control)) => {
                            // A manual bitrate frame is the user taking the
                            // wheel: stop auto-ABR for the rest of the session.
                            if matches!(control, desktop::StreamControl::SetBitrate(_)) {
                                manual_for_decode.store(true, Ordering::Relaxed);
                            }
                            if control_tx.send(control).await.is_err() {
                                break;
                            }
                        }
```

Add the auto-ABR task to teardown beside `control_task` — abort it after `stop_tx.send(true)`, guarding the `Option`:

```rust
    control_task.abort();
    if let Some(task) = abr_task {
        task.abort();
    }
```

- [ ] **Step 6: Write the tests**

In `apps/agent/src/desktop.rs` (`mod tests`):

```rust
    #[test]
    fn abr_next_target_ignores_the_unmoved_seed() {
        // GCC's published value equals the seed until feedback arrives: the
        // stream must keep the session profile's target (spec §2.3 step 2).
        assert_eq!(abr_next_target(crate::rtc::ABR_INITIAL_BPS, 6_000_000), None);
    }

    #[test]
    fn abr_next_target_applies_a_dead_band() {
        // A 10% move is inside the 15% dead-band and must not retarget.
        assert_eq!(abr_next_target(4_400_000.0, 4_000_000), None);
        // A 50% move is outside it.
        assert_eq!(abr_next_target(6_000_000.0, 4_000_000), Some(6_000_000));
    }

    #[test]
    fn abr_next_target_clamps_and_rejects_garbage() {
        assert_eq!(abr_next_target(0.0, 4_000_000), None);
        assert_eq!(abr_next_target(f64::NAN, 4_000_000), None);
        assert_eq!(abr_next_target(1.0e12, 4_000_000), Some(MAX_BITRATE_BPS));
        assert_eq!(abr_next_target(1.0, 4_000_000), Some(MIN_BITRATE_BPS));
    }
```

In `apps/agent/src/rtc.rs`, add this test **inside the existing `#[cfg(test)] mod tests`**, carrying its own non-musl gate on the function (the module itself is ungated, but `abr` does not exist on musl):

```rust
    #[cfg(not(target_env = "musl"))]
    #[test]
    fn reporting_estimator_publishes_its_initial_target() {
        let (_estimator, handle) = abr::estimator();
        let published = f64::from_bits(handle.load(std::sync::atomic::Ordering::Relaxed));
        assert_eq!(published, ABR_INITIAL_BPS);
    }
```

- [ ] **Step 7: Run the agent tests, fmt, and clippy**

Run:
```bash
cargo test --manifest-path apps/agent/Cargo.toml --locked
cargo fmt --manifest-path apps/agent/Cargo.toml --check
cargo clippy --manifest-path apps/agent/Cargo.toml --all-targets --locked -- -D warnings
```
Expected: PASS — the 4 new tests plus everything before. If the musl leg (`cargo build --target x86_64-unknown-linux-musl`) reports the `abr` module or `ABR_*` consts unused, check the `#[cfg]` split on the `build_peer` registry block rather than deleting the wiring.

- [ ] **Step 8: Commit**

```bash
git add apps/agent/src/rtc.rs apps/agent/src/desktop.rs apps/agent/src/main.rs
git commit -m "feat(agent): wire GCC auto-ABR into the in-place retarget path"
```

---

### Task 5: Web — store control wiring and `DesktopView` chrome (D4)

**Files:**
- Modify: `apps/web/src/stores/terminal.ts` (`channelLabels: ['control']`, `TabItem` fields, `selectDesktopSource`, `setDesktopBitrate`, the `onSources`/`onStats` subscriptions)
- Modify: `apps/web/src/components/desktop/DesktopView.vue` (picker, bitrate control, stats line)
- Modify: `apps/web/src/views/WorkspaceView.vue` (footer media line)
- Test: `apps/web/src/__tests__/terminal-store.test.ts`, `apps/web/src/__tests__/DesktopView.test.ts`, `apps/web/src/__tests__/WorkspaceView.test.ts`

**Interfaces:**
- Consumes: Task 1's `DesktopSourceInfo`/`DesktopStats` (from `@ponter/shared`); Task 2's `DesktopClient.onSources`/`onStats`/`selectSource`/`setBitrate`.
- Produces: `TabItem.desktopSources?`, `TabItem.desktopStats?`, `TabItem.desktopSourceId?`; store actions `selectDesktopSource(tabId, sourceId)`, `setDesktopBitrate(tabId, bps)`.

> **No input handling.** `DesktopView` gains control *chrome* — a `<select>`, a number input, and a stats line — but the `<video>` keeps **no `controls`** and the component adds **no pointer/keyboard handlers to the video**. Input forwarding is Week 9 (spec §7.2, Review Focus #3).

- [ ] **Step 1: Extend the store's desktop mock and write the failing store tests**

In `apps/web/src/__tests__/terminal-store.test.ts`, the mocked `DesktopClient` must expose the control surface, and the `PeerConnection` mock must record its constructor options so a test can assert the channel label. Replace the `vi.mock('@ponter/desktop-core', …)` block:

```typescript
const desktopStart = vi.fn();
const desktopClose = vi.fn();
const desktopSelectSource = vi.fn();
const desktopSetBitrate = vi.fn();
let desktopSourcesHandler: ((sources: unknown[]) => void) | null = null;
let desktopStatsHandler: ((stats: unknown) => void) | null = null;
const desktopOnSourcesOff = vi.fn();
const desktopOnStatsOff = vi.fn();

vi.mock('@ponter/desktop-core', () => ({
  DesktopClient: function (
    this: Record<string, unknown>,
    _agentId: string,
    _peer: unknown,
  ) {
    this.start = desktopStart;
    this.close = desktopClose;
    this.selectSource = desktopSelectSource;
    this.setBitrate = desktopSetBitrate;
    this.onSources = vi.fn((handler: (sources: unknown[]) => void) => {
      desktopSourcesHandler = handler;
      return desktopOnSourcesOff;
    });
    this.onStats = vi.fn((handler: (stats: unknown) => void) => {
      desktopStatsHandler = handler;
      return desktopOnStatsOff;
    });
  },
}));
```

The existing `PeerConnection` mock is a bare function, so it records no calls. Give it a spy-backed body — the `peerOptions` array is what the control-channel test reads:

```typescript
const peerOptions: Array<Record<string, unknown>> = [];

vi.mock('@ponter/webrtc-core', () => ({
  PeerConnection: function (
    this: Record<string, unknown>,
    _rtcPeer: unknown,
    _transport: unknown,
    options: Record<string, unknown>,
  ) {
    peerOptions.push(options);
    this.start = vi.fn(async () => {});
    this.close = vi.fn(async () => {});
    this.waitForChannel = vi.fn(async () => {});
    this.onConnectionStateChange = vi.fn(() => () => {});
    this.onRemoteTrack = vi.fn(() => () => {});
    this.dataChannels = {};
  },
  createBrowserAdapter: vi.fn(() => ({})),
  RESTPollingTransport: function (this: Record<string, unknown>) {
    this.onServerError = vi.fn();
  },
  WebSocketSignalTransport: function (this: Record<string, unknown>) {
    this.onServerError = vi.fn();
  },
}));
```

Extend the existing `beforeEach` so each test starts clean (the existing one only sets Pinia):

```typescript
  beforeEach(() => {
    setActivePinia(createPinia());
    peerOptions.length = 0;
    desktopSourcesHandler = null;
    desktopStatsHandler = null;
    desktopStart.mockReset();
    desktopSelectSource.mockReset();
    desktopSetBitrate.mockReset();
    desktopOnSourcesOff.mockReset();
    desktopOnStatsOff.mockReset();
  });
```

Then the new tests:

```typescript
  it('offers a control channel for a desktop tab', async () => {
    const store = useTerminalStore();
    desktopStart.mockResolvedValueOnce({ track: { kind: 'video' }, streams: [] });

    await store.openDesktopTab('ag-1', 'Host 1');

    expect(peerOptions.at(-1)).toMatchObject({ channelLabels: ['control'] });
  });

  it('populates desktopSources and selects the default entry', async () => {
    const store = useTerminalStore();
    desktopStart.mockResolvedValueOnce({ track: { kind: 'video' }, streams: [] });
    const tabId = await store.openDesktopTab('ag-1', 'Host 1');

    desktopSourcesHandler?.([
      { id: 'monitor:1', default: false },
      { id: 'monitor:2', default: true },
    ]);
    await nextTick();

    const tab = store.tabs.find((t) => t.id === tabId);
    expect(tab?.desktopSources).toHaveLength(2);
    expect(tab?.desktopSourceId).toBe('monitor:2');
  });

  it('records desktopStats from the agent', async () => {
    const store = useTerminalStore();
    desktopStart.mockResolvedValueOnce({ track: { kind: 'video' }, streams: [] });
    const tabId = await store.openDesktopTab('ag-1', 'Host 1');

    desktopStatsHandler?.({ width: 1920, height: 1080, fps: 30, targetBitrateBps: 6_000_000 });
    await nextTick();

    expect(store.tabs.find((t) => t.id === tabId)?.desktopStats?.targetBitrateBps).toBe(
      6_000_000,
    );
  });

  it('selectDesktopSource calls the client and records the id', async () => {
    const store = useTerminalStore();
    desktopStart.mockResolvedValueOnce({ track: { kind: 'video' }, streams: [] });
    const tabId = await store.openDesktopTab('ag-1', 'Host 1');

    store.selectDesktopSource(tabId, 'window:0x4a00007');
    await nextTick();

    expect(desktopSelectSource).toHaveBeenCalledWith('window:0x4a00007');
    expect(store.tabs.find((t) => t.id === tabId)?.desktopSourceId).toBe(
      'window:0x4a00007',
    );
  });

  it('setDesktopBitrate calls the client', async () => {
    const store = useTerminalStore();
    desktopStart.mockResolvedValueOnce({ track: { kind: 'video' }, streams: [] });
    const tabId = await store.openDesktopTab('ag-1', 'Host 1');

    store.setDesktopBitrate(tabId, 3_000_000);

    expect(desktopSetBitrate).toHaveBeenCalledWith(3_000_000);
  });

  it('tears down the control subscriptions on closeTab', async () => {
    const store = useTerminalStore();
    desktopStart.mockResolvedValueOnce({ track: { kind: 'video' }, streams: [] });
    const tabId = await store.openDesktopTab('ag-1', 'Host 1');

    store.closeTab(tabId);

    expect(desktopOnSourcesOff).toHaveBeenCalled();
    expect(desktopOnStatsOff).toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run the store tests to verify they fail**

Run: `pnpm --filter @ponter/web test terminal-store`
Expected: FAIL — `channelLabels` is `[]`; `desktopSources`/`desktopSourceId`/`desktopStats` are never set; `selectDesktopSource`/`setDesktopBitrate` are not functions.

- [ ] **Step 3: Wire the store**

In `apps/web/src/stores/terminal.ts`, add the type import:

```typescript
import type { DesktopSourceInfo, DesktopStats } from '@ponter/shared';
```

Add the three fields to `TabItem` (beside `desktopStream`):

```typescript
  /** Desktop tabs only: the agent's capture-source enumeration (spec §7.1). */
  desktopSources?: DesktopSourceInfo[];
  /** Desktop tabs only: best-effort telemetry from `desktop-stats`. */
  desktopStats?: DesktopStats;
  /** Desktop tabs only: the source the agent is streaming (or was asked to). */
  desktopSourceId?: string;
```

Change the desktop offer's labels (`:532`):

```typescript
      // A control channel carries the source picker, bitrate, and stats. The
      // media path is unchanged; the label rides the existing manager (spec §5.2).
      const peer = new PeerConnection(rtcPeer, transport, {
        role: 'offerer',
        channelLabels: ['control'],
        capabilities: ['desktop'],
        media: { video: true },
      });
```

Subscribe after `client.start()` resolves, before the tab is marked active:

```typescript
      if (live) live.initStep = 'stream';
      const stream = await client.start();

      // The agent pushes its enumeration when the control channel opens, so the
      // subscription is registered after `start()` (the track arrives first).
      // Both unsubscribers go into the same list the teardown already drains.
      unsubscribers.push(
        client.onSources((sources) => {
          const tab = tabs.value.find((t) => t.id === tabId);
          if (!tab) return;
          tab.desktopSources = sources;
          tab.desktopSourceId ??= sources.find((s) => s.default)?.id;
        }),
      );
      unsubscribers.push(
        client.onStats((stats) => {
          const tab = tabs.value.find((t) => t.id === tabId);
          if (tab) tab.desktopStats = stats;
        }),
      );

      if (live) {
        live.desktopStream = stream;
        live.status = 'active';
        live.initStep = undefined;
      }
```

Add the two actions (before the `return { … }`):

```typescript
  /**
   * Ask the agent to switch the desktop stream to another source (ADR-22).
   *
   * The tab records the id immediately so the picker shows the user's choice;
   * the agent's next `desktop-stats` is what confirms the switch actually took.
   * A refused switch arrives as a `status` note on that frame, not as an error.
   */
  function selectDesktopSource(tabId: string, sourceId: string): void {
    const tab = tabs.value.find((t) => t.id === tabId);
    if (!tab || tab.kind !== 'desktop') return;
    const conn = desktopConnections.get(tab.agentId);
    if (!conn) return;
    conn.client.selectSource(sourceId);
    tab.desktopSourceId = sourceId;
  }

  /** Set the desktop stream's target bitrate (manual control, ADR-23). */
  function setDesktopBitrate(tabId: string, bitrateBps: number): void {
    const tab = tabs.value.find((t) => t.id === tabId);
    if (!tab || tab.kind !== 'desktop') return;
    const conn = desktopConnections.get(tab.agentId);
    if (!conn) return;
    conn.client.setBitrate(bitrateBps);
  }
```

and export them:

```typescript
    selectDesktopSource,
    setDesktopBitrate,
```

- [ ] **Step 4: Write the failing `DesktopView` tests**

Add to `apps/web/src/__tests__/DesktopView.test.ts`:

```typescript
  const twoSources = [
    {
      id: 'monitor:1',
      kind: 'monitor' as const,
      name: 'eDP-1',
      width: 1920,
      height: 1080,
      x: 0,
      y: 0,
      scaleFactor: 1,
      rotation: 0,
      isPrimary: true,
      default: true,
    },
    {
      id: 'window:9',
      kind: 'window' as const,
      name: 'Editor',
      width: 800,
      height: 600,
      x: 100,
      y: 100,
      scaleFactor: 1,
      rotation: 0,
      isPrimary: false,
      default: false,
    },
  ];

  it('renders the source picker only when sources are present', async () => {
    const withoutSources = mount(DesktopView, { props: { tab: desktopTab() } });
    expect(withoutSources.find('[data-test="desktop-source-picker"]').exists()).toBe(
      false,
    );

    const withSources = mount(DesktopView, {
      props: {
        tab: desktopTab({ desktopSources: twoSources, desktopSourceId: 'monitor:1' }),
      },
    });
    const picker = withSources.find('[data-test="desktop-source-picker"]');
    expect(picker.exists()).toBe(true);
    expect(picker.findAll('option')).toHaveLength(2);
  });

  it('calls selectDesktopSource when the picker changes', async () => {
    const store = useTerminalStore();
    const select = vi
      .spyOn(store, 'selectDesktopSource')
      .mockImplementation(() => {});
    const wrapper = mount(DesktopView, {
      props: {
        tab: desktopTab({ desktopSources: twoSources, desktopSourceId: 'monitor:1' }),
      },
    });

    await wrapper
      .find('[data-test="desktop-source-picker"]')
      .setValue('window:9');

    expect(select).toHaveBeenCalledWith('tab-1', 'window:9');
  });

  it('renders the stats line and appends a status note when present', () => {
    const wrapper = mount(DesktopView, {
      props: {
        tab: desktopTab({
          desktopStats: {
            width: 1280,
            height: 720,
            fps: 30,
            targetBitrateBps: 4_000_000,
            status: { kind: 'quality-downgraded', detail: '720p (quality downgraded)' },
          },
        }),
      },
    });
    expect(wrapper.find('[data-test="desktop-stats"]').text()).toContain('1280×720');
    expect(wrapper.find('[data-test="desktop-stats"]').text()).toContain('30 fps');
    expect(wrapper.find('[data-test="desktop-stats"]').text()).toContain(
      'quality downgraded',
    );
  });

  it('calls setDesktopBitrate from the bitrate control', async () => {
    const store = useTerminalStore();
    const setBitrate = vi
      .spyOn(store, 'setDesktopBitrate')
      .mockImplementation(() => {});
    const wrapper = mount(DesktopView, {
      props: {
        tab: desktopTab({
          desktopStats: { width: 1920, height: 1080, fps: 30, targetBitrateBps: 6_000_000 },
        }),
      },
    });

    await wrapper.find('[data-test="desktop-bitrate"]').setValue('3000000');

    expect(setBitrate).toHaveBeenCalledWith('tab-1', 3_000_000);
  });

  it('keeps the video view-only: no controls, no input handlers', () => {
    const wrapper = mount(DesktopView, {
      props: {
        tab: desktopTab({ desktopSources: twoSources, desktopSourceId: 'monitor:1' }),
      },
    });
    const video = wrapper.find('video');
    // Review Focus #3: control chrome must not turn the video interactive.
    expect(video.attributes('controls')).toBeUndefined();
    expect(video.attributes('onmousedown')).toBeUndefined();
    expect(video.attributes('onkeydown')).toBeUndefined();
  });
```

- [ ] **Step 5: Run the `DesktopView` tests to verify they fail**

Run: `pnpm --filter @ponter/web test DesktopView`
Expected: FAIL — the picker/stats/bitrate elements do not exist.

- [ ] **Step 6: Implement the `DesktopView` chrome**

Add to the `<script setup>` in `apps/web/src/components/desktop/DesktopView.vue`:

```typescript
import { computed } from 'vue';

/** The stats line, or `null` before the first `desktop-stats` frame. */
const statsLine = computed(() => {
  const stats = props.tab.desktopStats;
  if (!stats) return null;
  const mbps = (stats.targetBitrateBps / 1_000_000).toFixed(1);
  const base = `${stats.width}×${stats.height} · ${Math.round(stats.fps)} fps · ${mbps} Mbps`;
  return stats.status ? `${base} · ${stats.status.detail}` : base;
});

function onSourceChange(event: Event): void {
  const sourceId = (event.target as HTMLSelectElement).value;
  store.selectDesktopSource(props.tab.id, sourceId);
}

function onBitrateChange(event: Event): void {
  const bps = Number((event.target as HTMLInputElement).value);
  if (Number.isFinite(bps) && bps > 0) {
    store.setDesktopBitrate(props.tab.id, bps);
  }
}
```

Add the chrome in the template, above the `<ConnectionProgress>` line — a small overlay bar that is hidden until the agent has pushed something:

```html
    <!-- Control chrome (Week 8). No input forwarding: that is Week 9. -->
    <div
      v-if="tab.status === 'active' && (tab.desktopSources?.length || statsLine)"
      class="absolute top-0 left-0 right-0 flex flex-wrap items-center gap-3 bg-[#090d16]/80 px-3 py-1.5 text-xs"
    >
      <select
        v-if="tab.desktopSources?.length"
        data-test="desktop-source-picker"
        class="rounded border border-border/60 bg-transparent px-1 py-0.5"
        :value="tab.desktopSourceId"
        @change="onSourceChange"
      >
        <option v-for="source in tab.desktopSources" :key="source.id" :value="source.id">
          {{ source.name }}{{ source.default ? ' (streaming)' : '' }}
        </option>
      </select>

      <label class="flex items-center gap-1 text-muted-foreground">
        <span>Bitrate</span>
        <input
          data-test="desktop-bitrate"
          type="number"
          min="250000"
          max="20000000"
          step="250000"
          class="w-24 rounded border border-border/60 bg-transparent px-1 py-0.5"
          :value="tab.desktopStats?.targetBitrateBps ?? 6_000_000"
          @change="onBitrateChange"
        />
        <span>bps</span>
      </label>

      <span v-if="statsLine" data-test="desktop-stats" class="text-muted-foreground font-mono">
        {{ statsLine }}
      </span>
    </div>
```

The `<video>` element is untouched — no `controls`, no handlers.

- [ ] **Step 7: Update the footer and its test**

In `apps/web/src/views/WorkspaceView.vue` (`:334`), replace the hardcoded line:

```html
            <span v-if="terminalStore.activeTab.kind === 'desktop'">
              Media: H.264 ·
              {{
                terminalStore.activeTab.desktopStats
                  ? `${terminalStore.activeTab.desktopStats.width}×${terminalStore.activeTab.desktopStats.height}`
                  : 'connecting'
              }}
            </span>
```

Add to `apps/web/src/__tests__/WorkspaceView.test.ts`:

```typescript
  it('shows the desktop stats-derived media line in the footer', async () => {
    const store = useTerminalStore();
    store.tabs.push({
      id: 'tab-d2',
      agentId: 'ag-1',
      kind: 'desktop',
      terminalId: '',
      title: 'Host 1',
      status: 'active',
      desktopStream: { track: { kind: 'video' }, streams: [] } as never,
      desktopStats: { width: 1280, height: 720, fps: 30, targetBitrateBps: 4_000_000 },
    });
    store.setActiveTab('tab-d2');

    const wrapper = mountWorkspace();
    await flushPromises();

    expect(wrapper.text()).toContain('Media: H.264');
    expect(wrapper.text()).toContain('1280×720');
  });
```

- [ ] **Step 8: Run the web suite, lint, and typecheck**

Run:
```bash
pnpm --filter @ponter/web test
pnpm --filter @ponter/web typecheck
pnpm lint
```
Expected: PASS — the new store, view, and footer tests, and every existing web test (the Week 7 "no `controls`" assertion included).

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/stores/terminal.ts apps/web/src/components/desktop/DesktopView.vue apps/web/src/views/WorkspaceView.vue apps/web/src/__tests__/terminal-store.test.ts apps/web/src/__tests__/DesktopView.test.ts apps/web/src/__tests__/WorkspaceView.test.ts
git commit -m "feat(web): desktop source picker, bitrate control, and stats line"
```

---

### Task 6: E2E — extend `desktop.e2e.test.ts`, and the D6 benchmark-harness decision (D5/D6)

**Files:**
- Modify: `packages/webrtc-core/test/e2e/desktop.e2e.test.ts` (control-aware opener + 3 new tests; the 3 Week 7 tests are kept)
- Modify: (only if the D6 decision goes the *benches* way — see Step 7) `apps/agent/Cargo.toml`, `apps/agent/benches/encode_throughput.rs`
- Test: `packages/webrtc-core/test/e2e/desktop.e2e.test.ts` (run by `pnpm --filter @ponter/webrtc-core test:e2e`)

**Interfaces:**
- Consumes (from Tasks 1–5): the `'control'` label; `desktop-sources`/`desktop-bitrate`/`desktop-select`/`desktop-stats` frames (Task 1 types, Task 4a–4e agent); the agent CLI `--desktop-source test`; the `desktop session loop finished` log line (Task 4a); `DesktopSourceInfo`/`DesktopStats` from `@ponter/shared`.
- Produces: nothing later code depends on — this is the last code task. (Task 7 is docs only.)

> **The opener gains the control channel, and that changes *why* teardown works.** Week 7's `openDesktopPeer` used `channelLabels: []` because a desktop session had no data channel; the peer-close test then relied on ICE silence (the shortened media-only timeouts, ~8s). Week 8's desktop peer carries the `'control'` channel, so `build_peer` now gives it the RFC-shaped ICE defaults (Task 4a) and the close signal is the **channel** close — the terminal path's signal, and a prompt one. So the opener moves to `channelLabels: ['control']` and the three Week 7 *assertions* stay byte-for-byte; only the comment explaining the close signal changes. This is the "extended, not replaced" regression guard spec §8.3 asks for.

- [ ] **Step 1: Make the opener control-aware**

In `packages/webrtc-core/test/e2e/desktop.e2e.test.ts`, add the type import beside the existing ones:

```typescript
import type {
  DataChannelMessage,
  DesktopSourceInfo,
  DesktopStats,
} from '@ponter/shared';
```

Replace `openDesktopPeer` with the control-aware version. The `control` flag defaults to `true`, so every call site in this file gets the control channel; the parameter exists so a future test can still open a bare media peer:

```typescript
  async function openDesktopPeer(
    sessionId: string,
    token: string,
    { control = true }: { control?: boolean } = {},
  ): Promise<{
    offerer: PeerConnection;
    tracks: WeriftTrack[];
    packets: RtpPacket[];
    controlFrames: Array<DataChannelMessage<unknown>>;
  }> {
    const transport = new RESTPollingTransport({
      baseUrl: BASE_URL,
      sessionId,
      token,
    });
    const offerer = new PeerConnection(
      new WeriftAdapter({ iceServers: [], codecs: { video: [useH264()] } }),
      transport,
      {
        role: 'offerer',
        // Week 8: the desktop session carries a `control` channel. The media
        // path is unchanged; the label rides the existing manager (spec §5.2).
        channelLabels: control ? ['control'] : [],
        capabilities: ['desktop'],
        media: { video: true },
      },
    );

    const tracks: WeriftTrack[] = [];
    const packets: RtpPacket[] = [];
    offerer.onRemoteTrack((track) => {
      const wt = track as unknown as WeriftTrack;
      tracks.push(wt);
      // Subscribe in the same turn the track is announced, so a packet that
      // arrives immediately after is not missed.
      wt.onReceiveRtp.subscribe((pkt) => packets.push(pkt));
    });

    // Register the control listener BEFORE `start()`: the agent sends
    // `desktop-sources` as soon as the channel opens, and the manager drops a
    // message that arrives with no typed listener registered (no replay —
    // `data-channel.ts` only fans out to listeners present at delivery time).
    // The channel itself is registered in the `PeerConnection` constructor
    // (the offerer pre-create block), so the listener must exist before the
    // offer goes out.
    const controlFrames: Array<DataChannelMessage<unknown>> = [];
    if (control) {
      offerer.dataChannels.onMessage('control', (msg) => controlFrames.push(msg));
    }

    await offerer.start();
    if (control) {
      const channel = await offerer.waitForChannel('control', 20_000);
      expect(channel.readyState).toBe('open');
    }
    return { offerer, tracks, packets, controlFrames };
  }
```

- [ ] **Step 2: Update the teardown test's comment (assertions unchanged)**

In the peer-close test (`ends the agent session on peer close and serves the next offer`), the assertions stay exactly as they are. Replace only the comment block that explains the close signal — it now describes the control channel, not ICE silence:

```typescript
    // werift's `pc.close()` tears down the SCTP association, so the agent sees
    // the `control` channel close and ends the session promptly (the same
    // signal the terminal path uses). Week 7 had no data channel here and
    // depended on the shortened media-only ICE timeouts; that path is gone —
    // a desktop peer with a control channel keeps the RFC-shaped defaults
    // (Task 4a), so the close must arrive through the channel, not ICE.
    await first.offerer.close();
```

- [ ] **Step 3: Run the suite — the three Week 7 tests must still pass**

Run: `cargo build --manifest-path apps/agent/Cargo.toml --locked && pnpm --filter @ponter/webrtc-core test:e2e`
Expected: PASS — the 3 Week 7 tests (track + RTP + IDR; peer-close teardown + second session; terminal unaffected) are green with the control channel present. A failure here means the control channel disturbed the media path, which is the regression this step exists to catch.

> The agent binary must be built first: the harness spawns `apps/agent/target/debug/ponter-agent`. On a host without the capture stack this still builds — `xcap`/`openh264` are runtime-only for `--desktop-source screen`, and this suite always passes `test`.

- [ ] **Step 4: Add the control-channel test**

```typescript
  // Review Focus: the control channel is the new inbound surface, so the first
  // thing to pin is that it opens and the agent enumerates onto it (spec §8.3).
  it('opens a control channel and enumerates the default test source', async () => {
    const { token, agentId, credential, sessionId } = await seed({
      capabilities: ['desktop'],
    });

    spawnAgent(agentId, credential, ['--desktop-source', 'test']);
    await waitForAgentOnline(token, agentId);

    const { offerer, controlFrames } = await openDesktopPeer(sessionId, token);
    try {
      await waitFor(
        () => controlFrames.some((f) => f.type === 'desktop-sources'),
        'a desktop-sources frame on the control channel',
        20_000,
      );

      const frame = controlFrames.find((f) => f.type === 'desktop-sources')!;
      expect(frame.channel).toBe('control');
      const sources = (frame.payload as { sources: DesktopSourceInfo[] }).sources;

      // `--desktop-source test` enumerates exactly one entry, flagged default —
      // which is why CI never has to send `desktop-select` (ADR-22).
      expect(sources).toHaveLength(1);
      expect(sources[0]!.id).toBe('test:0');
      expect(sources[0]!.default).toBe(true);
      expect(sources[0]!.kind).toBe('monitor');
      // The geometry fields Week 9's input mapping will need are on the wire.
      expect(sources[0]!.width).toBe(1280);
      expect(sources[0]!.height).toBe(720);
      expect(sources[0]!.scaleFactor).toBe(1);
    } finally {
      await offerer.close();
    }
  }, 120_000);
```

- [ ] **Step 5: Add the manual-bitrate test**

```typescript
  // The wire path and the stats echo, not the encoder internals (those are
  // Rust unit tests, Task 4b). Pins spec §2.3 step 6.
  it('applies a manual bitrate and reflects it in a later desktop-stats', async () => {
    const { token, agentId, credential, sessionId } = await seed({
      capabilities: ['desktop'],
    });

    spawnAgent(agentId, credential, ['--desktop-source', 'test']);
    await waitForAgentOnline(token, agentId);

    const { offerer, controlFrames } = await openDesktopPeer(sessionId, token);
    const stats = (): DesktopStats[] =>
      controlFrames
        .filter((f) => f.type === 'desktop-stats')
        .map((f) => f.payload as DesktopStats);

    try {
      // The stream emits a first `desktop-stats` on its first encoded frame.
      await waitFor(() => stats().length > 0, 'an initial desktop-stats', 20_000);

      offerer.dataChannels.sendJson('control', 'desktop-bitrate', {
        bitrateBps: 3_000_000,
      });

      await waitFor(
        () => stats().some((s) => s.targetBitrateBps === 3_000_000),
        'a desktop-stats echoing the 3 Mbps target',
        20_000,
      );
    } finally {
      await offerer.close();
    }
  }, 120_000);
```

- [ ] **Step 6: Add the refused-selection test**

```typescript
  // The §2.2 error contract: an unknown id is refused, the stream keeps
  // running, and the refusal arrives as `status.kind = 'select-refused'` on a
  // `desktop-stats` — never as a dedicated error frame, and never as a source
  // the agent did not enumerate (spec §9).
  it('refuses an unknown desktop-select and keeps streaming', async () => {
    const { token, agentId, credential, sessionId } = await seed({
      capabilities: ['desktop'],
    });

    spawnAgent(agentId, credential, ['--desktop-source', 'test']);
    await waitForAgentOnline(token, agentId);

    const { offerer, packets, controlFrames } = await openDesktopPeer(
      sessionId,
      token,
    );
    try {
      await waitFor(
        () => controlFrames.some((f) => f.type === 'desktop-sources'),
        'the source enumeration',
        20_000,
      );

      const before = packets.length;
      offerer.dataChannels.sendJson('control', 'desktop-select', {
        sourceId: 'monitor:999999',
      });

      await waitFor(
        () =>
          controlFrames.some(
            (f) =>
              f.type === 'desktop-stats' &&
              (f.payload as DesktopStats).status?.kind === 'select-refused',
          ),
        'a select-refused status on desktop-stats',
        20_000,
      );

      // The refusal must not have killed the stream: RTP keeps flowing.
      await waitFor(
        () => packets.length > before,
        'continued RTP after a refused selection',
        15_000,
      );
    } finally {
      await offerer.close();
    }
  }, 120_000);
```

- [ ] **Step 7: Run the full E2E suite**

Run: `pnpm --filter @ponter/webrtc-core test:e2e`
Expected: PASS — the 3 Week 7 tests plus the 3 new ones (6 total in `desktop.e2e.test.ts`), and every other E2E file unchanged.

- [ ] **Step 8: Decide D6 — where the benchmark harness lives**

Spec §10.1 leaves D6 open ("`apps/agent/benches/` **or** recorded verbatim in this spec's Appendix A"). Both options are real; here is the decision with its trade-offs.

**Option A — commit it as a Cargo bench target in `apps/agent/benches/`.**

```toml
# apps/agent/Cargo.toml
[[bench]]
name = "encode_throughput"
harness = false
```

`apps/agent/benches/encode_throughput.rs` is the Appendix A `main`, renamed and with its `Cargo.toml` collapsed into the agent's (it needs only `openh264`, which is already a non-musl dependency).

| | Option A — `apps/agent/benches/` |
|---|---|
| **Pro** | One command rebuilds it (`cargo bench -p ponter-agent --bench encode_throughput`); it lives with the code it measures. |
| **Pro** | `cargo clippy --all-targets` (the `Build Agent / Verify` gate) and `cargo test` compile it, so it cannot silently rot. |
| **Con** | It becomes part of the `Build Agent / Verify` gate's compile surface: `--all-targets` and `cargo test` now build the bench, and it must be warning-clean under `-D warnings`. |
| **Con** | Cargo cannot express a `cfg(target_env = "musl")` gate for a bench target, so the bench depends on `openh264` unconditionally while `openh264` is a non-musl-only dependency. No current CI leg hits it (the musl leg runs `cargo build`, not `--all-targets`/`test`), but it is a latent footgun for anyone who runs `cargo clippy --all-targets --target x86_64-unknown-linux-musl`. |
| **Con** | The harness is a standalone crate in the spec (its own `Cargo.toml`, `enc-bench`); porting it into the agent crate is extra work for a measurement nothing gates. |

**Option B — record it verbatim in the spec's Appendix A (the current state).**

| | Option B — Appendix A verbatim |
|---|---|
| **Pro** | Already written verbatim, with the exact Docker command that reproduces §3.1 (spec Appendix A). Zero new repo surface, zero risk to any gate, including the musl leg. |
| **Pro** | The measurement is a one-off reproduction of §3.1, not a tracked metric — there is no perf-regression gate for it to feed, so CI compilation buys nothing. |
| **Con** | Not compiled by CI, so it can rot if `openh264`'s API moves; the Docker command pins `rust:1.98-bookworm` and `openh264 = "0.9.8"`, which bounds the drift. |

**Recommendation: Option B.** The spec already contains the harness verbatim, the numbers it produces are cited as a one-off finding (§3.1) rather than a gated target, and Option A's only real benefit — CI compilation — is outweighed by adding a bench target to the exact gate (`Build Agent / Verify`, `--all-targets`) that must stay green, plus a musl edge Cargo cannot express. If the team later wants it tracked, Option A's `[[bench]]` block above is the mechanical switch.

- [ ] **Step 9: Verify the D6 harness reproduces (Option B)**

Run the spec's Appendix A command (Docker, offline against the cargo registry cache):

```bash
mkdir -p /tmp/enc-bench/src   # paste Cargo.toml + src/main.rs from spec Appendix A
docker run --rm --user "$(id -u):$(id -g)" \
  -e CARGO_HOME=/usr/local/cargo -e RUSTUP_HOME=/usr/local/rustup -e HOME=/tmp \
  -v "$HOME/.cargo:/usr/local/cargo" -v /tmp/enc-bench:/work -w /work \
  rust:1.98-bookworm bash -c \
  'export PATH=/usr/local/cargo/bin:/usr/bin:/bin; cargo run --release --offline'
```

Expected: the §3.1 shape — `1080p30 ≈ 28 ms/frame → ~1.2×`, `720p30 ≈ 11 ms → ~2.9×`, `1080p60 ≈ 28 ms → ~0.6×`. Record the actual numbers in the PR body (a different host will differ; the *ordering* — 720p30 comfortable, 1080p30 marginal, 1080p60 infeasible — is the claim). If Docker is unavailable on the dev host, note that in the PR and leave the harness as recorded; QA can run it.

- [ ] **Step 10: Confirm no CI change is required**

Spec §8.5: the control channel is SCTP over the existing transport, and `ci-e2e.yml`'s `Cross-language terminal E2E` job already installs the capture stack and builds the agent before `pnpm --filter @ponter/webrtc-core test:e2e`, which picks up the extended file automatically. Read `.github/workflows/ci-e2e.yml` and confirm: no new step, no new dependency. If a step *were* needed it would belong in that job — **not** in a `ci.yml`, which no longer exists.

- [ ] **Step 11: Commit**

```bash
git add packages/webrtc-core/test/e2e/desktop.e2e.test.ts
git commit -m "test(e2e): control channel, manual bitrate, and refused-selection coverage"
```

---

### Task 7: `docs/ARCHITECTURE.md` reconciliation, recorded demo, and closeout (D7/D8)

**Files:**
- Modify: `docs/ARCHITECTURE.md` (§8 roadmap line 941-944, §11 perf table line 1080-1081)
- Create: `docs/superpowers/specs/2026-10-03-phase3-week8-demo.md` (the recorded demo's checklist and results)
- Modify: (none otherwise — this task runs the gates and records outcomes)

**Interfaces:**
- Consumes: every artifact from Tasks 1–6.
- Produces: the reconciled ARCHITECTURE.md, the demo record, the PR.

> **D8 is NOT already done.** The Week 8 spec PR (#24, merged `f8c2c97`) was **spec-only** — it did not touch `docs/ARCHITECTURE.md`. So the two drifts the spec describes (§11) are still present on `main` today, and this task is where they are actually fixed:
> - `docs/ARCHITECTURE.md:1081` still reads `| Desktop stream (Phase 3 target) | 60fps | Hardware H.265 |` — and H.265 is not viable in WebRTC (spec §3.5). This row is **wrong** and is replaced, not merely annotated.
> - The roadmap §8 Week 8-9 list (`docs/ARCHITECTURE.md:941-944`) still shows every Week 8 item unchecked.
>
> Verify the drifts are still present before editing (`git log -1 --format=%h docs/ARCHITECTURE.md` and read the two line ranges); if a later PR has already reconciled them, re-check that the wording matches spec §11 and adjust rather than duplicate.

> **Language:** Historical note: `docs/ARCHITECTURE.md` section headers were previously in Vietnamese (`## 8. Implementation Roadmap`, `## 11. Performance Targets`), but all repository documentation has been standardized to English.

- [x] **Step 1: Fix the perf-table row (the H.265 drift)**

In `docs/ARCHITECTURE.md` §11 (Performance Targets, `docs/ARCHITECTURE.md:1080-1081`), the two desktop rows are:

```markdown
| Desktop stream (Week 7) | ~720p @ 15fps, view-only | Software H.264 (openh264) |
| Desktop stream (Phase 3 target) | 60fps | Hardware H.265 |
```

The second row names H.265 as an achievable target, which §3.5 establishes is **not viable in WebRTC**. Replace **both** rows with the Week 8 reality plus a clearly spike-gated future row:

```markdown
| Desktop stream (Week 8) | 1080p30 (baseline 720p30) | Software H.264 (openh264) |
| Desktop stream (hardware, future) | 60fps | H.264 hardware / AV1 — spike ADR-25, unconfirmed |
```

Rationale for the wording: `1080p30` with `720p30` as the guaranteed floor is ADR-24's conditional target; the hardware row now names the *viable* alternatives (hardware H.264 / AV1) and marks them as the **ADR-25 spike, not committed**, so the file no longer promises a codec WebRTC cannot carry.

- [x] **Step 2: Mark the Week 8 items in the roadmap §8**

In `docs/ARCHITECTURE.md:941-944`, the list is currently:

```markdown
#### Weeks 8-9: Quality & Interaction (upcoming)
- [ ] Increase quality/frame rate, adaptive bitrate
- [ ] Mouse & keyboard control (input forwarding) — currently view-only (ADR-18)
- [ ] Select display/window, hardware codec
```

Split it into a **done Week 8** sub-block and a **still-open** block, so the unchecked items name only what is actually left (input forwarding → Week 9 / Spec B; hardware codec → ADR-25 spike):

```markdown
#### Weeks 8-9: Quality & Interaction (upcoming)

##### Week 8: Quality & Source Selection (completed)
- [x] Quality profile 1080p30 (baseline 720p30), load-adaptive fallback (ADR-24)
- [x] Manual bitrate control, in-place retarget without rebuild (ADR-23)
- [x] GCC auto-ABR — goal, validated by spike §3.7 (not an acceptance criterion)
- [x] Select display/window, time-bounded source switching (ADR-22)
- [ ] Hardware codec (H.264 hardware / AV1) — spike ADR-25, uncommitted

##### Remaining (Week 9 — Spec B)
- [ ] Mouse & keyboard control (input forwarding) — currently view-only (ADR-18)
```

> The `##### Week 8` sub-heading and the split keep the roadmap's `####`/`#####` convention (the file already uses `####` under a `### Phase` block). The input-forwarding item moves under an explicit "Week 9 — Spec B" block so it stays unchecked and owned by the Week 9 spec, not silently dropped. The auto-ABR line is ticked **and** annotated as a goal, matching spec §10.2's "not an acceptance criterion".

- [x] **Step 3: Confirm the Phase 4 stub is untouched**

Spec §11: Phase 4's stub (`docs/ARCHITECTURE.md:946-948`, `### Phase 4: File Transfer (Weeks 10-11)` + its "Not yet designed" note) is **not** in scope. Confirm the edit in Steps 1-2 changed nothing between line 946 and `### Phase 5`.

- [x] **Step 4: Verify the file is still valid Markdown and the table renders**

Run (the repo has no configured markdown linter, so this is a manual read; if `markdownlint-cli2` is available, prefer it):

```bash
pnpm exec markdownlint-cli2 docs/ARCHITECTURE.md 2>/dev/null || \
  grep -n "^| Desktop stream" docs/ARCHITECTURE.md
```

Expected: the two desktop rows have the same three-column shape as their neighbours (each line has exactly two `|` separators around three cells), and no `|` inside a cell breaks the table. Visually confirm the §11 table and the §8 list render.

- [x] **Step 5: Run the full local verification sweep**

Run each, in order, and do not proceed on a red result:

```bash
pnpm lint && pnpm typecheck && pnpm test
cargo fmt --manifest-path apps/agent/Cargo.toml --check
cargo clippy --manifest-path apps/agent/Cargo.toml --all-targets --locked -- -D warnings
cargo test --manifest-path apps/agent/Cargo.toml --locked
pnpm --filter @ponter/webrtc-core test:e2e
```

Expected: all PASS. This is the local mirror of the current CI gates — `CI (Node) / Lint, Typecheck, Format & Node Tests`, `Build Agent / Verify`, `CI (E2E) / Cross-language terminal E2E` — so a green run here means CI has no surprise waiting. (There is no `ci.yml`; the old single-workflow jobs were split into `ci-node.yml` / `ci-e2e.yml` / `build-agent.yml`.)

- [x] **Step 6: Record the manual Chrome demo**

> Manual rows **not gated** — owner decision (2026-10-03); no recording artifact exists. The demo doc reports the automated real-screen evidence and marks the manual rows not observed — see `docs/superpowers/specs/2026-10-03-phase3-week8-demo.md`.

Follow spec §8.4. The recording is saved **outside the repo** (it is a large binary and is not committed). Write its location and the observed results into `docs/superpowers/specs/2026-10-03-phase3-week8-demo.md`:

```markdown
# Phase 3 Week 8 — Stream Quality & Source Selection Demo

**Date:** <YYYY-MM-DD>
**Machine:** Fedora <version>, Wayland session
**Agent:** `ponter-agent --desktop-source screen` (build <short sha>), profile 1080p30
**Recording:** <path or link outside the repo>

## Observed

| Check | Result |
|---|---|
| Stream appears immediately on the default (primary) source at 1080p30 | ✅ / ❌ |
| Picker lists monitors/windows | ✅ / ❌ |
| Switching source changes the stream (brief blip), stats update | ✅ / ❌ |
| Bitrate control changes the stream, `desktop-stats` reflects it | ✅ / ❌ |
| 720p30 fallback + `quality-downgraded` note on a host that cannot sustain 1080p30 | ✅ / ❌ / N/A |
| LAN glass-to-glass latency observed < 200 ms (informal, not gated) | ✅ / ❌ |
| Video stays view-only (no input forwarded) | ✅ / ❌ |

## Notes

<the Task 3 `ScreenContentRealTime` IDR finding, any deviation, frame rate under load>
```

> **Carry the Task 3 watch-item finding here.** If `screen_content_usage_emits_an_idr_only_on_the_first_frame` (Task 3, Step 9) failed — `ScreenContentRealTime` emitting an IDR every frame — say so in the Notes and in the PR body: it does not make the fallback wrong, but it changes what the "brief blip" on a source switch looks like. Confirm the finding before recording.

- [x] **Step 7: Confirm every acceptance criterion (spec §10.2)**

Walk spec §10.2 and tick each against evidence. **Auto-ABR and the ADR-25 hardware spike are explicitly NOT acceptance criteria** — they appear only as goals/annotations, never as a gated row:

| # | Criterion (spec §10.2) | Evidence |
|---|---|---|
| 1 | `cargo test --locked` passes with the new unit tests on Linux; musl target still builds | Step 5 + `Build Agent / Verify` + `Build Agent / Linux/x64-musl` |
| 2 | `pnpm lint && typecheck && test` pass workspace-wide including new test surfaces | Step 5 + `CI (Node) / Lint, Typecheck, Format & Node Tests` |
| 3 | E2E `desktop.e2e.test.ts` passes: control channel + one `default: true` source; a `desktop-bitrate` reflected in a later `desktop-stats`; Week 7 media assertions still pass | Step 5 + `CI (E2E) / Cross-language terminal E2E` (Task 6, Steps 4-6 + 1-3) |
| 4 | Terminal E2E suite passes unchanged | Step 5 + `CI (E2E) / Cross-language terminal E2E` (Task 6, Step 3) |
| 5 | Recorded demo shows real-screen 1080p30 (or the 720p30 fallback), picker, working switch, visible bitrate change, LAN latency < 200 ms (informal) | Step 6 |
| 6 | `ARCHITECTURE.md` records the Week 8 scope and the perf row no longer names H.265 as an achievable target | Steps 1-4 |

**Not gated (goals only):** GCC auto-ABR (ADR-23, confirmed by the spike §3.7) and the ADR-25 hardware-codec spike. If a reviewer asks to gate either, that is a scope change for a later spec, not this PR.

- [x] **Step 8: Open the PR**

Per repo convention (`docs(spec)` → `docs(plan)` → `feat`/`test` → `docs(architecture)`), the branch already carries each commit from Tasks 1–7. Open one PR to `main`:

```bash
git push -u origin feat/phase3-week8-stream-quality
gh pr create --base main --title "feat(phase3): Week 8 — stream quality profiles, source picker, and manual bitrate" --body "$(cat <<'EOF'
## Summary

Phase 3 Week 8 turns the Week 7 view-only ~720p15 desktop stream into a usable one: a resolved quality profile (1080p30 default, 720p30 floor), a browser-driven manual bitrate applied in place (no rebuild, no keyframe blip), a screen/window source picker that switches the live stream, a best-effort `desktop-stats` telemetry line, and GCC-driven auto-ABR — all over one new `'control'` data channel. The terminal flow is byte-identical.

Spec: `docs/superpowers/specs/2026-10-03-phase3-week8-stream-quality-design.md`
Plan: `docs/superpowers/plans/2026-10-03-phase3-week8-stream-quality.md`

## Scope

- `packages/shared`: `types/desktop.ts` (source/stats wire types)
- `packages/desktop-core`: `DesktopClient` control surface
- `apps/agent`: `StreamProfile`, source enumeration + `WindowSource`, control channel + dispatcher, in-place bitrate retarget (ADR-23), bounded source swap (ADR-22), sustain fallback (ADR-24)
- `apps/web`: store control wiring + `DesktopView` picker/bitrate/stats chrome
- E2E extensions; `ARCHITECTURE.md` reconciliation

## Not gated

Auto-ABR and the ADR-25 hardware-codec spike are goals, not acceptance criteria (spec §10.2).

## Not in scope (Week 9 / Spec B)

Input forwarding (mouse/keyboard) — the video stays view-only.

## Test plan

- [ ] `pnpm lint && pnpm typecheck && pnpm test`
- [ ] `cargo clippy --all-targets --locked -- -D warnings` && `cargo test --locked`
- [ ] `pnpm --filter @ponter/webrtc-core test:e2e`
- [ ] Manual Chrome demo (link in PR comment)
EOF
)"
```

> **Coordination:** one PR in flight at a time (repo convention). Rebase onto `main` after the Week 9 spec (#25) merges if it lands first.

- [x] **Step 9: Record the PR number and hand off**

> PR #27 — merged into `main` as `82fa821` (squash, 2026-10-03). No recording artifact exists; the demo's status and evidence live in `docs/superpowers/specs/2026-10-03-phase3-week8-demo.md` (Step 6).

Note the PR URL. The demo recording (Step 6) is attached as a PR comment, not committed. No further commits are expected on the branch until review.
