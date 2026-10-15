import { describe, it, expect } from 'vitest';
import { ApiClient } from '../src/client';
import { createApiClient } from '../src/factory';
import { MemoryStorage } from './helpers';

describe('createApiClient', () => {
  it('returns a fully wired ApiClient with the same behavior as `new ApiClient`', () => {
    const storage = new MemoryStorage();
    const client = createApiClient({
      baseUrl: 'http://localhost:8787/',
      storage,
    });

    expect(client).toBeInstanceOf(ApiClient);
    // Same normalization as the constructor: trailing slashes trimmed.
    expect(client.http.baseUrl).toBe('http://localhost:8787');
    expect(client.http.storage).toBe(storage);
    // Every resource is constructed.
    expect(client.auth).toBeDefined();
    expect(client.admin).toBeDefined();
    expect(client.users).toBeDefined();
    expect(client.devices).toBeDefined();
    expect(client.agents).toBeDefined();
    expect(client.sessions).toBeDefined();
    expect(client.webrtc).toBeDefined();
  });

  it('forwards onAuthError and a custom fetch unchanged', () => {
    const storage = new MemoryStorage();
    const onAuthError = () => {};
    const fetchImpl = (async () => new Response('{}')) as typeof fetch;
    const client = createApiClient({
      baseUrl: 'http://h',
      storage,
      onAuthError,
      fetch: fetchImpl,
    });
    expect(client.http.onAuthError).toBe(onAuthError);
  });
});
