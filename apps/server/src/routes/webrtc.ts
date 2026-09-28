import { Hono } from 'hono';
import { createHmac } from 'node:crypto';
import type { AppContext } from '../types.js';
import { authMiddleware } from '../middleware/auth.js';

const router = new Hono<AppContext>().use('*', authMiddleware);

/**
 * GET /api/webrtc/ice-servers
 *
 * Returns ICE server configuration for WebRTC peers. When a TURN_SECRET is
 * configured, generates RFC 5766 HMAC-SHA1 time-limited credentials. Otherwise,
 * returns the default public Google STUN server.
 */
router.get('/ice-servers', async (c) => {
  const user = c.get('user');

  const turnSecret = process.env.TURN_SECRET;
  const turnUrl = process.env.TURN_URL;
  const stunUrl = process.env.STUN_URL;

  if (!turnSecret || !turnUrl) {
    // Default: public STUN only
    return c.json({
      iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }],
    });
  }

  // Generate RFC 5766 HMAC-SHA1 credentials.
  // username = "<expiry_unix_timestamp>:<user_id>"
  // credential = base64( HMAC-SHA1(turnSecret, username) )
  const expiry = Math.floor(Date.now() / 1000) + 86400;
  const username = `${expiry}:${user.id}`;
  const credential = createHmac('sha1', turnSecret)
    .update(username)
    .digest('base64');

  // Ensure the turn URL starts with turn:
  const baseTurnUrl = turnUrl.startsWith('turn:') ? turnUrl : `turn:${turnUrl}`;

  const stunUrls = stunUrl ? [stunUrl] : ['stun:stun.l.google.com:19302'];

  return c.json({
    iceServers: [
      { urls: stunUrls },
      {
        urls: [`${baseTurnUrl}?transport=udp`, `${baseTurnUrl}?transport=tcp`],
        username,
        credential,
      },
    ],
  });
});

export default router;
