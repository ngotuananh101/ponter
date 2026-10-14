# Self-Hosting & Fork Guide

Ponter is MIT-licensed. You can fork it, build it from source, and run your own
instance. This guide covers the three author-specific defaults a fork has to
decide about. Building the four apps is covered in
[`development.md` §7](development.md#7-building-release-artifacts-from-source).

> **The official repo's identity stays as-is.** Badges, links, the published
> Docker Hub image, and the desktop updater key belong to the upstream author.
> A fork overrides them in its own copy; upstream does not remove them.

## 1. Desktop auto-update (ADR-61, ADR-80)

A self-built desktop app inherits the upstream updater `UPDATER_PUBKEY_B64` and
`UPDATE_ENDPOINT` compiled into `apps/desktop/src/core/updater.rs` (ADR-80). That
means an unmodified self-build polls the **upstream** release channel and
rejects any binary not signed by the upstream minisign key. Pick one of two paths.

### Path A — disable auto-update (recommended, no signing key)

To disable update checks in your self-build, simply do not invoke the updater
check, or point `UPDATE_ENDPOINT` in `apps/desktop/src/core/updater.rs` to an
empty or non-existent endpoint.

Build normally:

```bash
cargo build --release --manifest-path apps/desktop/Cargo.toml
```

No signing key is required and the app functions normally without auto-update.

### Path B — repoint to your own update channel (optional)

If you publish your own signed releases, point the app at your manifest and
minisign public key by updating `apps/desktop/src/core/updater.rs`:

- Set `UPDATE_ENDPOINT` to your release manifest URL (e.g. `https://github.com/<you>/<fork>/releases/latest/download/latest.json`).
- Set `UPDATER_PUBKEY_B64` to your base64-encoded minisign public key.

Build and package your release:

```bash
cargo build --release --manifest-path apps/desktop/Cargo.toml
```

You are responsible for signing your own release artifacts with minisign matching
your configured public key.

## 2. Docker image (self-publish)

The shipped Compose files pull the upstream image
(`ngotuananh2101/ponter`) via `DOCKERHUB_IMAGE`. To run your own:

```bash
docker build -f docker/Dockerfile -t <your-namespace>/ponter:dev .
```

Then, in `docker/.env`, set `DOCKERHUB_IMAGE=<your-namespace>/ponter:dev` and
`docker compose up -d` (or `docker compose -f docker-compose.coturn.yml up -d`). To publish a registry image
yourself, tag and push it:

```bash
docker tag <your-namespace>/ponter:dev <your-namespace>/ponter:latest
docker push <your-namespace>/ponter:latest
```

Upstream's `.github/workflows/docker-publish.yml` is wired to the upstream
Docker Hub secrets; a fork either adds its own secrets or pushes manually.

## 3. Server / API URL

Under the unified deployment, the web client determines its backend API URL dynamically at runtime via `/config.js` (`window.__PONTER_CONFIG__.apiUrl`), falling back to same-origin (`window.location.origin`). Setting `PONTER_API_URL` in `docker/.env` is only required if the frontend is accessed through a different origin or proxy than the backend.

During local development with the Vite dev server, `apps/web` falls back to `VITE_API_URL` (default `http://localhost:8787`). Set `CORS_ORIGIN` in `docker/.env` to include the browser origins that access the web client.

### 3.1 Desktop app default server (build-time)

The desktop client resolves its server URL in this order: the runtime
`PONTER_SERVER_URL` environment variable, then the user's saved value in the
app config file, then a **build-time default** compiled from
`PONTER_DEFAULT_SERVER_URL`, then `http://localhost:8787`.

The build-time default is compiled in with
`option_env!("PONTER_DEFAULT_SERVER_URL")` (ADR-67), so the variable must be
present in the environment of the `cargo build` that produces the binary.
When unset it is a no-op and the app falls back to the user's saved value or
`http://localhost:8787`.

The CI source for this value is the repository variable
`PONTER_DEFAULT_SERVER_URL` (Settings → Secrets and variables → Actions →
Variables):

```text
PONTER_DEFAULT_SERVER_URL = https://ponter.example.com
```

The CI workflow (`.github/workflows/build-desktop.yml`) reads that variable and
exposes it as `PONTER_DEFAULT_SERVER_URL` at **job-level `env`** of the `build`
job, so every compile step — the `Build` step (`cargo build --release --locked`)
and the `Test` step alike — runs with it present. This placement matters: the
installers are packaged from the already-built binary (`cargo deb --no-build` /
`cargo generate-rpm` / `scripts/make-appimage.sh`), so the default is baked in at
the `Build` step, not at test time. A source build sets it inline on the build
command itself:

```bash
PONTER_DEFAULT_SERVER_URL=https://ponter.example.com \
  cargo build --release --manifest-path apps/desktop/Cargo.toml
```

End users can still change the server from the app's first screen (or via
"Change" on the login screen); their choice persists in the app config
directory, in a `config.json` file:

- Linux: `~/.config/com.ponter.desktop/config.json`
- Windows: `%APPDATA%\com.ponter.desktop\config.json`

This file holds non-secret preferences only — the server URL, the input-gate
choice, and the theme. No secret is stored here: the access token stays in memory
and the refresh token lives in the OS keychain.

The desktop app also has a dark-mode toggle in the top-right corner. It
defaults to the OS `prefers-color-scheme` and stores the user's choice through
the same `config.json`, so the selection is kept across restarts.
