import { createHmac } from 'node:crypto';
import type { IceServerConfig } from '@ponter/shared';

const GOOGLE_STUN = 'stun:stun.l.google.com:19302';

/** TURN credentials are valid for one day. */
const TURN_TTL_SECONDS = 86400;

/**
 * Build the ICE server list for a user.
 *
 * When `TURN_SECRET` and `TURN_URL` are configured, mints RFC 5766
 * long-term credentials: `username = "<expiry>:<userId>"` and
 * `credential = base64(HMAC-SHA1(TURN_SECRET, username))`. Otherwise falls
 * back to the public Google STUN server, which is enough on a LAN.
 *
 * Shared by the user-facing `GET /api/webrtc/ice-servers` route and the
 * `ice-servers` frame pushed to agents on connect, so both peers are handed
 * the same shape of configuration.
 */
export function buildIceServers(userId: string): IceServerConfig[] {
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
