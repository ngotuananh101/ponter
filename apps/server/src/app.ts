import { Hono } from 'hono';
import type { AppContext } from './types.js';
import { cors } from 'hono/cors';

export function createApp() {
  const app = new Hono<AppContext>();
  app.use('*', cors());
  app.get('/health', (c) => c.json({ status: 'ok' }));
  return app;
}
