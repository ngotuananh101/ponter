# Ponter Server

Docker image for the self-hosted backend and WebRTC signaling server of [Ponter](https://github.com/ngotuananh101/ponter) — a remote access platform with a multi-shell remote terminal over peer-to-peer WebRTC DataChannels.

This image packages the `@ponter/server` Node.js application (`apps/server`) only. It does **not** contain the web UI, and the native Rust agent (`ponter-agent`) is not distributed as a Docker image.

## Quick Start

Generate two secrets (32+ characters each), then run the container:

```bash
openssl rand -base64 48   # use for JWT_SECRET
openssl rand -base64 48   # use for REFRESH_TOKEN_SECRET

docker run -d \
  --name ponter-server \
  -p 8787:8787 \
  -v ponter-data:/app/data \
  -e JWT_SECRET="<32+ random characters>" \
  -e REFRESH_TOKEN_SECRET="<32+ random characters>" \
  -e CORS_ORIGIN="https://your-web-app.example.com" \
  ngotuananh2101/ponter:latest
```

- `-p 8787:8787` — HTTP API and WebSocket signaling (same port).
- `-v ponter-data:/app/data` — persists the SQLite database across restarts.
- `JWT_SECRET` / `REFRESH_TOKEN_SECRET` — **required**; token operations return HTTP 500 without them.
- `CORS_ORIGIN` — set it to your web app origin (see the warning below).

Verify the container is healthy:

```bash
curl http://localhost:8787/health
# {"status":"ok"}
```

The `/health` endpoint answers HTTP 200 without authentication.

## Ports and Volumes

|                |                                                                                                             |
| -------------- | ----------------------------------------------------------------------------------------------------------- |
| **Port**       | `8787` — HTTP (`/health`, `/api/*`) and WebSocket upgrades (`/api/ws/agent`, `/api/ws/browser`)             |
| **Volume**     | `/app/data` — SQLite database (default `/app/data/remote.db`)                                               |
| **Base image** | `node:24-alpine`; the server process runs as the unprivileged `node` user                                   |
| **Entrypoint** | Starts as root only to `chown /app/data` (fixes bind-mount permissions), then drops to `node` via `su-exec` |

## Environment Variables

| Variable                   | Required | Default                                                 | Description                                                                                                                                              |
| -------------------------- | -------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                     | No       | `8080` (code); the image sets `8787`                    | HTTP + WebSocket listen port                                                                                                                             |
| `DATABASE_PATH`            | No       | `:memory:` (code); the image sets `/app/data/remote.db` | SQLite database path                                                                                                                                     |
| `JWT_SECRET`               | **Yes**  | —                                                       | Signs access tokens and browser WebSocket tickets                                                                                                        |
| `REFRESH_TOKEN_SECRET`     | **Yes**  | —                                                       | Signs refresh tokens                                                                                                                                     |
| `CORS_ORIGIN`              | No       | `*`                                                     | Comma-separated origin allowlist for HTTP CORS **and** the browser WebSocket Origin check                                                                |
| `JWT_EXPIRES_IN`           | No       | `900` (15m)                                             | Access token TTL. Requires an explicit unit — `s`, `m`, `h` or `d` (e.g. `15m`, `1h`, `900s`). A value without a unit is ignored and the default is used |
| `REFRESH_TOKEN_EXPIRES_IN` | No       | `604800` (7d)                                           | Refresh token TTL. Same unit requirement                                                                                                                 |
| `TURN_SECRET`              | No       | —                                                       | Coturn shared secret for minting time-limited TURN credentials                                                                                           |
| `TURN_URL`                 | No       | —                                                       | TURN server advertised to peers. Without it (and `TURN_SECRET`) the server falls back to public Google STUN                                              |
| `STUN_URL`                 | No       | `stun:stun.l.google.com:19302`                          | STUN entry used when TURN is configured                                                                                                                  |

**CORS_ORIGIN warning.** With `CORS_ORIGIN=*` (or unset), the browser WebSocket upgrade accepts any Origin, which disables the Cross-Site WebSocket Hijacking defence. Set it to your web app origin in production.

`NODE_ENV` and `LOG_LEVEL` are not read by the server; the image already sets `NODE_ENV=production`. `DOMAIN`, `CLOUDFLARE_TUNNEL_TOKEN` and `DOCKERHUB_IMAGE` are compose-level variables (Caddy, cloudflared, image selection), not read by the server process.

## What Else You Need

This image is one of three components:

1. **Web UI** (`apps/web`) — a Vue 3 SPA deployed separately (e.g. Cloudflare Pages or any static host) and pointed at this server via `VITE_API_URL`.
2. **Agent** (`apps/agent`) — the `ponter-agent` native binary that runs on the machines you want to reach, built from source with Cargo (`cargo build --release --manifest-path apps/agent/Cargo.toml`); see the [Agent Setup Guide](https://github.com/ngotuananh101/ponter/blob/main/docs/guides/agent-setup.md). It is not a Docker image.
3. **TURN relay** (optional) — e.g. Coturn, for peers behind symmetric NAT or restrictive firewalls.

## Deploying with Compose

The repository ships ready-made compose setups in [`docker/`](https://github.com/ngotuananh101/ponter/tree/main/docker):

- `docker-compose.tunnel.yml` — homelab behind a Cloudflare Tunnel (no inbound ports to open).
- `docker-compose.prod.yml` — VPS with Caddy (automatic HTTPS) + Coturn.
- `docker-compose.nginx.yml` — VPS with an existing host Nginx + Coturn.

They pull this image through the `DOCKERHUB_IMAGE` variable:

```bash
cd docker
cp .env.example .env
# edit .env: set JWT_SECRET, REFRESH_TOKEN_SECRET, DOMAIN, TURN_SECRET, and:
#   DOCKERHUB_IMAGE=ngotuananh2101/ponter

docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
```

See the [Deployment Guide](https://github.com/ngotuananh101/ponter/blob/main/docs/guides/deployment.md) for the full walkthrough (tunnel, prod and nginx variants).

## Tags

| Tag           | Meaning                                                                                                                                                                 |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `latest`      | The most recent image manually published from the `main` branch via the Docker Publish workflow                                                                         |
| `sha-<short>` | Every publish run, tagged with the 7-character commit SHA (e.g. `sha-553d3cd`) — use it to pin a build or roll back                                                     |
| `<tag>`       | An optional custom tag (e.g. `v1.2.3`) attached when the `tag` input is supplied; persists — avoid a `sha-` prefix, which falls inside the retention window (see below) |

Only the three most recent `sha-<short>` tags are retained; each publish without a custom tag prunes older `sha-` tags automatically. Pin a `sha-` tag only within that window, or use a custom tag for a durable name. A custom tag that itself starts with `sha-` is indistinguishable from a build tag and falls inside the retention window — avoid the `sha-` prefix for durable tags.

All tags are multi-arch manifests (`linux/amd64` + `linux/arm64` in one image, built on native runners without QEMU). The compressed image is roughly 280 MB on amd64 and 270 MB on arm64.

## How It Works

- **Signaling and auth, not a data relay.** The server authenticates users and agents, records sessions, and forwards WebRTC offer/answer/ICE messages; terminal data then flows peer-to-peer over WebRTC DataChannels (encrypted with DTLS/SCTP).
- **Two WebSocket channels.** Agents connect to `/api/ws/agent` with their agent credential; browsers mint a single-use ticket with a 15-second TTL via `POST /api/ws/ticket` and connect to `/api/ws/browser`. REST polling (`/api/signal/poll/:sessionId`) remains as a fallback.
- **SQLite persistence.** better-sqlite3 + Drizzle ORM in WAL mode (`foreign_keys=ON`, `busy_timeout=5000`); the schema is created at startup. The database is opened before the server starts listening, so an unusable `DATABASE_PATH` fails fast instead of failing on the first request.
- **Background maintenance.** Every 15 minutes, expired signals are deleted and abandoned pending sessions (older than 60 minutes) are terminated.
- **Graceful shutdown.** On SIGTERM/SIGINT the server closes signaling sockets with close code 1001, drains in-flight HTTP, and forces exit after 10 seconds. The prod and tunnel compose files set `stop_grace_period: 15s` so a redeploy does not look like a network drop to connected clients.

## Links

- Repository: <https://github.com/ngotuananh101/ponter>
- Deployment guide: <https://github.com/ngotuananh101/ponter/blob/main/docs/guides/deployment.md>
- Agent setup guide: <https://github.com/ngotuananh101/ponter/blob/main/docs/guides/agent-setup.md>
