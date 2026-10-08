import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const ENV_KEYS = [
  'TURN_PROVIDER',
  'TURN_SECRET',
  'TURN_URL',
  'STUN_URL',
  'TURN_KEY_ID',
  'TURN_KEY_API_TOKEN',
] as const;

function clearEnv(): void {
  for (const key of ENV_KEYS) delete process.env[key];
}

async function loadIce(): Promise<typeof import('../src/utils/ice.js')> {
  return await import('../src/utils/ice.js');
}

describe('buildIceServers — provider dispatch (coturn | none)', () => {
  beforeEach(() => {
    vi.resetModules();
    clearEnv();
  });

  afterEach(() => {
    clearEnv();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('unset TURN_PROVIDER resolves to coturn and reproduces the legacy shape', async () => {
    process.env.TURN_SECRET = 'test-turn-secret-123';
    process.env.TURN_URL = 'turn:turn.example.com:3478';
    process.env.STUN_URL = 'stun:stun.example.com:19302';

    const { buildIceServers } = await loadIce();
    const servers = await buildIceServers('user-1');

    expect(servers).toHaveLength(2);
    expect(servers[0]!.urls).toEqual(['stun:stun.example.com:19302']);
    expect(servers[1]!.urls).toEqual([
      'turn:turn.example.com:3478?transport=udp',
      'turn:turn.example.com:3478?transport=tcp',
    ]);

    const [expiryStr, userIdPart] = (servers[1]!.username ?? '').split(':');
    expect(Number(expiryStr)).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(userIdPart).toBe('user-1');
  });

  it('TURN_PROVIDER=coturn is identical to the default', async () => {
    process.env.TURN_PROVIDER = 'coturn';
    process.env.TURN_SECRET = 'test-turn-secret-123';
    process.env.TURN_URL = 'turn:turn.example.com:3478';
    process.env.STUN_URL = 'stun:stun.example.com:19302';

    const { buildIceServers } = await loadIce();
    const servers = await buildIceServers('user-1');

    expect(servers).toHaveLength(2);
    expect(servers[1]!.urls).toEqual([
      'turn:turn.example.com:3478?transport=udp',
      'turn:turn.example.com:3478?transport=tcp',
    ]);
  });

  it('TURN_PROVIDER=coturn with no secret falls back to public Google STUN', async () => {
    process.env.TURN_PROVIDER = 'coturn';

    const { buildIceServers } = await loadIce();
    const servers = await buildIceServers('user-1');

    expect(servers).toEqual([{ urls: ['stun:stun.l.google.com:19302'] }]);
  });

  it('TURN_PROVIDER=none returns STUN-only, honouring STUN_URL when set', async () => {
    process.env.TURN_PROVIDER = 'none';
    process.env.STUN_URL = 'stun:stun.example.com:19302';

    const { buildIceServers } = await loadIce();
    const servers = await buildIceServers('user-1');

    expect(servers).toEqual([{ urls: ['stun:stun.example.com:19302'] }]);
  });

  it('TURN_PROVIDER=none without STUN_URL returns public Google STUN', async () => {
    process.env.TURN_PROVIDER = 'none';

    const { buildIceServers } = await loadIce();
    const servers = await buildIceServers('user-1');

    expect(servers).toEqual([{ urls: ['stun:stun.l.google.com:19302'] }]);
  });

  it('an unrecognized TURN_PROVIDER falls back to coturn instead of throwing', async () => {
    process.env.TURN_PROVIDER = 'bogus';
    process.env.TURN_SECRET = 'test-turn-secret-123';
    process.env.TURN_URL = 'turn:turn.example.com:3478';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { buildIceServers } = await loadIce();
    const servers = await buildIceServers('user-1');

    expect(servers).toHaveLength(2);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('every emitted entry exposes urls as a string array (agent wire shape)', async () => {
    process.env.TURN_SECRET = 'test-turn-secret-123';
    process.env.TURN_URL = 'turn:turn.example.com:3478';
    process.env.STUN_URL = 'stun:stun.example.com:19302';

    const { buildIceServers } = await loadIce();
    const servers = await buildIceServers('user-1');

    for (const entry of servers) {
      expect(Array.isArray(entry.urls)).toBe(true);
    }
  });
});
