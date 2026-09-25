import { ApiError } from './errors';
import type {
  ApiClientConfig,
  RequestOptions,
  TokenStorageAdapter,
  AuthErrorHandler,
} from './types';
import { AuthResource } from './resources/auth';
import { UsersResource } from './resources/users';
import { DevicesResource } from './resources/devices';
import { AgentsResource } from './resources/agents';
import { SessionsResource } from './resources/sessions';

export class HttpClient {
  readonly baseUrl: string;
  readonly storage: TokenStorageAdapter;
  onAuthError?: AuthErrorHandler;
  private readonly customFetch: typeof fetch;
  private refreshPromise: Promise<void> | null = null;

  constructor(config: ApiClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.storage = config.storage;
    this.onAuthError = config.onAuthError;
    this.customFetch = config.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async request<T>(
    method: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<T> {
    const url = `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (options.auth !== false) {
      const token = await this.storage.getAccessToken();
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }
    }

    const init: RequestInit = {
      method,
      headers,
    };

    if (options.body !== undefined) {
      init.body = JSON.stringify(options.body);
    }

    let response: Response;
    try {
      response = await this.customFetch(url, init);
    } catch (err) {
      throw new ApiError(
        err instanceof Error ? err.message : 'Network request failed',
        0,
        'NETWORK_ERROR',
        null,
      );
    }

    if (response.ok) {
      if (response.status === 204) {
        return undefined as T;
      }
      try {
        return (await response.json()) as T;
      } catch {
        return undefined as T;
      }
    }

    const isAuthPath =
      path.includes('/api/auth/login') ||
      path.includes('/api/auth/refresh') ||
      path.includes('/api/auth/register');

    if (
      response.status === 401 &&
      options.auth !== false &&
      !isAuthPath &&
      !options.retried
    ) {
      return await this.refreshAndRetry<T>(method, path, options);
    }

    throw await ApiError.fromResponse(response);
  }

  private async refreshAndRetry<T>(
    method: string,
    path: string,
    options: RequestOptions,
  ): Promise<T> {
    if (this.refreshPromise === null) {
      this.refreshPromise = this.doRefresh();
    }

    try {
      await this.refreshPromise;
    } finally {
      this.refreshPromise = null;
    }

    return await this.request<T>(method, path, { ...options, retried: true });
  }

  private async doRefresh(): Promise<void> {
    const refreshToken = await this.storage.getRefreshToken();
    if (!refreshToken) {
      const err = new ApiError(
        'No refresh token available',
        401,
        'UNAUTHORIZED',
      );
      await this.storage.clearTokens();
      if (this.onAuthError) {
        this.onAuthError(err);
      }
      throw err;
    }

    try {
      const response = await this.customFetch(
        `${this.baseUrl}/api/auth/refresh`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken }),
        },
      );

      if (!response.ok) {
        throw await ApiError.fromResponse(response);
      }

      const data = (await response.json()) as {
        token: string;
        refreshToken: string;
        expiresIn: number;
      };

      await this.storage.setTokens({
        accessToken: data.token,
        refreshToken: data.refreshToken,
      });
    } catch (error) {
      const apiErr =
        error instanceof ApiError
          ? error
          : new ApiError(
              error instanceof Error ? error.message : 'Refresh failed',
              401,
              'REFRESH_FAILED',
            );
      await this.storage.clearTokens();
      if (this.onAuthError) {
        this.onAuthError(apiErr);
      }
      throw apiErr;
    }
  }
}

export class ApiClient {
  readonly http: HttpClient;
  readonly auth: AuthResource;
  readonly users: UsersResource;
  readonly devices: DevicesResource;
  readonly agents: AgentsResource;
  readonly sessions: SessionsResource;

  constructor(config: ApiClientConfig) {
    this.http = new HttpClient(config);
    this.auth = new AuthResource(this.http);
    this.users = new UsersResource(this.http);
    this.devices = new DevicesResource(this.http);
    this.agents = new AgentsResource(this.http);
    this.sessions = new SessionsResource(this.http);
  }
}
