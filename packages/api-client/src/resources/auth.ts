import type { HttpClient } from '../client';
import type { LoginResponse, RegisterResponse, User } from '@ponter/shared';

export interface RegisterInput {
  username: string;
  email?: string;
  password: string;
  publicKey: string;
  /** WS2 Ed25519 signing public key (base64 raw), registered for peer identity. */
  signingPublicKey?: string;
}

export class AuthResource {
  constructor(private readonly http: HttpClient) {}

  async register(input: RegisterInput): Promise<RegisterResponse> {
    const res = await this.http.request<RegisterResponse>(
      'POST',
      '/api/auth/register',
      {
        body: input,
        auth: false,
      },
    );
    if (res.token && res.refreshToken) {
      await this.http.storage.setTokens({
        accessToken: res.token,
        refreshToken: res.refreshToken,
      });
    }
    return res;
  }

  async login(username: string, password: string): Promise<LoginResponse> {
    const res = await this.http.request<LoginResponse>(
      'POST',
      '/api/auth/login',
      {
        body: { username, password },
        auth: false,
      },
    );
    await this.http.storage.setTokens({
      accessToken: res.token,
      refreshToken: res.refreshToken,
    });
    return res;
  }

  /**
   * Bootstrap a WS2 Ed25519 signing key for a legacy account (created before
   * PR #44, where `users.signing_public_key` is NULL).
   *
   * The browser generates a signing keypair, persists the private half locally,
   * persists the public raw alongside it (for re-registration after a server
   * 409), and POSTs `{ signingPublicKey, signature }` where `signature` is an
   * Ed25519 proof over `canonicalUserIdentityMessage(user.id)`.
   *
   * The server verifies the proof, rejects 400 on a bad proof, and returns 409
   * if a key is already set on the server. The caller decides how to treat a
   * 409. Auth is required (Bearer token).
   */
  async registerSigningKey(input: {
    signingPublicKey: string;
    signature: string;
  }): Promise<{ user: User }> {
    return await this.http.request<{ user: User }>(
      'POST',
      '/api/auth/signing-key',
      {
        body: input,
        auth: true,
      },
    );
  }

  async logout(refreshToken?: string): Promise<{ success: boolean }> {
    const token =
      refreshToken || (await this.http.storage.getRefreshToken()) || undefined;
    try {
      return await this.http.request<{ success: boolean }>(
        'POST',
        '/api/auth/logout',
        {
          body: token ? { refreshToken: token } : {},
          auth: true, // Requires Bearer token
        },
      );
    } finally {
      await this.http.storage.clearTokens();
    }
  }
}
