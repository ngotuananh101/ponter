import type { HttpClient } from '../client';
import type { LoginResponse } from '@remote/shared';

export interface RegisterInput {
  username: string;
  email?: string;
  password: string;
  publicKey: string;
}

export class AuthResource {
  constructor(private readonly http: HttpClient) {}

  async register(input: RegisterInput): Promise<LoginResponse> {
    const res = await this.http.request<LoginResponse>(
      'POST',
      '/api/auth/register',
      {
        body: input,
        auth: false,
      },
    );
    await this.http.storage.setTokens({
      accessToken: res.token,
      refreshToken: res.refreshToken,
    });
    return res;
  }

  async login(username: string, password: string): Promise<LoginResponse> {
    const res = await this.http.request<LoginResponse>('POST', '/api/auth/login', {
      body: { username, password },
      auth: false,
    });
    await this.http.storage.setTokens({
      accessToken: res.token,
      refreshToken: res.refreshToken,
    });
    return res;
  }

  async refresh(refreshToken: string): Promise<{ token: string; refreshToken: string; expiresIn: number }> {
    return await this.http.request('POST', '/api/auth/refresh', {
      body: { refreshToken },
      auth: false,
    });
  }

  async logout(refreshToken?: string): Promise<{ success: boolean }> {
    const token = refreshToken || (await this.http.storage.getRefreshToken()) || undefined;
    try {
      return await this.http.request<{ success: boolean }>('POST', '/api/auth/logout', {
        body: token ? { refreshToken: token } : {},
        auth: true, // Requires Bearer token
      });
    } finally {
      await this.http.storage.clearTokens();
    }
  }
}
