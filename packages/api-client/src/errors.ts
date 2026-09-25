export interface ApiErrorPayload {
  error?: string;
  code?: string;
  details?: unknown;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(message: string, status: number, code: string, details: unknown = null) {
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
      return new ApiError(
        response.statusText || `HTTP ${response.status}`,
        response.status,
        'NETWORK_ERROR',
        null,
      );
    }
  }
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}
