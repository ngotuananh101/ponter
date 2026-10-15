import { describe, it, expect, vi } from 'vitest';

vi.mock('@/services/token-storage', () => ({
  tokenStorage: {
    getAccessToken: vi.fn(async () => null),
    getRefreshToken: vi.fn(async () => null),
    setTokens: vi.fn(async () => {}),
    clearTokens: vi.fn(async () => {}),
  },
}));

import { apiClient } from '@/services/client';
import { ApiClient } from '@ponter/api-client';

describe('web api client', () => {
  it('is an ApiClient built from the resolved base URL', () => {
    expect(apiClient).toBeInstanceOf(ApiClient);
    expect(apiClient.http.baseUrl.length).toBeGreaterThan(0);
  });
});
