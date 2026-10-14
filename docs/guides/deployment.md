# Deployment Guide

Deployment guide for the Remote Access Platform. The platform runs as an all-in-one Docker container bundling the backend server (`@ponter/server`), the compiled web frontend (`@ponter/web`), and an internal Nginx reverse proxy under Supervisord, publishing a single port (`80`).

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [Architecture Overview](#2-architecture-overview)
3. [Docker Deployment](#3-docker-deployment)
   - [Scenario 1: Standard All-in-One Deployment](#scenario-1-standard-all-in-one-deployment)
   - [Scenario 2: Production VPS with Coturn TURN Relay](#scenario-2-production-vps-with-coturn-turn-relay)
   - [Deploying New Versions & Rollbacks](#31-deploying-new-versions--rollbacks)
   - [Browser WebSocket Signaling & Proxy Timeouts](#32-browser-websocket-signaling--proxy-timeouts)
4. [Runtime Frontend Configuration](#4-runtime-frontend-configuration)
5. [Environment Variables Reference](#5-environment-variables-reference)
6. [Troubleshooting](#6-troubleshooting)

---

## 1. Prerequisites

Before deploying, ensure you have:

- **Docker Engine**: `>= 25.0.0` ([installation instructions](https://docs.docker.com/get-docker/))
- **Docker Compose**: `>= 2.20.0` (bundled with Docker Desktop; invoke via `docker compose` on Linux)
- A Linux or Windows host with internet connectivity.

---

## 2. Architecture Overview

The production deployment consists of the following components:

1. **Unified Container Image (`ngotuananh2101/ponter`)**:
   - **Frontend Web Client (`@ponter/web`)**: Vue 3 SPA + Vite + Tailwind CSS + Pinia, compiled into static assets served by Nginx at `/usr/share/nginx/html`.
   - **Backend Server (`@ponter/server`)**: Node.js 24 LTS + Hono + `ws` library listening on internal loopback `127.0.0.1:8787`.
   - **Database**: SQLite (`/app/data/remote.db` via `better-sqlite3` + Drizzle ORM) in WAL mode, mounted from host directory `./data`.
   - **Internal Reverse Proxy (Nginx)**: Listens on port `80`, serves SPA assets with client-side history routing fallback (`try_files`), directly proxies health check probes (`/health`), and reverse proxies API routes (`/api/`) and WebSocket connections (`/api/ws/agent`, `/api/ws/browser`) with connection upgrade headers.
   - **Process Supervision**: Supervisord runs as PID 1 (`nodaemon=true`), managing Nginx as root and `@ponter/server` as an unprivileged user (`su-exec node`).

2. **WebRTC Relaying (NAT Traversal)**:
   - **Public STUN**: Default for direct peer-to-peer connections when peers are not behind symmetric NAT.
   - **Coturn TURN Server**: Standalone deployment option via `docker-compose.coturn.yml` for environments requiring a dedicated relay server.
   - **Cloudflare Calls TURN**: Supported hosted TURN relay option via `TURN_PROVIDER=cloudflare`.

---

## 3. Docker Deployment

All Docker packaging files reside in the `docker/` directory.

### Scenario 1: Standard All-in-One Deployment

The standard deployment runs the unified container on port `80`. Ideal for homelabs, VPS instances, or local network servers where direct peer-to-peer WebRTC connections succeed via STUN.

```bash
cd docker
cp .env.example .env
# Edit .env: configure JWT_SECRET and REFRESH_TOKEN_SECRET

# Pull published image and launch
docker compose pull
docker compose up -d
```

Access the web interface at `http://localhost`.

To build the image from source instead of pulling from Docker Hub:

```bash
docker compose up -d --build
```

**Health check:**

```bash
curl -fsS http://localhost/health
# {"status":"ok"}
```

---

### Scenario 2: Production VPS with Coturn TURN Relay

When agents or browser clients reside behind symmetric NAT firewalls (e.g. mobile networks, corporate intranets), WebRTC cannot establish direct peer-to-peer connections without a TURN relay.

The `docker/docker-compose.coturn.yml` file is a standalone compose configuration that runs the `ponter` container alongside an integrated Coturn TURN server on the host network.

**Step 1:** Point your domain (`A`/`CNAME`) to your VPS.

**Step 2:** Ensure firewall ports are open on the VPS:
- `80` (TCP): Web UI and API (or custom `PONTER_HTTP_PORT`)
- `3478` (TCP/UDP): Coturn STUN/TURN listener
- `49152:49200` (UDP): Coturn relay port range

**Step 3:** Configure `docker/.env`:
```bash
cd docker
cp .env.example .env
# Edit .env:
#   JWT_SECRET=<32+ chars>
#   REFRESH_TOKEN_SECRET=<32+ chars>
#   DOMAIN=ponter.example.com
#   TURN_SECRET=<random 32 hex chars>
#   CORS_ORIGIN=http://localhost,https://ponter.example.com
```

**Step 4:** Launch services:
```bash
docker compose -f docker-compose.coturn.yml pull
docker compose -f docker-compose.coturn.yml up -d
```

Coturn authenticates relay connections using the shared `TURN_SECRET`. The backend server's `GET /api/webrtc/ice-servers` endpoint mints time-limited HMAC-SHA1 credentials on demand for each authenticated user session.

#### Selecting a TURN Provider

The backend server selects its WebRTC ICE/TURN provider via the `TURN_PROVIDER` environment variable:

| Value              | Description                                                                                                                                                                                                                                                                                                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `coturn` (default) | Self-hosted Coturn relay. RFC 5766 HMAC-SHA1 credentials derived dynamically from `TURN_SECRET` and `TURN_URL`.                                                                                                                                                                                                                                                   |
| `cloudflare`       | Hosted Cloudflare Calls TURN relay. Requires `TURN_KEY_ID` and `TURN_KEY_API_TOKEN`. The server requests short-lived credentials from the Cloudflare API and caches them for their TTL. Media relays through Cloudflare's global anycast network (1,000 GB/month egress free tier, then ~$0.05/GB egress). Automatic fallback to STUN-only if the API is down. |
| `none`             | Public STUN only (no TURN relay). WebRTC connections will fail between peers when both sit behind symmetric NAT firewalls.                                                                                                                                                                                                                                         |

When using `TURN_PROVIDER=cloudflare`, configure your Cloudflare Calls credentials in `docker/.env`:

```env
TURN_PROVIDER=cloudflare
TURN_KEY_ID=your_cloudflare_turn_key_id
TURN_KEY_API_TOKEN=your_cloudflare_turn_api_token
```

---

## 3.1 Deploying New Versions & Rollbacks

The platform uses prebuilt multi-arch images (`linux/amd64` and `linux/arm64`) published to Docker Hub (`ngotuananh2101/ponter`) by GitHub Actions (`.github/workflows/docker-publish.yml`).

### Updating to the Latest Release

```bash
cd docker
docker compose pull
docker compose up -d
```

Verify the update:

```bash
curl -fsS http://localhost/health
# Expected: {"status":"ok"}
```

### Rollback Strategy

The Docker Publish workflow publishes three tags:
- `ngotuananh2101/ponter:latest`: Points to the newest build from `main`.
- `ngotuananh2101/ponter:sha-<sha>`: Retains the **3 most recent builds**.
- `ngotuananh2101/ponter:<tag>`: Created when a specific tag input (e.g. `v1.2.0`) is supplied.

To roll back a problematic release, update the image tag in `docker/docker-compose.yml`:

```yaml
services:
  ponter:
    image: ngotuananh2101/ponter:sha-previous_sha
```

Then execute:

```bash
docker compose up -d
```

---

## 3.2 Browser WebSocket Signaling & Proxy Timeouts

Browser signaling uses persistent WebSockets (`/api/ws/browser`) rather than REST polling. When a terminal session is open but idle, the signaling socket remains open without data transit.

To prevent connections from dropping prematurely:
1. **Internal Nginx Configuration**: `docker/nginx.web.conf` sets `proxy_read_timeout 86400s;` (24 hours), `proxy_send_timeout 86400s;`, and disables proxy buffering (`proxy_buffering off;`).
2. **Graceful Shutdown**: The container specifies `stop_grace_period: 15s`. When stopping or restarting, Supervisord sends `SIGTERM` to the Node.js server, allowing it to close signaling sockets with WebSocket status code `1001` (Going Away) before terminating cleanly.
3. **External Host Proxy**: If you run an external reverse proxy (e.g. Traefik, host Nginx, Caddy) in front of port 80, ensure its WebSocket read timeout is set to at least 24 hours.

---

## 4. Runtime Frontend Configuration

Under the unified deployment, the frontend SPA is compiled once into the container image. The web client dynamically determines its backend API endpoint at runtime, rather than baking a URL at build time.

### Resolution Precedence

`apps/web/src/config.ts` resolves the API endpoint in the following order:
1. **Runtime Injection (`window.__PONTER_CONFIG__.apiUrl`)**: Injected into `/usr/share/nginx/html/config.js` by `entrypoint.sh` from the `PONTER_API_URL` environment variable.
2. **Build-Time Variable (`import.meta.env.VITE_API_URL`)**: Used during local development with Vite dev server (`http://localhost:8787`).
3. **Same-Origin Fallback (`window.location.origin`)**: Default for container deployment where frontend and backend are served from the same host and port (`http://your-server`).

If Ponter is accessed via the standard published port on the same domain, leave `PONTER_API_URL` empty in `docker/.env`.

---

## 5. Environment Variables Reference

| Variable                   | Required   | Default                 | Description                                                                                                                                              |
| -------------------------- | ---------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PONTER_HTTP_PORT`         | No         | `80`                    | Published host port for the web UI and reverse proxy. Set to `127.0.0.1:80` (or `127.0.0.1:8080` to avoid host port collision) when behind a host proxy. |
| `PONTER_API_URL`           | No         | —                       | Optional API URL override injected into `/config.js`. Leave empty for same-origin default.                                                               |
| `PORT`                     | No         | `8787`                  | Internal Node.js backend port (bound to `127.0.0.1` inside container).                                                                                   |
| `DATABASE_PATH`            | No         | `/app/data/remote.db`   | SQLite database file path.                                                                                                                               |
| `JWT_SECRET`               | Yes        | —                       | HS256 HMAC secret for signing access tokens. Minimum 32 characters.                                                                                      |
| `REFRESH_TOKEN_SECRET`     | Yes        | —                       | HS256 HMAC secret for signing refresh tokens. Minimum 32 characters.                                                                                     |
| `CORS_ORIGIN`              | No         | `http://localhost`      | Allowed browser origins for CORS and WebSocket CSWSH defense. Comma-separated.                                                                           |
| `JWT_EXPIRES_IN`           | No         | `900` (15m)             | Access token TTL in seconds.                                                                                   |
| `REFRESH_TOKEN_EXPIRES_IN` | No         | `604800` (7d)           | Refresh token TTL in seconds.                                                                                  |
| `DOCKERHUB_IMAGE`          | No         | `ngotuananh2101/ponter` | Image repository name on Docker Hub.                                                                           |
| `DOMAIN`                   | Coturn     | —                       | Domain or hostname for the Coturn realm and TURN server.                                                       |
| `TURN_SECRET`              | Coturn     | —                       | Shared secret for Coturn RFC 5766 authentication.                                                              |
| `TURN_URL`                 | Coturn     | `turn:${DOMAIN}:3478`   | TURN URL advertised to clients. Override in `.env` to advertise an IP instead of a domain.                     |
| `STUN_URL`                 | Coturn     | `stun:${DOMAIN}:3478`   | STUN URL advertised to clients. Override in `.env` to advertise an IP instead of a domain.                     |
| `TURN_PROVIDER`            | No         | `coturn`                | TURN provider: `coturn` \| `cloudflare` \| `none`.                                                             |
| `TURN_KEY_ID`              | Cloudflare | —                       | Cloudflare Calls TURN key ID (required when `TURN_PROVIDER=cloudflare`).                                       |
| `TURN_KEY_API_TOKEN`       | Cloudflare | —                       | Cloudflare Calls TURN API token (required when `TURN_PROVIDER=cloudflare`).                                    |

---

## 6. Troubleshooting

### Issue: Container fails to start with "permission denied" on SQLite database

**Cause**: Host directory permissions on `./data` do not allow the container to create or write to the database file.

**Solution**: Ensure the `data` directory exists with appropriate permissions. On Linux:
```bash
mkdir -p docker/data
chmod 755 docker/data
```
The container entrypoint will automatically adjust ownership to the unprivileged `node` user when running as root.

### Issue: Web application cannot connect to the backend (CORS or Network Error)

**Cause**: `CORS_ORIGIN` does not match the origin in the browser address bar.

**Solution**: Update `CORS_ORIGIN` in `docker/.env` to include the exact protocol, domain, and port used to access the application:
```env
CORS_ORIGIN=http://localhost,https://ponter.example.com
```

### Issue: WebRTC peer connection fails across networks

**Cause**: Both peers are behind restrictive or symmetric NAT firewalls, and no TURN relay is available.

**Solution**:
1. If using Coturn (`docker-compose.coturn.yml`), ensure UDP port 3478 and UDP port range 49152-49200 are open in your host firewall.
2. Verify TURN credentials endpoint responds:
   ```bash
   curl -H "Authorization: Bearer <jwt>" http://localhost/api/webrtc/ice-servers
   ```
3. Alternatively, switch to Cloudflare Calls TURN by setting `TURN_PROVIDER=cloudflare`, `TURN_KEY_ID`, and `TURN_KEY_API_TOKEN` in `.env`.

### Issue: Browser signaling socket (`/api/ws/browser`) disconnects when idle

**Cause**: An external host reverse proxy is terminating idle WebSocket connections prematurely.

**Solution**: Configure your external reverse proxy with `proxy_read_timeout 86400s;` and verify WebSocket upgrade headers (`Upgrade` and `Connection`) are properly forwarded to port 80.
