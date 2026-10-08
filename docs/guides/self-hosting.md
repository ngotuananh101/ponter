# Self-Hosting & Fork Guide

Ponter is MIT-licensed. You can fork it, build it from source, and run your own
instance. This guide covers the three author-specific defaults a fork has to
decide about. Building the four apps is covered in
[`development.md` §7](development.md#7-building-release-artifacts-from-source).

> **The official repo's identity stays as-is.** Badges, links, the published
> Docker Hub image, and the desktop updater key belong to the upstream author.
> A fork overrides them in its own copy; upstream does not remove them.

## 1. Desktop auto-update (ADR-61)

A self-built desktop app inherits the upstream updater `pubkey` and `endpoints`
compiled into `apps/desktop/src-tauri/tauri.conf.json`. That means an
unmodified self-build would poll the **upstream** release channel and reject
any binary not signed by the upstream key. Pick one of two paths.

### Path A — disable auto-update (recommended, no signing key)

Edit your fork's `apps/desktop/src-tauri/tauri.conf.json` and **remove the
`plugins.updater` block** (or set it to an empty object):

```jsonc
"plugins": {
  // "updater": { "pubkey": "...", "endpoints": ["..."], "requireSignedVersion": true }
}
```

Build normally (`pnpm --filter @ponter/desktop tauri build`). No signing key is
required and the app never checks for updates.

### Path B — repoint to your own update channel (optional)

If you publish your own signed releases, point the app at your manifest and
public key. Tauri v2 does **not** interpolate environment variables inside
`tauri.conf.json`, so use a build-time config overlay — `apps/desktop/scripts/build-self.sh`
does this for you:

```bash
export PONTER_UPDATE_ENDPOINT="https://github.com/<you>/<fork>/releases/latest/download/latest.json"
export PONTER_UPDATE_PUBKEY="$(cat ~/.tauri/my-updater.key.pub)"
bash apps/desktop/scripts/build-self.sh
```

The script merges the overlay over the committed config; the committed
`tauri.conf.json` is untouched. You are responsible for signing your own
release artifacts with your own key.

## 2. Docker image (self-publish)

The shipped Compose files pull the upstream image
(`ngotuananh2101/ponter`) via `DOCKERHUB_IMAGE`. To run your own:

```bash
docker build -f docker/Dockerfile.server -t <your-namespace>/ponter:dev .
```

Then, in `docker/.env`, set `DOCKERHUB_IMAGE=<your-namespace>/ponter:dev` and
`docker compose -f docker-compose.prod.yml up -d`. To publish a registry image
yourself, tag and push it:

```bash
docker tag <your-namespace>/ponter:dev <your-namespace>/ponter:latest
docker push <your-namespace>/ponter:latest
```

Upstream's `.github/workflows/docker-publish.yml` is wired to the upstream
Docker Hub secrets; a fork either adds its own secrets or pushes manually.

## 3. Server / API URL

The web client compiles its API URL at build time. Set `VITE_API_URL` (and
`VITE_BROWSER_WS_SIGNALING=true` if you use WebSocket signaling) before
`pnpm --filter @ponter/web build`, and set `CORS_ORIGIN` on the server to the
exact origin that serves the built web app.

### 3.1 Desktop app default server (build-time)

The desktop client resolves its server URL in this order: the runtime
`PONTER_SERVER_URL` environment variable, then the user's saved value in the
app config file, then a **build-time default** compiled from
`PONTER_DEFAULT_SERVER_URL`, then `http://localhost:8787`.

To bake your server into an installer, set the repository variable
`PONTER_DEFAULT_SERVER_URL` before building (Settings → Secrets and variables →
Actions → Variables):

```text
PONTER_DEFAULT_SERVER_URL = https://ponter.example.com
```

The CI workflow passes it into `tauri build`; when unset it is a no-op and the
app falls back to the user's saved value or localhost. A source build can set
it directly:

```bash
PONTER_DEFAULT_SERVER_URL=https://ponter.example.com \
  pnpm --filter @ponter/desktop tauri build
```

End users can still change the server from the app's first screen (or via
"Change" on the login screen); their choice persists in the app config
directory.
