# Phase 3 Week 7 — Desktop Streaming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A browser workspace tab opens a view-only desktop stream from an agent: the browser negotiates a receive-only H.264 video session, the Rust agent captures the screen (or a deterministic test pattern in CI), encodes ~720p at 15 fps with software openh264, and streams it over the existing WebRTC DTLS/SRTP connection.

**Architecture:** Desktop is a session *mode* selected from the offer's capabilities before the answer is built (ADR-15). `packages/webrtc-core` grows a two-member optional media seam (`addTransceiver?`/`onTrack?`) plus `media-channel.ts` (closes ADR-06); `packages/desktop-core` wraps the first remote track in a DOM-free `DesktopClient`; the Rust agent adds `desktop.rs` (FrameSource → downscale/crop-to-even → openh264 → `TrackLocalStaticSample`) and an `attach_desktop_track` answer path in `rtc.rs`; the web store adds `openDesktopTab` with client-side per-agent exclusivity (ADR-19). The terminal flow stays byte-identical.

**Tech Stack:** TypeScript (webrtc-core, desktop-core, Vue 3 + Pinia web), werift (unit + E2E offerer), Rust (webrtc/rtc 0.21, openh264 0.9.8, xcap 0.9.8, tokio), vitest + cargo test, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-01-phase3-week7-desktop-streaming-design.md`

## Global Constraints

- **Precondition — do not start implementation until both PRs merge:** `fix/agent-session-dead-peer` (PR #12, merged) and `chore/deps-upgrade` (webrtc/rtc 0.21) must both be on `main`. Open `feat/phase3-week7-desktop-streaming` from a fresh rebase of `main`, in a **separate worktree** (e.g. `.claude/worktrees/phase3-week7`) — never `git checkout` in the shared working directory.
- **Repo rules:** `apps/server` must NOT runtime-value-import `@ponter/shared` (type-only is fine). GitHub URLs use `ngotuananh101`; Docker Hub namespace is `ngtuananh2011`.
- **No new `@ponter/shared` types:** `WebRTCChannelType` already includes `'desktop'`; desktop streaming uses no `DataChannelMessage` frames at all.
- **Terminal path stays byte-identical:** offer capabilities fall back to `channelLabels` (`capabilities ?? channelLabels`); existing terminal call sites pass no `capabilities` and must not change behavior.
- **Media seam members are optional:** `addTransceiver?`/`onTrack?` stay optional on `RTCPeerConnectionLike` so every existing mock and `OrderRecorder` keeps typechecking; adapters that lack them are rejected with a descriptive error when `media.video` is requested (fail fast, never silently).
- **No manual Annex-B start-code insertion:** openh264 NAL units already carry `00 00 00 01`; `write_sample` payloads are passed through untouched.
- **Even-dimension guard:** every path into `RgbaSliceU8::new` goes through `crop_to_even` — the panic in openh264's `RgbaSliceU8::new` is unreachable from production frames.
- **Rust deps:** add `bytes = "1"`, `openh264 = "0.9.8"`, and `xcap = "0.9.8"` under `[target.'cfg(not(target_env = "musl"))'.dependencies]` (all three are gated: `openh264-sys2` needs a C++ compiler cc-rs cannot provide for musl — see Task 3). Keep `webrtc = "0.21"` / `rtc = "0.21"` and `rust-version = "1.85"` unchanged. No custom codec registration (default PT 102 H.264 is used).
- **Week 7 scope:** view-only (no input), ~720p, 15 fps, software H.264, one desktop session per agent at a time (ADR-14/ADR-19). Linux is the runnable platform; macOS/Windows must compile and pass unit tests only.
- **Agent source selection:** `--desktop-source <screen|test>` (env `AGENT_DESKTOP_SOURCE`), default `screen`; E2E always passes `test`.
- **English for all repo artifacts:** code, comments, commit messages, and docs stay English (repo technical docs convention).

## Review Focus

The spec's six highest-risk behaviors, each pinned to the test in the task that owns the code:

1. **Order of operations in the desktop answer:** `add_track` must run strictly before `set_remote_description` (ADR-15) — a swapped order produces an answer without the sendonly m-line. Pinned in **Task 6, E2E Test 1** (the track never arrives if the order is wrong) and structurally guaranteed in **Task 4, Step 10** (`run_desktop_session` calls `attach_desktop_track` before `send_desktop_answer`).
2. **Annex-B handling:** no manual start-code prepending anywhere; every emitted NAL begins with an existing `00 00 00 01`. Pinned in **Task 3, encoder smoke test** (`every NAL starts with 00 00 00 01`).
3. **Even-dimension guard:** every path into `RgbaSliceU8::new` goes through `crop_to_even`; the encoder cannot panic on odd capture dimensions. Pinned in **Task 3, downscale/crop_to_even tests** (odd input → even output, byte length == w·h·4).
4. **Backward compatibility:** terminal offer/answer bytes unchanged; `capabilities ?? channelLabels` fallback keeps every existing call site identical. Pinned in **Task 1, p2p.test.ts additions** (capabilities preference, no data channels when `channelLabels: []`) and **Task 6, E2E Test 3** (terminal flow with the desktop flag present).
5. **Leak check:** `closeTab`, teardown, and failure paths all stop the stream task and close the peer; no orphaned capture (recorder `stop()`) or encoder task survives a session. Pinned in **Task 2, desktop client tests** (`close()` during wait rejects; `close()` idempotent), **Task 5, store closeTab test** (desktop client closed), and **Task 6, E2E Test 2** (peer close ends the agent session; a second session connects).
6. **ADR-19 enforcement:** no network call happens when the exclusivity guard rejects. Pinned in **Task 5, store exclusivity tests** (both directions; no `sessions.create` call).

---

### Task 1: `webrtc-core` media seam — types, `media-channel.ts`, `connection.ts`, adapters

**Files:**
- Modify: `packages/webrtc-core/src/types.ts`
- Create: `packages/webrtc-core/src/media-channel.ts`
- Modify: `packages/webrtc-core/src/connection.ts`
- Modify: `packages/webrtc-core/src/adapters/browser.ts`
- Modify: `packages/webrtc-core/src/adapters/werift.ts`
- Modify: `packages/webrtc-core/src/index.ts`
- Test: `packages/webrtc-core/test/media-channel.test.ts` (create)
- Test: `packages/webrtc-core/test/p2p.test.ts` (extend `OrderRecorder` + add two tests)

**Interfaces:**
- Consumes: existing `RTCPeerConnectionLike`, `PeerConnectionOptions`, `createOfferSignal` (already accepts a capabilities array).
- Produces (relied on by Tasks 2–6):
  - `MediaStreamTrackLike { readonly kind: string }`
  - `MediaStreamLike { getTracks(): MediaStreamTrackLike[] }`
  - `RTCPeerConnectionLike.addTransceiver?(kind: string, options?: { direction?: string }): unknown`
  - `RTCPeerConnectionLike.onTrack?(handler: (track: MediaStreamTrackLike, streams: MediaStreamLike[]) => void): void`
  - `PeerConnectionOptions.capabilities?: string[]` and `PeerConnectionOptions.media?: { video?: boolean }`
  - `configureReceiveMedia(peer: RTCPeerConnectionLike, media: { video?: boolean } | undefined): void`
  - `subscribeRemoteTracks(peer: RTCPeerConnectionLike, handler: (track: MediaStreamTrackLike, streams: MediaStreamLike[]) => void): () => void`
  - `PeerConnection.onRemoteTrack(cb: (track: MediaStreamTrackLike, streams: MediaStreamLike[]) => void): () => void`

- [ ] **Step 1: Write the failing `media-channel` tests**

Create `packages/webrtc-core/test/media-channel.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';
import {
  configureReceiveMedia,
  subscribeRemoteTracks,
} from '../src/media-channel';
import type {
  MediaStreamLike,
  MediaStreamTrackLike,
  RTCPeerConnectionLike,
} from '../src/types';

/** Minimal seam object: only the members each test actually needs. */
function fakePeer(members: Partial<RTCPeerConnectionLike>): RTCPeerConnectionLike {
  return members as RTCPeerConnectionLike;
}

const fakeTrack: MediaStreamTrackLike = { kind: 'video' };
const fakeStreams: MediaStreamLike[] = [];

describe('configureReceiveMedia', () => {
  it('is a no-op when media.video is falsy', () => {
    const addTransceiver = vi.fn();
    configureReceiveMedia(fakePeer({ addTransceiver }), undefined);
    configureReceiveMedia(fakePeer({ addTransceiver }), {});
    configureReceiveMedia(fakePeer({ addTransceiver }), { video: false });
    expect(addTransceiver).not.toHaveBeenCalled();
  });

  it('adds exactly one recvonly video transceiver', () => {
    const addTransceiver = vi.fn();
    configureReceiveMedia(fakePeer({ addTransceiver }), { video: true });
    expect(addTransceiver).toHaveBeenCalledTimes(1);
    expect(addTransceiver).toHaveBeenCalledWith('video', {
      direction: 'recvonly',
    });
  });

  it('throws a descriptive error when the adapter lacks addTransceiver', () => {
    expect(() =>
      configureReceiveMedia(fakePeer({}), { video: true }),
    ).toThrow(/addTransceiver/);
  });
});

describe('subscribeRemoteTracks', () => {
  it('forwards tracks to the handler and unsubscribes cleanly', () => {
    let fire: ((t: MediaStreamTrackLike, s: MediaStreamLike[]) => void) | null =
      null;
    const peer = fakePeer({
      onTrack: (handler) => {
        fire = handler;
      },
    });

    const received: string[] = [];
    const unsubscribe = subscribeRemoteTracks(peer, (track) => {
      received.push(track.kind);
    });

    fire?.(fakeTrack, fakeStreams);
    expect(received).toEqual(['video']);

    unsubscribe();
    fire?.(fakeTrack, fakeStreams);
    expect(received).toEqual(['video']);
  });

  it('throws a descriptive error when the adapter lacks onTrack', () => {
    expect(() => subscribeRemoteTracks(fakePeer({}), () => {})).toThrow(
      /onTrack/,
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @ponter/webrtc-core test media-channel`
Expected: FAIL — `Cannot find module '../src/media-channel'` (the file does not exist yet).

- [ ] **Step 3: Extend the seam in `types.ts`**

Add above `RTCPeerConnectionLike`:

```typescript
export interface MediaStreamTrackLike {
  readonly kind: string;
}

export interface MediaStreamLike {
  getTracks(): MediaStreamTrackLike[];
}
```

Add to `RTCPeerConnectionLike` (after `onDataChannel`):

```typescript
  /**
   * Optional media seam (ADR-06/ADR-20). Optional so every existing mock and
   * adapter keeps typechecking; an adapter that lacks it is rejected with a
   * descriptive error when `media.video` is requested.
   */
  addTransceiver?(kind: string, options?: { direction?: string }): unknown;
  onTrack?(
    handler: (track: MediaStreamTrackLike, streams: MediaStreamLike[]) => void,
  ): void;
```

Add to `PeerConnectionOptions`:

```typescript
  /** Capabilities sent in the offer. Falls back to `channelLabels`. */
  capabilities?: string[];
  /** Request receive-side media setup before the offer is created. */
  media?: { video?: boolean };
```

- [ ] **Step 4: Create `media-channel.ts`**

Create `packages/webrtc-core/src/media-channel.ts`:

```typescript
import type {
  MediaStreamLike,
  MediaStreamTrackLike,
  RTCPeerConnectionLike,
} from './types';

/**
 * Add the receive-only transceivers the offer must contain.
 *
 * Must be called BEFORE `createOffer()`: a transceiver added after the offer is
 * created does not appear in its SDP, so the remote never sends the media.
 *
 * A no-op when `media?.video` is falsy — every terminal call site passes no
 * media and must behave exactly as before.
 */
export function configureReceiveMedia(
  peer: RTCPeerConnectionLike,
  media: { video?: boolean } | undefined,
): void {
  if (!media?.video) return;

  if (!peer.addTransceiver) {
    throw new Error(
      'media.video was requested but this RTCPeerConnectionLike adapter does not implement addTransceiver — the offer would contain no video m-line',
    );
  }

  peer.addTransceiver('video', { direction: 'recvonly' });
}

/**
 * Forward remote tracks to `handler`. Returns an unsubscribe function.
 *
 * Throws when the adapter lacks `onTrack`: an adapter that cannot deliver
 * tracks would produce a stream that silently never arrives, which is worse
 * than a loud error at setup time.
 *
 * The seam has no removal API (matching `onIceCandidate`/`onDataChannel`), so
 * the unsubscriber is a local gate rather than a deregistration: the handler
 * checks a mutable `active` flag, so late tracks stop being delivered here even
 * though the adapter keeps the wrapper registered for the connection's lifetime.
 */
export function subscribeRemoteTracks(
  peer: RTCPeerConnectionLike,
  handler: (track: MediaStreamTrackLike, streams: MediaStreamLike[]) => void,
): () => void {
  if (!peer.onTrack) {
    throw new Error(
      'media.video was requested but this RTCPeerConnectionLike adapter does not implement onTrack — remote tracks could never be delivered',
    );
  }

  let active = true;
  peer.onTrack((track, streams) => {
    if (active) handler(track, streams);
  });

  return () => {
    active = false;
  };
}
```

- [ ] **Step 5: Run the media-channel tests to verify they pass**

Run: `pnpm --filter @ponter/webrtc-core test media-channel`
Expected: PASS (5 tests).

- [ ] **Step 6: Wire `connection.ts`**

In `packages/webrtc-core/src/connection.ts`:

1. Import the new module:

```typescript
import { configureReceiveMedia, subscribeRemoteTracks } from './media-channel';
import type { MediaStreamLike, MediaStreamTrackLike } from './types';
```

2. Add a `trackListeners` field next to `stateListeners`:

```typescript
  private readonly trackListeners: Array<
    (track: MediaStreamTrackLike, streams: MediaStreamLike[]) => void
  > = [];
```

3. In the constructor, after step 3 (state hook), add:

```typescript
    // 3b. Hook remote media tracks when the adapter supports them. The guard
    // keeps every existing mock (which has no onTrack) working untouched.
    if (this.peer.onTrack) {
      subscribeRemoteTracks(this.peer, (track, streams) => {
        for (const listener of [...this.trackListeners]) {
          listener(track, streams);
        }
      });
    }
```

4. Replace the body of `start()` with:

```typescript
  async start(): Promise<void> {
    if (this.isClosed) throw new Error('PeerConnection is closed');
    if (this.options.role !== 'offerer') return;

    // Fail fast BEFORE the offer is created: an adapter that cannot deliver
    // tracks would otherwise produce a stream that silently never arrives.
    if (this.options.media?.video) {
      if (!this.peer.addTransceiver || !this.peer.onTrack) {
        throw new Error(
          'media.video was requested but this adapter does not implement the media seam (addTransceiver/onTrack)',
        );
      }
      configureReceiveMedia(this.peer, this.options.media);
    }

    const offer = await this.peer.createOffer();
    await this.peer.setLocalDescription(offer);
    const capabilities = this.options.capabilities ?? this.options.channelLabels;
    const signal = createOfferSignal('', offer, capabilities);
    await this.transport.send(signal);
  }
```

5. Add the `onRemoteTrack` method after `onConnectionStateChange`:

```typescript
  onRemoteTrack(
    handler: (track: MediaStreamTrackLike, streams: MediaStreamLike[]) => void,
  ): () => void {
    this.trackListeners.push(handler);
    return () => {
      const idx = this.trackListeners.indexOf(handler);
      if (idx >= 0) this.trackListeners.splice(idx, 1);
    };
  }
```

- [ ] **Step 7: Extend the adapters**

In `packages/webrtc-core/src/adapters/browser.ts`:

1. Import the new types:

```typescript
import type {
  RTCPeerConnectionLike,
  RTCDataChannelLike,
  MediaStreamLike,
  MediaStreamTrackLike,
} from '../types';
```

2. Add a `trackHandlers` field:

```typescript
  private readonly trackHandlers: Array<
    (track: MediaStreamTrackLike, streams: MediaStreamLike[]) => void
  > = [];
```

3. In the constructor, after the `connectionstatechange` subscription, add:

```typescript
    this.pc.addEventListener('track', (event) => {
      for (const handler of this.trackHandlers) {
        handler(
          event.track as MediaStreamTrackLike,
          event.streams as MediaStreamLike[],
        );
      }
    });
```

4. Add the two methods (next to `onDataChannel`):

```typescript
  addTransceiver(kind: string, options?: { direction?: string }): unknown {
    return this.pc.addTransceiver(
      kind as 'video',
      options as RTCRtpTransceiverInit,
    );
  }

  onTrack(
    handler: (track: MediaStreamTrackLike, streams: MediaStreamLike[]) => void,
  ): void {
    this.trackHandlers.push(handler);
  }
```

In `packages/webrtc-core/src/adapters/werift.ts`:

1. Import the new types plus `TransceiverOptions` and `RTCRtpCodecParameters`:

```typescript
import { RTCPeerConnection as WeriftPC } from 'werift';
import type { RTCRtpCodecParameters, TransceiverOptions } from 'werift';
import type {
  RTCPeerConnectionLike,
  RTCDataChannelLike,
  MediaStreamLike,
  MediaStreamTrackLike,
} from '../types';
```

2. Add a `trackHandlers` field (same shape as the browser adapter's).

3. In the constructor, after the `connectionStateChange` subscription, add:

```typescript
    // werift fires BOTH onTrack and the DOM-style ontrack for the same track;
    // subscribing to exactly one of them avoids double delivery. `onTrack`
    // carries no streams array, so pass `[]` — consumers must not require it.
    this.pc.onTrack.subscribe((track) => {
      for (const handler of this.trackHandlers) {
        handler(track as MediaStreamTrackLike, []);
      }
    });
```

4. Add the two methods:

```typescript
  addTransceiver(kind: string, options?: { direction?: string }): unknown {
    return this.pc.addTransceiver(
      kind as 'video',
      options as Partial<TransceiverOptions>,
    );
  }

  onTrack(
    handler: (track: MediaStreamTrackLike, streams: MediaStreamLike[]) => void,
  ): void {
    this.trackHandlers.push(handler);
  }
```

5. Accept an optional `codecs` override in the constructor config, so a caller can offer a codec werift does not enable by default. werift's default `video` codec list is VP8-only (`generateDefaultPeerConfig`), and `setConfiguration` **replaces the array wholesale** (its `deepMerge` assigns each top-level key; arrays are not merged element-wise), so passing `{ codecs: { video: [useH264()] } }` is exactly what an H.264 desktop offer needs. This is additive — every existing caller passes `{ iceServers }` only.

Widen the constructor parameter type:

```typescript
  constructor(
    config: {
      iceServers?: IceServerConfig[];
      codecs?: { audio?: RTCRtpCodecParameters[]; video?: RTCRtpCodecParameters[] };
    } = {},
  ) {
```

and pass the codecs through to werift (inside the constructor, where `this.pc` is built):

```typescript
    this.pc = new WeriftPC({
      iceServers: rtcIceServers,
      ...(config.codecs ? { codecs: config.codecs } : {}),
    });
```

> **Why here and not in the E2E test:** the test would otherwise have to construct werift's `RTCPeerConnection` directly and lose the seam wrapper. Keeping the override on the adapter means the E2E drives the same `PeerConnection` code path the browser does, and any future browser-less host can request a codec the same way.

- [ ] **Step 8: Export the module**

In `packages/webrtc-core/src/index.ts`, add:

```typescript
export * from './media-channel';
```

- [ ] **Step 9: Extend `OrderRecorder` in `p2p.test.ts` and add the two seam tests**

In `packages/webrtc-core/test/p2p.test.ts`, extend `OrderRecorder` with a call-order log:

```typescript
class OrderRecorder implements RTCPeerConnectionLike {
  public remoteDescriptionSet = false;
  public violations = 0;
  public addIceCandidateCalls = 0;
  /** Names of calls in the order they were made (seam-order assertions). */
  public readonly callLog: string[] = [];

  constructor(private readonly inner: RTCPeerConnectionLike) {}

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    this.callLog.push('createOffer');
    return await this.inner.createOffer();
  }

  // ...keep every existing member, but prepend a push to callLog:
  //   createAnswer        -> this.callLog.push('createAnswer');
  //   setLocalDescription -> this.callLog.push('setLocalDescription');
  //   setRemoteDescription-> this.callLog.push('setRemoteDescription');
  //   addIceCandidate     -> this.callLog.push('addIceCandidate');
  //   createDataChannel   -> this.callLog.push(`createDataChannel:${label}`);
```

Then delegate the two optional seam members so `PeerConnection` sees them:

```typescript
  addTransceiver(kind: string, options?: { direction?: string }): unknown {
    this.callLog.push(`addTransceiver:${kind}`);
    return this.inner.addTransceiver?.(kind, options);
  }

  onTrack(
    handler: (track: MediaStreamTrackLike, streams: MediaStreamLike[]) => void,
  ): void {
    this.inner.onTrack?.(handler);
  }
```

Add the import for the two types at the top of the file:

```typescript
import type {
  RTCPeerConnectionLike,
  RTCDataChannelLike,
  SignalTransport,
  MediaStreamLike,
  MediaStreamTrackLike,
} from '../src/types';
```

Add the two tests at the end of the `describe('Real P2P Handshake (werift)')` block:

```typescript
  it('sends options.capabilities in the offer instead of channelLabels', async () => {
    const bus = new InProcessBus();
    const tA = bus.createTransport('A', 'B');

    // Capture the offer signal instead of delivering it anywhere.
    const sent: SignalMessage[] = [];
    const capturingTransport: SignalTransport = {
      send: async (msg) => {
        sent.push(msg);
      },
      subscribe: () => () => {},
      close: () => {},
    };
    void tA;

    const adapterA = new WeriftAdapter({ iceServers: [] });
    offererPC = new PeerConnection(adapterA, capturingTransport, {
      role: 'offerer',
      channelLabels: ['terminal'],
      capabilities: ['desktop'],
    });

    await offererPC.start();

    const offer = sent.find((m) => m.type === 'offer');
    expect(offer).toBeDefined();
    expect(offer && offer.type === 'offer' ? offer.data.capabilities : []).toEqual(
      ['desktop'],
    );
  }, 20000);

  it('creates no data channels when channelLabels is empty', async () => {
    const bus = new InProcessBus();
    const tA = bus.createTransport('A', 'B');
    const tB = bus.createTransport('B', 'A');

    // The recorder wraps the OFFERER: `addTransceiver` and `createOffer` are both
    // called on the offerer's peer, so wrapping the answerer would record
    // nothing and every indexOf below would be -1 (making the assertion fail).
    const recorder = new OrderRecorder(new WeriftAdapter({ iceServers: [] }));

    offererPC = new PeerConnection(recorder, tA, {
      role: 'offerer',
      channelLabels: [],
      capabilities: ['desktop'],
      media: { video: true },
    });

    answererPC = new PeerConnection(new WeriftAdapter({ iceServers: [] }), tB, {
      role: 'answerer',
      channelLabels: [],
    });

    await offererPC.start();

    expect(
      recorder.callLog.filter((c) => c.startsWith('createDataChannel:')),
    ).toEqual([]);
    // Review Focus #4: the media transceiver is configured BEFORE the offer is
    // created, or the offer's SDP would contain no video m-line at all.
    expect(recorder.callLog.indexOf('addTransceiver:video')).toBeLessThan(
      recorder.callLog.indexOf('createOffer'),
    );
  }, 20000);
```

- [ ] **Step 10: Run the full webrtc-core suite**

Run: `pnpm --filter @ponter/webrtc-core test`
Expected: PASS — all existing tests plus the new media-channel file and two p2p tests.

- [ ] **Step 11: Typecheck and lint**

Run: `pnpm --filter @ponter/webrtc-core typecheck && pnpm --filter @ponter/webrtc-core lint`
Expected: PASS, no errors.

- [ ] **Step 12: Commit**

```bash
git add packages/webrtc-core/src/types.ts packages/webrtc-core/src/media-channel.ts packages/webrtc-core/src/connection.ts packages/webrtc-core/src/adapters/browser.ts packages/webrtc-core/src/adapters/werift.ts packages/webrtc-core/src/index.ts packages/webrtc-core/test/media-channel.test.ts packages/webrtc-core/test/p2p.test.ts
git commit -m "feat(webrtc-core): add the receive-media seam and media-channel helpers"
```

---

### Task 2: `packages/desktop-core` — DOM-free `DesktopClient`

**Files:**
- Create: `packages/desktop-core/package.json`
- Create: `packages/desktop-core/tsconfig.json`
- Create: `packages/desktop-core/vitest.config.ts`
- Create: `packages/desktop-core/src/types.ts`
- Create: `packages/desktop-core/src/client.ts`
- Create: `packages/desktop-core/src/index.ts`
- Test: `packages/desktop-core/test/client.test.ts`

**Interfaces:**
- Consumes: `PeerConnection.onRemoteTrack`, `PeerConnection.onConnectionStateChange`, `PeerConnection.start()`, `PeerConnection.close()`, `MediaStreamTrackLike`, `MediaStreamLike` (Task 1).
- Produces (relied on by Tasks 5–6):
  - `DesktopStream { track: MediaStreamTrackLike; streams: MediaStreamLike[] }`
  - `DesktopClientOptions { trackTimeoutMs?: number }` (default `20_000`)
  - `DesktopClient` with `constructor(agentId: string, peer: PeerConnection, options?: DesktopClientOptions)`, `start(): Promise<DesktopStream>`, `onConnectionStateChange(handler: (state: string) => void): () => void`, `onError(handler: (message: string) => void): () => void`, `close(): void`

- [ ] **Step 1: Create the package scaffolding**

Create `packages/desktop-core/package.json`:

```json
{
  "name": "@ponter/desktop-core",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "scripts": {
    "lint": "eslint .",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@ponter/shared": "workspace:*",
    "@ponter/webrtc-core": "workspace:*"
  },
  "devDependencies": {
    "@types/node": "24.19.0",
    "typescript": "6.0.3",
    "vitest": "5.0.3"
  }
}
```

> **Versions match the rest of the workspace** (`webrtc-core`/`terminal-core`/`shared` all pin `@types/node` 24.19.0, `vitest` 5.0.3, `typescript` 6.0.3). A second, older `vitest` here would make pnpm resolve two copies and could change snapshot/runner behavior between packages.

Create `packages/desktop-core/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2024", "DOM"],
    "types": ["node"]
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

Create `packages/desktop-core/vitest.config.ts`:

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
  },
});
```

Create `packages/desktop-core/src/index.ts`:

```typescript
export * from './types';
export * from './client';
```

Create `packages/desktop-core/src/types.ts`:

```typescript
import type { MediaStreamLike, MediaStreamTrackLike } from '@ponter/webrtc-core';

/** The first remote video track and whatever streams it belongs to. */
export interface DesktopStream {
  track: MediaStreamTrackLike;
  /** Possibly empty: werift's onTrack path carries no streams array. */
  streams: MediaStreamLike[];
}

export interface DesktopClientOptions {
  /** How long `start()` waits for the first remote track. Default 20_000. */
  trackTimeoutMs?: number;
}
```

- [ ] **Step 2: Write the failing `DesktopClient` tests**

Create `packages/desktop-core/test/client.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';
import { DesktopClient } from '../src/client';
import type {
  MediaStreamLike,
  MediaStreamTrackLike,
} from '@ponter/webrtc-core';
import type { PeerConnection } from '@ponter/webrtc-core';

const fakeTrack: MediaStreamTrackLike = { kind: 'video' };
const fakeStreams: MediaStreamLike[] = [];

/**
 * Mock peer exposing only what DesktopClient touches: start, close,
 * onRemoteTrack, onConnectionStateChange. Mirrors the mock style of
 * terminal-errors.test.ts.
 */
function mockPeer() {
  let trackHandler:
    | ((t: MediaStreamTrackLike, s: MediaStreamLike[]) => void)
    | null = null;
  let stateHandler: ((state: string) => void) | null = null;
  const removeTrackHandler = vi.fn();
  const removeStateHandler = vi.fn();

  return {
    peer: {
      start: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      onRemoteTrack: vi.fn(
        (handler: (t: MediaStreamTrackLike, s: MediaStreamLike[]) => void) => {
          trackHandler = handler;
          return removeTrackHandler;
        },
      ),
      onConnectionStateChange: vi.fn((handler: (state: string) => void) => {
        stateHandler = handler;
        return removeStateHandler;
      }),
    } as unknown as PeerConnection,
    emitTrack: (t: MediaStreamTrackLike, s: MediaStreamLike[]) =>
      trackHandler?.(t, s),
    emitState: (state: string) => stateHandler?.(state),
    removeTrackHandler,
    removeStateHandler,
  };
}

describe('DesktopClient', () => {
  it('resolves with the first remote track', async () => {
    const { peer, emitTrack } = mockPeer();
    const client = new DesktopClient('agent-1', peer);

    const started = client.start();
    emitTrack(fakeTrack, fakeStreams);

    await expect(started).resolves.toEqual({
      track: fakeTrack,
      streams: fakeStreams,
    });
    client.close();
  });

  it('subscribes to tracks before calling peer.start()', async () => {
    const calls: string[] = [];
    const { peer } = mockPeer();
    (peer.onRemoteTrack as ReturnType<typeof vi.fn>).mockImplementation(
      (handler: (t: MediaStreamTrackLike, s: MediaStreamLike[]) => void) => {
        calls.push('onRemoteTrack');
        void handler;
        return () => {};
      },
    );
    (peer.start as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      calls.push('start');
    });

    const client = new DesktopClient('agent-1', peer);
    const started = client.start();
    // The first negotiation tick must not be missed: subscription first.
    expect(calls).toEqual(['onRemoteTrack', 'start']);

    // Settle the promise so the test leaves no pending timer.
    client.close();
    await expect(started).rejects.toThrow(/closed/i);
  });

  it('does not re-resolve when a second track arrives', async () => {
    const { peer, emitTrack } = mockPeer();
    const client = new DesktopClient('agent-1', peer);

    const started = client.start();
    emitTrack(fakeTrack, fakeStreams);
    const first = await started;

    const second: MediaStreamTrackLike = { kind: 'video' };
    emitTrack(second, fakeStreams);

    // The promise resolved once; later tracks are not the first stream.
    expect(first.track).toBe(fakeTrack);
    client.close();
  });

  it('rejects with a timeout when no track arrives', async () => {
    const { peer } = mockPeer();
    const client = new DesktopClient('agent-1', peer, { trackTimeoutMs: 50 });

    await expect(client.start()).rejects.toThrow(/timed out.*50ms/i);
    client.close();
  });

  it('rejects when the connection fails before a track', async () => {
    const { peer, emitState } = mockPeer();
    const client = new DesktopClient('agent-1', peer);

    const started = client.start();
    emitState('failed');

    await expect(started).rejects.toThrow(/failed/i);
    client.close();
  });

  it('rejects when close() is called while waiting', async () => {
    const { peer } = mockPeer();
    const client = new DesktopClient('agent-1', peer);

    const started = client.start();
    client.close();

    await expect(started).rejects.toThrow(/closed/i);
  });

  it('close() is idempotent and closes the peer exactly once', async () => {
    const { peer } = mockPeer();
    const client = new DesktopClient('agent-1', peer);

    client.close();
    client.close();

    expect(peer.close).toHaveBeenCalledTimes(1);
  });

  it('forwards connection state changes to handlers', async () => {
    const { peer, emitState } = mockPeer();
    const client = new DesktopClient('agent-1', peer);

    const states: string[] = [];
    const unsubscribe = client.onConnectionStateChange((s) => states.push(s));

    emitState('connecting');
    unsubscribe();
    emitState('connected');

    expect(states).toEqual(['connecting']);
    client.close();
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm install && pnpm --filter @ponter/desktop-core test`
Expected: FAIL — `Cannot find module '../src/client'`.

- [ ] **Step 4: Implement `DesktopClient`**

Create `packages/desktop-core/src/client.ts`:

```typescript
import type { PeerConnection } from '@ponter/webrtc-core';
import type { MediaStreamLike, MediaStreamTrackLike } from '@ponter/webrtc-core';
import type { DesktopClientOptions, DesktopStream } from './types';

const DEFAULT_TRACK_TIMEOUT_MS = 20_000;

/**
 * The desktop twin of `TerminalClient`: DOM-free, unit-testable, and the same
 * object the E2E suite drives. It never creates a data channel and never
 * touches the DOM — it owns exactly one thing, the first remote video track.
 */
export class DesktopClient {
  private readonly trackTimeoutMs: number;
  private readonly stateListeners: Array<(state: string) => void> = [];
  private readonly errorListeners: Array<(message: string) => void> = [];
  private closed = false;
  private started = false;
  /** Rejects the in-flight `start()` when `close()` is called while waiting. */
  private pendingReject: ((error: Error) => void) | null = null;

  constructor(
    public readonly agentId: string,
    private readonly peer: PeerConnection,
    options?: DesktopClientOptions,
  ) {
    this.trackTimeoutMs = options?.trackTimeoutMs ?? DEFAULT_TRACK_TIMEOUT_MS;
  }

  /**
   * Run the offer/answer handshake and resolve with the first remote track.
   *
   * The track subscription is registered BEFORE `peer.start()`: a track can
   * arrive in the very first negotiation tick, and missing it would turn into
   * a full `trackTimeoutMs` wait for a stream that is already flowing.
   */
  async start(): Promise<DesktopStream> {
    if (this.closed) throw new Error('DesktopClient is closed');

    let resolveTrack!: (stream: DesktopStream) => void;
    let rejectTrack!: (error: Error) => void;
    const trackPromise = new Promise<DesktopStream>((resolve, reject) => {
      resolveTrack = resolve;
      rejectTrack = reject;
    });

    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };
    // `close()` rejects through this hook rather than relying on the peer to
    // emit a state event: the mock peer does not, and a real `close()` should
    // not depend on event timing to fail the pending wait.
    this.pendingReject = (error) => settle(() => rejectTrack(error));

    const removeTrackHandler = this.peer.onRemoteTrack((track, streams) => {
      settle(() => resolveTrack({ track, streams }));
    });

    const removeStateHandler = this.peer.onConnectionStateChange((state) => {
      for (const listener of [...this.stateListeners]) {
        listener(state);
      }
      if (state === 'failed' || state === 'closed') {
        settle(() =>
          rejectTrack(new Error(`the connection ${state} before a track arrived`)),
        );
      }
    });

    const timeout = setTimeout(() => {
      settle(() =>
        rejectTrack(
          new Error(
            `timed out after ${this.trackTimeoutMs}ms waiting for a remote video track`,
          ),
        ),
      );
    }, this.trackTimeoutMs);

    // Every exit path clears the timeout and detaches the listeners; the
    // track listener is intentionally NOT removed on success so a future
    // `close()` is the only thing that ends delivery.
    const cleanup = (keepTrackHandler: boolean) => {
      clearTimeout(timeout);
      this.pendingReject = null;
      if (!keepTrackHandler) removeTrackHandler();
      removeStateHandler();
    };

    try {
      this.started = true;
      await this.peer.start();
    } catch (error) {
      cleanup(false);
      throw error instanceof Error ? error : new Error(String(error));
    }

    try {
      const stream = await trackPromise;
      cleanup(true);
      return stream;
    } catch (error) {
      cleanup(false);
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  onConnectionStateChange(handler: (state: string) => void): () => void {
    this.stateListeners.push(handler);
    return () => {
      const idx = this.stateListeners.indexOf(handler);
      if (idx >= 0) this.stateListeners.splice(idx, 1);
    };
  }

  onError(handler: (message: string) => void): () => void {
    this.errorListeners.push(handler);
    return () => {
      const idx = this.errorListeners.indexOf(handler);
      if (idx >= 0) this.errorListeners.splice(idx, 1);
    };
  }

  /** Idempotent: closes the underlying peer exactly once. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.pendingReject) {
      const reject = this.pendingReject;
      this.pendingReject = null;
      reject(new Error('DesktopClient closed while waiting for a track'));
    }
    void this.peer.close();
  }
}
```

Notes on the exact semantics the tests pin:

- `close()` while waiting rejects the pending `start()` through `pendingReject` (set in `start()`, cleared in `cleanup`) — see the code above; the `settled` gate makes a race with a simultaneous track arrival harmless.

- `onError` listeners are reserved for agent-reported failures; Week 7 has none over a data channel, so the array is currently only consumer wiring. Keep the method — Task 5 subscribes to it.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @ponter/desktop-core test`
Expected: PASS (8 tests).

- [ ] **Step 6: Typecheck and lint the new package**

Run: `pnpm --filter @ponter/desktop-core typecheck && pnpm --filter @ponter/desktop-core lint`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/desktop-core/
git commit -m "feat(desktop-core): add DesktopClient wrapping the first remote track"
```

---

### Task 3: Agent — `desktop.rs` capture → downscale → encode pipeline

**Files:**
- Modify: `apps/agent/Cargo.toml` (cfg-gated `bytes` + `openh264` + `xcap`)
- Modify: `apps/agent/src/main.rs:8-10` (declare `mod desktop;` — cfg-gated to non-musl)
- Create: `apps/agent/src/desktop.rs`
- Test: `apps/agent/src/desktop.rs` (`#[cfg(test)] mod tests` — the binary-crate convention this repo uses; see `main.rs`'s module doc)

**Interfaces:**
- Consumes: `openh264 0.9.8` — `Encoder::with_api_config(OpenH264API::from_source(), EncoderConfig)`, `Encoder::encode(&YUVBuffer) -> EncodedBitStream`, `EncodedBitStream::to_vec()`, `YUVBuffer::from_rgba8_source(RgbaSliceU8::new(&rgba, (w, h)))`; `xcap 0.9.8` — `Monitor::all()`, `Monitor::from_point(i32, i32)`, `Monitor::is_primary()`, `Monitor::video_recorder() -> XCapResult<(VideoRecorder, std::sync::mpsc::Receiver<Frame>)>`, `VideoRecorder::{start, stop}(&self)`, `xcap::Frame { width: u32, height: u32, raw: Vec<u8> }` (RGBA8); `webrtc 0.21` — `TrackLocalStaticSample::{sample_writer, write_sample}`; `rtc 0.21` — `rtc::media::Sample`, `rtc::rtp_transceiver::{SSRC, PayloadType}`.
- Produces (Task 4 consumes these):
  - `pub struct RawFrame { pub width: u32, pub height: u32, pub rgba: Vec<u8> }`
  - `pub trait FrameSource: Send { fn next_frame(&mut self) -> anyhow::Result<Option<RawFrame>>; fn stop(&mut self); }`
  - `pub struct TestPatternSource` with `pub fn new(width: u32, height: u32) -> Self`
  - `pub struct ScreenSource` with `pub async fn new() -> anyhow::Result<Self>`
  - `pub struct DesktopEncoder` with `pub fn new() -> anyhow::Result<Self>` and `pub fn encode(&mut self, frame: &RawFrame) -> anyhow::Result<Vec<u8>>`
  - `pub const FRAME_INTERVAL: Duration` (66 ms ≈ 15 fps), `pub const MAX_WIDTH: u32 = 1280`, `pub const MAX_HEIGHT: u32 = 720`
  - `pub async fn run_stream(source: Box<dyn FrameSource>, track: Arc<TrackLocalStaticSample>, ssrc: SSRC, payload_type: PayloadType, stop: watch::Receiver<bool>) -> anyhow::Result<()>`

**Two facts this design is built on** (both verified against the crates on disk, not assumed):

1. **The capture objects are not `Send` on every platform, so they must live on a dedicated `std::thread`.** `supervise_sessions` runs inside `tokio::spawn`, so everything in `run_one_session` must be `Send`. Verified by compiling an `is_send::<xcap::VideoRecorder>()` probe for each target: on `x86_64-apple-darwin` the probe fails (`AVCaptureSession` is not `Send + Sync`, so `Retained<AVCaptureSession>` is not `Send`); on `x86_64-pc-windows-msvc` the probe fails for `xcap::Monitor` (`HMONITOR(*mut c_void)` is a raw pointer). `ScreenSource` therefore spawns a `std::thread` that creates and owns the monitor, recorder and receiver for its whole life; only `Send` values (channels) cross the thread boundary.
2. **`xcap`'s `Frame` is RGBA8 on every platform** and its recorder pushes into a plain `std::sync::mpsc::Receiver<Frame>` — the drop-oldest policy is "drain the receiver, keep the last frame", which is a pure function we can unit-test.

**One deviation from the spec, and why.** Spec §6.1 gates only `xcap` off musl, leaving `openh264` unconditional — but `openh264-sys2` compiles vendored C++ through `cc`, and for `x86_64-unknown-linux-musl` cc-rs looks for `x86_64-linux-musl-g++`/`musl-g++`, which Debian/Ubuntu's `musl-tools` does not ship (verified by probe: `error occurred in cc-rs: failed to find tool "x86_64-linux-musl-g++"`). Gating `openh264` and `bytes` off musl as well makes spec §8.5's "the musl target needs nothing" true and matches the spec's own intent: musl is the fully-static terminal-only artifact. The musl-specific refusal logic of spec §6.4/§6.5 therefore moves from a runtime path to a compile-time one — on musl the module does not exist, so desktop offers fall into the ordinary "no matching capability" refusal, which is exactly what ADR-15 wants.

- [ ] **Step 1: Install the capture system packages, add the dependencies, declare the module**

On Linux the `xcap` build needs system development packages *before any cargo command works* (its `pipewire-sys`/`libspa-sys` build scripts use `pkg-config` + `bindgen`). Install them first — Fedora (the dev machine):

```bash
sudo dnf install -y pipewire-devel libspa-devel mesa-libgbm-devel libdrm-devel \
  mesa-libEGL-devel clang-devel pkgconf-pkg-config libxcb-devel libXrandr-devel \
  dbus-devel wayland-devel
```

Debian/Ubuntu (CI; Task 6 wires this into the workflows):

```bash
sudo apt-get update && sudo apt-get install -y pkg-config libclang-dev libxcb1-dev \
  libxrandr-dev libdbus-1-dev libpipewire-0.3-dev libspa-0.2-dev libwayland-dev \
  libegl-dev libgbm-dev libdrm-dev
```

macOS and Windows need nothing (xcap uses the platform frameworks directly), and the musl target never compiles `xcap` or `openh264` at all (both cfg-gated below).

Add to `apps/agent/Cargo.toml` — the new target section goes after the `[dependencies]` block, before `[profile.release]`:

```toml
# Desktop streaming. Absent on musl: that target is the fully-static
# terminal-only artifact, and desktop offers are refused there (ADR-15).
# openh264 is gated too, not just xcap: openh264-sys2 compiles vendored C++
# via cc, and cc-rs cannot find a C++ compiler for the musl target
# (musl-tools ships musl-gcc only — verified by probe).
[target.'cfg(not(target_env = "musl"))'.dependencies]
bytes = "1"
openh264 = "0.9.8"     # vendored Cisco source; no network at build time
xcap = "0.9.8"
```

Declare the module in `apps/agent/src/main.rs`:

```rust
// Desktop streaming is unavailable on musl (see Cargo.toml): the module is
// compiled out entirely, so the musl artifact stays terminal-only.
//
// The allow is temporary: Task 4 wires the module into the session loop, and
// this repository's `cargo clippy --all-targets -- -D warnings` gate fails on
// the dead_code warnings an unwired module produces (verified — in a binary
// crate even `pub` items are dead-code-checked).
#[cfg(not(target_env = "musl"))]
#[allow(dead_code)]
mod desktop;
mod pty;
mod rtc;
mod signal;
```

Create `apps/agent/src/desktop.rs` with just its module doc for now:

```rust
//! Desktop streaming: capture → downscale → H.264 encode → RTP samples.
//!
//! `run_stream` is the only entry point the session loop uses; everything else
//! here exists to be unit-tested without a peer connection or a live display.
```

Run: `cargo check` (no `--locked`: this step updates `Cargo.lock`, which is committed below)
Expected: PASS after a long first build — `openh264-sys2` compiles vendored C++ (a C++ compiler is required; g++/clang++ ship with the toolchains), `xcap` compiles its platform backends. `Cargo.lock` now contains `bytes`, `openh264`, `xcap` and their trees.

- [ ] **Step 2: Write the failing geometry, pattern, and drain tests**

Replace the placeholder body of `apps/agent/src/desktop.rs` with the tests first — the implementation functions they call do not exist yet, so this file will not compile. That compile failure *is* the failing test:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    /// A frame with per-pixel-varying bytes, so a wrong crop/downscale cannot
    /// accidentally pass by comparing a solid colour.
    fn solid(width: u32, height: u32) -> RawFrame {
        let mut rgba = vec![0u8; (width * height * 4) as usize];
        for (i, px) in rgba.chunks_exact_mut(4).enumerate() {
            px[0] = (i % 251) as u8;
            px[1] = ((i / 251) % 251) as u8;
            px[2] = 128;
            px[3] = 255;
        }
        RawFrame { width, height, rgba }
    }

    #[test]
    fn downscale_fits_1080p_into_the_720p_box() {
        let frame = downscale(&solid(1920, 1080), MAX_WIDTH, MAX_HEIGHT);
        assert_eq!((frame.width, frame.height), (1280, 720));
        assert_eq!(frame.rgba.len(), (1280 * 720 * 4) as usize);
    }

    #[test]
    fn downscale_preserves_aspect_for_an_ultrawide() {
        let frame = downscale(&solid(2560, 1080), MAX_WIDTH, MAX_HEIGHT);
        assert_eq!((frame.width, frame.height), (1280, 540));
        assert_eq!(frame.width % 2, 0);
        assert_eq!(frame.height % 2, 0);
    }

    #[test]
    fn downscale_never_upscales_a_small_screen() {
        let source = solid(800, 600);
        let frame = downscale(&source, MAX_WIDTH, MAX_HEIGHT);
        assert_eq!((frame.width, frame.height), (800, 600));
        assert_eq!(frame.rgba, source.rgba);
    }

    #[test]
    fn crop_to_even_trims_one_pixel_off_odd_dimensions() {
        let frame = crop_to_even(solid(1281, 721));
        assert_eq!((frame.width, frame.height), (1280, 720));
        assert_eq!(frame.rgba.len(), (1280 * 720 * 4) as usize);
    }

    #[test]
    fn crop_to_even_passes_even_frames_through() {
        let frame = crop_to_even(solid(1280, 720));
        assert_eq!((frame.width, frame.height), (1280, 720));
        assert_eq!(frame.rgba.len(), (1280 * 720 * 4) as usize);
    }

    #[test]
    fn test_pattern_is_deterministic_per_frame_number() {
        let mut a = TestPatternSource::new(64, 48);
        let mut b = TestPatternSource::new(64, 48);
        for _ in 0..3 {
            let fa = a.next_frame().unwrap().unwrap();
            let fb = b.next_frame().unwrap().unwrap();
            assert_eq!(fa.width, fb.width);
            assert_eq!(fa.height, fb.height);
            assert_eq!(fa.rgba, fb.rgba, "same frame number must render identical bytes");
        }
    }

    #[test]
    fn test_pattern_moves_between_frames() {
        let mut source = TestPatternSource::new(64, 48);
        let first = source.next_frame().unwrap().unwrap();
        let second = source.next_frame().unwrap().unwrap();
        assert_ne!(first.rgba, second.rgba);
    }

    #[test]
    fn drain_latest_keeps_the_newest_frame() {
        let (tx, rx) = std::sync::mpsc::channel();
        for w in [1u32, 2, 3] {
            tx.send(xcap::Frame::new(w, 1, vec![w as u8; 4])).unwrap();
        }
        let newest = drain_latest(&rx).expect("three frames queued");
        assert_eq!(newest.width, 3);
    }

    #[test]
    fn drain_latest_on_an_empty_receiver_is_none() {
        let (_tx, rx) = std::sync::mpsc::channel::<xcap::Frame>();
        assert!(drain_latest(&rx).is_none());
    }
}
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cargo test`
Expected: FAIL to compile — `error[E0425]: cannot find function `downscale` in this scope` (and the same for `crop_to_even`, `TestPatternSource`, `drain_latest`).

- [ ] **Step 4: Implement the frame types, geometry, pattern source, and drain helper**

Prepend the implementation above the tests module in `apps/agent/src/desktop.rs`:

```rust
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use bytes::Bytes;
use openh264::encoder::{
    BitRate, Complexity, Encoder, EncoderConfig, FrameRate, IntraFramePeriod, RateControlMode,
    UsageType, VuiConfig,
};
use openh264::formats::{RgbaSliceU8, YUVBuffer};
use openh264::OpenH264API;
use rtc::media::Sample;
use rtc::rtp_transceiver::{PayloadType, SSRC};
use tokio::sync::{oneshot, watch};
use webrtc::media_stream::track_local::static_sample::TrackLocalStaticSample;

// The whole module is compiled only on non-musl targets (see main.rs), so the
// xcap-only imports below need no cfg of their own.
use std::sync::mpsc::{Receiver, RecvTimeoutError};

/// The biggest frame that is ever encoded: ~720p, the Week 7 budget.
pub const MAX_WIDTH: u32 = 1280;
pub const MAX_HEIGHT: u32 = 720;

/// One frame, RGBA8, `width * height * 4` bytes.
#[derive(Clone)]
pub struct RawFrame {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

/// A source of frames the streaming loop can pull from.
///
/// `Send` is required: the loop runs inside a `tokio::spawn`ed task.
pub trait FrameSource: Send {
    /// The newest frame, or `None` when nothing new arrived since the last
    /// call (the caller skips that tick rather than re-encoding).
    fn next_frame(&mut self) -> Result<Option<RawFrame>>;
    /// Stops capture and releases the platform resources. Idempotent.
    fn stop(&mut self);
}

/// Box-filter downscale to fit `(max_w, max_h)`, preserving aspect ratio.
///
/// A frame that already fits is returned untouched — this never upscales, so
/// an 800×600 screen stays 800×600. Scaled output is floored to even
/// dimensions, which `RgbaSliceU8::new` requires (it panics on odd sizes).
fn downscale(frame: &RawFrame, max_w: u32, max_h: u32) -> RawFrame {
    if frame.width <= max_w && frame.height <= max_h {
        return frame.clone();
    }

    let scale = f64::min(
        max_w as f64 / frame.width as f64,
        max_h as f64 / frame.height as f64,
    );
    let dst_w = (((frame.width as f64 * scale) as u32) & !1).max(2);
    let dst_h = (((frame.height as f64 * scale) as u32) & !1).max(2);

    let mut rgba = vec![0u8; (dst_w * dst_h * 4) as usize];
    for dy in 0..dst_h {
        let sy0 = (dy as u64 * frame.height as u64 / dst_h as u64) as u32;
        let sy1 = (((dy + 1) as u64 * frame.height as u64 / dst_h as u64) as u32).max(sy0 + 1);
        for dx in 0..dst_w {
            let sx0 = (dx as u64 * frame.width as u64 / dst_w as u64) as u32;
            let sx1 = (((dx + 1) as u64 * frame.width as u64 / dst_w as u64) as u32).max(sx0 + 1);

            let mut sums = [0u32; 4];
            let mut count = 0u32;
            for sy in sy0..sy1 {
                for sx in sx0..sx1 {
                    let i = ((sy * frame.width + sx) * 4) as usize;
                    for c in 0..4 {
                        sums[c] += frame.rgba[i + c] as u32;
                    }
                    count += 1;
                }
            }

            let o = ((dy * dst_w + dx) * 4) as usize;
            for c in 0..4 {
                rgba[o + c] = (sums[c] / count) as u8;
            }
        }
    }

    RawFrame { width: dst_w, height: dst_h, rgba }
}

/// Crops the right/bottom pixel off odd dimensions.
///
/// The encoder's `RgbaSliceU8` panics on odd width/height or a byte length that
/// does not match `w * h * 4`; cropping by one pixel is the cheapest guarantee
/// that neither can happen, and a single lost row/column is invisible at 720p.
fn crop_to_even(frame: RawFrame) -> RawFrame {
    let width = frame.width & !1;
    let height = frame.height & !1;
    if width == frame.width && height == frame.height {
        return frame;
    }

    let mut rgba = Vec::with_capacity((width * height * 4) as usize);
    for y in 0..height {
        let start = (y * frame.width * 4) as usize;
        rgba.extend_from_slice(&frame.rgba[start..start + (width * 4) as usize]);
    }
    RawFrame { width, height, rgba }
}

/// Writes a `size`×`size` square of `color` at `(x0, y0)`, clamped to bounds.
fn fill_square(rgba: &mut [u8], w: u32, h: u32, x0: u32, y0: u32, size: u32, color: [u8; 4]) {
    for y in y0..(y0 + size).min(h) {
        for x in x0..(x0 + size).min(w) {
            let i = ((y * w + x) * 4) as usize;
            rgba[i..i + 4].copy_from_slice(&color);
        }
    }
}

/// A deterministic synthetic screen: dark background, four corner markers, and
/// a green bar whose position is a pure function of the frame counter.
///
/// Determinism is the point — the E2E (ADR-17) runs the agent with
/// `--desktop-source test` and asserts on the frames it produces, so the same
/// counter must render the same bytes on every platform.
pub struct TestPatternSource {
    width: u32,
    height: u32,
    counter: u64,
}

impl TestPatternSource {
    pub fn new(width: u32, height: u32) -> Self {
        Self { width, height, counter: 0 }
    }

    fn render(&self, n: u64) -> RawFrame {
        let (w, h) = (self.width, self.height);
        let mut rgba = vec![0u8; (w * h * 4) as usize];
        for px in rgba.chunks_exact_mut(4) {
            px.copy_from_slice(&[9, 13, 22, 255]);
        }

        let marker = [255, 255, 255, 255];
        let margin = 8u32;
        for (x0, y0) in [
            (0, 0),
            (w.saturating_sub(margin), 0),
            (0, h.saturating_sub(margin)),
            (w.saturating_sub(margin), h.saturating_sub(margin)),
        ] {
            fill_square(&mut rgba, w, h, x0, y0, margin, marker);
        }

        let bar = [0, 220, 120, 255];
        let bar_x = ((n * 8) % w as u64) as u32;
        for dx in 0..16u32 {
            let x = (bar_x + dx) % w;
            for y in 0..h {
                let i = ((y * w + x) * 4) as usize;
                rgba[i..i + 4].copy_from_slice(&bar);
            }
        }

        RawFrame { width: w, height: h, rgba }
    }
}

impl FrameSource for TestPatternSource {
    fn next_frame(&mut self) -> Result<Option<RawFrame>> {
        let frame = self.render(self.counter);
        self.counter += 1;
        Ok(Some(frame))
    }

    fn stop(&mut self) {}
}

/// Drains every queued frame and returns the newest; `None` when the queue is
/// empty.
///
/// This is the drop-oldest policy: superseded frames are discarded at the
/// source, so a lagging encoder can never build a backlog — the loop below can
/// only ever see the freshest frame the recorder produced.
fn drain_latest(receiver: &Receiver<xcap::Frame>) -> Option<xcap::Frame> {
    let mut newest = None;
    while let Ok(frame) = receiver.try_recv() {
        newest = Some(frame);
    }
    newest
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cargo test`
Expected: PASS — the 9 new tests plus every pre-existing `pty`/`rtc`/`main` test.

- [ ] **Step 6: Write the failing encoder test**

Add to the tests module in `apps/agent/src/desktop.rs`:

```rust
    #[test]
    fn encoder_emits_annex_b_and_an_idr_first() {
        let mut encoder = DesktopEncoder::new().expect("encoder");
        let frame = solid(320, 240);

        let mut saw_idr = false;
        for round in 0..3 {
            let data = encoder.encode(&frame).expect("encode");
            assert!(!data.is_empty());
            assert_eq!(
                &data[..4],
                &[0, 0, 0, 1],
                "round {round}: output must start with an Annex-B start code"
            );

            // Split on start codes and classify the NAL types present.
            let mut types = Vec::new();
            let mut i = 0;
            while i + 4 <= data.len() {
                if data[i..i + 4] == [0, 0, 0, 1] {
                    if i + 4 < data.len() {
                        types.push(data[i + 4] & 0x1F);
                    }
                    i += 4;
                } else {
                    i += 1;
                }
            }
            assert!(!types.is_empty());
            if round == 0 {
                saw_idr = types.contains(&5);
                assert!(types.contains(&7), "first access unit must carry SPS");
                assert!(types.contains(&8), "first access unit must carry PPS");
            }
        }
        assert!(saw_idr, "the first frame must be an IDR access unit");
    }
```

- [ ] **Step 7: Run the test to verify it fails**

Run: `cargo test encoder_emits_annex_b_and_an_idr_first`
Expected: FAIL to compile — `cannot find type `DesktopEncoder` in this scope`.

- [ ] **Step 8: Implement the encoder wrapper**

Insert after `crop_to_even` in `apps/agent/src/desktop.rs`:

```rust
/// The encoder is CPU-bound and synchronous; `run_stream` calls it inline on
/// the runtime worker, which is fine at 15 fps (the ticker's
/// `MissedTickBehavior::Delay` absorbs a slow frame instead of piling ticks
/// up). Moving it to `spawn_blocking` is a Week 8–9 refinement if 720p
/// encoding ever measurably starves the runtime.
///
/// `openh264`'s `Encoder` is `Send` (probe-verified), which is what lets the
/// streaming task own it; frames are converted RGBA8 → YUV 4:2:0
/// (`YUVBuffer`) before encoding.
pub struct DesktopEncoder {
    encoder: Encoder,
}

impl DesktopEncoder {
    pub fn new() -> Result<Self> {
        let config = EncoderConfig::new()
            .bitrate(BitRate::from_bps(2_000_000))
            .max_frame_rate(FrameRate::from_hz(15.0))
            .usage_type(UsageType::ScreenContentRealTime)
            .rate_control_mode(RateControlMode::Bitrate)
            .complexity(Complexity::Low)
            .intra_frame_period(IntraFramePeriod::from_num_frames(60))
            .vui(VuiConfig::bt709());
        let encoder = Encoder::with_api_config(OpenH264API::from_source(), config)
            .context("creating the H.264 encoder")?;
        Ok(Self { encoder })
    }

    /// Encodes one frame to Annex-B bytes (each NAL carries its own start
    /// code — verified against `openh264 0.9.8`, see spec §3.2).
    pub fn encode(&mut self, frame: &RawFrame) -> Result<Vec<u8>> {
        let yuv = YUVBuffer::from_rgba8_source(RgbaSliceU8::new(
            &frame.rgba,
            (frame.width as usize, frame.height as usize),
        ));
        let bitstream = self
            .encoder
            .encode(&yuv)
            .map_err(|e| anyhow::anyhow!("H.264 encode failed: {e}"))?;
        Ok(bitstream.to_vec())
    }
}
```

- [ ] **Step 9: Run the test to verify it passes**

Run: `cargo test encoder_emits_annex_b_and_an_idr_first`
Expected: PASS. The encoder prints `AdaptiveQuant(1) is not supported yet for screen content` / `BackgroundDetection ...` warnings on the first frame — that is openh264 auto-disabling two screen-content features, not an error.

- [ ] **Step 10: Write the failing `ScreenSource` test**

Add to the tests module in `apps/agent/src/desktop.rs`:

```rust
    #[test]
    fn screen_source_forwards_frames_from_a_stub_capture_thread() {
        // The capture thread is the only platform-specific part of ScreenSource;
        // the channel plumbing on either side of it is what this test pins.
        let (tx, rx) = std::sync::mpsc::channel::<xcap::Frame>();
        tx.send(xcap::Frame::new(4, 4, vec![7u8; 64])).unwrap();
        let mut source = ScreenSource::from_parts_for_test(rx);
        let frame = source.next_frame().unwrap().expect("one queued frame");
        assert_eq!((frame.width, frame.height), (4, 4));
        assert_eq!(frame.rgba.len(), 64);
        assert!(source.next_frame().unwrap().is_none(), "queue drained");
        source.stop();
    }

    /// `ScreenSource::new` must not panic or hang on a headless machine; it
    /// either returns a source or a clean error. Needs a live display, so it
    /// is ignored by default and run manually on the dev machine.
    #[tokio::test]
    #[ignore = "needs a live display; run manually on the dev machine"]
    async fn screen_source_smoke_on_a_live_display() {
        let mut source = ScreenSource::new().await.expect("live display");
        let frame = source.next_frame().unwrap();
        if let Some(frame) = frame {
            assert_eq!(frame.rgba.len(), (frame.width * frame.height * 4) as usize);
        }
        source.stop();
    }
```

- [ ] **Step 11: Run the test to verify it fails**

Run: `cargo test screen_source_forwards_frames_from_a_stub_capture_thread`
Expected: FAIL to compile — `cannot find type `ScreenSource` in this scope`.

- [ ] **Step 12: Implement `ScreenSource` with the dedicated capture thread**

Insert after `TestPatternSource`'s `FrameSource` impl in `apps/agent/src/desktop.rs`. The comment block at the top is load-bearing — it records the platform facts that force this shape:

```rust
/// Live screen capture.
///
/// **Why a dedicated thread.** `xcap`'s capture objects are not `Send` on every
/// platform — verified by compiling `is_send::<xcap::VideoRecorder>()` for
/// `x86_64-apple-darwin` (fails: `Retained<AVCaptureSession>` is not `Send`)
/// and `is_send::<xcap::Monitor>()` for `x86_64-pc-windows-msvc` (fails:
/// `HMONITOR` wraps a raw pointer) — while `supervise_sessions` runs in a
/// `tokio::spawn` and everything in `run_one_session` must be `Send`. So the
/// thread below creates, owns and drops the monitor/recorder/`Receiver`, and
/// only the channel (probe-verified `Send` on all three platforms) crosses the
/// boundary. The same design works everywhere, which beats three cfg-gated
/// shapes.
///
/// **Failure is reported, not lost.** The thread sends its setup outcome over
/// a `oneshot` before the frame loop, so `new()` returns the real error
/// (no display, missing portal, no permission) instead of a stream that never
/// produces a frame.
pub struct ScreenSource {
    frames: Option<Receiver<xcap::Frame>>,
    stop: Option<std::sync::mpsc::Sender<()>>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl ScreenSource {
    /// Starts capture of the primary monitor (falling back to the first
    /// monitor when there is no primary, e.g. some Wayland sessions).
    pub async fn new() -> Result<Self> {
        let (ready_tx, ready_rx) = oneshot::channel::<std::result::Result<(), String>>();
        let (stop_tx, stop_rx) = std::sync::mpsc::channel::<()>();
        let (frame_tx, frame_rx) = std::sync::mpsc::channel::<xcap::Frame>();

        let thread = std::thread::Builder::new()
            .name("desktop-capture".into())
            .spawn(move || {
                let recorder = match primary_recorder() {
                    Ok(recorder) => recorder,
                    Err(e) => {
                        let _ = ready_tx.send(Err(e.to_string()));
                        return;
                    }
                };
                let (recorder, frames) = recorder;
                if let Err(e) = recorder.start() {
                    let _ = ready_tx.send(Err(format!("starting capture: {e}")));
                    return;
                }
                let _ = ready_tx.send(Ok(()));

                // Forward frames until stopped. `recv_timeout` keeps the loop
                // responsive to the stop signal while the recorder is idle.
                loop {
                    match frames.recv_timeout(Duration::from_millis(100)) {
                        Ok(frame) => {
                            if frame_tx.send(frame).is_err() {
                                break; // ScreenSource dropped
                            }
                        }
                        Err(RecvTimeoutError::Timeout) => {}
                        Err(RecvTimeoutError::Disconnected) => break,
                    }
                    if stop_rx.try_recv().is_ok() {
                        break;
                    }
                }

                if let Err(e) = recorder.stop() {
                    tracing::warn!(error = %e, "stopping the screen recorder failed");
                }
            })
            .context("spawning the desktop capture thread")?;

        match ready_rx.await {
            Ok(Ok(())) => Ok(Self {
                frames: Some(frame_rx),
                stop: Some(stop_tx),
                thread: Some(thread),
            }),
            Ok(Err(message)) => {
                let _ = thread.join();
                bail!("screen capture unavailable: {message}");
            }
            Err(_) => {
                let _ = thread.join();
                bail!("the desktop capture thread died during setup");
            }
        }
    }

    /// Test seam: wraps an already-open frame channel.
    #[cfg(test)]
    fn from_parts_for_test(frames: Receiver<xcap::Frame>) -> Self {
        Self { frames: Some(frames), stop: None, thread: None }
    }
}

/// Picks a monitor and opens its recorder.
///
/// Preference order: the monitor at the origin (the primary in practice),
/// then an explicitly primary monitor, then any monitor at all. A Wayland
/// session with no primary flag set still gets a stream.
fn primary_recorder() -> Result<(xcap::VideoRecorder, Receiver<xcap::Frame>)> {
    let monitor = match xcap::Monitor::from_point(0, 0) {
        Ok(monitor) => monitor,
        Err(_) => {
            let monitors = xcap::Monitor::all().context("listing monitors")?;
            monitors
                .iter()
                .find(|m| m.is_primary().unwrap_or(false))
                .or_else(|| monitors.first())
                .ok_or_else(|| anyhow::anyhow!("no monitors found"))?
                .clone()
        }
    };
    let recorder = monitor.video_recorder().context("opening the video recorder")?;
    Ok(recorder)
}

impl FrameSource for ScreenSource {
    fn next_frame(&mut self) -> Result<Option<RawFrame>> {
        let Some(frames) = self.frames.as_ref() else {
            return Ok(None);
        };
        Ok(drain_latest(frames).map(|frame| RawFrame {
            width: frame.width,
            height: frame.height,
            rgba: frame.raw,
        }))
    }

    fn stop(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        // Bounded join: the capture thread checks the stop flag every 100 ms
        // and the recorder's `stop()` runs its own shutdown path.
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}
```

- [ ] **Step 13: Run the tests to verify they pass**

Run: `cargo test`
Expected: PASS — all previous tests plus the two new ones (the `#[ignore]`d one is reported as ignored).

- [ ] **Step 14: Write the failing `run_stream` tests**

Add to the tests module in `apps/agent/src/desktop.rs`:

```rust
    /// A track with an empty coding list: `write_sample` on it fails
    /// deterministically with `Error::CodecNotFound` (verified in the webrtc
    /// 0.21 sources: `codec(ssrc)` finds no coding and returns early before
    /// any packetizing), so these tests need no peer connection and no
    /// runtime driver.
    fn unbound_track() -> Arc<TrackLocalStaticSample> {
        Arc::new(
            TrackLocalStaticSample::new(
                Instant::now(),
                rtc::media_stream::MediaStreamTrack::new(
                    "test-stream".into(),
                    "test-track".into(),
                    // The label value is irrelevant to these tests; Task 4's
                    // `DESKTOP_LABEL` (rtc.rs) carries the same string.
                    "desktop".into(),
                    rtc::rtp_transceiver::rtp_sender::RtpCodecKind::Video,
                    vec![],
                ),
            )
            .expect("track"),
        )
    }

    #[tokio::test]
    async fn run_stream_stops_cleanly_without_a_bound_track() {
        // Before the peer connection binds the track, `write_sample` errors
        // with `CodecNotFound` — the loop must report that as an error instead
        // of spinning, so the session loop can tear down.
        let (stop_tx, stop_rx) = watch::channel(false);
        let source = Box::new(TestPatternSource::new(64, 48));

        let result = run_stream(source, unbound_track(), 1234, 96, stop_rx).await;
        assert!(
            result.is_err(),
            "writing to an unbound track must surface an error, got {result:?}"
        );
        drop(stop_tx);
    }

    #[tokio::test]
    async fn run_stream_honours_a_pre_set_stop_signal() {
        // A stop that is already set when the task starts must end it without
        // touching the track at all. `watch::Receiver::changed` only wakes on
        // the *next* send, so `run_stream` checks the current value up front —
        // this test pins that check.
        let (stop_tx, stop_rx) = watch::channel(true);
        let source = Box::new(TestPatternSource::new(64, 48));

        let result = tokio::time::timeout(
            Duration::from_secs(1),
            run_stream(source, unbound_track(), 1234, 96, stop_rx),
        )
        .await
        .expect("run_stream must exit promptly when stop is already set");
        assert!(result.is_ok());
        drop(stop_tx);
    }
```

- [ ] **Step 15: Run the tests to verify they fail**

Run: `cargo test run_stream_`
Expected: FAIL to compile — `cannot find function `run_stream` in this scope`.

- [ ] **Step 16: Implement `run_stream`**

Insert after the `ScreenSource` block in `apps/agent/src/desktop.rs`:

```rust
/// Tick interval: 15 fps. A tick with no new frame is skipped, so the real
/// rate follows the display, never faster than this.
pub const FRAME_INTERVAL: Duration = Duration::from_millis(66);

/// Encodes frames as they arrive and writes each as one media sample.
///
/// Runs until `stop` flips to `true` (checked before the first tick and after
/// every change), the source errors, or a `write_sample` fails — the last one
/// matters because the track is only writable once the peer connection has
/// bound it, and a bound-then-closed transport must end the task rather than
/// spin.
///
/// `ssrc`/`payload_type` are resolved by the caller from the negotiated sender
/// (§6.3) and are never hardcoded.
pub async fn run_stream(
    mut source: Box<dyn FrameSource>,
    track: Arc<TrackLocalStaticSample>,
    ssrc: SSRC,
    payload_type: PayloadType,
    mut stop: watch::Receiver<bool>,
) -> Result<()> {
    // `changed()` only resolves on the *next* send, so a signal that is
    // already set would be missed until the caller sends again. Check first.
    if *stop.borrow() {
        source.stop();
        return Ok(());
    }

    let mut encoder = DesktopEncoder::new()?;
    let mut ticker = tokio::time::interval(FRAME_INTERVAL);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    let mut skipped: u64 = 0;
    loop {
        tokio::select! {
            _ = stop.changed() => {
                if *stop.borrow() {
                    break;
                }
            }
            _ = ticker.tick() => {
                let Some(frame) = source.next_frame()? else {
                    skipped += 1;
                    if skipped % 150 == 1 {
                        tracing::debug!(skipped, "desktop: no new frame this tick");
                    }
                    continue;
                };
                let frame = crop_to_even(downscale(&frame, MAX_WIDTH, MAX_HEIGHT));
                let data = encoder.encode(&frame)?;
                let sample = Sample {
                    data: Bytes::from(data),
                    duration: FRAME_INTERVAL,
                    ..Sample::new(Instant::now())
                };
                track
                    .sample_writer(ssrc, payload_type)
                    .write_sample(&sample)
                    .await
                    .context("writing a desktop sample")?;
            }
        }
    }

    source.stop();
    Ok(())
}
```

- [ ] **Step 17: Run the tests to verify they pass**

Run: `cargo test run_stream_`
Expected: PASS — the unbound-track test gets `Error::CodecNotFound` on its first write, the pre-set-stop test returns `Ok(())` before the first tick.

- [ ] **Step 18: Run the full suite and the clippy gate**

Run: `cargo test && cargo clippy --all-targets --locked -- -D warnings`
Expected: PASS. If clippy flags `#[allow(dead_code)] mod desktop;` (items are still only used by tests at this point), keep the allow — Task 4 removes it when the session loop calls into the module.

- [ ] **Step 19: Commit**

```bash
cargo fmt
git add apps/agent/Cargo.toml apps/agent/Cargo.lock apps/agent/src/main.rs apps/agent/src/desktop.rs
git commit -m "feat(agent): capture-downscale-encode pipeline for desktop streaming"
```

---

### Task 4: Agent — desktop answer path, mode classification, and CLI

**Files:**
- Modify: `apps/agent/src/rtc.rs` (add `DESKTOP_LABEL`, `DesktopMedia`, `attach_desktop_track`, `send_desktop_answer`; extend `on_connection_state_change` at 248–252)
- Modify: `apps/agent/src/main.rs` (CLI field; `SessionConfig`; `SessionMode`/`classify_offer`; remove the post-answer check at 445–449; add the desktop session flow)
- Test: `apps/agent/src/rtc.rs` (`#[cfg(test)] mod tests` — SSRC helper)
- Test: `apps/agent/src/main.rs` (`#[cfg(test)] mod tests` — classification)

**Interfaces:**
- Consumes (from Task 3): `desktop::{run_stream, FrameSource, ScreenSource, TestPatternSource, FRAME_INTERVAL}`; `rtc 0.21` — `rtc::media_stream::MediaStreamTrack::new(MediaStreamId, MediaStreamTrackId, String, RtpCodecKind, Vec<RTCRtpEncodingParameters>)` (**not** `Result`), `rtc::rtp_transceiver::rtp_sender::{RtpCodecKind, RTCRtpCodec, RTCRtpCodingParameters, RTCRtpEncodingParameters}`, `rtc::rtp_transceiver::{SSRC, PayloadType}`, `rtc::peer_connection::configuration::media_engine::MIME_TYPE_H264`; `webrtc 0.21` — `webrtc::media_stream::track_local::TrackLocal` (trait, for the `add_track` cast), `webrtc::media_stream::Track` (`ssrcs()`, `codings()`), `webrtc::media_stream::track_local::static_sample::TrackLocalStaticSample::{new, ssrcs}`, `webrtc::rtp_transceiver::RtpSender` (`get_parameters()`, `track()`), `webrtc::peer_connection::RTCPeerConnectionState`.
- Produces (relied on by Tasks 6–8):
  - `pub const DESKTOP_LABEL: &str = "desktop"` (rtc.rs)
  - `pub struct DesktopMedia { pub track: Arc<TrackLocalStaticSample>, pub sender: Arc<dyn RtpSender> }` (rtc.rs)
  - `pub async fn attach_desktop_track(peer: &Arc<dyn PeerConnection>) -> Result<DesktopMedia>` (rtc.rs)
  - `pub async fn send_desktop_answer(peer, offer, outbound) -> Result<()>` (rtc.rs)
  - `enum DesktopSource { Screen, Test }` + `enum SessionMode { Terminal, Desktop, None }` + `fn classify_offer(capabilities: &[String]) -> SessionMode` (main.rs)
  - `SessionConfig.desktop_source: DesktopSource`

- [ ] **Step 1: Write the failing SSRC-helper test**

Append to the `#[cfg(test)] mod tests` in `apps/agent/src/rtc.rs` (after the last test, before the closing `}`):

```rust
    #[test]
    fn session_ssrcs_are_distinct_and_never_zero() {
        // The SSRC only has to be unique per sender within one process. Two
        // sessions that started in the same nanosecond (impossible in practice,
        // but the counter makes it impossible in principle) must not collide,
        // and 0 is avoided so no stack sees a "zero SSRC" packet.
        let a = next_ssrc();
        let b = next_ssrc();
        assert_ne!(a, b, "the per-process counter must break ties");
        assert_ne!(a, 0);
        assert_ne!(b, 0);
    }
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test --manifest-path apps/agent/Cargo.toml session_ssrcs_are_distinct_and_never_zero`
Expected: FAIL — `cannot find function `next_ssrc` in this scope` (compile error).

- [ ] **Step 3: Add the desktop answer path to `rtc.rs`**

Add these imports at the top of `apps/agent/src/rtc.rs` (merge with the existing `use` blocks):

```rust
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use rtc::peer_connection::configuration::media_engine::MIME_TYPE_H264;
use rtc::media_stream::MediaStreamTrack;
use rtc::rtp_transceiver::rtp_sender::{
    RTCRtpCodec, RTCRtpCodingParameters, RTCRtpEncodingParameters, RtpCodecKind,
};
use rtc::rtp_transceiver::{PayloadType, SSRC};
use webrtc::media_stream::track_local::static_sample::TrackLocalStaticSample;
use webrtc::media_stream::track_local::TrackLocal;
use webrtc::media_stream::Track;
use webrtc::rtp_transceiver::RtpSender;
```

> **Import paths (verified against the installed crates):** `MIME_TYPE_H264` lives in `rtc::peer_connection::configuration::media_engine` (rtc-0.21.0 `configuration/media_engine.rs:108`) — there is no `rtc::media` module. `TrackLocal` is `webrtc::media_stream::track_local::TrackLocal`; `media_stream` re-exports only `MediaStreamId`/`MediaStreamTrack`/`MediaStreamTrackId` (`webrtc-0.21.0/src/media_stream/mod.rs:26`). `RTCRtpCodecParameters` is **not** imported: only `RTCRtpCodec` (the capability struct) is constructed here.

(Keep the existing `use webrtc::peer_connection::{...}` block — it already imports `PeerConnection`, `RTCPeerConnectionState`, etc.)

Then add, right after the `TERMINAL_LABEL` const:

```rust
/// The capability string that selects a desktop session (ADR-15).
pub const DESKTOP_LABEL: &str = "desktop";

/// A per-process counter so two sessions in one agent never share an SSRC.
static SSRC_SEQUENCE: AtomicU32 = AtomicU32::new(0);

/// A session-local SSRC: process-start time XORed with a monotonic counter.
///
/// The value is not security-relevant (it only has to be unique per sender on
/// one connection), so this avoids adding a `rand` dependency: the nanosecond
/// clock gives cross-process spread, the counter makes collisions within one
/// process impossible, and `| 1` keeps the result non-zero.
fn next_ssrc() -> SSRC {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let seq = SSRC_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    ((nanos as u32) ^ ((nanos >> 32) as u32) ^ seq) | 1
}

/// The sending track plus the sender, so the session can resolve the
/// negotiated payload type and the SSRC after the answer is connected.
pub struct DesktopMedia {
    pub track: Arc<TrackLocalStaticSample>,
    pub sender: Arc<dyn RtpSender>,
}

/// Build the video track and attach it to the peer.
///
/// **Must be called before `set_remote_description`.** `add_track` creates the
/// transceiver and its m-line; adding it after the remote description exists
/// means the offer's video m-line is answered `inactive` and the browser never
/// receives a track (ADR-15, and the E2E in Task 6 pins it).
///
/// The codec parameters mirror the `MediaEngine`'s default H.264 entry (PT 102,
/// `level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f`).
/// The actual negotiated payload type is read back from the sender later — this
/// value only has to match the mime/fmtp the answer advertises so the offer's
/// H.264 m-line can be matched to it.
pub async fn attach_desktop_track(
    peer: &Arc<dyn PeerConnection>,
) -> Result<DesktopMedia> {
    let ssrc = next_ssrc();
    let rtp_codec = RTCRtpCodec {
        mime_type: MIME_TYPE_H264.to_owned(),
        clock_rate: 90_000,
        channels: 0,
        sdp_fmtp_line:
            "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f".to_owned(),
        rtcp_feedback: vec![],
    };

    let track = Arc::new(
        TrackLocalStaticSample::new(
            Instant::now(),
            MediaStreamTrack::new(
                "ponter-desktop".to_owned(),
                "screen".to_owned(),
                DESKTOP_LABEL.to_owned(),
                RtpCodecKind::Video,
                vec![RTCRtpEncodingParameters {
                    rtp_coding_parameters: RTCRtpCodingParameters {
                        ssrc: Some(ssrc),
                        ..Default::default()
                    },
                    codec: rtp_codec,
                    ..Default::default()
                }],
            ),
        )
        .context("building the desktop track")?,
    );

    let sender = peer
        .add_track(Arc::clone(&track) as Arc<dyn TrackLocal>)
        .await
        .context("add_track(desktop)")?;

    Ok(DesktopMedia { track, sender })
}

/// Answer a desktop offer with `approved: true` and the SDP just built.
///
/// The track is attached by the caller *before* this runs (ADR-15); this is the
/// same `set_remote_description → create_answer → set_local_description → send`
/// core as [`answer_offer`], with the flag fixed to `true` because the caller
/// has already decided the offer is a desktop offer it can serve.
pub async fn send_desktop_answer(
    peer: &Arc<dyn PeerConnection>,
    offer: &SignalOffer,
    outbound: &mpsc::Sender<SignalMessage>,
) -> Result<()> {
    send_answer(peer, offer, true, outbound).await
}

/// Resolve the negotiated payload type and SSRC for a desktop sender.
///
/// Neither is assumed: the payload type is whatever the SDP negotiation chose
/// (the offer may not have picked PT 102), and the SSRC is the one the track was
/// built with, read back through the track API. Both are needed by
/// `desktop::run_stream`, and a wrong payload type makes rtc drop every packet.
pub async fn desktop_stream_params(media: &DesktopMedia) -> Result<(SSRC, PayloadType)> {
    let payload_type = media
        .sender
        .get_parameters()
        .await
        .context("sender.get_parameters")?
        .rtp_parameters
        .codecs
        .first()
        .map(|codec| codec.payload_type)
        .ok_or_else(|| anyhow::anyhow!("the desktop sender has no negotiated codec"))?;

    let ssrc = *media
        .track
        .ssrcs()
        .await
        .first()
        .ok_or_else(|| anyhow::anyhow!("the desktop track has no SSRC"))?;

    Ok((ssrc, payload_type))
}
```

- [ ] **Step 4: Run the SSRC test and the rtc suite**

Run: `cargo test --manifest-path apps/agent/Cargo.toml session_ssrcs_are_distinct_and_never_zero && cargo test --manifest-path apps/agent/Cargo.toml rtc::`
Expected: PASS — `next_ssrc` compiles and the existing `rtc::tests` still pass. The crate still builds here: nothing in Steps 1–3 changed an existing signature.

- [ ] **Step 5: Add a `Connected` notification and `Closed` handling to `SessionHandler`**

A desktop session has no data channel, so its only "the connection is up" signal is `RTCPeerConnectionState::Connected`, and its only "the browser hung up" signal is `Closed`. Add a `connected_tx` field to `SessionHandler` (mirroring `open_tx`), fire it on `Connected`, and end the session on `Closed`.

> **Note:** this changes `SessionHandler::new`'s signature, so `main.rs` stops compiling until Step 8 updates the call site. Steps 6–8 are written so the crate compiles again at Step 8; do not try to run tests in between.

In `apps/agent/src/rtc.rs`, add the field to the struct (after `open_tx`):

```rust
    /// Fired once on `Connected`. The desktop session waits on it; the terminal
    /// session ignores it (it waits for the data channel instead).
    connected_tx: Arc<Mutex<Option<oneshot::Sender<()>>>>,
```

Add the matching parameter to `SessionHandler::new` (after `open_tx`) and store it:

```rust
    pub fn new(
        session_id: String,
        outbound: mpsc::Sender<SignalMessage>,
        end_tx: mpsc::Sender<&'static str>,
        channel: Arc<OnceLock<Arc<dyn DataChannel>>>,
        open_tx: Arc<Mutex<Option<oneshot::Sender<()>>>>,
        connected_tx: Arc<Mutex<Option<oneshot::Sender<()>>>>,
    ) -> Self {
        Self {
            session_id,
            outbound,
            end_tx,
            channel,
            open_tx,
            connected_tx,
        }
    }
```

Replace `on_connection_state_change` (currently lines 248–252) with:

```rust
    /// Report `Connected`, and end the session on `Failed` or `Closed`.
    ///
    /// `Failed` is ICE giving up (a killed tab that never sent a close, a
    /// network cut). `Closed` is the peer closing cleanly — for a terminal
    /// session the data-channel close already covers that, but a desktop
    /// session has no data channel, so `Closed` is the only signal that the
    /// browser hung up. `Disconnected` is deliberately NOT terminal: it is
    /// transient and recovers on its own. `Connected` fires `connected_tx`
    /// exactly once (the `take()` makes a repeat a no-op).
    async fn on_connection_state_change(&self, state: RTCPeerConnectionState) {
        match state {
            RTCPeerConnectionState::Connected => {
                if let Some(tx) = self.connected_tx.lock().unwrap().take() {
                    let _ = tx.send(());
                }
            }
            RTCPeerConnectionState::Failed => {
                let _ = self.end_tx.try_send("the peer connection failed");
            }
            RTCPeerConnectionState::Closed => {
                let _ = self.end_tx.try_send("the peer connection closed");
            }
            _ => {}
        }
    }
```

- [ ] **Step 6: Write the failing classification test**

Append to the `#[cfg(test)] mod tests` in `apps/agent/src/main.rs`:

```rust
    #[test]
    fn classify_offer_maps_capabilities_to_a_session_mode() {
        // The capabilities are attacker-controlled strings; classification is a
        // pure comparison against the two known labels (ADR-15). An unknown or
        // empty list is None (refused), and terminal wins if a malformed client
        // somehow offers both — the established flow is the safe default.
        assert_eq!(
            classify_offer(&["terminal".to_string()]),
            SessionMode::Terminal
        );
        assert_eq!(
            classify_offer(&["desktop".to_string()]),
            SessionMode::Desktop
        );
        assert_eq!(classify_offer(&[]), SessionMode::None);
        assert_eq!(classify_offer(&["unknown".to_string()]), SessionMode::None);
        assert_eq!(
            classify_offer(&["desktop".to_string(), "terminal".to_string()]),
            SessionMode::Terminal,
        );
    }
```

- [ ] **Step 7: Run the test to verify it fails**

Run: `cargo test --manifest-path apps/agent/Cargo.toml classify_offer_maps_capabilities_to_a_session_mode`
Expected: FAIL — the crate does not compile yet (the `SessionHandler::new` call site still has five arguments, and `classify_offer`/`SessionMode` do not exist). This is the failing state; Step 8 fixes it.

- [ ] **Step 8: Add the CLI flag, the `SessionConfig` field, the classification helper, and the updated handler call site**

In `apps/agent/src/main.rs`, add the source enum and the session-mode enum + helper (place them just above `struct SessionConfig`):

```rust
/// Which frames a desktop session streams (ADR-17).
///
/// Defined unconditionally so the CLI has the same shape on every target; on
/// musl the value is accepted and then refused, because the desktop module is
/// compiled out there.
#[derive(clap::ValueEnum, Clone, Copy, Debug, PartialEq, Eq)]
enum DesktopSource {
    /// Capture the real primary display (Linux is the runnable platform in Week 7).
    Screen,
    /// A deterministic synthetic pattern: headless CI and the E2E harness.
    Test,
}

/// What an offer asks this agent to serve (ADR-15). Decided from the offer's
/// capabilities *before* the answer is built.
#[derive(Debug, PartialEq, Eq)]
enum SessionMode {
    Terminal,
    Desktop,
    None,
}

/// Classify an offer's capabilities into the mode this agent will serve.
///
/// Pure and total: the input is attacker-controlled strings and the only
/// operation is exact comparison against the two known labels. Terminal is
/// checked first so a malformed client offering both gets the established flow.
fn classify_offer(capabilities: &[String]) -> SessionMode {
    if capabilities.iter().any(|c| c == rtc::TERMINAL_LABEL) {
        SessionMode::Terminal
    } else if capabilities.iter().any(|c| c == rtc::DESKTOP_LABEL) {
        SessionMode::Desktop
    } else {
        SessionMode::None
    }
}
```

Add the field to `SessionConfig`:

```rust
#[derive(Clone)]
struct SessionConfig {
    stun: String,
    cols: u16,
    rows: u16,
    shell: String,
    /// Unused on musl, where the desktop module is compiled out; kept so the
    /// CLI shape is identical on every target.
    #[allow(dead_code)]
    desktop_source: DesktopSource,
}
```

Add the CLI flag to `struct Cli` (after `rows`):

```rust
    /// Desktop frame source: `screen` captures the display, `test` streams a
    /// deterministic pattern (what CI and the E2E harness use).
    #[arg(long, env = "AGENT_DESKTOP_SOURCE", value_enum, default_value_t = DesktopSource::Screen)]
    desktop_source: DesktopSource,
```

Populate it in `run_with_reconnect` where `cfg` is built (currently lines 195–200):

```rust
    let cfg = SessionConfig {
        stun: cli.stun.clone(),
        cols: cli.cols,
        rows: cli.rows,
        shell: shell.to_string(),
        desktop_source: cli.desktop_source,
    };
```

Then, still in `run_one_session`, classify the offer **before** the peer is built. The mode decides the peer's ICE timeouts (a desktop peer is media-only and has no data channel to signal a clean close — see the `build_peer` change below). Insert at the top of `run_one_session`'s body:

```rust
    // ADR-15: classify from the offer's capabilities before anything is built.
    // The mode also selects the ICE timeouts passed to `build_peer`.
    let mode = classify_offer(&offer.capabilities);
```

Update the `build_peer` call (currently line 432) to pass the media-only flag:

```rust
    let peer = rtc::build_peer(pushed_ice, &cfg.stun, handler, mode == SessionMode::Desktop).await?;
```

Finally, create the `connected` channel alongside `open_tx` (currently lines 421–431) and pass it to the handler — this restores compilation:

```rust
    let channel: Arc<OnceLock<Arc<dyn DataChannel>>> = Arc::new(OnceLock::new());
    let (open_tx, mut open_rx) = tokio::sync::oneshot::channel::<()>();
    let open_tx = Arc::new(Mutex::new(Some(open_tx)));
    // Fired on `Connected`; the desktop session waits on it (a desktop peer has
    // no data channel to wait for instead). Unused by the terminal path.
    let (connected_tx, connected_rx) = tokio::sync::oneshot::channel::<()>();
    let connected_tx = Arc::new(Mutex::new(Some(connected_tx)));

    let handler = Arc::new(rtc::SessionHandler::new(
        offer.session_id.clone(),
        outbound.clone(),
        end_tx.clone(),
        channel.clone(),
        open_tx,
        connected_tx,
    ));
```

(`connected_rx` is bound but not yet used; Step 10 consumes it. If the intermediate `cargo clippy` gate is run here it will warn on the unused binding — Step 10 removes the warning, and Steps 11–12 are the gates that must be green.)

Now the `build_peer` change in `apps/agent/src/rtc.rs`. Add `Duration` to the desktop import added in Step 3:

```rust
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
```

Widen `build_peer` (currently at line 99) with a `media_only` flag:

```rust
pub async fn build_peer(
    pushed: &[IceServerEntry],
    stun_url: &str,
    handler: Arc<dyn PeerConnectionEventHandler>,
    media_only: bool,
) -> Result<Arc<dyn PeerConnection>> {
```

Change the `setting` binding from the single `let setting = SettingEngineBuilder::new()...build();` to a mutable builder with a conditional timeout, keeping the existing `with_multicast_dns_mode` / `with_answering_dtls_role` calls (and their long explanatory comment) exactly as they are:

```rust
    let mut setting = SettingEngineBuilder::new()
        .with_multicast_dns_mode(MulticastDnsMode::Disabled)
        // ...the existing `with_answering_dtls_role(RTCDtlsRole::Server)` call
        // and its comment stay verbatim...
        .with_answering_dtls_role(RTCDtlsRole::Server);

    // A media-only (desktop) peer has no data channel, so ICE silence is its
    // only "the browser is gone" signal: werift's `pc.close()` on a connection
    // with no SCTP association sends neither a DTLS close_notify nor an ICE
    // packet, it simply stops. The defaults (disconnected 5s + failed 25s, per
    // `rtc-ice`'s `validate_selected_pair`) would hold the ADR-14 slot for ~30s
    // after a network drop — long enough that a user cannot reconnect, and long
    // enough that the E2E teardown assertion (20s) could never pass. Desktop
    // media flows every ~66ms, so 3s of silence is unambiguous; Failed at
    // 3s + 5s = 8s keeps a brief `Disconnected` recoverable while still freeing
    // the slot promptly. Terminal peers keep the RFC-shaped defaults — their
    // data channel is the close signal, so a short ICE timeout would only add
    // false failures on a healthy-but-quiet link.
    if media_only {
        setting = setting.with_ice_timeouts(
            Some(Duration::from_secs(3)),
            Some(Duration::from_secs(5)),
            Some(Duration::from_secs(1)),
        );
    }
    let setting = setting.build();
```

Update the second `build_peer` call site (main.rs:852, the `NoopHandler` construction path used by tests) to pass `false`:

```rust
    let peer = rtc::build_peer(pushed_ice, &cfg.stun, Arc::new(rtc::NoopHandler), false).await?;
```

- [ ] **Step 9: Run the classification test to verify it passes**

Run: `cargo test --manifest-path apps/agent/Cargo.toml classify_offer_maps_capabilities_to_a_session_mode`
Expected: PASS.

- [ ] **Step 10: Branch `run_one_session` on the mode and add the desktop flow**

In `run_one_session`, replace the `rtc::answer_offer(&peer, offer, outbound).await?;` call and the post-answer capability check (currently lines 437–449) with the mode branch on the `mode` value computed in Step 8:

```rust
    // Branch on the classification made before the peer was built (ADR-15). A
    // desktop offer needs its sending track attached before the remote
    // description exists; an unsupported offer is refused with a real SDP
    // (approved: false) and never reaches the terminal setup below.
    match mode {
        SessionMode::Desktop => {
            return run_desktop_session(
                offer,
                &peer,
                outbound,
                pushed_ice,
                cfg,
                &mut pending,
                connected_rx,
                end_rx,
                inbound,
            )
            .await;
        }
        SessionMode::None => {
            tracing::warn!(session_id = %offer.session_id, "refused: no recognised capability");
            rtc::refuse_offer(&peer, offer, outbound).await?;
            let _ = peer.close().await;
            return Ok(());
        }
        SessionMode::Terminal => {}
    }

    rtc::answer_offer(&peer, offer, outbound).await?;

    // Apply whatever the browser trickled while the answer was being built.
    // `answer_offer` returns as soon as the answer is on the wire, and the
    // browser starts trickling the moment it reads it, so this is a real race
    // rather than a theoretical one.
    rtc::flush_pending_candidates(&peer, &mut pending).await?;
```

**This deletes the old post-answer check** (`if !offer.capabilities.iter().any(|c| c == rtc::TERMINAL_LABEL) { ... }` at lines 445–449) — classification now happens before the answer, and the `None` arm above replaces it. Note `end_rx` is moved into `run_desktop_session` on the desktop path only; the terminal path below is unchanged and still owns it.

Then add the desktop flow. Because the whole `desktop` module is compiled out on musl, there are two cfg'd versions — the real one, and a musl stub that refuses. Add both right after `run_one_session`:

```rust
/// Serve a desktop offer end to end: create the source, attach the track,
/// answer, wait for the connection, stream, and tear down.
///
/// The order is load-bearing (ADR-15, pinned by the Task 6 E2E): the sending
/// track is attached **before** the answer's remote description is set, and the
/// frame source is created **before** the answer is sent — a host with no
/// display must refuse the offer rather than open a session that can never
/// produce a frame.
#[cfg(not(target_env = "musl"))]
#[allow(clippy::too_many_arguments)]
async fn run_desktop_session(
    offer: &signal::SignalOffer,
    peer: &Arc<dyn PeerConnection>,
    outbound: &mpsc::Sender<signal::SignalMessage>,
    pushed_ice: &[signal::IceServerEntry],
    cfg: &SessionConfig,
    pending: &mut Vec<RTCIceCandidateInit>,
    connected_rx: tokio::sync::oneshot::Receiver<()>,
    mut end_rx: mpsc::Receiver<&'static str>,
    inbound: &mut mpsc::Receiver<signal::SignalMessage>,
) -> Result<()> {
    // Create the source first so a capture failure is a clean refusal
    // (`approved: false`) instead of a session the browser opens onto a black
    // video element.
    let source: Box<dyn desktop::FrameSource> = match cfg.desktop_source {
        DesktopSource::Test => Box::new(desktop::TestPatternSource::new(1280, 720)),
        DesktopSource::Screen => match desktop::ScreenSource::new().await {
            Ok(source) => Box::new(source),
            Err(e) => {
                tracing::warn!(error = %e, "desktop capture unavailable; refusing the offer");
                rtc::refuse_offer(peer, offer, outbound).await?;
                let _ = peer.close().await;
                return Ok(());
            }
        },
    };

    let media = rtc::attach_desktop_track(peer).await?;
    rtc::send_desktop_answer(peer, offer, outbound).await?;
    rtc::flush_pending_candidates(peer, pending).await?;

    // Wait for the connection. Until it is `Connected` the track is unbound and
    // every `write_sample` fails with `Error::CodecNotFound` (Task 3's test
    // pins that failure mode), so streaming must not start before this.
    if !matches!(
        tokio::time::timeout(Duration::from_secs(20), connected_rx).await,
        Ok(Ok(()))
    ) {
        tracing::warn!(session_id = %offer.session_id, "desktop peer did not connect within 20s");
        let _ = peer.close().await;
        return Ok(());
    }

    let (ssrc, payload_type) = rtc::desktop_stream_params(&media).await?;

    let (stop_tx, stop_rx) = tokio::sync::watch::channel(false);
    let mut stream = tokio::spawn(desktop::run_stream(
        source,
        media.track.clone(),
        ssrc,
        payload_type,
        stop_rx,
    ));

    // The desktop session loop: same shape as the terminal one minus the data
    // channel. Ways out: the stream task ending (an error), a candidate/offer
    // on `inbound`, the connection closing or failing (via `end_rx` — the
    // desktop equivalent of "the data channel closed"), the hourly cap, or a
    // shutdown signal.
    let session_deadline = tokio::time::Instant::now() + Duration::from_secs(3600);
    let reason = loop {
        tokio::select! {
            result = &mut stream => break match result {
                Ok(Ok(())) => "the desktop stream ended",
                Ok(Err(e)) => {
                    tracing::warn!(error = %e, "the desktop stream failed");
                    "the desktop stream failed"
                }
                Err(e) => {
                    tracing::warn!(error = %e, "the desktop stream task panicked");
                    "the desktop stream panicked"
                }
            },
            message = inbound.recv() => match message {
                Some(message) => route_inbound(
                    peer,
                    &offer.session_id,
                    pending,
                    message,
                    outbound,
                    pushed_ice,
                    cfg,
                ).await?,
                None => break "the agent is shutting down",
            },
            reason = end_rx.recv() => break reason.unwrap_or("the peer went away"),
            _ = tokio::time::sleep_until(session_deadline) => break "the 1h session cap",
            _ = shutdown_signal() => break "a shutdown signal",
        }
    };
    tracing::info!(session_id = %offer.session_id, reason, "desktop session loop finished");

    // Teardown: signal the stream to stop, give it a bounded moment to exit
    // (it stops the capture thread on the way out), then close the peer. A
    // stream that ignores the stop signal is aborted so no capture task leaks.
    let _ = stop_tx.send(true);
    if tokio::time::timeout(Duration::from_secs(5), &mut stream)
        .await
        .is_err()
    {
        tracing::warn!("the desktop stream did not stop within 5s; aborting it");
        stream.abort();
    }
    let _ = peer.close().await;
    Ok(())
}

/// On musl the desktop module does not exist, so a desktop offer is refused
/// like any other unsupported mode (ADR-15) — no track, no capture, no encoder.
#[cfg(target_env = "musl")]
#[allow(clippy::too_many_arguments)]
async fn run_desktop_session(
    offer: &signal::SignalOffer,
    peer: &Arc<dyn PeerConnection>,
    outbound: &mpsc::Sender<signal::SignalMessage>,
    _pushed_ice: &[signal::IceServerEntry],
    _cfg: &SessionConfig,
    _pending: &mut Vec<RTCIceCandidateInit>,
    _connected_rx: tokio::sync::oneshot::Receiver<()>,
    _end_rx: mpsc::Receiver<&'static str>,
    _inbound: &mut mpsc::Receiver<signal::SignalMessage>,
) -> Result<()> {
    tracing::warn!(
        session_id = %offer.session_id,
        "desktop streaming is unavailable on this build (musl); refusing",
    );
    rtc::refuse_offer(peer, offer, outbound).await?;
    let _ = peer.close().await;
    Ok(())
}
```

- [ ] **Step 11: Verify the whole crate compiles and clippy is clean**

Run: `cargo clippy --manifest-path apps/agent/Cargo.toml --all-targets --locked -- -D warnings`
Expected: PASS. On musl (`cargo clippy --target x86_64-unknown-linux-musl ...`) the desktop module is absent and only the stub is compiled — also clean.

- [ ] **Step 12: Run the full agent test suite**

Run: `cargo test --manifest-path apps/agent/Cargo.toml`
Expected: PASS — the new classification test and SSRC test pass; every pre-existing test is unchanged.

- [ ] **Step 13: Commit**

```bash
cargo fmt
git add apps/agent/src/main.rs apps/agent/src/rtc.rs
git commit -m "feat(agent): answer desktop offers with a live H.264 track"
```

---

### Task 5: Web — desktop tab in the store, view, and affordances

**Files:**
- Modify: `apps/web/src/stores/terminal.ts`
- Create: `apps/web/src/components/desktop/DesktopView.vue`
- Modify: `apps/web/src/views/WorkspaceView.vue`
- Modify: `apps/web/src/components/terminal/TerminalTabBar.vue`
- Modify: `apps/web/src/components/terminal/WorkspaceSidebar.vue`
- Modify: `apps/web/src/components/agent/RegisterAgentDialog.vue:95`
- Test: `apps/web/src/__tests__/terminal-store.test.ts` (extend)
- Test: `apps/web/src/__tests__/DesktopView.test.ts` (create)
- Test: `apps/web/src/__tests__/WorkspaceView.test.ts` (extend)
- Test: `apps/web/src/__tests__/TerminalComponents.test.ts` (extend — sidebar Monitor button)
- Test: `apps/web/src/__tests__/RegisterAgentDialog.test.ts` (update assertion)

**Interfaces:**
- Consumes (from Tasks 1–2): `DesktopClient`, `DesktopStream` from `@ponter/desktop-core`; `PeerConnection` options `{ channelLabels, capabilities, media }` from `@ponter/webrtc-core`.
- Produces (relied on by Task 6's manual demo; the E2E drives the Rust agent, not the store):
  - `TabItem.kind: 'terminal' | 'desktop'`, `TabItem.session?`, `TabItem.desktopStream?`
  - `useTerminalStore().openDesktopTab(agentId: string, title?: string): Promise<string>`

- [ ] **Step 1: Write the failing store tests**

Append to `apps/web/src/__tests__/terminal-store.test.ts`. Add the mock at the top of the file (after the existing imports):

```typescript
import { vi } from 'vitest';

// The store builds a DesktopClient for every desktop tab. Mock the module so
// the test drives `start()` deterministically and can assert `close()`.
const desktopStart = vi.fn();
const desktopClose = vi.fn();
const desktopStateHandler = vi.fn();
const desktopErrorHandler = vi.fn();

vi.mock('@ponter/desktop-core', () => ({
  DesktopClient: vi.fn(() => ({
    start: desktopStart,
    close: desktopClose,
    onConnectionStateChange: desktopStateHandler,
    onError: desktopErrorHandler,
  })),
}));

vi.mock('@/services/client', () => ({
  apiClient: {
    sessions: { create: vi.fn(async () => ({ id: 'sess-desktop' })), terminate: vi.fn() },
    webrtc: { getIceServers: vi.fn(async () => []) },
    http: { baseUrl: 'http://localhost', refreshAccessToken: vi.fn() },
  },
}));

vi.mock('@ponter/webrtc-core', () => ({
  PeerConnection: vi.fn(() => ({
    start: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    waitForChannel: vi.fn(async () => {}),
    onConnectionStateChange: vi.fn(() => () => {}),
    dataChannels: {},
  })),
  createBrowserAdapter: vi.fn(() => ({})),
  RESTPollingTransport: vi.fn(() => ({})),
  WebSocketSignalTransport: vi.fn(() => ({})),
}));
```

Then add the tests (inside the existing `describe`):

```typescript
  it('openDesktopTab creates a desktop tab that reaches active', async () => {
    const { apiClient } = await import('@/services/client');
    const store = useTerminalStore();
    desktopStart.mockResolvedValueOnce({
      track: { kind: 'video' },
      streams: [],
    });

    const tabId = await store.openDesktopTab('ag-1', 'Host 1');

    expect(apiClient.sessions.create).toHaveBeenCalledWith({ agentId: 'ag-1' });
    const tab = store.tabs.find((t) => t.id === tabId);
    expect(tab?.kind).toBe('desktop');
    expect(tab?.status).toBe('active');
    expect(tab?.desktopStream?.track).toEqual({ kind: 'video' });
  });

  it('openDesktopTab refuses when the agent already has an open tab', async () => {
    const { apiClient } = await import('@/services/client');
    const store = useTerminalStore();
    store.tabs.push({
      id: 'tab-1',
      agentId: 'ag-1',
      kind: 'terminal',
      terminalId: 'term-1',
      title: 'Host 1',
      status: 'active',
      session: {} as unknown as TerminalSession,
    });
    vi.mocked(apiClient.sessions.create).mockClear();

    const tabId = await store.openDesktopTab('ag-1', 'Host 1');

    expect(apiClient.sessions.create).not.toHaveBeenCalled();
    expect(store.tabs.find((t) => t.id === tabId)?.status).toBe('error');
    expect(store.tabs.find((t) => t.id === tabId)?.error).toMatch(/already has/i);
  });

  it('closeTab on a desktop tab closes the client and its peer', async () => {
    const store = useTerminalStore();
    desktopStart.mockResolvedValueOnce({ track: { kind: 'video' }, streams: [] });
    const tabId = await store.openDesktopTab('ag-2', 'Host 2');

    store.closeTab(tabId);

    expect(desktopClose).toHaveBeenCalled();
    expect(store.tabs.find((t) => t.id === tabId)).toBeUndefined();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @ponter/web test -- terminal-store`
Expected: FAIL — `store.openDesktopTab is not a function`.

- [ ] **Step 3: Add the discriminator, the desktop connection map, and `openDesktopTab`**

In `apps/web/src/stores/terminal.ts`, change the `TabItem` interface:

```typescript
export interface TabItem {
  id: string;
  agentId: string;
  /** Discriminates the tab body and which connection map owns its lifecycle. */
  kind: 'terminal' | 'desktop';
  terminalId: string;
  title: string;
  status: 'connecting' | 'active' | 'exited' | 'error';
  exitCode?: number;
  /** Why the connection failed, when `status === 'error'`. */
  error?: string;
  /** Terminal tabs only. */
  session?: TerminalSessionType;
  /** Desktop tabs only: the render data. The client/peer live in `desktopConnections`. */
  desktopStream?: DesktopStream;
}
```

Update the imports:

```typescript
import { DesktopClient, type DesktopStream } from '@ponter/desktop-core';
```

Add the desktop connection map next to `connections`:

```typescript
  // Desktop clients are kept apart from terminal connections so a desktop
  // client is never handed to the terminal flow and vice versa. The tab holds
  // only `desktopStream` (render data); lifecycle stays here.
  const desktopConnections = new Map<
    string,
    { peer: PeerConnection; client: DesktopClient; sessionId: string }
  >();
```

Add `kind: 'terminal'` at the two existing construction sites: in `openTab`'s `newTab` (after `agentId`) and in `recordFailedTab`'s pushed object (after `agentId`).

**Then update the pre-existing test fixtures that construct a `TabItem`** — `kind` is required, so the web typecheck (Step 14) fails on every fixture that omits it. `kind` stays required rather than optional on purpose: making it optional would let a store bug create a tab with `kind === undefined` that silently falls through the `kind === 'desktop'` branches, and it would force `=== 'desktop'` checks to also defend against `undefined`. Add `kind: 'terminal'` to each:

- `apps/web/src/__tests__/terminal-store.test.ts:19` (the `store.tabs.push({ ... })` in "selects active tab…").
- `apps/web/src/__tests__/WorkspaceView.test.ts:40` (the `seedTab` helper's `store.tabs.push({ ... })`).
- `apps/web/src/__tests__/TerminalComponents.test.ts` — the two `tabs` prop arrays at lines ~8 and ~27 (add `kind: 'terminal'` to each tab object). These are props for `TerminalTabBar`, whose widened prop type now requires `kind`.

Then add `openDesktopTab` before the `return` block:

```typescript
  /**
   * Open a view-only desktop stream tab (ADR-18/ADR-19).
   *
   * Exclusivity is enforced client-side per agent: one session per agent at a
   * time (ADR-14 makes the server refuse a second anyway, but the user should
   * see why before any network call). The check is deliberately before
   * `sessions.create`, so a rejected click costs nothing.
   */
  async function openDesktopTab(agentId: string, title?: string): Promise<string> {
    const tabId = `tab-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    if (tabs.value.some((t) => t.agentId === agentId)) {
      recordDesktopErrorTab(
        tabId,
        agentId,
        title,
        'This agent already has an open session tab (one session per agent). Close it first.',
      );
      return tabId;
    }

    try {
      const sessionResp = await apiClient.sessions.create({ agentId });
      const transport = await createSignalingTransport(sessionResp.id);
      const iceServers = await apiClient.webrtc.getIceServers();
      const rtcPeer = createBrowserAdapter({ iceServers });

      // No data channel: desktop is media-only, so `channelLabels: []` and the
      // capability/media options drive the offer.
      const peer = new PeerConnection(rtcPeer, transport, {
        role: 'offerer',
        channelLabels: [],
        capabilities: ['desktop'],
        media: { video: true },
      });

      if (transport instanceof WebSocketSignalTransport) {
        transport.onServerError((code) => {
          if (code !== 'SESSION_TERMINATED' && code !== 'NOT_FOUND') return;
          const message =
            code === 'SESSION_TERMINATED'
              ? 'Session terminated: the agent disconnected or the session was closed.'
              : 'Session not found on the server.';
          for (const tab of tabs.value) {
            if (tab.agentId !== agentId || tab.kind !== 'desktop') continue;
            tab.status = 'error';
            tab.error = message;
          }
          desktopConnections.delete(agentId);
        });
      }

      peer.onConnectionStateChange((state) => {
        if (state !== 'failed') return;
        const message =
          'Connection failed: no direct route to the agent (ICE). Check that ' +
          'TURN is reachable, or that the agent is not behind a blocking NAT.';
        for (const tab of tabs.value) {
          if (tab.agentId !== agentId || tab.kind !== 'desktop') continue;
          tab.status = 'error';
          tab.error = message;
        }
        desktopConnections.delete(agentId);
      });

      const client = new DesktopClient(agentId, peer);
      desktopConnections.set(agentId, { peer, client, sessionId: sessionResp.id });

      const tab: TabItem = {
        id: tabId,
        agentId,
        kind: 'desktop',
        terminalId: '',
        title: title || `Agent ${agentId.slice(0, 8)}`,
        status: 'connecting',
      };
      tabs.value.push(tab);
      activeTabId.value = tabId;

      const stream = await client.start();
      tab.desktopStream = stream;
      tab.status = 'active';
      return tabId;
    } catch (e) {
      const message =
        e instanceof Error ? e.message : String(e ?? 'unknown error');
      // Drop the half-built connection so a retry does not reuse a dead peer.
      const half = desktopConnections.get(agentId);
      if (half) {
        half.client.close();
        void half.peer.close();
        desktopConnections.delete(agentId);
      }
      const existing = tabs.value.find((t) => t.id === tabId);
      if (existing) {
        existing.status = 'error';
        existing.error = message;
      } else {
        recordDesktopErrorTab(tabId, agentId, title, message);
      }
      return tabId;
    }
  }

  /** A desktop tab that shows a failure instead of a video element. */
  function recordDesktopErrorTab(
    tabId: string,
    agentId: string,
    title: string | undefined,
    message: string,
  ): void {
    tabs.value.push({
      id: tabId,
      agentId,
      kind: 'desktop',
      terminalId: '',
      title: title || `Agent ${agentId.slice(0, 8)}`,
      status: 'error',
      error: message,
    });
    activeTabId.value = tabId;
  }
```

Extract the shared signaling-transport builder from `getOrConnectAgent` so the two flows cannot drift. Replace the token/transport block inside `getOrConnectAgent` (currently lines 50–84) with a call to the new helper, and add the helper:

```typescript
  /**
   * Build the signaling transport for a session. Shared by the terminal and
   * desktop flows so the WS/REST selection and the refresh callback cannot
   * drift apart between them.
   */
  async function createSignalingTransport(
    sessionId: string,
  ): Promise<WebSocketSignalTransport | RESTPollingTransport> {
    const token = await tokenStorage.getAccessToken();
    const useWsSignaling = import.meta.env.VITE_BROWSER_WS_SIGNALING === 'true';

    const restTransport = () =>
      new RESTPollingTransport({
        baseUrl: apiClient.http.baseUrl,
        sessionId,
        token: token ?? '',
        onUnauthorized: async () => apiClient.http.refreshAccessToken(),
      });

    return useWsSignaling
      ? new WebSocketSignalTransport({
          baseUrl: apiClient.http.baseUrl,
          sessionId,
          getToken: () => tokenStorage.getAccessToken(),
          onUnauthorized: () => apiClient.http.refreshAccessToken(),
          reconnect: true,
          fallback: restTransport(),
        })
      : restTransport();
  }
```

(Inside `getOrConnectAgent`, replace `const token = ...` through the `const transport = ...` block with `const transport = await createSignalingTransport(sessionResp.id);`.)

- [ ] **Step 4: Update `closeTab`, `retryTab`, and the exports**

In `closeTab`, branch on `kind` after `removed` is spliced:

```typescript
    if (removed.kind === 'desktop') {
      const conn = desktopConnections.get(removed.agentId);
      if (conn) {
        conn.client.close();
        void conn.peer.close();
        desktopConnections.delete(removed.agentId);
        void apiClient.sessions.terminate(conn.sessionId).catch(() => {});
      }
    } else {
      try {
        removed.session?.close();
      } catch {
        // session may be a mock in tests, or already closed
      }

      const hasOtherTabsForAgent = tabs.value.some(
        (t) => t.agentId === removed.agentId && t.kind === 'terminal',
      );
      if (!hasOtherTabsForAgent) {
        const conn = connections.get(removed.agentId);
        if (conn) {
          conn.client.dispose();
          void conn.peer.close();
          connections.delete(removed.agentId);
          void apiClient.sessions.terminate(conn.sessionId).catch(() => {});
        }
      }
    }
```

(Move the active-tab reselection block above this branch so it runs for both kinds — it only reads `tabs`/`activeTabId`.)

In `retryTab`, dispatch on `failed.kind`:

```typescript
    tabs.value.splice(index, 1);
    if (failed.kind === 'desktop') {
      const conn = desktopConnections.get(failed.agentId);
      if (conn) {
        conn.client.close();
        void conn.peer.close();
        desktopConnections.delete(failed.agentId);
      }
      await openDesktopTab(failed.agentId, failed.title);
    } else {
      connections.delete(failed.agentId);
      pendingConnections.delete(failed.agentId);
      await openTab(failed.agentId, failed.title);
    }
```

Add `openDesktopTab` to the returned object:

```typescript
  return {
    tabs,
    activeTabId,
    activeTab,
    openTab,
    openDesktopTab,
    retryTab,
    setActiveTab,
    closeTab,
    getOrConnectAgentForTest: getOrConnectAgent,
  };
```

- [ ] **Step 5: Run the store tests to verify they pass**

Run: `pnpm --filter @ponter/web test -- terminal-store`
Expected: PASS.

- [ ] **Step 6: Write the failing `DesktopView` tests**

Create `apps/web/src/__tests__/DesktopView.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import DesktopView from '@/components/desktop/DesktopView.vue';
import { useTerminalStore } from '@/stores/terminal';
import type { TabItem } from '@/stores/terminal';

function desktopTab(overrides: Partial<TabItem> = {}): TabItem {
  return {
    id: 'tab-1',
    agentId: 'ag-1',
    kind: 'desktop',
    terminalId: '',
    title: 'Host 1',
    status: 'active',
    ...overrides,
  };
}

describe('DesktopView', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('renders a video element with no controls (view-only)', () => {
    const wrapper = mount(DesktopView, { props: { tab: desktopTab() } });
    const video = wrapper.find('video');
    expect(video.exists()).toBe(true);
    expect(video.attributes('controls')).toBeUndefined();
    expect(video.attributes('muted')).toBeDefined();
    expect(video.attributes('autoplay')).toBeDefined();
  });

  it('shows the error overlay and a Retry button when the tab errored', async () => {
    const store = useTerminalStore();
    const retry = vi.spyOn(store, 'retryTab').mockResolvedValue();
    const wrapper = mount(DesktopView, {
      props: { tab: desktopTab({ status: 'error', error: 'no route' }) },
    });
    expect(wrapper.text()).toContain('no route');
    await wrapper.find('[data-test="retry-desktop-tab-1"]').trigger('click');
    expect(retry).toHaveBeenCalledWith('tab-1');
  });

  it('clears srcObject on unmount', () => {
    const wrapper = mount(DesktopView, {
      props: {
        tab: desktopTab({
          desktopStream: { track: { kind: 'video' }, streams: [] } as never,
        }),
      },
    });
    const video = wrapper.find('video').element as HTMLVideoElement;
    wrapper.unmount();
    expect(video.srcObject).toBeNull();
  });
});
```

- [ ] **Step 7: Run the test to verify it fails**

Run: `pnpm --filter @ponter/web test -- DesktopView`
Expected: FAIL — `Failed to resolve import "@/components/desktop/DesktopView.vue"`.

- [ ] **Step 8: Create `DesktopView.vue`**

Create `apps/web/src/components/desktop/DesktopView.vue`:

```vue
<script setup lang="ts">
import { ref, watch, onBeforeUnmount } from 'vue';
import { RefreshCw } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import { useTerminalStore } from '@/stores/terminal';
import type { TabItem } from '@/stores/terminal';

const props = defineProps<{ tab: TabItem }>();
const store = useTerminalStore();
const videoEl = ref<HTMLVideoElement | null>(null);

/** Assign the stream, guarding the detached-element case during teardown. */
function attach() {
  const el = videoEl.value;
  if (!el) return;
  const stream = props.tab.desktopStream;
  if (!stream) {
    el.srcObject = null;
    return;
  }
  // werift's onTrack path reports no streams, so fall back to a stream built
  // from the track alone; a real browser reports `streams[0]`.
  const srcObject =
    stream.streams[0] ?? new MediaStream([stream.track as MediaStreamTrack]);
  try {
    el.srcObject = srcObject as MediaStream;
  } catch {
    // The element was detached mid-teardown; nothing to attach to.
  }
}

watch(() => props.tab.desktopStream, attach, { immediate: true });

onBeforeUnmount(() => {
  // Release the decoder without touching the store's client lifecycle — the
  // store owns closing the client/peer (closeTab).
  if (videoEl.value) videoEl.value.srcObject = null;
});
</script>

<template>
  <div class="relative h-full w-full bg-[#090d16]">
    <!-- No `controls`: Week 7 is view-only (ADR-18). -->
    <video
      ref="videoEl"
      autoplay
      muted
      playsinline
      class="h-full w-full object-contain"
    />

    <div
      v-if="tab.status === 'connecting'"
      class="absolute inset-0 flex flex-col items-center justify-center gap-3 text-muted-foreground"
    >
      <span
        class="h-5 w-5 rounded-full border-2 border-muted-foreground/30 border-t-primary animate-spin"
      ></span>
      <p class="text-xs font-mono">Negotiating stream…</p>
    </div>

    <div
      v-if="tab.status === 'error'"
      class="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[#090d16]/95 p-6 text-center"
    >
      <p class="text-sm text-destructive font-semibold">
        Could not open the desktop stream for {{ tab.title }}
      </p>
      <p class="text-xs text-muted-foreground font-mono max-w-lg break-words">
        {{ tab.error }}
      </p>
      <Button
        size="sm"
        variant="outline"
        class="text-xs flex items-center gap-2 border-border/80"
        :data-test="`retry-desktop-${tab.id}`"
        @click="store.retryTab(tab.id)"
      >
        <RefreshCw class="w-3.5 h-3.5" />
        Retry connection
      </Button>
    </div>
  </div>
</template>
```

- [ ] **Step 9: Run the `DesktopView` tests to verify they pass**

Run: `pnpm --filter @ponter/web test -- DesktopView`
Expected: PASS.

- [ ] **Step 10: Dispatch the workspace body on `kind` and add the desktop telemetry line**

In `apps/web/src/views/WorkspaceView.vue`, add the import:

```typescript
import DesktopView from '@/components/desktop/DesktopView.vue';
```

Replace the single `<XtermTerminal ... />` in the body with a kind dispatch:

```html
          <XtermTerminal
            v-if="terminalStore.activeTab.kind === 'terminal'"
            :key="terminalStore.activeTab.id"
            :session="toRaw(terminalStore.activeTab.session) as TerminalSession"
          />
          <DesktopView v-else :key="terminalStore.activeTab.id" :tab="terminalStore.activeTab" />
```

In the footer telemetry bar, make the channel span kind-aware:

```html
          <span class="flex items-center gap-1">
            <Radio class="w-3 h-3 text-primary" />
            <span v-if="terminalStore.activeTab.kind === 'desktop'">
              Media: H.264 · view-only
            </span>
            <span v-else>Channel: terminal (64 KiB buffer)</span>
          </span>
```

Add the sidebar wiring (the `WorkspaceSidebar` gains a `connect-desktop` event):

```html
    <WorkspaceSidebar
      v-show="sidebarOpen"
      @connect-agent="handleConnect"
      @connect-desktop="handleConnectDesktop"
    />
```

```typescript
function handleConnectDesktop(agent: Agent) {
  terminalStore.openDesktopTab(
    agent.id,
    agent.hostname || `Agent ${agent.id.slice(0, 6)}`,
  );
}
```

- [ ] **Step 11: Add the sidebar Monitor affordance and the tab-bar icon**

In `apps/web/src/components/terminal/WorkspaceSidebar.vue`, import `Monitor`:

```typescript
import { Terminal, Monitor, RefreshCw, Server, Search } from '@lucide/vue';
```

Add the emit:

```typescript
defineEmits<{
  (e: 'connectAgent', agent: Agent): void;
  (e: 'connectDesktop', agent: Agent): void;
}>();
```

Replace the single trailing icon `<div>` (currently lines 139–143) with a kind-aware affordance group:

```html
          <div class="flex items-center gap-1">
            <button
              class="p-1 rounded bg-muted/50 group-hover:bg-primary/10 group-hover:text-primary transition-colors text-muted-foreground"
              title="Open terminal"
              :data-test="`connect-terminal-${a.id}`"
              @click.stop="$emit('connectAgent', a)"
            >
              <Terminal class="w-3.5 h-3.5" />
            </button>
            <button
              v-if="a.capabilities.includes('desktop')"
              class="p-1 rounded bg-muted/50 group-hover:bg-primary/10 group-hover:text-primary transition-colors text-muted-foreground"
              title="Open desktop stream"
              :data-test="`connect-desktop-${a.id}`"
              @click.stop="$emit('connectDesktop', a)"
            >
              <Monitor class="w-3.5 h-3.5" />
            </button>
          </div>
```

In `apps/web/src/components/terminal/TerminalTabBar.vue`, widen the props type and add the kind icon:

```typescript
import { Plus, RefreshCw, X, Terminal, Monitor } from '@lucide/vue';
// ...
defineProps<{
  tabs: Array<{
    id: string;
    title: string;
    status: string;
    kind: 'terminal' | 'desktop';
  }>;
  activeTabId: string | null;
}>();
```

In the row, before the title `<span class="truncate max-w-[130px] font-mono">`:

```html
          <Monitor v-if="tab.kind === 'desktop'" class="w-3.5 h-3.5 flex-shrink-0" />
          <Terminal v-else class="w-3.5 h-3.5 flex-shrink-0" />
```

- [ ] **Step 12: Advertise the desktop capability at registration and update its test**

In `apps/web/src/components/agent/RegisterAgentDialog.vue:95`, change:

```typescript
      capabilities: ['terminal', 'desktop'],
```

In `apps/web/src/__tests__/RegisterAgentDialog.test.ts`, update the two assertions at lines 16 and 119 from `capabilities: ['terminal']` to `capabilities: ['terminal', 'desktop']`.

- [ ] **Step 13: Add the workspace and sidebar component tests**

Append to `apps/web/src/__tests__/WorkspaceView.test.ts`:

```typescript
  it('renders DesktopView (not XtermTerminal) for a desktop tab', async () => {
    const store = useTerminalStore();
    store.tabs.push({
      id: 'tab-d',
      agentId: 'ag-1',
      kind: 'desktop',
      terminalId: '',
      title: 'Host 1',
      status: 'active',
      desktopStream: { track: { kind: 'video' }, streams: [] } as never,
    });
    store.setActiveTab('tab-d');
    const wrapper = mount(WorkspaceView);
    await flushPromises();
    expect(wrapper.find('video').exists()).toBe(true);
  });
```

Append to `apps/web/src/__tests__/TerminalComponents.test.ts` (the file that already mounts `WorkspaceSidebar`):

```typescript
  it('shows the Monitor button only for agents advertising desktop', async () => {
    const wrapper = mount(WorkspaceSidebar, {
      props: {},
      global: { stubs: { ScrollArea: { template: '<div><slot /></div>' } } },
    });
    // Drive the agent list through the mocked api client used by this suite.
    // Agent A advertises desktop; agent B does not.
    await flushPromises();
    expect(wrapper.find('[data-test="connect-desktop-a1"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="connect-desktop-a2"]').exists()).toBe(false);

    await wrapper.find('[data-test="connect-desktop-a1"]').trigger('click');
    expect(wrapper.emitted('connectDesktop')).toBeTruthy();
    expect(wrapper.emitted('connectAgent')).toBeFalsy();
  });
```

(If the existing suite's agent fixture does not include a `capabilities` array, add `capabilities: ['terminal', 'desktop']` to agent A and `capabilities: ['terminal']` to agent B in that fixture — the sidebar reads `a.capabilities.includes('desktop')` directly.)

- [ ] **Step 14: Run the full web suite and the typecheck**

Run: `pnpm --filter @ponter/web test && pnpm --filter @ponter/web typecheck`
Expected: PASS.

- [ ] **Step 15: Commit**

```bash
pnpm --filter @ponter/web exec prettier --write src/stores/terminal.ts src/components/desktop/DesktopView.vue src/views/WorkspaceView.vue src/components/terminal/TerminalTabBar.vue src/components/terminal/WorkspaceSidebar.vue src/components/agent/RegisterAgentDialog.vue
git add apps/web/src/stores/terminal.ts apps/web/src/components/desktop/DesktopView.vue apps/web/src/views/WorkspaceView.vue apps/web/src/components/terminal/TerminalTabBar.vue apps/web/src/components/terminal/WorkspaceSidebar.vue apps/web/src/components/agent/RegisterAgentDialog.vue apps/web/src/__tests__/terminal-store.test.ts apps/web/src/__tests__/DesktopView.test.ts apps/web/src/__tests__/WorkspaceView.test.ts apps/web/src/__tests__/TerminalComponents.test.ts apps/web/src/__tests__/RegisterAgentDialog.test.ts
git commit -m "feat(web): desktop stream tab, view, and per-agent affordance"
```

---

### Task 6: E2E — harness extensions, `desktop.e2e.test.ts`, CI capture deps

**Files:**
- Modify: `packages/webrtc-core/test/e2e/harness.ts`
- Create: `packages/webrtc-core/test/e2e/desktop.e2e.test.ts`
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/build-agent.yml`

**Interfaces:**
- Consumes (from Tasks 1–5): `PeerConnection` options `{ role, channelLabels, capabilities, media }`; `WeriftAdapter` config `{ iceServers, codecs }`; `werift`'s `useH264`; the agent CLI flag `--desktop-source test`; the agent log line `"desktop session loop finished"` (Task 4, Step 10); the media-only ICE timeouts (Task 4, Step 8).
- Produces (relied on by nothing later — this is the last code task):
  - `spawnAgent(agentId: string, credential: string, extraArgs?: string[]): { child: ChildProcess; output: () => string }` (harness.ts)
  - `seed(options?: { capabilities?: string[] })` (harness.ts)

- [ ] **Step 1: Extend `spawnAgent` with `extraArgs`**

In `packages/webrtc-core/test/e2e/harness.ts`, replace `spawnAgent` (currently lines 406–426) with the appended-args version. The default `[]` keeps every existing call site — the whole terminal suite — byte-identical:

```typescript
/** Spawn the real binary and register it for teardown. */
export function spawnAgent(
  agentId: string,
  credential: string,
  extraArgs: string[] = [],
): { child: ChildProcess; output: () => string } {
  const spawned = spawnLogged(
    AGENT_BIN,
    [
      '--agent-id',
      agentId,
      '--server',
      WS_URL,
      '--credential',
      credential,
      '--stun',
      '',
      ...extraArgs,
    ],
    { cwd: REPO_ROOT, env: { RUST_LOG: 'info' } },
  );
  agents.push(spawned);
  return spawned;
}
```

- [ ] **Step 2: Extend `seed` with a `capabilities` option**

Replace `seed` (currently lines 365–403) so the agent is registered with the capabilities the caller names. The default `['terminal']` preserves today's behavior exactly:

```typescript
/** Register a user, an agent and a session; return everything a test needs. */
export async function seed(
  { capabilities = ['terminal'] }: { capabilities?: string[] } = {},
): Promise<{
  token: string;
  agentId: string;
  credential: string;
  sessionId: string;
}> {
  // `randomUUID` rather than `Math.random`: S2245 flags any use of the
  // non-cryptographic PRNG, and a UUID is just as unique for a test suffix.
  const suffix = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;

  const auth = await postJson<{ token: string }>('/api/auth/register', {
    username: `e2e_${suffix}`,
    password: 'Password123!',
    publicKey: `pk_e2e_${suffix}`,
  });

  const create = await postJson<AgentCreated>(
    '/api/agents',
    {
      id: `agent_e2e_${suffix}`,
      publicKey: `pk_agent_${suffix}`,
      capabilities,
    },
    auth.token,
  );

  const session = await postJson<{ id: string }>(
    '/api/sessions',
    { agentId: create.agent.id },
    auth.token,
  );

  return {
    token: auth.token,
    agentId: create.agent.id,
    credential: create.credential,
    sessionId: session.id,
  };
}
```

- [ ] **Step 3: Confirm the harness changes are backward-compatible**

Run: `pnpm --filter @ponter/webrtc-core test:e2e`

Expected: PASS — the existing `terminal.e2e.test.ts` suite is unchanged and green. The two new parameters default to the old behavior, so a regression here means the defaulting is wrong, not the tests.

> **Note:** if the agent binary is not built, build it first: `cargo build --manifest-path apps/agent/Cargo.toml`. On a host without the capture stack, this still succeeds — `xcap`/`openh264` are only needed at *runtime* for `--desktop-source screen`, and this suite always passes `test`.

- [ ] **Step 4: Create `packages/webrtc-core/test/e2e/desktop.e2e.test.ts`**

```typescript
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { useH264 } from 'werift';
import type { MediaStreamTrack as WeriftTrack, RtpPacket } from 'werift';
import { PeerConnection } from '../../src/connection';
import { WeriftAdapter } from '../../src/adapters/werift';
import { RESTPollingTransport } from '../../src/transport';
import {
  isLinux,
  BASE_URL,
  setupE2E,
  teardownE2E,
  seed,
  spawnAgent,
  waitForAgentOnline,
  connectTerminal,
  postJson,
  sendKeystrokes,
  waitFor,
  waitForTerminalOutput,
} from './harness';

/**
 * Whether an RTP payload contains an H.264 IDR (NAL type 5).
 *
 * rtc-rtp's H.264 payloader emits a STAP-A (SPS+PPS) before the first slice,
 * then a single NAL when it fits the MTU or FU-A fragments when it does not.
 * An IDR therefore shows up as: a single NAL of type 5, an FU-A/FU-B whose
 * *start* fragment carries type 5, or a STAP-A containing a type-5 NAL.
 */
function hasIdr(payload: Buffer): boolean {
  if (payload.length === 0) return false;
  const nalType = payload[0]! & 0x1f;
  if (nalType === 5) return true;
  if ((nalType === 28 || nalType === 29) && payload.length >= 2) {
    return (payload[1]! & 0x1f) === 5;
  }
  if (nalType === 24) {
    let offset = 1;
    while (offset + 2 <= payload.length) {
      const size = payload.readUInt16BE(offset);
      offset += 2;
      if (size === 0 || offset + size > payload.length) break;
      if ((payload[offset]! & 0x1f) === 5) return true;
      offset += size;
    }
  }
  return false;
}

/**
 * Layer 3 for desktop streaming: a Rust agent capturing/encoding H.264, a
 * werift offerer, the real backend, and real SRTP over DTLS.
 *
 * Linux-only, and headless by construction: the agent is spawned with
 * `--desktop-source test` (ADR-17), so no display, portal, or PipeWire session
 * is involved — the stream is a deterministic pattern.
 */
describe.skipIf(!isLinux)('cross-language desktop E2E', () => {
  beforeAll(async () => {
    await setupE2E();
  }, 120_000);

  afterAll(async () => {
    await teardownE2E();
  }, 60_000);

  /**
   * Open a desktop offerer: recvonly video, no data channels, and H.264 offered
   * explicitly. werift's default video codec list is VP8-only
   * (`generateDefaultPeerConfig`), so without the override the offer would
   * advertise VP8 and the agent — which serves H.264 — would have no video
   * m-line to answer into.
   */
  async function openDesktopPeer(
    sessionId: string,
    token: string,
  ): Promise<{
    offerer: PeerConnection;
    tracks: WeriftTrack[];
    packets: RtpPacket[];
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
        channelLabels: [],
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

    await offerer.start();
    return { offerer, tracks, packets };
  }

  it('receives a real H.264 track with flowing RTP', async () => {
    const { token, agentId, credential, sessionId } = await seed({
      capabilities: ['desktop'],
    });

    spawnAgent(agentId, credential, ['--desktop-source', 'test']);
    await waitForAgentOnline(token, agentId);

    const { offerer, tracks, packets } = await openDesktopPeer(sessionId, token);

    try {
      // If the answer's track were attached after `set_remote_description`
      // (ADR-15), no track would ever arrive — this is the order-of-operations
      // assertion from Review Focus #1.
      await waitFor(() => tracks.length > 0, 'a remote video track', 20_000);
      const track = tracks[0]!;
      expect(track.kind).toBe('video');

      // The floor is far below 15 fps × 15 s; it tolerates CI jitter while
      // still proving the stream is continuous rather than a lone packet.
      await waitFor(
        () => packets.length >= 30,
        'at least 30 RTP packets over the window',
        15_000,
      );

      // H.264, and every packet on the negotiated payload type. The literal PT
      // is deliberately NOT pinned: the agent answers with the PT it accepted
      // from the offer, and `track.codec` — built by werift from the answer
      // SDP — is the source of truth.
      expect(track.codec?.mimeType).toBe('video/H264');
      const pt = track.codec!.payloadType;
      expect(packets.every((p) => p.header.payloadType === pt)).toBe(true);

      // At least one keyframe in the window (ADR-16: periodic IDR).
      expect(packets.some((p) => hasIdr(p.payload))).toBe(true);
    } finally {
      await offerer.close();
    }
  }, 120_000);

  // Review Focus #5, the desktop half: a dead peer must not keep the ADR-14
  // slot. This is the desktop twin of the terminal `fix/agent-session-dead-peer`
  // bug — but the desktop session has no data channel, so the close signal is
  // ICE silence rather than an SCTP reset.
  it('ends the agent session on peer close and serves the next offer', async () => {
    const { token, agentId, credential, sessionId } = await seed({
      capabilities: ['desktop'],
    });

    const agent = spawnAgent(agentId, credential, ['--desktop-source', 'test']);
    await waitForAgentOnline(token, agentId);

    const first = await openDesktopPeer(sessionId, token);
    await waitFor(() => first.packets.length > 0, 'the first RTP packet', 20_000);

    // werift's `pc.close()` on a media-only connection sends neither a DTLS
    // close_notify nor an ICE packet — the socket simply goes quiet. The agent
    // detects that through ICE: with the media-only timeouts from Task 4
    // (disconnected 3s + failed 5s), it reaches `Failed` ~8s after the last
    // packet and ends the session. The bound must exceed 8s; 20s leaves room
    // for CI scheduling without hiding a genuinely hung session.
    await first.offerer.close();

    try {
      await waitFor(
        () => agent.output().includes('desktop session loop finished'),
        'the agent to end the desktop session after its peer closed',
        20_000,
      );
    } catch (error) {
      // The agent log is the evidence when this fails: a session that never
      // noticed the close shows no ICE transition at all.
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\n` +
          `--- agent output ---\n${agent.output()}`,
      );
    }
    expect(agent.child.exitCode).toBeNull();

    // A fresh session for the same agent must connect: the dead peer must not
    // have swallowed the slot (ADR-14's "ready for the next offer").
    const session2 = await postJson<{ id: string }>(
      '/api/sessions',
      { agentId },
      token,
    );
    const second = await openDesktopPeer(session2.id, token);
    try {
      await waitFor(
        () => second.packets.length > 0,
        'the second session to receive RTP',
        20_000,
      );
    } finally {
      await second.offerer.close();
    }
  }, 120_000);

  // Review Focus #4: desktop mode must not have altered the terminal answer
  // path. The agent is spawned with the desktop flag present but is offered a
  // terminal session, and the terminal frame contract must be unchanged.
  it('leaves the terminal flow unaffected', async () => {
    const { token, agentId, credential, sessionId } = await seed(); // default: terminal

    spawnAgent(agentId, credential, ['--desktop-source', 'test']);
    await waitForAgentOnline(token, agentId);

    const { offerer, frames } = await connectTerminal(sessionId, token);

    try {
      sendKeystrokes(offerer, sessionId, 'echo hello\n');
      await waitForTerminalOutput(frames, 'hello');

      expect(frames[0]?.channel).toBe('terminal');
      expect(frames[0]?.type).toBe('terminal-data');
    } finally {
      await offerer.close();
    }
  }, 90_000);
});
```

> **Why the three tests share one file:** `vitest.e2e.config.ts` sets `fileParallelism: false` and `sequence.concurrent: false`, and its own comment already anticipates a second file. Both E2E files bind port 8787 and the same SQLite file, so they must not run concurrently — which the config guarantees.

- [ ] **Step 5: Run the desktop E2E suite**

Run: `pnpm --filter @ponter/webrtc-core test:e2e`

Expected: PASS — all three desktop tests plus the pre-existing terminal suite. A failure localises to one layer:
- **no track within 20s** → the answer's track order (Task 4, Step 10) or the codec negotiation (the agent must have an H.264 m-line to answer into);
- **track but no/too few packets** → the encoder or the payloader (Task 3);
- **packets on a different PT than `track.codec.payloadType`** → the agent is sending on the wrong payload type (`desktop_stream_params`, Task 4);
- **Test 2 timing out** → the media-only ICE timeouts were not applied (Task 4, Step 8), so the session lingers ~30s.

- [ ] **Step 6: Add the capture-stack apt step to `ci.yml`**

In `.github/workflows/ci.yml`, the `rust` job builds the agent for glibc, which now includes `xcap`/`openh264` and needs their system headers. Add, immediately after the `Install Rust toolchain` step (before the cache step) in the **`rust`** job:

```yaml
      - name: Install system dependencies (capture stack)
        run: sudo apt-get update && sudo apt-get install -y libpipewire-0.3-dev libspa-0.2-dev libgbm-dev libdrm-dev libegl-dev
```

Add the identical step to the **`e2e`** job, immediately before `Build the agent binary` (that job compiles the agent the harness spawns):

```yaml
      - name: Install system dependencies (capture stack)
        run: sudo apt-get update && sudo apt-get install -y libpipewire-0.3-dev libspa-0.2-dev libgbm-dev libdrm-dev libegl-dev
```

> `nasm` is intentionally absent: `openh264-sys2`'s `try_compile_nasm` only *warns* when NASM is missing and falls back to the C path, so the build succeeds either way. Adding it would be harmless but is not required.

- [ ] **Step 7: Add the capture-stack apt step to `build-agent.yml`**

In the **`verify`** job (ubuntu-latest, glibc), add the same step after `Install Rust toolchain`:

```yaml
      - name: Install system dependencies (capture stack)
        run: sudo apt-get update && sudo apt-get install -y libpipewire-0.3-dev libspa-0.2-dev libgbm-dev libdrm-dev libegl-dev
```

In the **`build`** job, only the two linux-**gnu** targets need the headers. Add, immediately before the `Build` step (after the existing musl-tools step):

```yaml
      - name: Install system dependencies (capture stack, linux-gnu only)
        if: ${{ matrix.target == 'x86_64-unknown-linux-gnu' || matrix.target == 'aarch64-unknown-linux-gnu' }}
        run: |
          sudo apt-get update
          sudo apt-get install -y libpipewire-0.3-dev libspa-0.2-dev libgbm-dev libdrm-dev libegl-dev
```

> The **musl** target needs nothing: `xcap`, `openh264` and `bytes` are gated behind `[target.'cfg(not(target_env = "musl"))'.dependencies]` (Task 3), so they are absent from that build. The **macOS** and **Windows** targets also need nothing — `xcap` compiles against system frameworks there. `ubuntu-24.04-arm` uses the same apt package names as `ubuntu-latest`.

- [ ] **Step 8: Verify the workflows are valid YAML**

Run: `pnpm dlx yaml-lint .github/workflows/ci.yml .github/workflows/build-agent.yml` (or, if `yaml-lint` is unavailable, `python3 -c "import yaml,sys; [yaml.safe_load(open(f)) for f in sys.argv[1:]]" .github/workflows/ci.yml .github/workflows/build-agent.yml`)

Expected: no output, exit 0. This catches an indentation slip in the inserted steps, which GitHub would otherwise only surface as a workflow that never runs.

- [ ] **Step 9: Commit**

```bash
git add packages/webrtc-core/test/e2e/harness.ts packages/webrtc-core/test/e2e/desktop.e2e.test.ts .github/workflows/ci.yml .github/workflows/build-agent.yml
git commit -m "test(e2e): desktop streaming across the real stack; CI capture deps"
```

---

### Task 7: `docs/ARCHITECTURE.md` reconciliation

**Files:**
- Modify: `docs/ARCHITECTURE.md` (§8 roadmap, §11 perf table)

**Interfaces:**
- Consumes: nothing (documentation only).
- Produces: nothing (documentation only).

> **Language:** `docs/ARCHITECTURE.md` is written in Vietnamese — its own section headers ("## 8. Lộ trình Triển khai", "### Phase 2: WebRTC & Terminal (Tuần 4-6)") establish the file's convention. The additions below are Vietnamese to match. This is the one place the plan deviates from the global "repo docs stay English" rule, and it is because the rule itself defers to a file's own convention.

- [ ] **Step 1: Add the Phase 3 roadmap section**

In `docs/ARCHITECTURE.md` §8, the roadmap currently jumps from `### Phase 2: WebRTC & Terminal (Tuần 4-6)` straight to `### Phase 5: E2EE & Security & Polish (Tuần 12-14)` — Phases 3 and 4 have no section. Insert the Phase 3 section **between** the end of Phase 2 (the last line of its Tuần 6 block, `- [ ] Handle resize events`) and `### Phase 5: ...`:

```markdown
### Phase 3: Desktop Streaming (Tuần 7-9)

> **Trạng thái:** Tuần 7 là *thin slice* đã hoàn thành — xem view-only, ~720p @ 15fps, H.264 phần mềm (openh264). Tuần 8-9 (chất lượng hình ảnh, điều khiển chuột/phím, hardening) là hạng mục sắp tới.

#### Tuần 7: Desktop Streaming — lát cắt mỏng (đã xong)
- [x] `packages/webrtc-core` — seam media tuỳ chọn (`addTransceiver`/`onTrack`) + `media-channel.ts` (đóng ADR-06)
- [x] `packages/desktop-core` — `DesktopClient` không phụ thuộc DOM
- [x] Agent Rust — `desktop.rs` (capture → downscale → openh264) + nhánh trả lời desktop trong `rtc.rs`
- [x] Web — tab desktop trong workspace, độc quyền theo agent (ADR-19)
- [x] E2E cross-language (`desktop.e2e.test.ts`) + demo thủ công trên Chrome

#### Tuần 8-9: Chất lượng & tương tác (sắp tới)
- [ ] Tăng chất lượng/khung hình, adaptive bitrate
- [ ] Điều khiển chuột & bàn phím (input forwarding) — hiện chỉ view-only (ADR-18)
- [ ] Chọn màn hình/cửa sổ, codec phần cứng

### Phase 4: File Transfer (Tuần 10-11)

> **Chưa thiết kế.** Mục này được giữ chỗ để lộ trình không nhảy cóc từ Phase 3 sang Phase 5; nội dung chi tiết sẽ bổ sung khi có spec riêng.
```

> **Decision — the Phase 4 stub:** the spec (§11.1) left this to implementation time. A one-line stub is added rather than leaving the gap, because a roadmap that reads "Phase 3 → Phase 5" is the exact drift this task exists to fix; the stub is explicitly labelled "chưa thiết kế" so it invents no scope. The week range (Tuần 10-11) is the only one not yet stated in the file — it is the slot between Phase 3 (Tuần 7-9) and Phase 5 (Tuần 12-14).

- [ ] **Step 2: Split the perf-table row**

In §11 (Performance Targets), the row `| Desktop FPS | 60fps | Hardware H.265 |` is aspirational and now contradicted by shipped scope. Replace that single line with two rows — the shipped Week 7 reality, then the Phase 3 ambition labelled as a target:

```markdown
| Desktop stream (Week 7) | ~720p @ 15fps, view-only | Software H.264 (openh264) |
| Desktop stream (Phase 3 target) | 60fps | Hardware H.265 |
```

- [ ] **Step 3: Verify the file is still valid Markdown and the table renders**

Run: `pnpm exec markdownlint-cli2 docs/ARCHITECTURE.md` (if the repo has no markdown linter configured, this step is a manual read: confirm the two new rows have the same three-column shape as their neighbours and that no `|` inside the text breaks the table)

Expected: no errors, or (manual path) a visually consistent 3-column table.

- [ ] **Step 4: Commit**

```bash
git add docs/ARCHITECTURE.md
git commit -m "docs(architecture): add Phase 3 roadmap and split the desktop perf target"
```

---

### Task 8: Closeout — manual demo, verification sweep, PR

**Files:**
- Create: `docs/superpowers/specs/2026-10-01-phase3-week7-demo.md` (the recorded demo's checklist and results)
- Modify: (none — this task only runs gates and records outcomes)

**Interfaces:**
- Consumes: every artifact from Tasks 1–7.
- Produces: the demo record and the PR.

- [ ] **Step 1: Run the full local verification sweep**

Run each, in order, and do not proceed on a red result:

```bash
pnpm lint && pnpm typecheck && pnpm test
cargo fmt --manifest-path apps/agent/Cargo.toml --check
cargo clippy --manifest-path apps/agent/Cargo.toml --all-targets --locked -- -D warnings
cargo test --manifest-path apps/agent/Cargo.toml --locked
pnpm --filter @ponter/webrtc-core test:e2e
```

Expected: all PASS. This is the local mirror of the `verify`, `rust`, and `e2e` CI jobs — a green run here means CI has no surprise waiting.

- [ ] **Step 2: Record the manual Chrome demo**

Follow the checklist in spec §8.4 (Fedora/Wayland; build deps installed; agent run with `--desktop-source screen`; server + web dev servers up; agent registered with `['terminal', 'desktop']`). Record a screen capture that shows, in order:

1. The Monitor icon on the agent row opening a desktop tab.
2. Chrome rendering the live **real** screen at ~720p, visibly ~15 fps.
3. Interacting with the host (e.g. moving a window) changing the stream — proving it is the real display, not the test pattern.
4. Closing and reopening the tab → the stream returns.
5. Opening a terminal tab while desktop is open → the clear ADR-19 refusal message.

Save the recording outside the repo (it is a large binary and is not committed). Write its location and the observed results into `docs/superpowers/specs/2026-10-01-phase3-week7-demo.md`:

```markdown
# Phase 3 Week 7 — Desktop Streaming Demo

**Date:** <YYYY-MM-DD>
**Machine:** Fedora <version>, Wayland session
**Agent:** `ponter-agent --desktop-source screen` (build <short sha>)
**Recording:** <path or link outside the repo>

## Observed

| Check | Result |
|---|---|
| Monitor icon opens a desktop tab | ✅ / ❌ |
| Live real-screen stream in Chrome, ~720p | ✅ / ❌ |
| Visibly ~15 fps | ✅ / ❌ |
| Host interaction changes the stream | ✅ / ❌ |
| Close → reopen → stream returns | ✅ / ❌ |
| Terminal tab refused while desktop open (ADR-19) | ✅ / ❌ |
| PipeWire portal accepted on first capture (if shown) | ✅ / ❌ / N/A |

## Notes

<any deviation, e.g. frame rate under load, portal prompt behaviour>
```

- [ ] **Step 3: Confirm every acceptance criterion**

Walk spec §10.2 and tick each against evidence:

| # | Criterion | Evidence |
|---|---|---|
| 1 | `cargo test --locked` passes on Linux; musl `cargo build --locked` succeeds | Step 1 + CI `rust` job + `build-agent` musl matrix leg |
| 2 | `pnpm lint && typecheck && test` pass workspace-wide | Step 1 + CI `verify` job |
| 3 | E2E passes: track, ≥30 packets @ negotiated PT, ≥1 IDR, teardown + second session | Step 1 + CI `e2e` job (Task 6, Test 1 & 2) |
| 4 | Terminal E2E still passes unchanged | Step 1 + CI `e2e` job (Task 6, Test 3 + pre-existing suite) |
| 5 | Recorded demo shows live 720p15 + refusal + reopen | Step 2 |
| 6 | ARCHITECTURE.md no longer claims 60fps/H.265 as achieved | Task 7 |

- [ ] **Step 4: Open the PR**

Per repo convention (`docs(spec)` → `docs(plan)` → `feat`/`test` → `docs(architecture)`), the branch already carries each commit from Tasks 1–7. Open one PR to `main`:

```bash
git push -u origin feat/phase3-week7-desktop-streaming
gh pr create --base main --title "feat(phase3): Week 7 — view-only desktop streaming (720p15 software H.264)" --body "$(cat <<'EOF'
## Summary

Phase 3 Week 7: a browser workspace tab opens a **view-only** desktop stream from an agent. The browser negotiates a receive-only H.264 video session; the Rust agent captures the screen (or a deterministic test pattern in CI), encodes ~720p @ 15 fps with software openh264, and streams it over the existing WebRTC DTLS/SRTP connection. The terminal flow is byte-identical.

Spec: `docs/superpowers/specs/2026-10-01-phase3-week7-desktop-streaming-design.md`
Plan: `docs/superpowers/plans/2026-10-01-phase3-week7-desktop-streaming.md`

## Scope

- `packages/webrtc-core`: optional media seam (`addTransceiver`/`onTrack`) + `media-channel.ts` (closes ADR-06)
- `packages/desktop-core`: DOM-free `DesktopClient`
- `apps/agent`: `desktop.rs` (capture → downscale → openh264), desktop answer path, `--desktop-source`
- `apps/web`: desktop tab, `DesktopView.vue`, per-agent exclusivity (ADR-19)
- E2E + CI capture deps; `ARCHITECTURE.md` reconciliation

## Not in scope (Weeks 8-9)

Input forwarding, hardware codecs, adaptive bitrate, screen/window picker.

## Test plan

- [ ] `pnpm lint && pnpm typecheck && pnpm test`
- [ ] `cargo clippy --all-targets --locked -- -D warnings` && `cargo test --locked`
- [ ] `pnpm --filter @ponter/webrtc-core test:e2e`
- [ ] Manual Chrome demo (link in PR comment)
EOF
)"
```

> **Coordination:** one PR in flight at a time (repo convention). This branch must be rebased onto `main` *after* the `fix/agent-session-dead-peer` and `chore/deps-upgrade` PRs merge (Global Constraints). If either is still open, wait.

- [ ] **Step 5: Record the PR number and hand off**

Note the PR URL. The demo recording (Step 2) is attached as a PR comment, not committed. No further commits are expected on the branch until review.

---



