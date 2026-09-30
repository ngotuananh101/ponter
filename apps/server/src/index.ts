import { createApp } from './app.js';
import type { AddressInfo } from 'node:net';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { createAgentWebSocketServer, handleAgentUpgrade } from './routes/ws.js';
import { getDb } from './db/client.js';
import type { Database } from './db/client.js';
import { runCleanup } from './utils/cleanup.js';

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
      let body: Uint8Array | undefined;
      if (
        req.method === 'POST' ||
        req.method === 'PUT' ||
        req.method === 'PATCH'
      ) {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        if (chunks.length > 0) {
          body = Buffer.concat(chunks);
        }
      }

      // Convert IncomingHttpHeaders to a HeadersInit-compatible structure.
      const headersInit: Record<string, string> = {};
      for (const [key, value] of Object.entries(req.headers)) {
        if (value !== undefined) {
          headersInit[key] = Array.isArray(value) ? value.join(', ') : value;
        }
      }

      const request = new Request(url, {
        method: req.method,
        headers: headersInit,
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
  server.on('upgrade', (_req, socket, head) => {
    const url = _req.url ?? '';
    if (url === '/api/ws/agent' || url.startsWith('/api/ws/agent?')) {
      // Authentication happens inside handleAgentUpgrade before the WS handshake.
      // If auth fails, it sends an HTTP 401 and destroys the socket.
      void getDb(process.env.DATABASE_PATH); // ensure DB is initialized
      void handleAgentUpgrade(_req, socket as Duplex, head, wss);
    } else {
      socket.destroy();
    }
  });

  return server;
}

/**
 * Start the periodic cleanup that reaps expired signals and abandoned
 * sessions.
 *
 * `signals.expires_at` was written from the start and honoured by the poll
 * query, but nothing ever deleted the rows; a `pending` session abandoned
 * mid-handshake had no timer at all. Both grew without bound.
 *
 * Exported separately from `startServer` so a test can drive one pass without
 * waiting on a timer, and so the interval can be shortened in a test.
 */
export function startCleanup(
  db: Database,
  intervalMs: number,
): {
  stop: () => void;
} {
  const tick = async (): Promise<void> => {
    try {
      const result = await runCleanup(db);
      if (result.signalsDeleted > 0 || result.sessionsTerminated > 0) {
        console.log(
          `[cleanup] removed ${result.signalsDeleted} expired signal(s), ` +
            `terminated ${result.sessionsTerminated} abandoned session(s)`,
        );
      }
    } catch (err) {
      // A failed reap must never take the server down: it is housekeeping, and
      // the next tick will try again.
      console.error('[cleanup] pass failed:', err);
    }
  };

  const timer = setInterval(() => void tick(), intervalMs);
  // Do not hold the event loop open on the timer's account alone.
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}

/** How often the reap runs. Fifteen minutes is well inside the 1 h window. */
export const CLEANUP_INTERVAL_MS = 15 * 60 * 1000;

export function startServer(port?: number) {
  const portNum = port ?? (Number(process.env.PORT) || 8080);
  const { server } = createSignalingServer();

  // Open the database before listening, so a path that cannot be opened fails
  // at startup rather than as a 500 on the first request. The handle is reused
  // by the cleanup timer below: a second `getDb()` would only return the same
  // singleton.
  const db = getDb(process.env.DATABASE_PATH);

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

  startCleanup(db, CLEANUP_INTERVAL_MS);

  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startServer();
}
