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
    let normalized = config.baseUrl;
    while (normalized.endsWith('/')) {
      normalized = normalized.slice(0, -1);
    }
    this.baseUrl = normalized;
    this.storage = config.storage;
    this.onAuthError = config.onAuthError;
    this.customFetch = config.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async request<T>(
    method: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<T> {
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    const url = `${this.baseUrl}${normalizedPath}`;
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
    this.refreshPromise ??= this.doRefresh();

    try {
      await this.refreshPromise;
    } finally {
      this.refreshPromise = null;
    }

    return await this.request<T>(method, path, { ...options, retried: true });
  }

  /**
   * Clear stored tokens and notify the auth listener.
   *
   * Both refresh failure paths must do exactly this before rejecting, so it
   * lives in one place; `error` is returned so callers can `throw` it.
   */
  private async failRefresh(error: ApiError): Promise<ApiError> {
    await this.storage.clearTokens();
    this.onAuthError?.(error);
    return error;
  }

  private async doRefresh(): Promise<void> {
    const refreshToken = await this.storage.getRefreshToken();
    if (!refreshToken) {
      throw await this.failRefresh(
        new ApiError('No refresh token available', 401, 'UNAUTHORIZED'),
      );
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
      let apiErr: ApiError;
      if (error instanceof ApiError) {
        apiErr = error;
      } else {
        const message =
          error instanceof Error ? error.message : 'Refresh failed';
        apiErr = new ApiError(message, 401, 'REFRESH_FAILED');
      }
      throw await this.failRefresh(apiErr);
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
