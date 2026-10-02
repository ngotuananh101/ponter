import { describe, it, expect, vi } from 'vitest';
import { MemoryStorage, jsonResponse, makeClient } from './helpers';

/**
 * The `agents` resource's mutating verbs (delete, update).
 *
 * These pin the wire contract the backend routes implement: the HTTP method,
 * the URL, and the exact body the resource forwards. A regression that swapped
 * PATCH for PUT, or dropped the id from the path, would pass a typecheck but
 * fail here.
 */
describe('AgentsResource', () => {
  describe('delete', () => {
    it('sends DELETE /api/agents/:id and returns { success: true }', async () => {
      const storage = new MemoryStorage();
      storage.setTokens({ accessToken: 'access-1', refreshToken: 'refresh-1' });

      const mockFetch = vi
        .fn()
        .mockResolvedValue(jsonResponse({ success: true }));
      const client = makeClient(storage, mockFetch);

      const res = await client.agents.delete('agent-1');

      expect(res).toEqual({ success: true });
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:8787/api/agents/agent-1');
      expect(init.method).toBe('DELETE');
    });
  });

  describe('update', () => {
    it('sends PATCH /api/agents/:id with only the provided fields', async () => {
      const storage = new MemoryStorage();
      storage.setTokens({ accessToken: 'access-1', refreshToken: 'refresh-1' });

      const updated = {
        id: 'agent-1',
        userId: 'u1',
        hostname: 'renamed-host',
        platform: 'linux',
        osVersion: '24.04',
        agentVersion: '0.2.0',
        publicKey: 'pk1',
        isOnline: false,
        lastHeartbeat: null,
        capabilities: ['terminal'],
        createdAt: '2026-01-01 00:00:00',
      };
      const mockFetch = vi.fn().mockResolvedValue(jsonResponse(updated));
      const client = makeClient(storage, mockFetch);

      const res = await client.agents.update('agent-1', {
        hostname: 'renamed-host',
        capabilities: ['terminal'],
      });

      expect(res).toEqual(updated);
      const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:8787/api/agents/agent-1');
      expect(init.method).toBe('PATCH');
      expect(JSON.parse(init.body as string)).toEqual({
        hostname: 'renamed-host',
        capabilities: ['terminal'],
      });
    });
  });
});
