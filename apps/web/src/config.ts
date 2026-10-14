declare global {
  interface Window {
    __PONTER_CONFIG__?: {
      apiUrl?: string;
    };
  }
}

/**
 * Resolves the backend API base URL with the following precedence:
 * 1. Runtime config injected into `window.__PONTER_CONFIG__.apiUrl` (e.g. from `/config.js` via entrypoint.sh)
 * 2. Build-time Vite environment variable `import.meta.env.VITE_API_URL`
 * 3. Current browser origin (`window.location.origin`) for same-origin container deployments
 * 4. Fallback to default local server URL (`http://localhost:8787`)
 */
export function getApiBaseUrl(): string {
  if (typeof window !== 'undefined') {
    const runtimeApiUrl = window.__PONTER_CONFIG__?.apiUrl?.trim();
    if (runtimeApiUrl && runtimeApiUrl.length > 0) {
      return runtimeApiUrl;
    }
  }

  const buildApiUrl = import.meta.env.VITE_API_URL?.trim();
  if (buildApiUrl && buildApiUrl.length > 0) {
    return buildApiUrl;
  }

  if (
    typeof window !== 'undefined' &&
    window.location?.origin &&
    window.location.origin !== 'null'
  ) {
    return window.location.origin;
  }

  return 'http://localhost:8787';
}
