# Docker Packaging

This directory contains the multi-stage Dockerfile and three Docker Compose setups for running the `@remote/server` self-hosted backend.

## Files

| File                        | Description                                                                                                                                        |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Dockerfile.server`         | Multi-stage build: `node:24-alpine` base → builder (full deps + native toolchain) → runner (production deps only, better-sqlite3 native bindings). |
| `docker-compose.local.yml`  | Local LAN testing. No TURN, Google public STUN only.                                                                                               |
| `docker-compose.tunnel.yml` | Homelab behind a Cloudflare Tunnel. Public exposure via `cloudflared`.                                                                             |
| `docker-compose.prod.yml`   | Production VPS. Caddy (Let's Encrypt) + Coturn (TURN/STUN) alongside the server.                                                                   |
| `Caddyfile`                 | Caddy reverse proxy config for the prod setup.                                                                                                     |
| `.env.example`              | Template for required environment variables.                                                                                                       |

## Quick Start

### 1. Local Development

Ideal for LAN testing with an ephemeral SQLite database.

```bash
cd docker
cp .env.example .env

# Build and start
docker compose -f docker-compose.local.yml up --build
```

The server listens on `http://localhost:8787`.

### 2. Homelab (Cloudflare Tunnel)

Exposes the server to the internet through a Cloudflare Tunnel, so no port 80/443 or DNS is needed on the host.

1. Create a tunnel on the Cloudflare dashboard or CLI:
   ```bash
   cloudflared tunnel create my-tunnel
   cloudflared tunnel token my-tunnel
   ```
2. Configure `.env`:
   ```bash
   cd docker
   cp .env.example .env
   # Edit .env: set JWT_SECRET, REFRESH_TOKEN_SECRET, CLOUDFLARE_TUNNEL_TOKEN, CORS_ORIGIN
   ```
3. Start:
   ```bash
   docker compose -f docker-compose.tunnel.yml up --build
   ```

### 3. Production (VPS with Caddy + Coturn)

Full production stack with automatic HTTPS and a native TURN relay for WebRTC NAT traversal.

1. Point your domain (`A`/`CNAME`) at the VPS.
2. Configure `.env`:
   ```bash
   cd docker
   cp .env.example .env
   # Edit .env: set JWT_SECRET, REFRESH_TOKEN_SECRET, DOMAIN, TURN_SECRET
   ```
3. Start:
   ```bash
   docker compose -f docker-compose.prod.yml up --build -d
   ```

Caddy will automatically request Let's Encrypt certificates for `DOMAIN`. The Coturn server uses `TURN_SECRET` as its RFC 5766 shared secret; the server's `GET /api/webrtc/ice-servers` endpoint mints time-limited HMAC-SHA1 TURN credentials on demand.

## Environment Variables

| Variable                   | Required    | Default               | Description                                    |
| -------------------------- | ----------- | --------------------- | ---------------------------------------------- |
| `PORT`                     | No          | `8787`                | Server listen port (inside container).         |
| `DATABASE_PATH`            | No          | `/app/data/remote.db` | SQLite database file.                          |
| `JWT_SECRET`               | Yes         | —                     | HS256 secret for access tokens. Min 32 chars.  |
| `REFRESH_TOKEN_SECRET`     | Yes         | —                     | HS256 secret for refresh tokens. Min 32 chars. |
| `CORS_ORIGIN`              | No          | `*`                   | CORS allow-origin for the API.                 |
| `JWT_EXPIRES_IN`           | No          | `900` (15m)           | Access token TTL.                              |
| `REFRESH_TOKEN_EXPIRES_IN` | No          | `604800` (7d)         | Refresh token TTL.                             |
| `TURN_SECRET`              | Prod only   | —                     | Shared secret for Coturn long-term auth.       |
| `TURN_URL`                 | Prod only   | `turn:${DOMAIN}:3478` | TURN URL advertised to clients.                |
| `STUN_URL`                 | Prod only   | `stun:${DOMAIN}:3478` | STUN URL advertised to clients.                |
| `DOMAIN`                   | Prod only   | —                     | Your public domain for Caddy TLS + TURN realm. |
| `CLOUDFLARE_TUNNEL_TOKEN`  | Tunnel only | —                     | Cloudflare Tunnel token.                       |

## Building Locally

You can also build the image directly without Compose:

```bash
docker build -f docker/Dockerfile.server -t remote-server:test .
```

Podman is also supported:

```bash
podman build -f docker/Dockerfile.server -t remote-server:test .
```

## Smoke Test

After starting the container, verify it is ready:

```bash
curl http://localhost:8787/health
# Expected: {"status":"ok"}
```
