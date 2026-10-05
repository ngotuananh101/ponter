import { vi, expect } from 'vitest';
import type { DataChannelManager } from '@ponter/webrtc-core';

export interface FakeFrame {
  type: string;
  payload: Record<string, unknown>;
}

export function makeFakeManager() {
  const sent: Array<FakeFrame & { label: string }> = [];
  const rawSent: Array<{ label: string; bytes: Uint8Array }> = [];
  let handler:
    | ((msg: {
        type: string;
        channel: string;
        payload: unknown;
        timestamp: number;
      }) => void)
    | null = null;
  let rawHandler: ((data: string | ArrayBuffer) => void) | null = null;
  const off = vi.fn();
  const offRaw = vi.fn();
  return {
    sent,
    rawSent,
    off,
    offRaw,
    manager: {
      sendJson: (
        label: string,
        type: string,
        payload: Record<string, unknown>,
      ) => {
        sent.push({ label, type, payload });
      },
      sendRaw: (label: string, data: string | ArrayBuffer | Uint8Array) => {
        rawSent.push({
          label,
          bytes:
            data instanceof Uint8Array
              ? data
              : new Uint8Array(data as ArrayBuffer),
        });
      },
      onMessage: (
        label: string,
        h: (msg: {
          type: string;
          channel: string;
          payload: unknown;
          timestamp: number;
        }) => void,
      ) => {
        expect(label).toBe('files');
        handler = h;
        return off;
      },
      onRawMessage: (
        label: string,
        h: (data: string | ArrayBuffer) => void,
      ) => {
        expect(label).toBe('files');
        rawHandler = h;
        return offRaw;
      },
    } as unknown as DataChannelManager,
    emit: (type: string, payload: Record<string, unknown>) => {
      handler?.({ type, channel: 'files', payload, timestamp: Date.now() });
    },
    emitRaw: (bytes: Uint8Array | ArrayBuffer) => {
      const buf =
        bytes instanceof ArrayBuffer
          ? bytes
          : bytes.buffer.slice(
              bytes.byteOffset,
              bytes.byteOffset + bytes.byteLength,
            );
      rawHandler?.(buf as ArrayBuffer);
    },
  };
}
