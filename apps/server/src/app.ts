import { Hono } from 'hono';
import type { AppContext } from './types.js';
import { cors } from 'hono/cors';
import { errorHandler } from './middleware/error.js';
import { getDb } from './db/client.js';
import auth from './routes/auth.js';
import users from './routes/users.js';
import agents from './routes/agents.js';
import devices from './routes/devices.js';
import sessions from './routes/sessions.js';
import signalRoutes from './routes/signal.js';
import webrtcRoutes from './routes/webrtc.js';

export function createApp() {
  const app = new Hono<AppContext>();
  const corsOrigin = process.env.CORS_ORIGIN?.trim();
  app.use(
    '*',
    cors({
      origin: corsOrigin && corsOrigin !== '*' ? corsOrigin.split(',').map((o) => o.trim()) : '*',
      allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'Authorization'],
    }),
  );
  app.onError(errorHandler);

  // Make the shared SQLite database instance available on every request so
  // that middleware and routes never need to call `getDb()` more than once.
  // `getDb()` is a singleton: the first call (here, or in a test fixture) wins
  // the database path, so `DATABASE_PATH` only takes effect before the first
  // request or when `closeDb()` has not yet been called.
  app.use('*', async (c, next) => {
    c.set('db', getDb(process.env.DATABASE_PATH));
    await next();
  });

  app.get('/health', (c) => c.json({ status: 'ok' }));

  app.route('/api/auth', auth);
  app.route('/api/users', users);
  app.route('/api/agents', agents);
  app.route('/api/devices', devices);
  app.route('/api/sessions', sessions);
  app.route('/api/signal', signalRoutes);
  app.route('/api/webrtc', webrtcRoutes);

  return app;
}
