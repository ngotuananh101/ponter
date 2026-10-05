import { describe, it, expect, vi } from 'vitest';
import { PeerConnection, CHANNEL_CLOSE_TIMEOUT_MS } from '../src/connection';
import { ScriptedPeer, stubTransport } from './helpers';
import type { RTCDataChannelLike } from '../src/types';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A channel whose close is a two-step handshake like a real SCTP stream reset
 * (RFC 6525): `close()` moves it to `closing`, and only `ack()` — the remote's
 * reconfiguration response — moves it to `closed`.
 */
class HandshakeChannel implements RTCDataChannelLike {
  readyState: RTCDataChannelLike['readyState'] = 'open';

  constructor(readonly label: string) {}

  send(): void {}

  close(): void {
    if (this.readyState !== 'closed') this.readyState = 'closing';
  }

  onMessage(): void {}

  onStateChange(): void {}

  /** The remote acknowledges the reset: the reconfiguration response lands. */
  ack(): void {
    this.readyState = 'closed';
  }
}

/**
 * The race this pins (2026-10-01): `close()` started the SCTP closing
 * handshake and immediately tore the transport down. When `peer.close()`
 * stopped ICE before the fire-and-forget stream reset left the machine,
 * `ice.send()` dropped the packet silently — the remote never learned the
 * peer had left and only noticed ~30s later on ICE failure. The Rust agent
 * relies on the data channel close to end its session, so the race made
 * "close every tab, reopen" flaky: on losing runs the agent held the
 * single-session slot for the whole 20s channel timeout.
 *
 * The fix: the channel only reaches `closed` when the remote acknowledges the
 * reset, and that acknowledgement is the very signal the remote uses to end
 * its session — so `close()` waits for it (bounded) before stopping ICE.
 */
describe('close() waits for the data channel closing handshake', () => {
  it('does not tear down the peer until the remote acknowledges the reset', async () => {
    const channel = new HandshakeChannel('terminal');
    const peer = new ScriptedPeer({ channelFactory: () => channel });
    const { transport } = stubTransport();
    const pc = new PeerConnection(peer, transport, {
      sessionId: 'sess_1',
      role: 'offerer',
      channelLabels: ['terminal'],
    });

    const closing = pc.close();

    // The reset is in flight: closing, not yet acknowledged. The transport
    // must stay up so the acknowledgement can still arrive.
    await sleep(60);
    expect(channel.readyState).toBe('closing');
    expect(peer.closeCalls).toBe(0);

    channel.ack();
    await closing;

    expect(peer.closeCalls).toBe(1);
  });

  it('tears down anyway after a bounded wait when the remote never acks', async () => {
    vi.useFakeTimers();
    try {
      const channel = new HandshakeChannel('terminal');
      const peer = new ScriptedPeer({ channelFactory: () => channel });
      const { transport } = stubTransport();
      const pc = new PeerConnection(peer, transport, {
        sessionId: 'sess_1',
        role: 'offerer',
        channelLabels: ['terminal'],
      });

      const closing = pc.close();
      await vi.advanceTimersByTimeAsync(CHANNEL_CLOSE_TIMEOUT_MS + 200);
      await closing;

      expect(peer.closeCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
