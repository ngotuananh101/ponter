import { describe, it, expect, vi } from 'vitest';
import { MemoryStorage, jsonResponse, makeClient } from './helpers';

describe('WebrtcResource', () => {
  it('1. GETs /api/webrtc/ice-servers and returns the iceServers array', async () => {
    const storage = new MemoryStorage();
    storage.setTokens({
      accessToken: 'access-123',
      refreshToken: 'refresh-456',
    });

    const iceServers = [
      { urls: ['stun:stun.example.com:19302'] },
      {
        urls: ['turn:turn.example.com:3478?transport=udp'],
        username: '123:user-1',
        credential: 'cred-abc',
      },
    ];

    const mockFetch = vi.fn().mockResolvedValue(jsonResponse({ iceServers }));
    const client = makeClient(storage, mockFetch);

    const result = await client.webrtc.getIceServers();

    expect(result).toEqual(iceServers);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('http://localhost:8787/api/webrtc/ice-servers');
    expect(init.method).toBe('GET');
  });

  it('2. Attaches the Authorization header to the ICE request', async () => {
    const storage = new MemoryStorage();
    storage.setTokens({
      accessToken: 'access-123',
      refreshToken: 'refresh-456',
    });

    const mockFetch = vi
      .fn()
      .mockResolvedValue(jsonResponse({ iceServers: [] }));
    const client = makeClient(storage, mockFetch);

    await client.webrtc.getIceServers();

    const callInit = mockFetch.mock.calls[0]![1] as RequestInit;
    expect(callInit.headers).toMatchObject({
      Authorization: 'Bearer access-123',
    });
  });

  it('3. Propagates ApiError when the ICE request is rejected', async () => {
    const storage = new MemoryStorage();
    storage.setTokens({
      accessToken: 'access-123',
      refreshToken: 'refresh-456',
    });

    const mockFetch = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(
          { error: 'Unauthorized', code: 'UNAUTHORIZED', details: null },
          401,
        ),
      );
    const client = makeClient(storage, mockFetch);

    await expect(client.webrtc.getIceServers()).rejects.toMatchObject({
      status: 401,
      code: 'UNAUTHORIZED',
    });
  });

  it('4. Returns an empty array when the response omits iceServers', async () => {
    const storage = new MemoryStorage();
    storage.setTokens({
      accessToken: 'access-123',
      refreshToken: 'refresh-456',
    });

    const mockFetch = vi.fn().mockResolvedValue(jsonResponse({}));
    const client = makeClient(storage, mockFetch);

    const result = await client.webrtc.getIceServers();
    expect(result).toEqual([]);
  });
});
