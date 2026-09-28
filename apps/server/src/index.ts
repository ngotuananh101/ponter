import { createApp } from './app.js';
import { serve } from '@hono/node-server';
import type { AddressInfo } from 'node:net';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { createAgentWebSocketServer, handleAgentUpgrade } from './routes/ws.js';
import { getDb } from './db/client.js';

/**
 * Create a fully-wired signaling HTTP server, including the WebSocket upgrade
 * handler for `/api/ws/agent`.
 *
 * Returns both the Hono app (for `app.fetch` / unit tests) and the raw
 * `http.Server` (for WebSocket attachment and for listening on an ephemeral
 * port in tests).
 */
export function createSignalingServer() {
  const app = createApp();
  const server = createServerFromApp(app);
  return { app, server };
}

/**
 * Wrap a Hono app's fetch handler in a Node.js `http.Server`, wiring up:
 * - WebSocket upgrade on path `/api/ws/agent` via the `ws` library.
 * - All other paths fall through to Hono's fetch handler.
 *
 * Authentication for the WebSocket upgrade happens before the handshake
 * completes, so an invalid credential results in an HTTP 401 response.
 */
function createServerFromApp(app: ReturnType<typeof createApp>): Server {
  const wss = createAgentWebSocketServer();

  const server = createServer(async (req, res) => {
    // Ensure the database is initialized before handling requests.
    getDb(process.env.DATABASE_PATH);

    try {
      // Convert Node IncomingMessage to a standard Request for Hono.
      const headers = req.headers;
      const url = `http://${headers.host ?? 'localhost'}${req.url ?? '/'}`;

      // Read the body if present
      let body: BodyInit | undefined;
      if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        if (chunks.length > 0) {
          body = Buffer.concat(chunks);
        }
      }

      const request = new Request(url, {
        method: req.method,
        headers,
        body,
      });

      const response = await app.fetch(request);

      // Copy status and headers from the Hono Response to the raw HTTP response.
      for (const [key, value] of response.headers.entries()) {
        res.setHeader(key, value);
      }
      res.writeHead(response.status);

      if (response.body) {
        const reader = response.body.getReader();
        const pump = () => {
          reader.read().then(({ done, value }) => {
            if (done) {
              res.end();
              return;
            }
            res.write(Buffer.from(value));
            pump();
          });
        };
        pump();
      } else {
        res.end();
      }
    } catch (err) {
      console.error('[server] unhandled fetch error:', err);
      if (!res.headersSent) {
        res.writeHead(500);
      }
      res.end('Internal Server Error');
    }
  });

  // Handle upgrade events: only intercept `/api/ws/agent`, destroy the rest.
  server.on('upgrade', (_req, socket) => {
    const url = _req.url ?? '';
    if (url === '/api/ws/agent' || url.startsWith('/api/ws/agent?')) {
      // Authentication happens inside handleAgentUpgrade before the WS handshake.
      // If auth fails, it sends an HTTP 401 and destroys the socket.
      void getDb(); // ensure DB is initialized
      void handleAgentUpgrade(_req, socket, Buffer.alloc(0), wss);
    } else {
      socket.destroy();
    }
  });

  return server;
}

export function startServer(port?: number) {
  const portNum = port ?? (Number(process.env.PORT) || 8080);
  const { server } = createSignalingServer();

  server.listen(portNum);
  server.on('listening', () => {
    const addr = server.address();
    const actualPort =
      typeof addr === 'object' && addr ? (addr as AddressInfo).port : portNum;
    console.log(`server running on port ${actualPort}`);
  });
  server.on('error', (err) => {
    console.error('[server] fatal error:', err);
  });

  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startServer();
}
