import { describe, it, expect, vi } from 'vitest';
import { TerminalClient } from '../src/client';
import type { DataChannelManager } from '@remote/webrtc-core';
import type { DataChannelMessage } from '@remote/shared';

describe('TerminalClient', () => {
  it('creates a session and dispatches terminal-create message', () => {
    const mockSendJson = vi.fn();
    const mockOnMessage = vi.fn().mockReturnValue(() => {});
    const mockDataChannel = {
      sendJson: mockSendJson,
      onMessage: mockOnMessage,
    } as unknown as DataChannelManager;

    const client = new TerminalClient('agent-1', mockDataChannel);
    const session = client.createSession({ cols: 100, rows: 30 });

    expect(session).toBeDefined();
    expect(mockSendJson).toHaveBeenCalledWith(
      'terminal',
      'terminal-create',
      expect.objectContaining({
        terminalId: session.id,
        cols: 100,
        rows: 30,
      })
    );
  });

  it('receives terminal-data and delivers decoded bytes to session', () => {
    let messageHandler: ((msg: DataChannelMessage) => void) | undefined;
    const mockDataChannel = {
      sendJson: vi.fn(),
      onMessage: vi.fn((_channel, cb) => {
        messageHandler = cb;
        return () => {};
      }),
    } as unknown as DataChannelManager;

    const client = new TerminalClient('agent-1', mockDataChannel);
    const session = client.createSession();

    let receivedBytes = '';
    session.onData((chunk) => {
      receivedBytes += new TextDecoder().decode(chunk);
    });

    const rawData = 'hello from pty\r\n';
    const base64Data = Buffer.from(rawData).toString('base64');

    messageHandler?.({
      type: 'terminal-data',
      channel: 'terminal',
      payload: { terminalId: session.id, data: base64Data },
      timestamp: Date.now(),
    });

    expect(receivedBytes).toBe(rawData);
  });

  it('receives terminal-exit and marks session as exited', () => {
    let messageHandler: ((msg: DataChannelMessage) => void) | undefined;
    const mockDataChannel = {
      sendJson: vi.fn(),
      onMessage: vi.fn((_channel, cb) => {
        messageHandler = cb;
        return () => {};
      }),
    } as unknown as DataChannelManager;

    const client = new TerminalClient('agent-1', mockDataChannel);
    const session = client.createSession();

    const exitHandler = vi.fn();
    session.onExit(exitHandler);

    messageHandler?.({
      type: 'terminal-exit',
      channel: 'terminal',
      payload: { terminalId: session.id, exitCode: 42 },
      timestamp: Date.now(),
    });

    expect(session.state).toBe('exited');
    expect(session.exitCode).toBe(42);
    expect(exitHandler).toHaveBeenCalledWith(42);
  });

  it('getSession returns the session by terminalId', () => {
    const mockDataChannel = {
      sendJson: vi.fn(),
      onMessage: vi.fn().mockReturnValue(() => {}),
    } as unknown as DataChannelManager;

    const client = new TerminalClient('agent-1', mockDataChannel);
    const session = client.createSession();

    expect(client.getSession(session.id)).toBe(session);
    expect(client.getSession('non-existent')).toBeUndefined();
  });

  it('closeSession sends terminal-close and removes session', () => {
    const mockSendJson = vi.fn();
    const mockDataChannel = {
      sendJson: mockSendJson,
      onMessage: vi.fn().mockReturnValue(() => {}),
    } as unknown as DataChannelManager;

    const client = new TerminalClient('agent-1', mockDataChannel);
    const session = client.createSession();

    client.closeSession(session.id);

    expect(mockSendJson).toHaveBeenCalledWith('terminal', 'terminal-close', {
      terminalId: session.id,
    });
    expect(client.getSession(session.id)).toBeUndefined();
  });

  it('sendInput encodes input to base64 and sends terminal-data', () => {
    const mockSendJson = vi.fn();
    const mockDataChannel = {
      sendJson: mockSendJson,
      onMessage: vi.fn().mockReturnValue(() => {}),
    } as unknown as DataChannelManager;

    const client = new TerminalClient('agent-1', mockDataChannel);
    const session = client.createSession();

    const input = 'hello world';
    const expectedBase64 = Buffer.from(input).toString('base64');

    session.write(input);

    expect(mockSendJson).toHaveBeenCalledWith('terminal', 'terminal-data', {
      terminalId: session.id,
      data: expectedBase64,
    });
  });

  it('debounces resize frames (~100ms)', () => {
    vi.useFakeTimers();

    const mockSendJson = vi.fn();
    const mockDataChannel = {
      sendJson: mockSendJson,
      onMessage: vi.fn().mockReturnValue(() => {}),
    } as unknown as DataChannelManager;

    const client = new TerminalClient('agent-1', mockDataChannel);
    const session = client.createSession({ cols: 80, rows: 24 });

    // Rapid resizes should only send the last one after debounce
    session.resize(100, 30);
    session.resize(120, 40);
    session.resize(140, 50);

    expect(mockSendJson).not.toHaveBeenCalledWith(
      'terminal',
      'terminal-resize',
      expect.anything()
    );

    vi.advanceTimersByTime(99);
    expect(mockSendJson).not.toHaveBeenCalledWith(
      'terminal',
      'terminal-resize',
      expect.anything()
    );

    vi.advanceTimersByTime(1);
    expect(mockSendJson).toHaveBeenCalledWith('terminal', 'terminal-resize', {
      terminalId: session.id,
      cols: 140,
      rows: 50,
    });

    vi.useRealTimers();
  });

  it('dispose unsubscribes message handler and cleans up timers', () => {
    const mockSendJson = vi.fn();
    const unsubscribe = vi.fn();
    const mockDataChannel = {
      sendJson: mockSendJson,
      onMessage: vi.fn().mockReturnValue(unsubscribe),
    } as unknown as DataChannelManager;

    const client = new TerminalClient('agent-1', mockDataChannel);
    const session1 = client.createSession();
    const session2 = client.createSession();

    expect(client.getSession(session1.id)).toBeDefined();
    expect(client.getSession(session2.id)).toBeDefined();

    client.dispose();

    expect(unsubscribe).toHaveBeenCalled();
    expect(client.getSession(session1.id)).toBeUndefined();
    expect(client.getSession(session2.id)).toBeUndefined();
    // Should send terminal-close for each session
    const closeCalls = mockSendJson.mock.calls.filter(
      ([, type]) => type === 'terminal-close'
    );
    expect(closeCalls).toHaveLength(2);
  });

  it('dispose clears pending resize debounce timers', () => {
    vi.useFakeTimers();

    const mockSendJson = vi.fn();
    const unsubscribe = vi.fn();
    const mockDataChannel = {
      sendJson: mockSendJson,
      onMessage: vi.fn().mockReturnValue(unsubscribe),
    } as unknown as DataChannelManager;

    const client = new TerminalClient('agent-1', mockDataChannel);
    const session = client.createSession();

    session.resize(100, 30);

    client.dispose();

    // Advance past the debounce window - should not send resize
    vi.advanceTimersByTime(200);
    const resizeCalls = mockSendJson.mock.calls.filter(
      ([, type]) => type === 'terminal-resize'
    );
    expect(resizeCalls).toHaveLength(0);

    vi.useRealTimers();
  });

  it('ignoring messages for unknown terminalId is safe', () => {
    let messageHandler: ((msg: DataChannelMessage) => void) | undefined;
    const mockDataChannel = {
      sendJson: vi.fn(),
      onMessage: vi.fn((_channel, cb) => {
        messageHandler = cb;
        return () => {};
      }),
    } as unknown as DataChannelManager;

    const client = new TerminalClient('agent-1', mockDataChannel);
    client.createSession();

    // Should not throw
    messageHandler?.({
      type: 'terminal-data',
      channel: 'terminal',
      payload: { terminalId: 'unknown-id', data: 'dGVzdA==' },
      timestamp: Date.now(),
    });

    messageHandler?.({
      type: 'terminal-exit',
      channel: 'terminal',
      payload: { terminalId: 'unknown-id', exitCode: 0 },
      timestamp: Date.now(),
    });
  });

  it('createSession uses default cols and rows when not specified', () => {
    const mockSendJson = vi.fn();
    const mockDataChannel = {
      sendJson: mockSendJson,
      onMessage: vi.fn().mockReturnValue(() => {}),
    } as unknown as DataChannelManager;

    const client = new TerminalClient('agent-1', mockDataChannel);
    const session = client.createSession();

    expect(session.cols).toBe(80);
    expect(session.rows).toBe(24);
    expect(mockSendJson).toHaveBeenCalledWith(
      'terminal',
      'terminal-create',
      expect.objectContaining({
        cols: 80,
        rows: 24,
      })
    );
  });
});
