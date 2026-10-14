# Ponter

Docker image for [Ponter](https://github.com/ngotuananh101/ponter) — a high-performance, zero-trust remote access platform featuring multi-shell remote terminal, remote desktop, and remote file management over peer-to-peer WebRTC DataChannels.

This unified all-in-one container packages:

- **Backend Server (`@ponter/server`)**: Node.js 24 LTS, Hono REST API, SQLite database with WAL mode, and WebSocket signaling servers (`/api/ws/agent`, `/api/ws/browser`) listening internally on `127.0.0.1:8787`.
- **Web Client SPA (`@ponter/web`)**: Vue 3 SPA static assets compiled and served by Nginx from `/usr/share/nginx/html`.
- **Reverse Proxy (Nginx)**: Front door listening on port `80`, serving frontend SPA assets with client-side history routing fallback (`try_files`), directly proxying `/health`, and reverse proxying `/api/` and WebSocket signaling with connection upgrade support to the backend server.
- **Process Supervisor (`supervisord`)**: Supervises Nginx and the Node.js backend (`su-exec node`), handling automatic restarts and graceful multi-process termination.

The native Rust agent daemon (`ponter-agent`) runs on the target machines you want to access and is not distributed as a Docker image (see the [Agent Setup Guide](https://github.com/ngotuananh101/ponter/blob/main/docs/guides/agent-setup.md)).

---

## Quick Start

Generate two secrets (minimum 32 characters each), then run the container:

```bash
openssl rand -base64 48   # use for JWT_SECRET
openssl rand -base64 48   # use for REFRESH_TOKEN_SECRET

docker run -d \
  --name ponter \
  -p 80:80 \
  -v ponter-data:/app/data \
  -e JWT_SECRET="<32+ random characters>" \
  -e REFRESH_TOKEN_SECRET="<32+ random characters>" \
  -e CORS_ORIGIN="http://localhost" \
  ngotuananh2101/ponter:latest
```

- `-p 80:80` — Publishes port 80 for the Web UI, REST API, and WebSocket signaling.
- `-v ponter-data:/app/data` — Persists the SQLite database across restarts.
- `JWT_SECRET` / `REFRESH_TOKEN_SECRET` — **Required**; authentication returns HTTP 500 without them.
- `CORS_ORIGIN` — Allowed browser origins for CORS and WebSocket CSWSH defense.

Access the web interface at `http://localhost`.

Verify the container is healthy:

```bash
curl -fsS http://localhost/health
# {"status":"ok"}
```

The `/health` endpoint responds with HTTP 200 without authentication.

---

## Ports and Volumes

|                |                                                                                                                 |
| -------------- | --------------------------------------------------------------------------------------------------------------- |
| **Port**       | `80` (TCP) — Web UI (SPA), HTTP API (`/health`, `/api/*`), and WebSocket upgrades (`/api/ws/*`)                 |
| **Volume**     | `/app/data` — SQLite database (default `/app/data/remote.db`)                                                   |
| **Base image** | `node:24-alpine`; Nginx runs as root, backend runs as unprivileged `node` user via `su-exec`                    |
| **Entrypoint** | Adjusts `./data` permissions, renders `/usr/share/nginx/html/config.js` from `PONTER_API_URL`, runs Supervisord |

---

## Environment Variables Reference

| Variable                   | Required   | Default                 | Description                                                                                                                                           |
| -------------------------- | ---------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PONTER_HTTP_PORT`         | No         | `80`                    | Published host port for the web UI and reverse proxy. Use `127.0.0.1:80` (or `127.0.0.1:8080` to avoid host port collision) when behind a host proxy. |
| `PONTER_API_URL`           | No         | —                       | Optional API URL override injected into `/config.js`. Leave empty for default same-origin resolution.                                                 |
| `PORT`                     | No         | `8787`                  | Internal Node.js backend port (bound to `127.0.0.1` inside container).                                                                                |
| `DATABASE_PATH`            | No         | `/app/data/remote.db`   | SQLite database file path.                                                                                                                            |
| `JWT_SECRET`               | **Yes**    | —                       | Secret used to sign JWT access tokens (HS256). Minimum 32 characters.                                                                                 |
| `REFRESH_TOKEN_SECRET`     | **Yes**    | —                       | Secret used to sign JWT refresh tokens (HS256). Minimum 32 characters.                                                                                |
| `CORS_ORIGIN`              | No         | `http://localhost`      | Allowed browser origins for CORS and WebSocket CSWSH defense. Comma-separated.                                                                        |
| `JWT_EXPIRES_IN`           | No         | `900` (15m)             | Access token TTL in seconds.                                                                                                                          |
| `REFRESH_TOKEN_EXPIRES_IN` | No         | `604800` (7d)           | Refresh token TTL in seconds.                                                                                                                         |
| `DOCKERHUB_IMAGE`          | No         | `ngotuananh2101/ponter` | Image repository name on Docker Hub.                                                                                                                  |
| `DOMAIN`                   | Coturn     | —                       | Domain or hostname for the Coturn realm and TURN server.                                                                                              |
| `TURN_SECRET`              | Coturn     | —                       | Shared secret for Coturn RFC 5766 authentication.                                                                                                     |
| `TURN_URL`                 | Coturn     | `turn:${DOMAIN}:3478`   | TURN URL advertised to clients. Override in `.env` to advertise an IP instead of a domain.                                                            |
| `STUN_URL`                 | Coturn     | `stun:${DOMAIN}:3478`   | STUN URL advertised to clients. Override in `.env` to advertise an IP instead of a domain.                                                            |
| `TURN_PROVIDER`            | No         | `coturn`                | TURN provider: `coturn` \| `cloudflare` \| `none`.                                                                                                    |
| `TURN_KEY_ID`              | Cloudflare | —                       | Cloudflare Calls TURN key ID (required when `TURN_PROVIDER=cloudflare`).                                                                              |
| `TURN_KEY_API_TOKEN`       | Cloudflare | —                       | Cloudflare Calls TURN API token (required when `TURN_PROVIDER=cloudflare`).                                                                           |

---

## Deploying with Docker Compose

The repository ships two standard compose configurations in [`docker/`](https://github.com/ngotuananh101/ponter/tree/main/docker):

Both compose files include `env_file: [{path: .env, required: false}]`, automatically loading environment variables from `docker/.env`.

### 1. Standard Deployment (`docker-compose.yml`)

For local networks, homelabs, or VPS instances where direct peer-to-peer WebRTC connections succeed via STUN:

```bash
cd docker
cp .env.example .env
# Edit .env: set JWT_SECRET and REFRESH_TOKEN_SECRET

docker compose pull
docker compose up -d
```

Access the web interface at `http://localhost`.

### 2. Production VPS with Coturn TURN Relay (`docker-compose.coturn.yml`)

When clients or agents reside behind symmetric NAT firewalls (e.g., mobile networks, corporate intranets), use the standalone Coturn compose configuration:

```bash
cd docker
cp .env.example .env
# Edit .env: set JWT_SECRET, REFRESH_TOKEN_SECRET, DOMAIN, and TURN_SECRET

docker compose -f docker-compose.coturn.yml pull
docker compose -f docker-compose.coturn.yml up -d
```

Required firewall ports for Coturn:

- `80` (TCP): Web UI & API (or your custom `PONTER_HTTP_PORT`)
- `3478` (TCP/UDP): Coturn STUN/TURN listener
- `49152-49200` (UDP): Coturn media relay port range

---

## Running Behind an External Host Reverse Proxy

If your host machine already runs an external reverse proxy (e.g., Traefik, Caddy, or host Nginx) terminating TLS on ports 80/443:

1. Bind the container to loopback in `docker/.env`:
   ```env
   PONTER_HTTP_PORT=127.0.0.1:8080
   CORS_ORIGIN=https://ponter.example.com
   ```
2. Forward traffic from your external reverse proxy to `http://127.0.0.1:8080`:
   - Pass standard proxy headers: `Host`, `X-Real-IP`, `X-Forwarded-For`, and `X-Forwarded-Proto`.
   - Forward WebSocket upgrade headers: `Upgrade $http_upgrade` and `Connection $connection_upgrade`.
   - Set proxy read and send timeouts to at least `86400s` (24h) to maintain persistent WebRTC signaling connections.
   - Disable proxy buffering (`proxy_buffering off;`).
   - Set maximum client body size to at least `50M` (`client_max_body_size 50M;`) for file transfers.

---

## Runtime Frontend Configuration

The Vue 3 frontend SPA dynamically resolves its backend API endpoint at runtime rather than baking a URL at build time:

1. On container startup, `entrypoint.sh` writes `/usr/share/nginx/html/config.js` based on `PONTER_API_URL`.
2. The web application resolves its API endpoint with the following precedence:
   - `window.__PONTER_CONFIG__.apiUrl` (if `PONTER_API_URL` is set).
   - `import.meta.env.VITE_API_URL` (build-time variable, used during local `vite dev`).
   - `window.location.origin` (default same-origin fallback).

For standard deployments where the frontend and backend are served together on the same host and port (`http://your-host`), leave `PONTER_API_URL` empty.

---

## Tags & Versioning

| Tag           | Description                                                                                                                                                         |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `latest`      | The newest build published from the `main` branch.                                                                                                                  |
| `sha-<short>` | Build tagged with the 7-character commit SHA (e.g. `sha-553d3cd`). **Only the 3 most recent builds are retained**; older tags are automatically pruned.             |
| `<tag>`       | Custom versioned release tag (e.g. `v1.2.0`). Retained permanently. Avoid using a `sha-` prefix for custom tags to prevent them from matching the automated pruner. |

All published tags are multi-arch manifests (`linux/amd64` and `linux/arm64`) built on native GitHub Actions runners.

---

## How It Works

- **Signaling and Coordination, Not Data Relaying:** The backend authenticates users and agents, tracks sessions, and exchanges WebRTC signaling messages (SDP offer/answer and ICE candidates). Terminal, desktop, and file transfer streams flow directly peer-to-peer over DTLS/SCTP WebRTC DataChannels.
- **WebSocket Signaling Channels:** Agents connect to `/api/ws/agent` using long-lived agent credentials (`ag_`). Browser clients mint a short-lived ticket via `POST /api/ws/ticket` and connect to `/api/ws/browser`.
- **SQLite Database:** Uses `better-sqlite3` with Drizzle ORM in WAL mode (`foreign_keys=ON`, `busy_timeout=5000`). Database schema migrations run automatically on startup.
- **Process Supervision:** Supervisord runs as PID 1 (`nodaemon=true`), monitoring Nginx and `@ponter/server` with automatic process restart on unexpected exits (`autorestart=true`).
- **Graceful Termination:** On `SIGTERM`, Supervisord signals the Node.js server with a 15-second grace period (`stop_grace_period: 15s`), allowing WebSocket signaling sockets to close cleanly with status code 1001 (Going Away).

---

## Links

- **Repository:** <https://github.com/ngotuananh101/ponter>
- **Deployment Guide:** <https://github.com/ngotuananh101/ponter/blob/main/docs/guides/deployment.md>
- **Local Development Guide:** <https://github.com/ngotuananh101/ponter/blob/main/docs/guides/development.md>
- **Desktop Agent Setup Guide:** <https://github.com/ngotuananh101/ponter/blob/main/docs/guides/agent-setup.md>
