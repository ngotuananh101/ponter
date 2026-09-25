import { describe, it, expect } from 'vitest';
import {
  toSessionDescriptionInit,
  toIceCandidateInit,
  createOfferSignal,
  createAnswerSignal,
  createCandidateSignal,
} from '../src/signal-handler';

describe('Signal Handler conversions', () => {
  it('converts SDP string to RTCSessionDescriptionInit', () => {
    const sdp = 'v=0\r\no=- 123 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n';
    const desc = toSessionDescriptionInit({ sdp }, 'offer');
    expect(desc).toEqual({ type: 'offer', sdp });
  });

  it('converts ICE candidate signal to RTCIceCandidateInit', () => {
    const cand = toIceCandidateInit({
      candidate: 'candidate:1 1 UDP 2130706431 192.168.1.1 50000 typ host',
      sdpMid: '0',
      sdpMLineIndex: 0,
    });
    expect(cand).toEqual({
      candidate: 'candidate:1 1 UDP 2130706431 192.168.1.1 50000 typ host',
      sdpMid: '0',
      sdpMLineIndex: 0,
    });
  });

  it('builds offer SignalMessage payload', () => {
    const msg = createOfferSignal(
      'sess_1',
      { type: 'offer', sdp: 'sdp_offer' },
      ['terminal'],
    );
    expect(msg).toEqual({
      type: 'offer',
      data: {
        sessionId: 'sess_1',
        sdp: 'sdp_offer',
        capabilities: ['terminal'],
      },
    });
  });

  it('builds answer SignalMessage payload', () => {
    const msg = createAnswerSignal(
      'sess_1',
      { type: 'answer', sdp: 'sdp_answer' },
      true,
    );
    expect(msg).toEqual({
      type: 'answer',
      data: {
        sessionId: 'sess_1',
        sdp: 'sdp_answer',
        approved: true,
      },
    });
  });

  it('builds candidate SignalMessage payload with null defaults for mid/index', () => {
    const msg = createCandidateSignal('sess_1', {
      candidate: 'candidate_line',
    });
    expect(msg).toEqual({
      type: 'ice-candidate',
      data: {
        sessionId: 'sess_1',
        candidate: 'candidate_line',
        sdpMid: null,
        sdpMLineIndex: null,
      },
    });
  });

  it('throws on empty sdp or candidate', () => {
    expect(() => toSessionDescriptionInit({ sdp: '' }, 'offer')).toThrow(
      'Empty SDP',
    );
    expect(() => toIceCandidateInit({ candidate: '' })).toThrow(
      'Empty ICE candidate',
    );
  });
});
