import { describe, it, expect } from 'vitest';
import type {
  BrowserSocketMessage,
  BrowserMessageInit,
  BrowserErrorCode,
} from '../src';
import { parseBrowserMessage } from '../src';

describe('BrowserSocketMessage types', () => {
  it('instantiates a signal frame with id', () => {
    const msg: BrowserSocketMessage = {
      type: 'signal',
      data: {
        type: 'offer',
        data: { sessionId: 'sess_1', sdp: 'v=0', capabilities: ['terminal'] },
      },
      id: 'sig_1',
    };
    expect(msg.id).toBe('sig_1');
    expect(msg.data.type).toBe('offer');
  });

  it('instantiates subscribed ack with hasMore', () => {
    const msg: BrowserSocketMessage = {
      type: 'subscribed',
      data: { sessionId: 'sess_1', after: 'sig_9', hasMore: true },
    };
    expect(msg.data.hasMore).toBe(true);
  });

  it('error frame carries a BrowserErrorCode', () => {
    const code: BrowserErrorCode = 'SESSION_TERMINATED';
    const msg: BrowserSocketMessage = { type: 'error', code };
    expect(msg.code).toBe('SESSION_TERMINATED');
  });
});

describe('parseBrowserMessage', () => {
  it('parses subscribe with after', () => {
    const parsed = parseBrowserMessage(
      JSON.stringify({
        type: 'subscribe',
        data: { sessionId: 'sess_1', after: 'sig_5' },
      }),
    );
    expect(parsed).toEqual({
      type: 'subscribe',
      data: { sessionId: 'sess_1', after: 'sig_5' },
    });
  });

  it('parses subscribe without after', () => {
    const parsed = parseBrowserMessage(
      JSON.stringify({ type: 'subscribe', data: { sessionId: 'sess_1' } }),
    );
    expect(parsed).toEqual({
      type: 'subscribe',
      data: { sessionId: 'sess_1' },
    });
  });

  it('parses ping', () => {
    expect(parseBrowserMessage(JSON.stringify({ type: 'ping' }))).toEqual({
      type: 'ping',
    });
  });

  it('parses a signal frame into a normalized SignalMessage', () => {
    const parsed = parseBrowserMessage(
      JSON.stringify({
        type: 'signal',
        data: {
          type: 'ice-candidate',
          data: {
            sessionId: 'sess_1',
            candidate: 'candidate:1',
            sdpMid: 'audio',
            sdpMLineIndex: 3,
          },
        },
      }),
    );
    expect(parsed).toEqual({
      type: 'signal',
      data: {
        type: 'ice-candidate',
        data: {
          sessionId: 'sess_1',
          candidate: 'candidate:1',
          sdpMid: 'audio',
          sdpMLineIndex: 3,
        },
      },
    });
  });

  it('defaults ice-candidate sdpMid/sdpMLineIndex to null when absent', () => {
    const parsed = parseBrowserMessage(
      JSON.stringify({
        type: 'signal',
        data: {
          type: 'ice-candidate',
          data: { sessionId: 'sess_1', candidate: 'candidate:1' },
        },
      }),
    );
    expect(parsed).toEqual({
      type: 'signal',
      data: {
        type: 'ice-candidate',
        data: {
          sessionId: 'sess_1',
          candidate: 'candidate:1',
          sdpMid: null,
          sdpMLineIndex: null,
        },
      },
    });
  });

  it('defaults answer approved to true when absent', () => {
    const parsed = parseBrowserMessage(
      JSON.stringify({
        type: 'signal',
        data: {
          type: 'answer',
          data: { sessionId: 'sess_1', sdp: 'v=0' },
        },
      }),
    );
    expect(parsed).toEqual({
      type: 'signal',
      data: {
        type: 'answer',
        data: { sessionId: 'sess_1', sdp: 'v=0', approved: true },
      },
    });
  });

  it('returns null on malformed JSON', () => {
    expect(parseBrowserMessage('{not json')).toBeNull();
  });

  it('returns null on unknown frame type', () => {
    expect(
      parseBrowserMessage(JSON.stringify({ type: 'nope', data: {} })),
    ).toBeNull();
  });

  it('returns null on subscribe without sessionId', () => {
    expect(
      parseBrowserMessage(JSON.stringify({ type: 'subscribe', data: {} })),
    ).toBeNull();
  });

  it('returns null on signal with empty sdp', () => {
    expect(
      parseBrowserMessage(
        JSON.stringify({
          type: 'signal',
          data: { type: 'offer', data: { sessionId: 's', sdp: '' } },
        }),
      ),
    ).toBeNull();
  });

  it('returns null on a non-object frame', () => {
    expect(parseBrowserMessage('42')).toBeNull();
    expect(parseBrowserMessage('null')).toBeNull();
    expect(parseBrowserMessage('[]')).toBeNull();
  });

  it('accepts a signal frame typed as BrowserMessageInit', () => {
    const init: BrowserMessageInit = {
      type: 'signal',
      data: {
        type: 'offer',
        data: { sessionId: 's', sdp: 'v=0', capabilities: [] },
      },
    };
    expect(init.type).toBe('signal');
  });
});
