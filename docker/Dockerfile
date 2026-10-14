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
COPY --from=builder /app/apps/server/node_modules ./apps/server/node_modules
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
ENV PONTER_HTTP_PORT=80

EXPOSE 80

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["supervisord", "-c", "/etc/supervisord.conf"]
