import { env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import app from '../src/index';

describe('Worker Scaffolding & Health', () => {
  it('returns 200 OK and status ok on /health', async () => {
    const res = await app.request('/health', {}, env);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { status: string };
    expect(data.status).toBe('ok');
  });

  it('can read and write to KV CACHE binding', async () => {
    await env.CACHE.put('test:ping', 'pong');
    const val = await env.CACHE.get('test:ping');
    expect(val).toBe('pong');
  });
});
