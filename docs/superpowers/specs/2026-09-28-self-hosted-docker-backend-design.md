# Technical Design Spec: Self-Hosted Docker Backend & WebRTC Architecture

- **Date:** 2026-09-28
- **Status:** Approved
- **Scope:** Architectural (Backend Transition from Cloudflare Workers to Dockerized Node.js + SQLite)

---

## 1. Problem Statement & Motivation

### 1.1 Context
In the current implementation, the signaling and REST API backend was hosted on Cloudflare Workers Serverless Edge. During integration testing of the Web Terminal feature (`packages/webrtc-core`, `apps/agent`, `apps/web`), users consistently encountered:
```text
Uncaught (in promise) Error: timeout waiting for channel "terminal" (saw state: connecting)
```

### 1.2 Root Cause Analysis
1. **Edge Multi-Isolate Fragmentation:** Cloudflare Workers distributes HTTP requests (`POST /api/signal/offer`) and WebSocket connections (`GET /api/ws/agent`) across disparate worldwide V8 isolates (e.g., Hong Kong, Singapore). In-memory maps cannot be shared across isolates.
2. **Subrequest Limits:** Polling or synchronization on Cloudflare Free workers hits the hard 50 subrequests limit per invocation.
3. **Deployment Lifecycles & Disconnects:** When redeploying workers, existing long-lived WebSocket connections remain connected to zombie/stale isolates, preventing new signal routing endpoints from discovering the connected agent.
4. **NAT Traversal Deficit (Symmetric NAT):** WebRTC peer-to-peer data channels fail across cellular/corporate networks when relying solely on public STUN without a fallback TURN relay server. Cloudflare Workers cannot host a TURN relay server.

### 1.3 Solution
Migrate the backend from Cloudflare Workers to a centralized, stateful **Node.js application** packaged as a **Docker container** (`apps/server`), backed by local SQLite via `better-sqlite3`, while retaining `apps/web` on Cloudflare Pages/Worker static hosting. Provide three dedicated Docker Compose setups for Local LAN, Homelab (via Cloudflare Tunnel), and Production VPS with a native Coturn TURN server.

---

## 2. System Architecture

```text
                               ┌────────────────────────────────────────┐
                               │       Client (Web Browser)             │
                               │  (Vue 3 SPA hosted on Cloudflare/CDN)   │
                               └──────────────────┬─────────────────────┘
                                                  │ HTTPS REST / Polling
                                                  ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ Docker Host / VPS                                                                      │
│                                                                                        │
│   ┌────────────────────────────────────────────────────────────────────────────────┐   │
│   │ apps/server (@ponter/server)                                                   │   │
│   │                                                                                │   │
│   │   • Runtime: Node.js 24 LTS + @hono/node-server + ws                           │   │
│   │   • In-Memory WebSocket Registry: Map<agentId, AgentConnection> (RAM)          │   │
│   │   • Instantaneous Signal Dispatch (< 1ms cross-session forwarding)             │   │
│   │   • Database: SQLite (/app/data/remote.db via better-sqlite3 + Drizzle ORM)    │   │
│   │   • Token Revocation: SQLite table `revoked_tokens`                            │   │
│   │   • ICE Servers Endpoint: GET /api/webrtc/ice-servers                          │   │
│   └───────────────────────▲────────────────────────────────▲───────────────────────┘   │
│                           │                                │                           │
│     WSS /api/ws/agent     │                                │ STUN/TURN Allocation      │
│                           │                                │ (RFC 5766 Shared Secret)  │
│   ┌───────────────────────┴───────────────┐    ┌───────────┴───────────────────────┐   │
│   │ ponter-agent (Rust Daemon)            │    │ coturn (Dockerized STUN/TURN)     │   │
│   │ (Windows / Linux / macOS)             │    │ Port 3478, Relays: 49152-49200    │   │
│   └───────────────────────────────────────┘    └───────────────────────────────────┘   │
│                                                                                        │
│   WebRTC Peer Connection (DataChannel: "terminal" / PTY)                               │
│   Browser <=======================================================> Agent              │
│               (Direct P2P or Relayed through Coturn TURN)                              │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Package & Monorepo Structure

### 3.1 Migration from `workers/` to `apps/server`
The `workers/` directory is replaced by `apps/server` in `pnpm-workspace.yaml`:
```yaml
packages:
  - 'apps/*'
  - 'packages/*'
```

### 3.2 `apps/server` Structure
```text
apps/server/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts              # Entrypoint: @hono/node-server + ws WebSocketServer
│   ├── types.ts              # Env & Context types
│   ├── db/
│   │   ├── client.ts         # better-sqlite3 + drizzle(sqlite)
│   │   ├── schema.ts         # Drizzle SQLite schema (users, agents, devices, sessions, signals, revoked_tokens)
│   │   └── migrations/       # SQL migration files
│   ├── middleware/
│   │   ├── auth.ts           # Bearer JWT verification
│   │   ├── cors.ts           # Configurable CORS headers
│   │   └── error.ts          # Unified error handling
│   ├── routes/
│   │   ├── auth.ts           # Login, register, refresh, logout
│   │   ├── users.ts          # Profile management
│   │   ├── agents.ts         # Agent registration & tokens
│   │   ├── devices.ts        # Device authorization
│   │   ├── sessions.ts       # Session lifecycle
│   │   ├── signal.ts         # WebRTC offer, answer, ice-candidate endpoints
│   │   ├── ws.ts             # Agent WebSocket handler & in-memory dispatcher
│   │   └── webrtc.ts         # Dynamic ICE servers credentials (STUN / TURN)
│   └── utils/
│       ├── crypto.ts         # PBKDF2 and SHA-256 (via Web Crypto / Node crypto)
│       ├── jwt.ts            # Hono JWT sign / verify
│       └── signals.ts        # Signal parsing & validation
└── test/                     # Vitest suite for all REST & WebSocket routes
```

---

## 4. Key Implementation Details

### 4.1 In-Memory WebSocket Dispatcher
Because Node.js runs as a persistent single process, `agentConnections` in `apps/server/src/routes/ws.ts` holds active WebSocket references directly in process memory:
```typescript
export interface AgentConnection {
  agentId: string;
  userId: string;
  socket: WebSocket;
  send: (data: string) => void;
}

export const agentConnections = new Map<string, AgentConnection>();

export function pushToAgent(agentId: string, message: SignalMessage): boolean {
  const conn = agentConnections.get(agentId);
  if (!conn) return false;
  try {
    conn.send(JSON.stringify({ type: 'signal', data: message }));
    return true;
  } catch {
    agentConnections.delete(agentId);
    return false;
  }
}
```
When a browser posts an offer (`POST /api/signal/offer`), `pushToAgent` immediately sends the message to the open WebSocket without crossing isolates, Durable Objects, or subrequest boundaries.

### 4.2 SQLite Persistence with `better-sqlite3`
- Database path configured by environment variable `DATABASE_PATH` (defaults to `/app/data/remote.db`).
- SQLite uses WAL mode (`PRAGMA journal_mode = WAL;`) for high concurrency and immediate write durability.
- Automatic migration on startup using `drizzle-orm/better-sqlite3/migrator`.

### 4.3 Dynamic STUN/TURN Credentials (`GET /api/webrtc/ice-servers`)
To bypass strict firewalls and symmetric NATs:
- In production, coturn uses RFC 5766 time-limited ephemeral credentials:
  - `username = timestamp:userId`
  - `password = HMAC-SHA1(username, TURN_SECRET)`
- Endpoint `GET /api/webrtc/ice-servers` returns:
```json
{
  "iceServers": [
    { "urls": ["stun:turn.yourdomain.com:3478"] },
    {
      "urls": [
        "turn:turn.yourdomain.com:3478?transport=udp",
        "turn:turn.yourdomain.com:3478?transport=tcp"
      ],
      "username": "1727548800:usr_123",
      "credential": "base64hmacpassword"
    }
  ]
}
```
- In local mode, returns standard public STUN (`stun:stun.l.google.com:19302`).

---

## 5. Docker Packaging & Compose Setups

### 5.1 Multi-Stage `docker/Dockerfile.server`
- Base: `node:24-alpine` (with build-base / python3 for native `better-sqlite3` build).
- Stage 1 (`deps`): Installs dependencies with `pnpm install --frozen-lockfile`.
- Stage 2 (`builder`): Builds `@ponter/shared` and `@ponter/server`.
- Stage 3 (`runner`): Strips devDependencies, sets `NODE_ENV=production`, exposes port `8787`, mounts volume `/app/data`.

### 5.2 Compose Scenarios

#### Scenario 1: `docker-compose.local.yml`
```yaml
services:
  server:
    build:
      context: ..
      dockerfile: docker/Dockerfile.server
    ports:
      - "8787:8787"
    environment:
      - PORT=8787
      - DATABASE_PATH=/app/data/remote.db
      - JWT_SECRET=local-dev-jwt-secret-key-32-chars-min
      - REFRESH_TOKEN_SECRET=local-dev-refresh-secret-key-32-chars
      - CORS_ORIGIN=*
    volumes:
      - ./data:/app/data
```

#### Scenario 2: `docker-compose.tunnel.yml` (Homelab + Cloudflare Tunnel)
```yaml
services:
  server:
    build:
      context: ..
      dockerfile: docker/Dockerfile.server
    restart: unless-stopped
    environment:
      - PORT=8787
      - DATABASE_PATH=/app/data/remote.db
      - JWT_SECRET=${JWT_SECRET}
      - REFRESH_TOKEN_SECRET=${REFRESH_TOKEN_SECRET}
      - CORS_ORIGIN=${CORS_ORIGIN}
    volumes:
      - ./data:/app/data

  cloudflared:
    image: cloudflare/cloudflared:latest
    restart: unless-stopped
    command: tunnel run
    environment:
      - TUNNEL_TOKEN=${CLOUDFLARE_TUNNEL_TOKEN}
    depends_on:
      - server
```

#### Scenario 3: `docker-compose.prod.yml` (VPS + Caddy + Coturn TURN)
```yaml
services:
  server:
    build:
      context: ..
      dockerfile: docker/Dockerfile.server
    restart: always
    environment:
      - PORT=8787
      - DATABASE_PATH=/app/data/remote.db
      - JWT_SECRET=${JWT_SECRET}
      - REFRESH_TOKEN_SECRET=${REFRESH_TOKEN_SECRET}
      - CORS_ORIGIN=https://${DOMAIN}
      - TURN_SECRET=${TURN_SECRET}
      - TURN_URL=${TURN_URL:-turn:${DOMAIN}:3478}
      - STUN_URL=${STUN_URL:-stun:${DOMAIN}:3478}
    volumes:
      - ./data:/app/data

  coturn:
    image: coturn/coturn:latest
    restart: always
    network_mode: host
    command:
      - "-n"
      - "--log-file=stdout"
      - "--lt-cred-mech"
      - "--use-auth-secret"
      - "--static-auth-secret=${TURN_SECRET}"
      - "--realm=${DOMAIN}"
      - "--min-port=49152"
      - "--max-port=49200"

  caddy:
    image: caddy:2-alpine
    restart: always
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile
      - ./caddy_data:/data
      - ./caddy_config:/config
    depends_on:
      - server
```

---

## 6. Documentation & CI/CD Updates

1. **`docs/ARCHITECTURE.md`:** Update system architecture diagrams, removing Cloudflare Workers backend and detailing Node.js stateful architecture, SQLite storage, and STUN/TURN fallback.
2. **`docs/guides/deployment.md`:** Provide complete instructions for running `docker-compose.local.yml`, `docker-compose.tunnel.yml`, and `docker-compose.prod.yml`, plus Cloudflare Pages static web deployment.
3. **`docs/guides/development.md`:** Replace `wrangler dev` commands with `pnpm --filter @ponter/server dev`.
4. **`docs/guides/agent-setup.md`:** Point agent configurations to self-hosted server endpoints.
5. **`README.md` & `docs/README.md`:** Update stack overview.
6. **`.github/workflows/deploy.yml` & `ci.yml`:**
   - Remove Cloudflare Worker deploy job.
   - Add Docker build verification.
   - Retain Cloudflare Pages deployment for `apps/web`.

---

## 7. Verification & Success Criteria

1. **Unit & Integration Tests:** All authentication, agent management, signaling, and WebSocket tests pass on Node.js 24 (`pnpm --filter @ponter/server test`).
2. **Docker Container Launch:** Container builds successfully via `docker build` and starts cleanly under all 3 compose environments.
3. **End-to-End Terminal Session:**
   - `apps/agent` connects to `ws://localhost:8787/api/ws/agent`.
   - Web UI triggers session initiation.
   - WebRTC DataChannel `"terminal"` opens within 500ms without timeout.
   - Interactive shell commands (`dir`, `ls`, etc.) stream back and forth with zero dropped frames.
