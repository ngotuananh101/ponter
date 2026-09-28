import { createApp } from './app.js';
import { serve } from '@hono/node-server';
import type { AddressInfo } from 'node:net';

export function startServer() {
  const app = createApp();
  const port = Number(process.env.PORT) || 8080;
  serve(
    {
      fetch: app.fetch,
      port,
    },
    (addr: AddressInfo) => {
      console.log(`server running on port ${addr.port}`);
    }
  );
  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startServer();
}
