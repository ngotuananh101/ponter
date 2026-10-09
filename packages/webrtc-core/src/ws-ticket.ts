export function buildBrowserWsUrl(baseUrl: string, ticket: string): string {
  const wsBase = baseUrl.replace(/^http/, 'ws');
  return `${wsBase}/api/ws/browser?ticket=${encodeURIComponent(ticket)}`;
}

export interface MintWsTicketOptions {
  baseUrl: string;
  getToken: () => Promise<string | null>;
  onUnauthorized?: () => Promise<string | null>;
  fetch: typeof fetch;
}

/**
 * POST {baseUrl}/api/ws/ticket with the bearer token; mirrors the ws-transport mint exactly.
 */
export async function mintWsTicket(
  opts: MintWsTicketOptions,
): Promise<string | null> {
  const token = await opts.getToken();
  if (!token) return null;

  const attempt = async (t: string): Promise<Response> =>
    opts.fetch(`${opts.baseUrl}/api/ws/ticket`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${t}` },
    });

  let res = await attempt(token);
  if (res.status === 401 && opts.onUnauthorized) {
    const fresh = await opts.onUnauthorized();
    if (!fresh) return null;
    res = await attempt(fresh);
  }
  if (res.status >= 500) {
    // The server is up but broken (or a proxy answered for a restarting
    // upstream): same class as a dropped socket.
    throw new Error(`ticket endpoint answered HTTP ${res.status}`);
  }
  if (!res.ok) return null;

  const body = (await res.json()) as { ticket?: string };
  return body.ticket ?? null;
}
