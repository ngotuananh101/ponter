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

const CLOUDFLARE_URL =
  'https://rtc.live.cloudflare.com/v1/turn/keys/key-123/credentials/generate-ice-servers';

function mockFetchOnce(payload: unknown, ok = true, status = 200) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok,
    status,
    json: async () => payload,
  } as unknown as Response);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('buildIceServers — cloudflare provider', () => {
  beforeEach(() => {
    vi.resetModules();
    clearEnv();
    process.env.TURN_PROVIDER = 'cloudflare';
    process.env.TURN_KEY_ID = 'key-123';
    process.env.TURN_KEY_API_TOKEN = 'token-abc';
  });

  afterEach(() => {
    clearEnv();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('mints credentials from the Cloudflare API and normalizes urls to arrays', async () => {
    const fetchMock = mockFetchOnce({
      iceServers: [
        { urls: 'stun:stun.cloudflare.com:3478' },
        {
          urls: [
            'turn:turn.cloudflare.com:3478?transport=udp',
            'turns:turn.cloudflare.com:5349?transport=tcp',
          ],
          username: 'cf-user',
          credential: 'cf-cred',
        },
      ],
    });

    const { buildIceServers } = await loadIce();
    const servers = await buildIceServers('user-1');

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(CLOUDFLARE_URL);
    const requestInit = init as RequestInit;
    expect(requestInit.method).toBe('POST');
    expect(requestInit.headers).toMatchObject({
      Authorization: 'Bearer token-abc',
      'Content-Type': 'application/json',
    });
    expect(JSON.parse(requestInit.body as string)).toEqual({ ttl: 86400 });

    expect(servers).toHaveLength(2);
    expect(servers[0]!.urls).toEqual(['stun:stun.cloudflare.com:3478']);
    expect(servers[1]!.urls).toEqual([
      'turn:turn.cloudflare.com:3478?transport=udp',
      'turns:turn.cloudflare.com:5349?transport=tcp',
    ]);
    expect(servers[1]!.username).toBe('cf-user');
    expect(servers[1]!.credential).toBe('cf-cred');
  });

  it('caches the minted credentials across calls within the TTL window', async () => {
    const fetchMock = mockFetchOnce({
      iceServers: [{ urls: ['stun:stun.cloudflare.com:3478'] }],
    });

    const { buildIceServers } = await loadIce();
    await buildIceServers('user-1');
    await buildIceServers('user-2');

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('missing TURN_KEY_ID / TURN_KEY_API_TOKEN falls soft to STUN-only', async () => {
    delete process.env.TURN_KEY_ID;
    delete process.env.TURN_KEY_API_TOKEN;
    process.env.STUN_URL = 'stun:stun.example.com:19302';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { buildIceServers } = await loadIce();
    const servers = await buildIceServers('user-1');

    expect(servers).toEqual([{ urls: ['stun:stun.example.com:19302'] }]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a non-2xx Cloudflare response falls soft to STUN-only', async () => {
    mockFetchOnce({}, false, 403);

    const { buildIceServers } = await loadIce();
    const servers = await buildIceServers('user-1');

    expect(servers).toEqual([{ urls: ['stun:stun.l.google.com:19302'] }]);
  });

  it('a 200 response with a malformed body falls soft to STUN-only', async () => {
    mockFetchOnce({ unexpected: true });

    const { buildIceServers } = await loadIce();
    const servers = await buildIceServers('user-1');

    expect(servers).toEqual([{ urls: ['stun:stun.l.google.com:19302'] }]);
  });

  it('a network failure falls soft to STUN-only without throwing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    );

    const { buildIceServers } = await loadIce();
    const servers = await buildIceServers('user-1');

    expect(servers).toEqual([{ urls: ['stun:stun.l.google.com:19302'] }]);
  });
});
