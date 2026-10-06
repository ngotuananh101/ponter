# Docker Packaging

This directory contains the multi-stage Dockerfile and four Docker Compose setups for running the `@ponter/server` self-hosted backend.

The server image is built and published to Docker Hub by CI (`.github/workflows/docker-publish.yml`), so the three deployment setups below pull a prebuilt image instead of compiling on the host. See [Deploying a new version](#deploying-a-new-version) for the workflow.

## Files

| File                        | Description                                                                                                                                        |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Dockerfile.server`         | Multi-stage build: `node:24-alpine` base → builder (full deps + native toolchain) → runner (production deps only, better-sqlite3 native bindings). |
| `docker-compose.local.yml`  | Local LAN testing. **Builds from source.** No TURN, Google public STUN only.                                                                       |
| `docker-compose.tunnel.yml` | Homelab behind a Cloudflare Tunnel. Pulls the published image. Public exposure via `cloudflared`.                                                  |
| `docker-compose.prod.yml`   | Production VPS. Pulls the published image. Caddy (Let's Encrypt) + Coturn (TURN/STUN) alongside the server.                                        |
| `docker-compose.nginx.yml`  | Production VPS with host Nginx. Pulls the published image. Binds `127.0.0.1:8787` + Coturn; host Nginx handles TLS & WebSocket proxying.           |
| `nginx.conf.example`        | Sample Nginx configuration for reverse proxy with WebSocket upgrade support and SSL.                                                               |
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
   docker compose -f docker-compose.tunnel.yml pull
   docker compose -f docker-compose.tunnel.yml up -d
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
   docker compose -f docker-compose.prod.yml pull
   docker compose -f docker-compose.prod.yml up -d
   ```

Caddy will automatically request Let's Encrypt certificates for `DOMAIN`. The Coturn server uses `TURN_SECRET` as its RFC 5766 shared secret; the server's `GET /api/webrtc/ice-servers` endpoint mints time-limited HMAC-SHA1 TURN credentials on demand.

### 4. Production (VPS with Existing Nginx + Coturn)

When your VPS already has Nginx running on ports 80/443:

1. Configure `.env`:
   ```bash
   cd docker
   cp .env.example .env
   # Edit .env: set JWT_SECRET, REFRESH_TOKEN_SECRET, DOMAIN, TURN_SECRET, CORS_ORIGIN
   ```
2. Start the backend and Coturn:
   ```bash
   docker compose -f docker-compose.nginx.yml pull
   docker compose -f docker-compose.nginx.yml up -d
   ```
   The server container binds only to `127.0.0.1:8787`.
3. Configure Nginx on the host using `docker/nginx.conf.example` as a template:
   - Ensure WebSocket upgrade headers are passed (`proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection $connection_upgrade;`).
   - Increase `proxy_read_timeout` to `86400s` to avoid idle WebSocket disconnects.
   - Reload Nginx: `sudo nginx -t && sudo systemctl reload nginx`.
4. Ensure VPS firewall opens Coturn ports:
   - `3478` (TCP/UDP)
   - `49152:49200` (UDP)

## Environment Variables

| Variable                   | Required    | Default                 | Description                                                                                        |
| -------------------------- | ----------- | ----------------------- | -------------------------------------------------------------------------------------------------- |
| `PORT`                     | No          | `8787`                  | Server listen port (inside container).                                                             |
| `DATABASE_PATH`            | No          | `/app/data/remote.db`   | SQLite database file.                                                                              |
| `JWT_SECRET`               | Yes         | —                       | HS256 secret for access tokens. Min 32 chars.                                                      |
| `REFRESH_TOKEN_SECRET`     | Yes         | —                       | HS256 secret for refresh tokens. Min 32 chars.                                                     |
| `CORS_ORIGIN`              | No          | `*`                     | CORS allow-origin for the API.                                                                     |
| `JWT_EXPIRES_IN`           | No          | `900` (15m)             | Access token TTL.                                                                                  |
| `REFRESH_TOKEN_EXPIRES_IN` | No          | `604800` (7d)           | Refresh token TTL.                                                                                 |
| `TURN_SECRET`              | Prod only   | —                       | Shared secret for Coturn long-term auth.                                                           |
| `TURN_URL`                 | Prod only   | `turn:${DOMAIN}:3478`   | TURN URL advertised to clients. Override in `.env` to use an IP instead of the domain.             |
| `STUN_URL`                 | Prod only   | `stun:${DOMAIN}:3478`   | STUN URL advertised to clients. Override in `.env` to use an IP instead of the domain.             |
| `DOMAIN`                   | Prod only   | —                       | Your public domain for Caddy TLS + TURN realm.                                                     |
| `CLOUDFLARE_TUNNEL_TOKEN`  | Tunnel only | —                       | Cloudflare Tunnel token.                                                                           |
| `DOCKERHUB_IMAGE`          | Deploy only | `ngotuananh2101/ponter` | Image to pull, e.g. `ngotuananh2101/ponter`. Not used by `docker-compose.local.yml`, which builds. |

## Building Locally

You can also build the image directly without Compose:

```bash
docker build -f docker/Dockerfile.server -t ponter-server:test .
```

Podman is also supported:

```bash
podman build -f docker/Dockerfile.server -t ponter-server:test .
```

## Deploying a new version

The three deployment setups (tunnel / prod / nginx) pull the published image instead of building it. `docker-compose.local.yml` is the exception — it builds from source so local development reflects uncommitted edits.

**0. Point the deployment at your image.** The Docker Hub account is not the same identifier as the GitHub one, so the namespace comes from the `DOCKERHUB_USERNAME` secret the workflow reads, while Compose reads `DOCKERHUB_IMAGE` from `docker/.env`. The shipped default already points at the published repository; override it only when publishing under a different namespace:

```bash
cd docker
# in .env (created from .env.example):
DOCKERHUB_IMAGE=ngotuananh2101/ponter
```

**1. Publish the image.** In GitHub, go to Actions → _Docker Publish_ → _Run workflow_. Pick the branch to build from.

Optionally, set the **tag** input to also attach a named tag (e.g. `v1.2.3`) to the published manifest; leaving it empty keeps `latest`/`sha` only.

The workflow builds `linux/amd64` and `linux/arm64` on separate native runners and merges them into one multi-arch manifest, so the same image works on an x86 VPS and an ARM machine (Oracle Cloud, Ampere, Raspberry Pi) without QEMU emulation.

The image is pushed as `<your-dockerhub-username>/ponter` (currently `ngotuananh2101/ponter`). Create that repository on Docker Hub first — pushes to a name that does not exist are rejected rather than auto-created.

| Tag                                          | When it moves                                  | Use                                                          |
| -------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------ |
| `<your-dockerhub-username>/ponter:latest`    | Only for runs on `main`                        | What the compose files point at.                             |
| `<your-dockerhub-username>/ponter:sha-<sha>` | Every run; **only the 3 most recent are kept** | Pinning a specific build, or rolling back to an earlier one. |
| `<your-dockerhub-username>/ponter:<tag>`     | When the `tag` input is supplied (persists)    | A durable, human-readable tag (e.g. `v1.2.3`).               |

A run from a feature branch publishes only the `sha-` tag, so experimenting cannot move the image production resolves. Each tag-less publish (no `tag` input) prunes older `sha-` tags, keeping only the three most recent.

**2. Pull and restart on the host:**

```bash
cd docker
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
```

**3. Verify:**

```bash
curl https://<your-domain>/health
# Expected: {"status":"ok"}
```

**Rolling back.** Because `latest` moves, a bad release is undone by pinning the previous `sha-` tag in the compose file and re-running `pull && up -d`. **Only the three most recent `sha-` tags are retained** — each tag-less publish prunes older ones, so pin a `sha-` tag only within that window, or pass an explicit `tag` input for a durable name.

**Repository secrets.** The workflow needs `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` (a Docker Hub **access token** from Account Settings → Personal Access Tokens with Read/Write **and Delete** — not the account password). The publish workflow prunes old `sha-` tags through the Docker Hub API, so a token without Delete scope fails the prune step (the image is still published). The native ARM runner is only free for public repositories; this one is public, so it costs nothing.

## Smoke Test

After starting the container, verify it is ready:

```bash
curl http://localhost:8787/health
# Expected: {"status":"ok"}
```
