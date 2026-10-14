# Docker Packaging

This directory contains the Docker packaging and Docker Compose configurations for running the unified all-in-one Ponter platform.

The unified image bundles:

- **Backend Server (`@ponter/server`)**: Node.js 24 LTS, Hono REST API, SQLite database with WAL mode, and WebSocket signaling servers (`/api/ws/agent`, `/api/ws/browser`) listening internally on `127.0.0.1:8787`.
- **Web Frontend (`@ponter/web`)**: Vue 3 SPA static assets served from `/usr/share/nginx/html`.
- **Reverse Proxy (Nginx)**: Listens on port `80`, serves frontend SPA assets with client-side history routing fallback (`try_files`), directly proxies `/health`, and reverse proxies `/api/` and WebSocket signaling with connection upgrade support to the backend server.
- **Process Supervisor (`supervisord`)**: Manages both Nginx and the Node.js backend (`su-exec node`), handling automatic restarts and graceful multi-process termination.

The unified image is published to Docker Hub as `ngotuananh2101/ponter` (multi-arch `linux/amd64` and `linux/arm64`).

---

## Files

| File                        | Description                                                                                                                                           |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Dockerfile`                | Multi-stage build (`node:24-alpine`): builder compiles `@ponter/server` and `@ponter/web` SPA; runner installs Nginx + Supervisord + production deps. |
| `docker-compose.yml`        | Standard all-in-one deployment. Single container publishing port `80`. Public STUN only.                                                              |
| `docker-compose.coturn.yml` | Standalone production deployment bundling the `ponter` service and an integrated Coturn TURN server (`network_mode: host`) for symmetric NAT relay.   |
| `nginx.web.conf`            | Nginx site configuration: port 80, SPA fallback, security headers, `/config.js` no-cache, and `/api/` + WebSocket proxying.                           |
| `supervisord.conf`          | Supervisord configuration running Nginx and unprivileged Node.js (`su-exec node`) in foreground (`nodaemon=true`).                                    |
| `entrypoint.sh`             | Container entrypoint: fixes `./data` volume permissions for SQLite, renders runtime `/config.js` from `PONTER_API_URL`, and execs supervisord.        |
| `.env.example`              | Template for required and optional environment variables.                                                                                             |
| `DOCKERHUB.md`              | Repository description and documentation for Docker Hub.                                                                                              |

---

## Quick Start

### 1. Standard Deployment (All-in-One Container)

Runs the unified platform publishing port `80`. Uses public STUN servers for WebRTC peer-to-peer connection establishment.

```bash
cd docker
cp .env.example .env
# Edit .env: set JWT_SECRET and REFRESH_TOKEN_SECRET

# Pull published image and start
docker compose pull
docker compose up -d
```

Access the web interface at `http://localhost`.

To build from source instead of pulling from Docker Hub:

```bash
docker compose up -d --build
```

### 2. Production Deployment with Coturn (TURN Relay)

For environments where clients or agents operate behind symmetric or restrictive NAT firewalls, use the standalone `docker-compose.coturn.yml` setup. It runs the all-in-one Ponter container alongside an integrated Coturn TURN server.

1. Point your domain (`A`/`CNAME`) to your host machine or VPS.
2. Ensure firewall ports are open:
   - `80` (TCP): Ponter Web UI & API (or your custom `PONTER_HTTP_PORT`)
   - `3478` (TCP/UDP): Coturn signaling & STUN/TURN
   - `49152-49200` (UDP): Coturn media relay port range
3. Configure `.env`:
   ```bash
   cd docker
   cp .env.example .env
   # Edit .env: set JWT_SECRET, REFRESH_TOKEN_SECRET, DOMAIN, and TURN_SECRET
   ```
4. Start services:
   ```bash
   docker compose -f docker-compose.coturn.yml pull
   docker compose -f docker-compose.coturn.yml up -d
   ```

Coturn runs with `network_mode: host` and authenticates relay sessions using the shared `TURN_SECRET`. The backend server's `GET /api/webrtc/ice-servers` endpoint mints time-limited HMAC-SHA1 credentials on demand for authenticated clients.

---

## Runtime Frontend Configuration

Under the unified deployment, the web frontend SPA is compiled into static assets inside the container at build time. To eliminate the need for rebuilding the image for different domains or hostnames, the frontend dynamically resolves its backend API URL at runtime.

### How It Works

1. On container boot, `docker/entrypoint.sh` inspects the `PONTER_API_URL` environment variable and writes `/usr/share/nginx/html/config.js`:
   ```javascript
   window.__PONTER_CONFIG__ = {
     apiUrl: '', // populated if PONTER_API_URL is set
   };
   ```
2. The web client (`apps/web/src/config.ts`) resolves the API endpoint with the following precedence:
   - `window.__PONTER_CONFIG__.apiUrl` (if configured in `PONTER_API_URL`).
   - `import.meta.env.VITE_API_URL` (build-time environment variable, used during local `vite dev`).
   - `window.location.origin` (default same-origin fallback).

For standard deployments where the frontend and backend share the same domain and port (`http://your-host`), leave `PONTER_API_URL` empty in `.env`.

---

## Running Behind an External Host Reverse Proxy

If your host machine already runs an external reverse proxy (e.g., Traefik, Caddy, or host Nginx) to terminate TLS on ports 80/443:

1. Bind the container to loopback in `docker/.env`:
   ```env
   PONTER_HTTP_PORT=127.0.0.1:8080
   CORS_ORIGIN=https://ponter.example.com
   ```
2. Configure your external reverse proxy to forward traffic to `http://127.0.0.1:8080`:
   - Pass standard proxy headers: `Host`, `X-Real-IP`, `X-Forwarded-For`, and `X-Forwarded-Proto`.
   - Enable WebSocket upgrade headers: `Upgrade $http_upgrade` and `Connection "upgrade"`.
   - Set proxy read and send timeouts to at least `86400s` (24h) to prevent dropping idle WebRTC signaling connections.
   - Disable proxy response buffering (`proxy_buffering off;`).
   - Increase maximum request body size to at least `50M` (`client_max_body_size 50M;`) for file transfers.

---

## Environment Variables Reference

| Variable                   | Required   | Default                 | Description                                                                                                                                           |
| -------------------------- | ---------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PONTER_HTTP_PORT`         | No         | `80`                    | Published host port for the web UI and reverse proxy. Use `127.0.0.1:80` (or `127.0.0.1:8080` to avoid host port collision) when behind a host proxy. |
| `PONTER_API_URL`           | No         | —                       | Optional API URL override injected into `/config.js`. Leave empty for same-origin default.                                                            |
| `PORT`                     | No         | `8787`                  | Internal Node.js backend port (bound to `127.0.0.1` inside container).                                                                                |
| `DATABASE_PATH`            | No         | `/app/data/remote.db`   | SQLite database file path.                                                                                                                            |
| `JWT_SECRET`               | Yes        | —                       | HS256 secret for signing access tokens. Minimum 32 characters.                                                                                        |
| `REFRESH_TOKEN_SECRET`     | Yes        | —                       | HS256 secret for signing refresh tokens. Minimum 32 characters.                                                                                       |
| `CORS_ORIGIN`              | No         | `http://localhost`      | Allowed browser origins for CORS and WebSocket CSWSH defense. Comma-separated.                                                                        |
| `JWT_EXPIRES_IN`           | No         | `900` (15m)             | Access token TTL in seconds.                                                                                                                          |
| `REFRESH_TOKEN_EXPIRES_IN` | No         | `604800` (7d)           | Refresh token TTL in seconds.                                                                                                                         |
| `DOCKERHUB_IMAGE`          | No         | `ngotuananh2101/ponter` | Image repository name on Docker Hub.                                                                                                                  |
| `DOMAIN`                   | Coturn     | —                       | Domain or hostname for the Coturn realm and TURN server.                                                                                              |
| `TURN_SECRET`              | Coturn     | —                       | Shared secret for Coturn RFC 5766 authentication.                                                                                                     |
| `TURN_URL`                 | Coturn     | `turn:${DOMAIN}:3478`   | TURN URL advertised to clients. Override in `.env` to advertise an IP instead of a domain.                                                            |
| `STUN_URL`                 | Coturn     | `stun:${DOMAIN}:3478`   | STUN URL advertised to clients. Override in `.env` to advertise an IP instead of a domain.                                                            |
| `TURN_PROVIDER`            | No         | `coturn`                | TURN provider: `coturn` \| `cloudflare` (Cloudflare Calls TURN relay) \| `none`.                                                                      |
| `TURN_KEY_ID`              | Cloudflare | —                       | Cloudflare Calls TURN key ID (required when `TURN_PROVIDER=cloudflare`).                                                                              |
| `TURN_KEY_API_TOKEN`       | Cloudflare | —                       | Cloudflare Calls TURN API token (required when `TURN_PROVIDER=cloudflare`).                                                                           |

---

## Building Locally

You can build the unified image directly from the root repository directory:

```bash
# Build unified image with Docker
docker build -f docker/Dockerfile -t ponter:latest .

# Build using Docker Compose bake
docker compose build
```

Podman is also supported:

```bash
podman build -f docker/Dockerfile -t ponter:latest .
```

---

## Deploying a New Version

The standard compose files pull the prebuilt multi-arch image from Docker Hub.

**1. Publish the image:**
In GitHub Actions, trigger the **Docker Publish** workflow (`.github/workflows/docker-publish.yml`). The workflow builds `linux/amd64` and `linux/arm64` on dedicated native runners and publishes a multi-arch manifest.

| Tag                                          | Update Condition                               | Use Case                                             |
| -------------------------------------------- | ---------------------------------------------- | ---------------------------------------------------- |
| `<your-dockerhub-username>/ponter:latest`    | Runs on `main` branch                          | Standard production tag referenced by compose files. |
| `<your-dockerhub-username>/ponter:sha-<sha>` | Every run; **only the 3 most recent are kept** | Pinning a specific build or performing rollbacks.    |
| `<your-dockerhub-username>/ponter:<tag>`     | When `tag` input is provided (retained)        | Durable versioned release tag (e.g. `v1.2.0`).       |

**2. Pull and restart on the deployment host:**

```bash
cd docker
docker compose pull
docker compose up -d
```

**3. Rolling back:**
If a new release causes issues, update `image: ngotuananh2101/ponter:sha-<sha>` in `docker/docker-compose.yml` to the previous SHA tag within the 3-build retention window and run `docker compose up -d`.

---

## Smoke Test & Health Check

After launching the container, verify system health:

```bash
# Verify backend readiness probe via Nginx proxy
curl -fsS http://localhost/health
# Expected: {"status":"ok"}

# Verify frontend SPA asset serving
curl -fsS http://localhost/ | grep '<div id="app"></div>'

# Verify runtime configuration endpoint
curl -fsS http://localhost/config.js
```
