# Unified Docker Deployment (All-in-One Image) — Design Spec

- **Status:** Draft (ready for PM and owner review)
- **Phase:** Deployment Consolidation (All-in-One Container & Docker Compose Simplification)
- **Related ADRs:** ADR-83 (Unified Container Image), ADR-84 (Docker-Only Deployment)
- **Related Files:** `docker/Dockerfile`, `docker/nginx.web.conf`, `docker/supervisord.conf`, `docker/docker-compose.yml`, `docker/docker-compose.coturn.yml`, `docker/entrypoint.sh`, `apps/web/src/config.ts`, `apps/web/src/services/client.ts`, `apps/web/src/components/agent/RegisterAgentDialog.vue`, `apps/web/index.html`, `.dockerignore`, `.github/workflows/{docker-publish,ci-docker}.yml`, `package.json`, `apps/web/package.json`, `README.md`, `docs/ARCHITECTURE.md`, `docs/guides/{deployment,self-hosting}.md`.

---

## 1. Context & Motivation

Self-hosting Ponter currently requires navigating four distinct Docker Compose scenarios (`docker-compose.local.yml`, `docker-compose.prod.yml`, `docker-compose.nginx.yml`, `docker-compose.tunnel.yml`), maintaining a Caddyfile, provisioning Cloudflare Tunnels, and hosting the web frontend separately on Cloudflare Pages (via `apps/web/wrangler.toml` and `.github/workflows/deploy.yml`).

This fragmented topology introduces significant friction:
1. **Split-Brain Hosting:** The frontend static assets live on Cloudflare Pages, while the backend server runs in Docker on a VPS or homelab. Users must configure cross-origin resource sharing (CORS), manage separate domain names, and endure build-time API URL baking (`VITE_API_URL`).
2. **Configuration Proliferation:** Choosing among four compose files creates confusion regarding which scenario matches a user's network environment.
3. **External Cloudflare Infrastructure Dependency:** Deploying the web client requires Cloudflare account credentials (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`), which runs counter to the project's self-hosting philosophy.

**The Goal:** Unify the deployment into a single self-contained Docker image (`ngotuananh2101/ponter`) containing the Node.js backend server (`@ponter/server`), the compiled web frontend (`@ponter/web`), and an internal Nginx reverse proxy managed by Supervisord. The entire platform publishes exactly **one HTTP port** (default `8080`) and is driven by exactly **two compose files**:
- `docker-compose.yml`: Standard all-in-one deployment (Backend + Frontend + Nginx, STUN-only).
- `docker-compose.coturn.yml`: Complete self-hosted deployment with an integrated Coturn TURN relay service.

---

## 2. Locked Owner Decisions

The following architectural and operational decisions were approved by the project owner and are non-negotiable:

1. **One Unified Image on Docker Hub:** Published to `ngotuananh2101/ponter` (single repository and tag namespace). Contains `@ponter/server`, `@ponter/web` static assets, and Nginx.
2. **CI Builds from Compose:** The GitHub Actions release pipeline builds the image via `docker buildx bake -f docker/docker-compose.yml` (or direct compose build), never from a standalone, detached Dockerfile invocation.
3. **Exactly Two Compose Files:**
   - `docker/docker-compose.yml`: All-in-one service publishing one port (8080).
   - `docker/docker-compose.coturn.yml`: Standalone compose file containing the `ponter` service plus an integrated `coturn` service. Runs independently via `docker compose -f docker-compose.coturn.yml up`.
4. **Default Published Port = 8080:** The host port defaults to `8080` (overridable via environment variable, e.g. `PONTER_HTTP_PORT`).
5. **Supervisord Process Model:** Inside the container, processes are supervised by `supervisord` (installed via Alpine `apk add supervisor`). `s6-overlay` is explicitly rejected.
6. **Retain Cloudflare TURN Relay Provider:** `TURN_PROVIDER=cloudflare` is strictly preserved in server source code (`apps/server/src/utils/ice.ts`), unit tests (`test/ice-provider.test.ts`), and documentation. Only Cloudflare *hosting and infrastructure* (Pages, Tunnels, Caddy) are removed.
7. **Runtime Frontend Configuration:** The web frontend resolves its API endpoint dynamically at runtime via `window.__PONTER_CONFIG__.apiUrl`, falling back to same-origin (`window.location.origin`), eliminating build-time endpoint baking.

---

## 3. Architecture Decisions

### ADR-83: Unified All-in-One Container Image (BE + FE + Nginx under Supervisord)

- **Decision:** Consolidate the backend HTTP/WebSocket signaling server (`@ponter/server`) and the web client static SPA (`@ponter/web`) into a single multi-stage Docker image based on `node:24-alpine`. Inside the container, Nginx acts as the front door listening on port `8080`, serving frontend static files at `/` and proxying `/api/` (including WebSocket upgrade routes) to `@ponter/server` listening on internal loopback `127.0.0.1:8787`. Both processes run under `supervisord`.
- **Rationale:** Reduces operational overhead to zero for self-hosters. Eliminates CORS mismatches because frontend and backend share the exact same host and port. Prevents PID 1 zombie reaping issues and manages graceful multi-process termination.
- **Alternatives Rejected:**
  - *Separate Frontend Container:* Rejected — requires managing multiple containers, inter-container bridge networks, and port orchestration.
  - *Node-only Server Serving Static Files:* Rejected — Hono/Node static serving adds memory overhead, lacks robust caching/compression, and complicates SPA fallback routing compared to Nginx.
  - *s6-overlay:* Rejected by owner decision in favor of standard Alpine `supervisor`.

### ADR-84: Docker-Only Unified Deployment & Cloudflare Infra Retirement

- **Decision:** Eliminate Cloudflare Pages deployment workflows (`.github/workflows/deploy.yml`), Cloudflare Tunnel configurations (`docker/cloudflared/`), Caddy reverse proxy (`docker/Caddyfile`), and the legacy 4-compose matrix (`docker-compose.{local,prod,nginx,tunnel}.yml`). Standardize on `docker-compose.yml` and `docker-compose.coturn.yml`. Security headers formerly configured in `apps/web/public/_headers` are ported directly into `docker/nginx.web.conf`.
- **Rationale:** Simplifies maintenance and aligns with a zero-trust, privacy-first self-hosted model where users own the full software stack on their own hardware.
- **Alternatives Rejected:**
  - *Keep Cloudflare Pages as a secondary deployment option:* Rejected — dual deployment targets cause documentation drift, double CI maintenance, and necessitate complex environment handling.

---

## 4. The Unified Image Specification

### 4.1 Multi-Stage Dockerfile Layout (`docker/Dockerfile`)

The build uses `node:24-alpine` across three stages: `base`, `builder`, and `runner`.

```dockerfile
###############################################################################
# Stage 1: base — shared Node 24 runtime with Corepack & pnpm
###############################################################################
FROM node:24-alpine AS base

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
ENV NODE_ENV=production

RUN corepack enable

###############################################################################
# Stage 2: builder — compile @ponter/server and @ponter/web
###############################################################################
FROM base AS builder

WORKDIR /app

# Copy package manifests and workspace lockfiles
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/ ./packages/
COPY apps/server/ ./apps/server/
COPY apps/web/ ./apps/web/

# Install full dependencies (including devDependencies)
RUN pnpm install --frozen-lockfile

# Build backend server
RUN pnpm --filter @ponter/server build

# Build frontend SPA with browser WebSocket signaling flag enabled
ENV VITE_BROWSER_WS_SIGNALING=true
RUN pnpm --filter @ponter/web build

# Install production-only dependencies for backend runtime
RUN pnpm install --prod --frozen-lockfile

###############################################################################
# Stage 3: runner — production all-in-one runtime
###############################################################################
FROM base AS runner

WORKDIR /app

# Install Nginx, Supervisord, and privilege-drop helper su-exec
RUN apk add --no-cache nginx supervisor su-exec

# Copy backend dependencies and compiled code
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/apps/server/package.json ./apps/server/package.json
COPY --from=builder /app/apps/server/dist ./apps/server/dist

# Copy compiled frontend SPA to Nginx document root
COPY --from=builder /app/apps/web/dist /usr/share/nginx/html

# Copy Nginx, Supervisord, and Entrypoint configurations
COPY docker/nginx.web.conf /etc/nginx/http.d/default.conf
COPY docker/supervisord.conf /etc/supervisord.conf
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Ensure required run directories and data volume exist
RUN mkdir -p /app/data /run/nginx /var/log/supervisor && \
    chown -R node:node /app/data

VOLUME /app/data

# Default environment configuration
ENV DATABASE_PATH=/app/data/remote.db
ENV PORT=8787
ENV HOST=127.0.0.1
ENV PONTER_HTTP_PORT=8080

EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["supervisord", "-c", "/etc/supervisord.conf"]
```

### 4.2 Nginx Web & Reverse Proxy Configuration (`docker/nginx.web.conf`)

Nginx listens on port `8080`, serves SPA assets with client-side history routing fallback, preserves all security headers formerly in `apps/web/public/_headers`, sets no-cache directives on runtime config, and proxies API / WebSocket calls to `127.0.0.1:8787`.

```nginx
# Connection upgrade map for WebSocket support
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 8080 default_server;
    listen [::]:8080 default_server;
    server_name _;

    root /usr/share/nginx/html;
    index index.html;

    client_max_body_size 50M;

    # Security headers (ported from apps/web/public/_headers)
    add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' https: wss:; media-src 'self' blob:; font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;

    # Runtime frontend configuration script (generated by entrypoint)
    location = /config.js {
        add_header Cache-Control "no-store, no-cache, must-revalidate" always;
        add_header Content-Type "application/javascript" always;
    }

    # Direct health-check proxy for container readiness probes
    location = /health {
        proxy_pass http://127.0.0.1:8787/health;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # API endpoints and WebSocket signaling proxy
    location /api/ {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;

        # WebSocket headers (critical for /api/ws/agent and /api/ws/browser)
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;

        # Standard reverse-proxy headers
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Keep alive settings for long-lived WebSockets
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
        proxy_connect_timeout 60s;

        # Disable buffering for real-time WebRTC signaling
        proxy_buffering off;
    }

    # SPA history mode fallback
    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

### 4.3 Supervisord Configuration (`docker/supervisord.conf`)

Runs in foreground (`nodaemon=true`), piping logs directly to stdout/stderr. Manages unprivileged execution for `@ponter/server` via `su-exec node`.

```ini
[supervisord]
nodaemon=true
user=root
logfile=/var/log/supervisor/supervisord.log
logfile_maxbytes=0
pidfile=/var/run/supervisord.pid

[program:server]
command=su-exec node node apps/server/dist/index.js
directory=/app
autostart=true
autorestart=true
stdout_logfile=/dev/stdout
stdout_logfile_maxbytes=0
stderr_logfile=/dev/stderr
stderr_logfile_maxbytes=0
stopsignal=TERM
stopwaitsecs=15

[program:nginx]
command=nginx -g "daemon off;"
autostart=true
autorestart=true
stdout_logfile=/dev/stdout
stdout_logfile_maxbytes=0
stderr_logfile=/dev/stderr
stderr_logfile_maxbytes=0
stopsignal=TERM
stopwaitsecs=5
```

### 4.4 Container Entrypoint (`docker/entrypoint.sh`)

Extended from the existing `docker/entrypoint.sh` to perform three tasks:
1. Fix host bind-mount directory permissions for SQLite (`/app/data`).
2. Generate runtime frontend configuration `/usr/share/nginx/html/config.js` from `PONTER_API_URL`.
3. Exec supervisord (or user-supplied command).

```bash
#!/bin/sh
set -e

DATA_DIR="$(dirname "${DATABASE_PATH:-/app/data/remote.db}")"

# Fix database directory ownership if running as root
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  chown -R node:node "$DATA_DIR"
fi

# Render runtime frontend configuration
CONFIG_FILE="/usr/share/nginx/html/config.js"
mkdir -p "$(dirname "$CONFIG_FILE")"

cat <<EOF > "$CONFIG_FILE"
// Runtime configuration injected by container entrypoint
window.__PONTER_CONFIG__ = {
  apiUrl: "${PONTER_API_URL:-}"
};
EOF

exec "$@"
```

---

## 5. Runtime Frontend Configuration

### 5.1 Runtime Resolution Model

Today, `@ponter/web` hardcodes its backend URL at build time:
`const baseUrl = import.meta.env.VITE_API_URL || 'http://localhost:8787';`

Under the unified deployment, the frontend is compiled once into the Docker image. Because self-hosters deploy across arbitrary domains, hostnames, and ports, baking `VITE_API_URL` at build time is obsolete.

We introduce `apps/web/src/config.ts`:

```typescript
declare global {
  interface Window {
    __PONTER_CONFIG__?: {
      apiUrl?: string;
    };
  }
}

/**
 * Resolve the API base URL following runtime precedence:
 * 1. Runtime injection via window.__PONTER_CONFIG__.apiUrl (if non-empty)
 * 2. Build-time Vite environment variable VITE_API_URL (if provided)
 * 3. Browser origin window.location.origin (default for same-origin all-in-one container)
 */
export function getApiBaseUrl(): string {
  if (typeof window !== 'undefined') {
    const runtimeApiUrl = window.__PONTER_CONFIG__?.apiUrl?.trim();
    if (runtimeApiUrl && runtimeApiUrl.length > 0) {
      return runtimeApiUrl;
    }
  }

  const buildApiUrl = import.meta.env.VITE_API_URL?.trim();
  if (buildApiUrl && buildApiUrl.length > 0) {
    return buildApiUrl;
  }

  if (typeof window !== 'undefined' && window.location?.origin) {
    return window.location.origin;
  }

  return 'http://localhost:8787';
}
```

### 5.2 Integration Points

1. **`apps/web/index.html`:** Add `<script src="/config.js"></script>` in `<head>` prior to the main script module. If `/config.js` is absent (such as in local `vite dev`), the browser silently logs a 404 and `window.__PONTER_CONFIG__` remains undefined.
2. **`apps/web/src/services/client.ts`:**
   ```typescript
   import { ApiClient } from '@ponter/api-client';
   import { tokenStorage } from './token-storage';
   import { getApiBaseUrl } from '../config';

   export const apiClient = new ApiClient({
     baseUrl: getApiBaseUrl(),
     storage: tokenStorage,
   });
   ```
3. **`apps/web/src/components/agent/RegisterAgentDialog.vue`:**
   ```typescript
   import { getApiBaseUrl } from '@/config';

   const signalingServerUrl = computed(() => {
     const apiUrl = getApiBaseUrl();
     const wsUrl = apiUrl.replace(/^http/, 'ws');
     return `${wsUrl}/api/ws/agent`;
   });
   ```

---

## 6. The Two Compose Files (Exact Specification)

### 6.1 `docker/docker-compose.yml` (Standard Unified Deployment)

Used for all standard deployments. Contains build instructions as well as prebuilt image reference:

```yaml
# Standard self-hosted compose setup for Ponter.
#
# Runs the all-in-one container containing:
#   - @ponter/server (Node.js 24 signaling & REST backend on internal 127.0.0.1:8787)
#   - @ponter/web (Vue 3 static SPA)
#   - Nginx (reverse proxy & static server publishing port 8080)
#
# Usage:
#   cd docker
#   cp .env.example .env
#   docker compose pull && docker compose up -d
#
# Build from source:
#   docker compose up -d --build
#
services:
  ponter:
    build:
      context: ..
      dockerfile: docker/Dockerfile
    image: ${DOCKERHUB_IMAGE:-ngotuananh2101/ponter}:latest
    container_name: ponter
    restart: unless-stopped
    stop_grace_period: 15s
    ports:
      - "${PONTER_HTTP_PORT:-8080}:8080"
    environment:
      - PORT=8787
      - DATABASE_PATH=/app/data/remote.db
      - JWT_SECRET=${JWT_SECRET:?JWT_SECRET must be set}
      - REFRESH_TOKEN_SECRET=${REFRESH_TOKEN_SECRET:?REFRESH_TOKEN_SECRET must be set}
      - CORS_ORIGIN=${CORS_ORIGIN:-http://localhost:8080}
      - PONTER_API_URL=${PONTER_API_URL:-}
    volumes:
      - ./data:/app/data
```

### 6.2 `docker/docker-compose.coturn.yml` (Self-Hosted TURN Relay Deployment)

Self-contained standalone compose file including both `ponter` and `coturn`. Can be run directly via `docker compose -f docker-compose.coturn.yml up -d`:

```yaml
# Production compose setup with integrated Coturn TURN server.
#
# Runs the all-in-one Ponter container alongside Coturn for peer relaying
# across symmetric NAT environments.
#
# Usage:
#   cd docker
#   cp .env.example .env
#   # configure TURN_SECRET and DOMAIN in .env
#   docker compose -f docker-compose.coturn.yml pull
#   docker compose -f docker-compose.coturn.yml up -d
#
services:
  ponter:
    build:
      context: ..
      dockerfile: docker/Dockerfile
    image: ${DOCKERHUB_IMAGE:-ngotuananh2101/ponter}:latest
    container_name: ponter
    restart: unless-stopped
    stop_grace_period: 15s
    ports:
      - "${PONTER_HTTP_PORT:-8080}:8080"
    environment:
      - PORT=8787
      - DATABASE_PATH=/app/data/remote.db
      - JWT_SECRET=${JWT_SECRET:?JWT_SECRET must be set}
      - REFRESH_TOKEN_SECRET=${REFRESH_TOKEN_SECRET:?REFRESH_TOKEN_SECRET must be set}
      - CORS_ORIGIN=${CORS_ORIGIN:-http://localhost:8080}
      - PONTER_API_URL=${PONTER_API_URL:-}
      - TURN_SECRET=${TURN_SECRET:?TURN_SECRET must be set for Coturn deployment}
      - TURN_URL=${TURN_URL:-turn:${DOMAIN}:3478}
      - STUN_URL=${STUN_URL:-stun:${DOMAIN}:3478}
      - TURN_PROVIDER=coturn
    volumes:
      - ./data:/app/data

  coturn:
    image: coturn/coturn:4.6.3@sha256:71c3c990283385567f11794ee692e3a47b66fd9b0bb39e42afbe776e331dd888
    container_name: ponter-coturn
    restart: unless-stopped
    network_mode: host
    command:
      - '-n'
      - '--log-file=stdout'
      - '--lt-cred-mech'
      - '--use-auth-secret'
      - '--static-auth-secret=${TURN_SECRET}'
      - '--realm=${DOMAIN}'
      - '--min-port=49152'
      - '--max-port=49200'
```

---

## 7. CI & Automation Updates

### 7.1 `.github/workflows/docker-publish.yml`

Reworked to build via `docker buildx bake -f docker/docker-compose.yml` (multi-arch `linux/amd64` and `linux/arm64`):
1. **Trigger:** Manual `workflow_dispatch` (optional custom `tag` parameter).
2. **Matrix:** Multi-arch via native runners (`ubuntu-latest` for amd64, `ubuntu-24.04-arm` for arm64).
3. **Bake Execution:** Uses buildx bake target derived from `docker/docker-compose.yml`.
4. **Digest Assembly & Tags:** Merge job combines platform digests, pushing `latest`, short SHA (`sha-*`), and optional custom tag.
5. **Pruning:** Retains `docker/prune-tags.sh` execution to keep the 3 newest `sha-*` tags.
6. **Deployment Webhook:** Dispatches `docker/trigger-webhook.sh` if `DEPLOY_BE_WEBHOOK` secret is configured.

### 7.2 `.github/workflows/ci-docker.yml`

Updated to test the unified container:
1. **Path Triggers:** Runs on changes to `docker/**`, `apps/server/**`, `apps/web/**`, `packages/**`, workspace manifests, and `.github/workflows/ci-docker.yml`.
2. **Build Step:** Builds `ponter:ci` from `docker/Dockerfile`.
3. **Smoke Verification Matrix:**
   - Boots container with mapped port `8080:8080`.
   - Polling check `GET http://localhost:8080/health` -> HTTP 200 `{"status":"ok"}`.
   - Frontend verification `GET http://localhost:8080/` -> HTTP 200, contains `<div id="app"></div>`.
   - Runtime config verification `GET http://localhost:8080/config.js` -> HTTP 200, content contains `window.__PONTER_CONFIG__`.
   - Proxy verification `GET http://localhost:8080/api/auth/me` -> HTTP 401 Unauthorized (confirms reverse proxy successfully routes to backend without bypass).

---

## 8. Deletions, Retentions & File Inventory

### 8.1 Files to Delete (Cloudflare Infra & Legacy Compose)

1. `docker/Caddyfile`
2. `docker/cloudflared/config.yml` (and directory `docker/cloudflared/`)
3. `docker/docker-compose.local.yml`
4. `docker/docker-compose.prod.yml`
5. `docker/docker-compose.nginx.yml`
6. `docker/docker-compose.tunnel.yml`
7. `docker/nginx.conf.example`
8. `apps/web/public/_headers` (security headers ported to `nginx.web.conf`)
9. `apps/web/wrangler.toml`
10. `.github/workflows/deploy.yml`

### 8.2 Files to Modify

1. `package.json`: Remove root script `"deploy:web": "pnpm --filter @ponter/web deploy"`.
2. `apps/web/package.json`: Remove `"deploy"` script and devDependency `"wrangler": "^4.145.0"`.
3. `pnpm-lock.yaml`: Prune wrangler from the lockfile via `pnpm install`.
4. `.dockerignore`: Remove line 59 (`apps/web/`) so `apps/web` is included in the build context.
5. `apps/web/index.html`: Inject `<script src="/config.js"></script>` in `<head>`.
6. `apps/web/src/services/client.ts`: Route `baseUrl` through `getApiBaseUrl()`.
7. `apps/web/src/components/agent/RegisterAgentDialog.vue`: Route `signalingServerUrl` through `getApiBaseUrl()`.
8. `.github/workflows/docker-publish.yml`: Update build instructions to bake from compose.
9. `.github/workflows/ci-docker.yml`: Update path filters and smoke tests for port 8080.
10. `docker/.env.example`: Update environment variables for the two compose files.
11. `docker/README.md`: Rewrite around the two compose files.
12. `docs/guides/deployment.md`: Rewrite deployment instructions; retain Cloudflare TURN provider table; remove Cloudflare Pages/Tunnel instructions.
13. `docs/guides/self-hosting.md`: Rewrite self-hosting guide for the unified image.
14. `docs/README.md` & `README.md`: Update architectural diagrams and deployment documentation.
15. `docs/ARCHITECTURE.md`: Record ADR-83 and ADR-84, update §8 trail.

### 8.3 Files to Create

1. `docker/Dockerfile`: Multi-stage all-in-one container build.
2. `docker/nginx.web.conf`: Unified Nginx site configuration.
3. `docker/supervisord.conf`: Multi-process supervisor configuration.
4. `docker/docker-compose.yml`: Standard all-in-one compose file.
5. `docker/docker-compose.coturn.yml`: Coturn-integrated compose file.
6. `apps/web/src/config.ts`: Runtime frontend configuration module.

### 8.4 Explicit Retentions (Do NOT Delete)

1. `docker/Dockerfile.server`: Kept as a reference or standalone server option.
2. `docker/entrypoint.sh`: Kept and extended to render `/config.js`.
3. `docker/prune-tags.sh`, `docker/prune-step.test.sh`, `docker/prune-tags.test.sh`: Kept for Docker Hub tag pruning.
4. `docker/trigger-webhook.sh`: Kept for deployment webhooks.
5. `docker/DOCKERHUB.md`: Kept for Docker Hub repository description.
6. `apps/server/src/utils/ice.ts`: **STRICTLY KEPT.** Cloudflare Calls TURN integration remains fully functional.
7. `test/ice-provider.test.ts`: **STRICTLY KEPT.** Unit tests for Cloudflare TURN provider remain active.

---

## 9. Consequences & Trade-offs

1. **Symmetric NAT Handling:** Running the standard `docker-compose.yml` relies purely on public STUN servers (e.g. Google STUN). In environments where both client and agent sit behind restrictive or symmetric NAT, direct peer-to-peer WebRTC connections will fail without a TURN relay. Deployers requiring guaranteed connectivity across strict firewalls must use `docker-compose.coturn.yml` or configure `TURN_PROVIDER=cloudflare`.
2. **Default Host Binding (`0.0.0.0:8080`):** Mapping `8080:8080` binds to all host interfaces by default, making the web UI reachable on the local network. Users fronting Ponter with an existing host reverse proxy (such as external Traefik or Nginx with Let's Encrypt) should bind explicitly to localhost (`127.0.0.1:8080:8080`) in `.env` via `PONTER_HTTP_PORT=127.0.0.1:8080`.
3. **Container Image Footprint:** Including Nginx, Supervisord, and frontend static assets increases the uncompressed image size from ~380MB (server-only) to ~450MB. This slight increase is easily justified by eliminating an entire external hosting platform and third-party SaaS dependency.
4. **Process Lifecycle Semantics:** Supervisord manages `@ponter/server` and `nginx`. If the Node.js server crashes, Supervisord automatically restarts it (`autorestart=true`). If the container receives `SIGTERM`, Supervisord gracefully signals `@ponter/server` with 15 seconds grace period, allowing WebSockets to close cleanly with status 1001.

---

## 10. Verification & Testing Strategy

A full quality assurance cycle must verify the following items:

1. **Image Build Verification:** `docker buildx bake -f docker/docker-compose.yml` builds without errors on Linux `amd64` and `arm64`.
2. **Container Boot & Supervision:** Running `docker compose up -d` launches Supervisord, which in turn boots both `@ponter/server` and `nginx`.
3. **Health Check Endpoint:** `curl -fsS http://localhost:8080/health` returns HTTP 200 with JSON `{"status":"ok"}`.
4. **SPA Asset Serving:** `curl -fsS http://localhost:8080/` returns HTTP 200 containing HTML with `<div id="app"></div>`. Subpaths like `http://localhost:8080/devices` return `index.html` via `try_files` fallback.
5. **Runtime Configuration Injection:** `curl -fsS http://localhost:8080/config.js` returns JavaScript assigning `window.__PONTER_CONFIG__`. Setting `PONTER_API_URL=https://my-domain.com` in container environment properly populates `apiUrl: "https://my-domain.com"`.
6. **API Proxying:** `curl -fsS http://localhost:8080/api/auth/me` returns HTTP 401 Unauthorized from the Node.js backend.
7. **WebSocket Upgrade Flow:** Connecting a WebSocket client to `ws://localhost:8080/api/ws/agent` and `ws://localhost:8080/api/ws/browser` successfully initiates handshakes and maintains persistent connections without idle disconnects.
8. **Data Persistence Invariant:** SQLite data created at `/app/data/remote.db` persists across container destruction and recreate (`docker compose down && docker compose up -d`).
9. **Coturn Deployment Variant:** `docker compose -f docker-compose.coturn.yml up -d` brings up both `ponter` and `coturn` services cleanly on the host network.
10. **CI Validation:** Both `.github/workflows/ci-docker.yml` and repository linting/formatting pass with zero errors.
