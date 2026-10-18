import { describe, it, expect, beforeEach } from 'vitest';
import { DynamicTokenAdapter } from '../services/token-storage';

describe('DynamicTokenAdapter (Ticket #156)', () => {
  let adapter: DynamicTokenAdapter;

  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    adapter = new DynamicTokenAdapter();
  });

  it('stores tokens in localStorage when rememberMe is true and clears sessionStorage', async () => {
    adapter.setRememberMe(true);
    await adapter.setTokens({
      accessToken: 'local-access',
      refreshToken: 'local-refresh',
    });

    expect(localStorage.getItem('remote.accessToken')).toBe('local-access');
    expect(localStorage.getItem('remote.refreshToken')).toBe('local-refresh');
    expect(sessionStorage.getItem('remote.accessToken')).toBeNull();
    expect(sessionStorage.getItem('remote.refreshToken')).toBeNull();

    expect(await adapter.getAccessToken()).toBe('local-access');
    expect(await adapter.getRefreshToken()).toBe('local-refresh');
  });

  it('stores tokens in sessionStorage when rememberMe is false and clears localStorage', async () => {
    // Seed localStorage first to ensure it gets cleared
    localStorage.setItem('remote.accessToken', 'old-access');
    localStorage.setItem('remote.refreshToken', 'old-refresh');

    adapter.setRememberMe(false);
    await adapter.setTokens({
      accessToken: 'session-access',
      refreshToken: 'session-refresh',
    });

    expect(sessionStorage.getItem('remote.accessToken')).toBe('session-access');
    expect(sessionStorage.getItem('remote.refreshToken')).toBe(
      'session-refresh',
    );
    expect(localStorage.getItem('remote.accessToken')).toBeNull();
    expect(localStorage.getItem('remote.refreshToken')).toBeNull();

    expect(await adapter.getAccessToken()).toBe('session-access');
    expect(await adapter.getRefreshToken()).toBe('session-refresh');
  });

  it('prioritizes sessionStorage over localStorage when reading tokens', async () => {
    sessionStorage.setItem('remote.accessToken', 'priority-access');
    sessionStorage.setItem('remote.refreshToken', 'priority-refresh');
    localStorage.setItem('remote.accessToken', 'fallback-access');
    localStorage.setItem('remote.refreshToken', 'fallback-refresh');

    expect(await adapter.getAccessToken()).toBe('priority-access');
    expect(await adapter.getRefreshToken()).toBe('priority-refresh');
  });

  it('clears tokens from both localStorage and sessionStorage on clearTokens()', async () => {
    sessionStorage.setItem('remote.accessToken', 'session-acc');
    sessionStorage.setItem('remote.refreshToken', 'session-ref');
    localStorage.setItem('remote.accessToken', 'local-acc');
    localStorage.setItem('remote.refreshToken', 'local-ref');

    await adapter.clearTokens();

    expect(sessionStorage.getItem('remote.accessToken')).toBeNull();
    expect(sessionStorage.getItem('remote.refreshToken')).toBeNull();
    expect(localStorage.getItem('remote.accessToken')).toBeNull();
    expect(localStorage.getItem('remote.refreshToken')).toBeNull();

    expect(await adapter.getAccessToken()).toBeNull();
    expect(await adapter.getRefreshToken()).toBeNull();
  });
});
