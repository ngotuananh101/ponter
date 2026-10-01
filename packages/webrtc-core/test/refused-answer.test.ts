import { describe, it, expect } from 'vitest';
import { PeerConnection } from '../src/connection';
import { ScriptedPeer, stubTransport } from './helpers';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The bug this pins (2026-10-01): the agent answers a second concurrent offer
 * with `approved: false` — a real SDP the browser was expected to inspect. The
 * offerer never read the flag, applied the refusal SDP as if it were an
 * approval, and then sat on `waitForChannel` for the full 10s timeout, telling
 * the user "timeout waiting for channel (saw state: connecting)" — a message
 * that names neither the refusal nor its cause.
 *
 * A refused answer must fail fast and say why, and must NOT be applied: the
 * refusal SDP is a real answer for a peer connection the agent is about to
 * close, so applying it flips the browser to `stable` and makes any subsequent
 * retry look like a signaling-state error instead of a refusal.
 */
describe('a refused answer (approved: false)', () => {
  it('fails waitForChannel fast with a refusal message instead of a timeout', async () => {
    const peer = new ScriptedPeer();
    const { transport, deliver } = stubTransport();
    const pc = new PeerConnection(peer, transport, {
      role: 'offerer',
      channelLabels: ['terminal'],
    });

    const wait = pc.waitForChannel('terminal', 5000);

    deliver({
      type: 'answer',
      data: { sessionId: 'sess_1', sdp: 'v=0-answer', approved: false },
    });

    const started = Date.now();
    await expect(wait).rejects.toThrow(/refus|declin/i);
    // "Fast" is load-bearing: the whole complaint was a 10s timeout with no
    // explanation. 1s is generous for a rejection that needs no network.
    expect(Date.now() - started).toBeLessThan(1000);

    await pc.close();
  });

  it('never applies the refusal SDP as a remote description', async () => {
    const peer = new ScriptedPeer();
    const { transport, deliver } = stubTransport();
    const pc = new PeerConnection(peer, transport, {
      role: 'offerer',
      channelLabels: ['terminal'],
    });

    deliver({
      type: 'answer',
      data: { sessionId: 'sess_1', sdp: 'v=0-answer', approved: false },
    });
    await sleep(20);

    expect(peer.setRemoteCalls.filter((d) => d.type === 'answer')).toHaveLength(
      0,
    );

    await pc.close();
  });

  it('still applies and opens normally when the answer is approved', async () => {
    // The positive control: the guard must key on the flag, not on the shape
    // of an answer message.
    const peer = new ScriptedPeer();
    const { transport, deliver } = stubTransport();
    const pc = new PeerConnection(peer, transport, {
      role: 'offerer',
      channelLabels: ['terminal'],
    });

    deliver({
      type: 'answer',
      data: { sessionId: 'sess_1', sdp: 'v=0-answer', approved: true },
    });
    await sleep(20);

    expect(peer.setRemoteCalls.filter((d) => d.type === 'answer')).toHaveLength(
      1,
    );

    await pc.close();
  });
});
