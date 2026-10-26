// packages/desktop-core/test/control-composition.test.ts
import { describe, expect, it, vi } from 'vitest';
import type { RTCDataChannelLike } from '@ponter/webrtc-core';
import { DataChannelManager } from '@ponter/webrtc-core';
import type { PeerConnection } from '@ponter/webrtc-core';
import { DataChannelRouter } from '../../../apps/agent/src/session/data-channels';
import { DesktopClient } from '../src/client';

/**
 * **The composition axis, on the desktop control path.**
 *
 * Task 17's two decoders (`decodeStreamControl`, `decodeDesktopSelect`) read a
 * vocabulary **no producer on this wire ever sends** — `stream-control` with an
 * `action` field, and `desktop-select` carrying `source: { kind, id }`. Every
 * fence stayed green because `control.test.ts` fed them that same dead
 * vocabulary: it certified an implementation against a contract nobody used,
 * while the router's hand-rolled arms sent the real frames down a different
 * path entirely. Two implementations of one contract, tested against each
 * other's fixtures, and neither against the wire.
 *
 * So these cells never hand-build a payload. They drive the browser's **real
 * sender** (`DesktopClient.selectSource` / `setBitrate`, `client.ts:424,429`)
 * through `webrtc-core`'s **real** `DataChannelManager`, take the exact bytes
 * that reach the channel, and feed them to the agent's **real**
 * `DataChannelRouter` — the same object `AgentRuntime` wires up. If either side
 * renames a type or a field, this file goes red. That is the whole point.
 */

function fakeBrowserChannel(label: string): RTCDataChannelLike & {
  sent: string[];
} {
  const sent: string[] = [];
  return {
    label,
    readyState: 'open',
    send: (data: string | ArrayBuffer | Uint8Array) => {
      sent.push(typeof data === 'string' ? data : String(data));
    },
    close: vi.fn(),
    onMessage: () => {},
    onStateChange: () => {},
    sent,
  };
}

/**
 * The smallest `PeerConnection` `DesktopClient` needs to reach `sendControl`.
 *
 * `sendControl` guards on `getChannel('control')?.readyState` and nothing else
 * (`client.ts:473-477`), so `start()` and the offer/answer dance are not
 * required here — `DataChannelManager` is.
 */
function peerWithChannel(channel: RTCDataChannelLike): {
  peer: PeerConnection;
  manager: DataChannelManager;
} {
  const manager = new DataChannelManager();
  manager.registerChannel(channel);
  const peer = {
    start: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    onRemoteTrack: vi.fn(() => vi.fn()),
    onConnectionStateChange: vi.fn(() => vi.fn()),
    dataChannels: manager,
    waitForChannel: vi.fn(async () => channel),
    options: { sessionId: 'test-session' },
  } as unknown as PeerConnection;
  return { peer, manager };
}

/** The agent's real router over a `control` channel we can push bytes into. */
function agentRouter() {
  const onSelect = vi.fn();
  const onControl = vi.fn();
  const warn = vi.fn();
  const router = new DataChannelRouter({
    terminal: {
      write: vi.fn(),
      resize: vi.fn(),
      close: vi.fn(),
      create: vi.fn(),
    },
    files: { handle: () => [], acceptBinaryChunk: () => [] },
    desktop: { onSelect, onControl },
    input: { admit: () => false, decode: () => null, apply: () => null },
    send: vi.fn(),
    logger: { warn },
    now: () => 1_700_000_000_000,
  });
  let deliver: (text: string) => void = () => {};
  router.attach({
    label: 'control',
    on: (_event, cb) => {
      deliver = (text) => cb(text);
      return () => {};
    },
    send: vi.fn(),
    close: vi.fn(),
  });
  return {
    router,
    onSelect,
    onControl,
    warn,
    deliver: (t: string) => deliver(t),
  };
}

function browser() {
  const channel = fakeBrowserChannel('control');
  const { peer } = peerWithChannel(channel);
  return { client: new DesktopClient('agent-1', peer), channel };
}

describe('browser control sender → agent control router', () => {
  it('selectSource reaches onSelect as the scheme string it sent', () => {
    // `client.ts:424` — `sendControl('desktop-select', { sourceId })`. The
    // agent must hand the consumer the raw id, not a parsed `{kind, id}`:
    // the Rust carries `source_id` verbatim into `SourceSwap`
    // (`desktop.rs:2011-2013`, pinned at `:2951-2962`) and splits it later in
    // `source_for` (`:922-948`).
    const { client, channel } = browser();
    const agent = agentRouter();
    client.selectSource('window:0x4a00007');

    expect(channel.sent).toHaveLength(1);
    agent.deliver(channel.sent[0]!);
    expect(agent.onSelect).toHaveBeenCalledWith('window:0x4a00007');
    expect(agent.onControl).not.toHaveBeenCalled();
  });

  it('setBitrate reaches onControl clamped at the wire boundary', () => {
    // `client.ts:429` — `sendControl('desktop-bitrate', { bitrateBps })`.
    // 99 Mbps is above the encoder's ceiling, so the agent's `decode_control`
    // equivalent must clamp it (`desktop.rs:2015-2019`) rather than forward it
    // and let the encoder refuse the retarget.
    const { client, channel } = browser();
    const agent = agentRouter();
    client.setBitrate(99_000_000);

    expect(channel.sent).toHaveLength(1);
    agent.deliver(channel.sent[0]!);
    expect(agent.onControl).toHaveBeenCalledWith({
      kind: 'bitrate',
      bitrate: 20_000_000,
    });
    expect(agent.onSelect).not.toHaveBeenCalled();
  });

  it('a bitrate inside the range passes through unchanged', () => {
    // The positive control for the clamp above: without it, a decoder that
    // returned the bound for every input would satisfy the previous cell.
    const { client, channel } = browser();
    const agent = agentRouter();
    client.setBitrate(3_000_000);
    agent.deliver(channel.sent[0]!);
    expect(agent.onControl).toHaveBeenCalledWith({
      kind: 'bitrate',
      bitrate: 3_000_000,
    });
  });

  it('drops the dead stream-control vocabulary the old fence certified', () => {
    // The frame the pre-fix decoder answered with `{kind:'pause'}`. It is not
    // in `client.ts` because the browser never sends it, and the Rust has no
    // arm for it (`desktop.rs:2021-2023`). Nothing is dispatched, and the
    // router does not treat an unknown type as malformed: it is dropped
    // silently, never answered.
    const agent = agentRouter();
    agent.deliver(
      JSON.stringify({
        type: 'stream-control',
        channel: 'control',
        payload: { action: 'pause' },
        timestamp: 0,
      }),
    );
    expect(agent.onSelect).not.toHaveBeenCalled();
    expect(agent.onControl).not.toHaveBeenCalled();
    expect(agent.warn).not.toHaveBeenCalled();
  });

  it('refuses a fractional bitrate instead of rounding it onto the wire', () => {
    // The Rust deserialises `bitrate_bps: u32` (`desktop.rs:1970`), so
    // `3_000_000.5` is a malformed payload and `decode_control` returns `Err`
    // — it is never clamped, because it never becomes a `u32`. BASE's
    // hand-rolled arm tested only `typeof === 'number'` and passed the
    // fractional value through `clampBitrate`, which rounded it into a target
    // the Rust would have refused. This cell is RED at BASE.
    const { client, channel } = browser();
    const agent = agentRouter();
    client.setBitrate(3_000_000.5);
    agent.deliver(channel.sent[0]!);
    expect(agent.onControl).not.toHaveBeenCalled();
    // Exactly one warning, and it names the type that failed. Asserting the
    // full sentence would pin a spelling; asserting only "warned" would not
    // distinguish this from the cell below. The type name is the load-bearing
    // part an operator needs, so that is what is measured.
    expect(agent.warn).toHaveBeenCalledTimes(1);
    expect(agent.warn.mock.calls[0]?.[0]).toContain('desktop-bitrate');
  });

  it('warns on a malformed known type instead of dropping it silently', () => {
    // The distinction the decoder cannot make on its own: `null` from an
    // unknown type means "not mine", `null` from a `desktop-select` with no
    // `sourceId` means "someone tried and it failed". Only the boundary knows
    // which, so the warning lives there.
    const agent = agentRouter();
    agent.deliver(
      JSON.stringify({
        type: 'desktop-select',
        channel: 'control',
        payload: {},
        timestamp: 0,
      }),
    );
    expect(agent.onSelect).not.toHaveBeenCalled();
    expect(agent.warn).toHaveBeenCalledTimes(1);
    expect(agent.warn.mock.calls[0]?.[0]).toContain('desktop-select');
  });
});
