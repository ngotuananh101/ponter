# Deployment Guide

Deployment guide for the Remote Access Platform. The backend (`@ponter/server`) is a self-hosted Node.js application running in Docker. The web frontend (`apps/web`) is a Vue 3 SPA deployed to Cloudflare Pages.

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [Architecture Overview](#2-architecture-overview)
3. [Docker Deployment (Backend Server)](#3-docker-deployment-backend-server)
   - [Scenario 1: Local LAN](#scenario-1-local-lan)
   - [Scenario 2: Homelab (Cloudflare Tunnel)](#scenario-2-homelab-cloudflare-tunnel)
   - [Scenario 3: Production VPS (Caddy + Coturn)](#scenario-3-production-vps-caddy--coturn)
   - [Deploying New Versions](#31-deploying-new-versions)
   - [Browser WebSocket Signaling (proxy & idle timeouts)](#32-browser-websocket-signaling-proxy--idle-timeouts)
4. [Deploying the Web Frontend to Cloudflare Pages](#4-deploying-the-web-frontend-to-cloudflare-pages)
   - [Configure Environment Variables](#41-configure-environment-variables)
   - [Build and Deploy](#42-build-and-deploy)
   - [Verify Web Deployment](#43-verify-web-deployment)
5. [Environment Variables Reference](#5-environment-variables-reference)
6. [Troubleshooting](#6-troubleshooting)

---

## 1. Prerequisites

Before deploying, ensure you have:

- **Docker**: `>= 25.0.0` ([installation](https://docs.docker.com/get-docker/))
- **Docker Compose**: `>= 2.20.0` (bundled with Docker Desktop; use `docker compose` on Linux)
- **Cloudflare Account**: [Sign up](https://dash.cloudflare.com/sign-up) (required only for frontend deployment)
- **pnpm**: `>= 12.0.0` (required only for frontend deployment)
- **Node.js**: `>= 24.0.0` (required only for frontend deployment)

---

## 2. Architecture Overview

Production deployment consists of the following components:

1. **Frontend Web Client (`apps/web`)**:
   - **Hosting**: Cloudflare Pages (static CDN hosting, runs no backend logic)
   - **Framework**: Vue 3 SPA + Vite + Tailwind CSS + Pinia
   - **Backend Connection**: Configured via `VITE_API_URL` pointing to the self-hosted server

2. **Backend Server (`@ponter/server`)**:
   - **Runtime**: Node.js 24 LTS + @hono/node-server + `ws` library
   - **Database**: SQLite (better-sqlite3 + Drizzle ORM) with WAL mode
   - **WebSocket**: Two channels — `/api/ws/agent` (agent ↔ server) and `/api/ws/browser` (browser signaling, push instead of poll)
   - **Token Revocation**: SQLite table `revoked_tokens` (replaces Cloudflare KV)
   - **ICE Servers**: Dynamic STUN/TURN credentials via `GET /api/webrtc/ice-servers`
   - **Containerization**: Docker multi-stage image

3. **TURN Server (Production)**: Coturn for WebRTC NAT traversal (symmetric NAT)

---

## 3. Docker Deployment (Backend Server)

All Docker files reside in the `docker/` directory.

### Scenario 1: Local LAN

Intended for testing on a local LAN. The server listens on `http://localhost:8787` with an ephemeral SQLite database and Google's public STUN server. No TURN relay is used.

```bash
cd docker
docker compose -f docker-compose.local.yml up --build
```

The server will run at `http://localhost:8787`.

> **Scenario 1 is the only exception that builds from source.** Images are prebuilt and published by CI to Docker Hub (`<your-dockerhub-user>/ponter:latest`), and Scenarios 2/3 only `pull` that image — eliminating the need to rebuild on deployment hosts. Scenario 1 keeps `--build` to reflect local code changes, including uncommitted edits. See [Deploying New Versions](#31-deploying-new-versions).

**Health check:**
```bash
curl http://localhost:8787/health
# {"status":"ok"}
```

### Scenario 2: Homelab (Cloudflare Tunnel)

Exposes the server to the internet via Cloudflare Tunnel. Ideal for home servers needing remote access without opening router ports or configuring public DNS.

**Step 1:** Create Cloudflare Tunnel:
```bash
cloudflared tunnel create my-tunnel
cloudflared tunnel token my-tunnel
```

**Step 2:** Configure `.env`:
```bash
cd docker
cp .env.example .env
# Edit .env: set JWT_SECRET, REFRESH_TOKEN_SECRET, CLOUDFLARE_TUNNEL_TOKEN, CORS_ORIGIN
```

**Step 3:** Start containers:
```bash
docker compose -f docker-compose.tunnel.yml pull
docker compose -f docker-compose.tunnel.yml up -d
```

### Scenario 3: Production VPS (Caddy + Coturn)

Full production deployment on a VPS with automated HTTPS (Caddy + Let's Encrypt) and a Coturn TURN server for WebRTC NAT traversal.

**Step 1:** Point your domain (`A`/`CNAME`) to the VPS.

**Step 2:** Configure `.env`:
```bash
cd docker
cp .env.example .env
# Edit .env: set JWT_SECRET, REFRESH_TOKEN_SECRET, DOMAIN, TURN_SECRET
```

**Step 3:** Start containers:
```bash
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
```

Caddy automatically requests Let's Encrypt certificates for `DOMAIN`. The Coturn server uses `TURN_SECRET` as an RFC 5766 shared secret; the server's `GET /api/webrtc/ice-servers` endpoint mints time-limited HMAC-SHA1 credentials for each user.

#### Selecting a TURN Provider

The server selects a TURN provider via the `TURN_PROVIDER` environment variable:

| Value | Description |
|---|---|
| `coturn` (default) | Self-hosted Coturn, RFC 5766 credentials derived from `TURN_SECRET` + `TURN_URL`. Preserves behavior from earlier phases. |
| `cloudflare` | Cloudflare Calls TURN (hosted). Requires `TURN_KEY_ID` + `TURN_KEY_API_TOKEN`. Server mints credentials via Cloudflare API and caches per TTL. **Note:** media flows through Cloudflare infrastructure (third-party). Cloudflare provides **1,000 GB egress/month free tier** (shared across Cloudflare Realtime services), then ~$0.05/GB egress; STUN `stun.cloudflare.com` is free. Differs from self-hosted model. |
| `none` | STUN only, no relay. Peers behind symmetric NAT may fail to connect. |

When Cloudflare fails (missing configuration, non-2xx response, network error), the server automatically falls back to STUN-only and logs a warning — connections are not blocked.

---

## 3.1 Deploying New Versions

Scenarios 2 and 3 run prebuilt images published by the **Docker Publish** workflow (`.github/workflows/docker-publish.yml`).

**Step 0 — Point compose to your image.** Docker Hub account names do not match GitHub usernames, so the namespace is read from the `DOCKERHUB_USERNAME` secret in the workflow, while Compose reads `DOCKERHUB_IMAGE` in `docker/.env`. The default already points to the published repository; override only when publishing under a different namespace:

```bash
cd docker
# in .env (created from .env.example):
DOCKERHUB_IMAGE=ngotuananh2101/ponter
```

### 3.1.1 Publish your own image (fork)

The shipped `DOCKERHUB_IMAGE` points at the upstream image. To deploy an image
you built yourself:

```bash
docker build -f docker/Dockerfile.server -t <your-namespace>/ponter:latest .
docker push <your-namespace>/ponter:latest
# then set DOCKERHUB_IMAGE=<your-namespace>/ponter:latest in docker/.env
```

See `docs/guides/self-hosting.md` §2 for the full fork walkthrough.

**Step 1 — Publish image:** on GitHub, navigate to Actions → *Docker Publish* → *Run workflow*, selecting the target branch.

The workflow builds `linux/amd64` and `linux/arm64` on dedicated native runners and merges them into a multi-arch manifest, allowing the same image to run on x86 VPS and ARM machines (Oracle Cloud, Ampere, Raspberry Pi) without QEMU.

The image is pushed to `<your-dockerhub-user>/ponter` (currently `ngotuananh2101/ponter`). **You must create this repository on Docker Hub first** — Docker Hub will not automatically create repositories on push to non-existent names and returns an authorization error.

Three tags may be generated:

| Tag | Update Condition | Purpose |
| --- | --- | --- |
| `<your-dockerhub-user>/ponter:latest` | Only on `main` branch runs | Tag referenced by compose files. |
| `<your-dockerhub-user>/ponter:sha-<sha>` | Every run; **keeps only the 3 most recent builds** | Pins a specific build, or enables rollback to a previous version. |
| `<your-dockerhub-user>/ponter:<tag>` | When input `tag` is provided (retained indefinitely) | Human-readable release tag (e.g. `v1.2.3`). |

Runs from feature branches never produce the `latest` tag, ensuring experimental builds cannot displace production images. Each publish without a `tag` input prunes old `sha-` tags, preserving only the three most recent builds.

**Step 2 — Pull and restart on deployment host:**
```bash
cd docker
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
```

**Step 3 — Verify:**
```bash
curl https://<your-domain>/health
# {"status":"ok"}
```

**Rollback:** Because `latest` is a mutable tag, if a new release causes issues, update the `image:` line in your compose file to the `sha-` tag of the previous build, then run `pull && up -d`.

> **Repository secrets:** The workflow requires `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` (Docker Hub **access token** from Account Settings → Personal Access Tokens, with Read/Write **and Delete** permissions — not your account password). The prune step deletes old `sha-` tags via the Docker Hub API, so a token lacking Delete permission will cause the prune step to fail (the image will still publish successfully).

---

## 3.2 Browser WebSocket Signaling (proxy & idle timeouts)

Browser signaling uses WebSocket instead of REST polling. The browser tab mints a ticket via `POST /api/ws/ticket` (TTL 15s, single-use) and opens `GET /api/ws/browser?ticket=...`; the server pushes signals directly to the tab as soon as they are recorded, eliminating 200ms–2000ms polling loops. REST (`/api/signal/*`) remains active as a fallback if WebSocket connection fails.

Enable WebSocket signaling for web using the build-time variable `VITE_BROWSER_WS_SIGNALING` (default `false`):

```env
# apps/web/.env.production
VITE_API_URL=https://your-domain.com
VITE_BROWSER_WS_SIGNALING=true
```

This is a **build-time** variable: a single bundle carries one setting for all users, so toggling it requires rebuilding and redeploying the frontend (see [Section 4](#4-deploying-the-web-frontend-to-cloudflare-pages)).

### Why Proxy and Docker Configuration is Required

The signaling socket is **silent when no signals are in transit** — which is normal while a terminal session is open. Intermediate layers (reverse proxy, Cloudflare Tunnel, Docker) have default idle timeouts, cutting sockets prematurely mid-session. Three configurations are pre-tuned in the repository:

| Layer | Configuration | File |
|---|---|---|
| Caddy (Scenario 3) | matcher `path /api/ws/*` + `transport http { read_buffer 65536; keepalive 300s }` | `docker/Caddyfile` |
| Cloudflare Tunnel (Scenario 2) | `originRequest.maxIdleDuration: 300s` | `docker/cloudflared/config.yml` (mounted read-only, passed via `--config`) |
| Docker (all 3 scenarios) | `stop_grace_period: 15s` for service `server` | `docker/docker-compose.*.yml` |

- **Caddy** must isolate the `/api/ws/*` block to apply `keepalive 300s`; Caddy defaults are lower and would silently terminate idle sockets.
- **Cloudflare Tunnel**: `maxIdleDuration` **has no equivalent environment variable** — it must reside in `config.yml` and cloudflared must run with `--config /etc/cloudflared/config.yml`. Using `TUNNEL_TOKEN` alone (without `--config`) ignores this configuration.
- **Docker**: defaults to 10s before issuing `SIGKILL`. The server implements graceful shutdown (closing all signaling sockets with close code 1001 before draining via `server.close`); `stop_grace_period: 15s` allows sufficient completion time, ensuring redeployments do not resemble network drops to connected clients or agents.

### Verification

After deployment, confirm the socket survives an idle period (leave terminal open without interaction for ~2 minutes), then check that the tab remains connected in DevTools → Network → WS (`/api/ws/browser`). If the socket disconnects periodically, increase `maxIdleDuration`/`keepalive` accordingly and ensure the proxy uses the correct configuration file.

Test graceful shutdown manually:

```bash
docker compose -f docker-compose.prod.yml stop server
docker compose -f docker-compose.prod.yml logs server | tail -20
# Logs should show sockets closing with code 1001; container exits with 0 without SIGKILL.
```

---

## 4. Deploying the Web Frontend to Cloudflare Pages

The `apps/web` frontend is a Vue 3 SPA deployed as static assets to Cloudflare Pages. This is the only system component utilizing Cloudflare.

### 4.1 Configure Environment Variables

The web frontend communicates with the self-hosted backend via the `VITE_API_URL` environment variable.

1. Copy template:
   ```bash
   pnpm --filter @ponter/web exec cp .env.production.example .env.production
   ```
   (`.env.production` is gitignored to keep local configuration private)

2. Update `VITE_API_URL` with your self-hosted server URL:
   ```env
   VITE_API_URL=https://your-domain.com
   ```

### 4.2 Build and Deploy

```bash
# Build web application
pnpm --filter @ponter/web build

# Deploy to Cloudflare Pages
pnpm --filter @ponter/web exec wrangler deploy
```

### 4.3 Verify Web Deployment

1. Open `https://<your-pages-project>.pages.dev` in a browser
2. Register an account or log in
3. Test SPA reloading: navigate to `/dashboard` and press `F5`. The page must reload cleanly without 404 errors.
4. Open Developer Tools (`F12`) to verify network requests route to the backend server.

---

## 5. Environment Variables Reference

| Variable | Required | Default | Description |
|---|---|---|---|
| `PORT` | No | `8787` | Server listen port (inside container). |
| `DATABASE_PATH` | No | `/app/data/remote.db` | SQLite database file path. |
| `JWT_SECRET` | Yes | — | HMAC secret for access tokens. Minimum 32 characters. |
| `REFRESH_TOKEN_SECRET` | Yes | — | HMAC secret for refresh tokens. Minimum 32 characters. |
| `CORS_ORIGIN` | No | `*` | CORS allow-origin for API. **Explicitly set in production**: `*` permits all origins via CORS while also **disabling** WebSocket signaling Origin check (`/api/ws/browser` — CSWSH defense, see [Section 3.2](#32-browser-websocket-signaling-proxy--idle-timeouts)). |
| `JWT_EXPIRES_IN` | No | `900` (15m) | Access token TTL (seconds). |
| `REFRESH_TOKEN_EXPIRES_IN` | No | `604800` (7d) | Refresh token TTL (seconds). |
| `TURN_SECRET` | Prod only | — | Shared secret for Coturn long-term authentication. |
| `TURN_URL` | Prod only | `turn:${DOMAIN}:3478` | TURN URL advertised to clients. Override in `.env` to use IP instead of domain. |
| `STUN_URL` | Prod only | `stun:${DOMAIN}:3478` | STUN URL advertised to clients. Override in `.env` to use IP instead of domain. |
| `DOMAIN` | Prod only | — | Public domain for Caddy TLS and TURN realm. |
| `TURN_PROVIDER` | No | `coturn` | TURN provider: `coturn` \| `cloudflare` \| `none`. |
| `TURN_KEY_ID` | Cloudflare only | — | Cloudflare Calls TURN key ID. Required when `TURN_PROVIDER=cloudflare`. |
| `TURN_KEY_API_TOKEN` | Cloudflare only | — | Cloudflare TURN API token (Bearer). Required when `TURN_PROVIDER=cloudflare`. |
| `CLOUDFLARE_TUNNEL_TOKEN` | Tunnel only | — | Cloudflare Tunnel token. |
| `VITE_API_URL` | Web only | `http://localhost:8787` | API URL for web frontend. |
| `VITE_BROWSER_WS_SIGNALING` | Web only | `false` | Enable WebSocket signaling (`/api/ws/browser`) instead of REST polling. Build-time — rebuild to change. See [Section 3.2](#32-browser-websocket-signaling-proxy--idle-timeouts). |

---

## 6. Troubleshooting

### Issue: Container fails to start with "permission denied" on SQLite file

**Cause**: Volume mount permissions too restrictive or `data` directory does not exist.

**Solution**: Ensure the `data` directory exists with write permissions:
```bash
mkdir -p docker/data
chmod 755 docker/data
```

### Issue: CORS error when web app calls API

**Cause**: `CORS_ORIGIN` does not match the web app domain.

**Solution**: Update `CORS_ORIGIN` in `.env` to match your production domain:
```env
CORS_ORIGIN=https://your-app.pages.dev
```

### Issue: WebRTC connection fails in production

**Cause**: TURN server misconfigured or UDP firewall blocking ports.

**Solution**:
1. Ensure `TURN_SECRET` is set in `.env`
2. Open UDP port 3478 and UDP port range 49152-49200 on firewall
3. Verify ICE servers endpoint:
   ```bash
   curl -H "Authorization: Bearer <jwt>" https://your-domain.com/api/webrtc/ice-servers
   ```

### Issue: Agent cannot connect to WebSocket

**Cause**: Agent is connecting to the wrong URL or providing invalid credentials.

**Solution**:
1. Ensure agent connects to `ws://<host>:8787/api/ws/agent` (or `wss://` via tunnel/Caddy)
2. Verify agent credentials in database:
   ```bash
   sqlite3 data/remote.db "SELECT id, user_id FROM agents;"
   ```
3. Review server logs for authentication failures.

### Issue: Browser signaling socket (`/api/ws/browser`) keeps disconnecting

**Cause**: Intermediate proxy/tunnel drops idle connections based on default timeouts.

**Solution**: See [Section 3.2](#32-browser-websocket-signaling-proxy--idle-timeouts). Verify Caddy uses the `/api/ws/*` block with `keepalive 300s`, and Cloudflare Tunnel runs with `--config /etc/cloudflared/config.yml` (using `TUNNEL_TOKEN` alone ignores `maxIdleDuration`).

### Issue: GitHub Actions deploy fails with "This Worker does not exist"

**Cause**: Error applies only to legacy Cloudflare Workers backend. Under the self-hosted Docker architecture, the backend no longer deploys to Cloudflare Workers.

**Solution**: Deploy frontend to Cloudflare Pages and backend via Docker Compose. See [GitHub Actions workflow](../.github/workflows/deploy.yml) for CI/CD configuration.
