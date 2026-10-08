import { createHmac } from 'node:crypto';
import type { IceServerConfig } from '@ponter/shared';

const GOOGLE_STUN = 'stun:stun.l.google.com:19302';

/** TURN credentials are valid for one day. */
const TURN_TTL_SECONDS = 86400;

export type TurnProvider = 'coturn' | 'none';

/**
 * Resolve the configured TURN provider.
 *
 * The default is `coturn` — the pre-Phase-8 behaviour — so an unset or empty
 * `TURN_PROVIDER` leaves existing deployments byte-for-byte unchanged. An
 * unrecognized value falls back to `coturn` with a warning rather than
 * throwing: ICE configuration is fetched while a peer is connecting, and a
 * typo in a deployment's `.env` must not break every session.
 */
export function resolveTurnProvider(): TurnProvider {
  const raw = (process.env.TURN_PROVIDER ?? '').trim().toLowerCase();
  if (raw === '' || raw === 'coturn') return 'coturn';
  if (raw === 'none') return 'none';
  console.warn(
    `[ice] unknown TURN_PROVIDER="${raw}"; falling back to "coturn"`,
  );
  return 'coturn';
}

/**
 * Normalize a `urls` value to the array shape the Rust agent parses
 * (`IceServerEntry { urls: Vec<String> }`).
 */
export function toUrlArray(urls: string | string[]): string[] {
  return Array.isArray(urls) ? urls : [urls];
}

function buildCoturnIceServers(userId: string): IceServerConfig[] {
  const turnSecret = process.env.TURN_SECRET;
  const turnUrl = process.env.TURN_URL;
  const stunUrl = process.env.STUN_URL;

  if (!turnSecret || !turnUrl) {
    // STUN_URL is deliberately ignored here: `STUN_URL` configures the STUN
    // entry of a *TURN-enabled* deployment, while this branch is the
    // no-TURN fallback, which is always the public Google resolver.
    return [{ urls: [GOOGLE_STUN] }];
  }

  const expiry = Math.floor(Date.now() / 1000) + TURN_TTL_SECONDS;
  const username = `${expiry}:${userId}`;
  const credential = createHmac('sha1', turnSecret)
    .update(username)
    .digest('base64');

  // Ensure the turn URL starts with turn:
  const baseTurnUrl = turnUrl.startsWith('turn:') ? turnUrl : `turn:${turnUrl}`;

  return [
    { urls: [stunUrl || GOOGLE_STUN] },
    {
      urls: [`${baseTurnUrl}?transport=udp`, `${baseTurnUrl}?transport=tcp`],
      username,
      credential,
    },
  ];
}

/**
 * STUN-only list. Used by `TURN_PROVIDER=none` and as the fail-soft result
 * when a TURN provider is selected but unavailable. Unlike the coturn
 * no-secret fallback, this honours `STUN_URL` when it is set (ADR-62).
 */
function buildStunOnlyIceServers(): IceServerConfig[] {
  return [{ urls: [process.env.STUN_URL || GOOGLE_STUN] }];
}

/**
 * Build the ICE server list for a user.
 *
 * Provider is selected by `TURN_PROVIDER`:
 *   - `coturn` (default): RFC 5766 HMAC credentials from `TURN_SECRET` +
 *     `TURN_URL`; `STUN_URL` optional.
 *   - `none`: STUN only.
 *
 * Shared by the user-facing `GET /api/webrtc/ice-servers` route and the
 * `ice-servers` frame pushed to agents on connect, so both peers are handed
 * the same shape of configuration. Every emitted `urls` is a string array.
 */
export async function buildIceServers(
  userId: string,
): Promise<IceServerConfig[]> {
  const provider = resolveTurnProvider();

  if (provider === 'none') {
    return buildStunOnlyIceServers();
  }

  return buildCoturnIceServers(userId);
}
