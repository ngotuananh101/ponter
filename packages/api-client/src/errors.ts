export interface ApiErrorPayload {
  error?: string;
  code?: string;
  details?: unknown;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(
    message: string,
    status: number,
    code: string,
    details: unknown = null,
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  static async fromResponse(response: Response): Promise<ApiError> {
    try {
      const data = (await response.json()) as ApiErrorPayload;
      return new ApiError(
        data.error || response.statusText || 'Unknown API Error',
        response.status,
        data.code || 'API_ERROR',
        data.details ?? null,
      );
    } catch {
      // A body that is not JSON is not a transport failure: the server answered.
      // A 5xx is the server's own fault, a 4xx is the caller's — `NETWORK_ERROR`
      // is reserved for the branch in `client.ts` where `fetch` itself rejects.
      const isServerError = response.status >= 500 && response.status < 600;
      return new ApiError(
        response.statusText || `HTTP ${response.status}`,
        response.status,
        isServerError ? 'SERVER_ERROR' : 'API_ERROR',
        null,
      );
    }
  }
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}
