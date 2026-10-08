import { Hono } from 'hono';
import type { AppContext } from '../types.js';
import { authMiddleware } from '../middleware/auth.js';
import { buildIceServers } from '../utils/ice.js';

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
  return c.json({ iceServers: await buildIceServers(user.id) });
});

export default router;
