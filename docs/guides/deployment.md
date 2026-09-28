# Cloudflare Deployment Guide

This guide covers step-by-step instructions to deploy both the frontend web client (`apps/web`) to Cloudflare Pages and the backend services (`workers/`) of the Remote Access Platform to Cloudflare Workers, Cloudflare D1 (SQLite database), and Cloudflare Workers KV.

---

## Table of Contents
1. [Prerequisites](#1-prerequisites)
2. [Architecture Overview](#2-architecture-overview)
3. [Cloudflare Account & Authentication](#3-cloudflare-account--authentication)
4. [Provision Cloudflare Resources](#4-provision-cloudflare-resources)
   - [Create D1 Database](#41-create-d1-database)
   - [Create KV Namespace](#42-create-kv-namespace)
5. [Configure Production Settings (`wrangler.prod.toml`)](#5-configure-production-settings-wranglerprodtoml)
6. [Apply Database Migrations](#6-apply-database-migrations)
7. [Deploy the Backend Worker](#7-deploy-the-backend-worker)
8. [Configure Production Secrets](#8-configure-production-secrets)
9. [Verify Backend Deployment](#9-verify-backend-deployment)
10. [Deploy Web Client to Cloudflare Pages](#10-deploy-web-client-to-cloudflare-pages)
   - [Configure Environment Variables](#101-configure-environment-variables)
   - [SPA Routing Fallback](#102-spa-routing-fallback)
   - [Create Pages Project & Deploy](#103-create-pages-project--deploy)
   - [Verify Web Deployment](#104-verify-web-deployment)
11. [Cloudflare Workers Builds (Git Integration) — Important Distinction](#11-cloudflare-workers-builds-git-integration--important-distinction)
12. [Automate Deployment with GitHub Actions (CI/CD)](#12-automate-deployment-with-github-actions-cicd)
13. [Free Tier Quotas & Monitoring](#13-free-tier-quotas--monitoring)
14. [Troubleshooting & FAQ](#14-troubleshooting--faq)

---

## 1. Prerequisites

Before deploying, ensure you have:
- **Node.js**: `>= 24.0.0`
- **pnpm**: `>= 12.0.0`
- **Cloudflare Account**: [Sign up for free](https://dash.cloudflare.com/sign-up)
- Repository dependencies installed:
  ```bash
  pnpm install
  ```

---

## 2. Architecture Overview

The platform production deployment consists of two cloud components:

1. **Frontend Web Client (`apps/web`)**:
   - **Hosting**: Cloudflare Workers (Static Assets with global CDN caching).
   - **Framework**: Vue 3 SPA + Vite + Tailwind CSS + Pinia.
   - **Routing**: HTML5 History mode with Workers SPA fallback (`not_found_handling = "single-page-application"`).
   - **Backend Connection**: Configured via `VITE_API_URL` pointing to the deployed Worker.

2. **Unified Backend Service (`workers/`)**:
   - **Runtime**: Cloudflare Workers with Hono (`hono/quick-start`).
   - **Database**: Cloudflare D1 (Serverless SQLite) with Drizzle ORM.
   - **Cache**: Cloudflare Workers KV (`CACHE` namespace) for token revocation blacklist.
   - **Auth**: PBKDF2-HMAC-SHA256 password hashing + stateless JWT access (15m) & refresh (7d) tokens.

---

## 3. Cloudflare Account & Authentication

Authenticate Wrangler CLI with your Cloudflare account:

```bash
pnpm --filter @remote/signaling exec wrangler login
```

A browser window will open asking you to authorize Wrangler. Once approved, verify your authentication status:

```bash
pnpm --filter @remote/signaling exec wrangler whoami
```

You should see your account name and Account ID.

---

## 4. Provision Cloudflare Resources

### 4.1 Create D1 Database

Run the following command to create the remote D1 SQLite database named `remote-access`:

```bash
pnpm --filter @remote/signaling exec wrangler d1 create remote-access
```

**Output example:**
```
✅ Successfully created DB 'remote-access'!

[[d1_databases]]
binding = "DB"
database_name = "remote-access"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

Save the `database_id` value for the next step.

### 4.2 Create KV Namespace

Run the following command to create the KV namespace for the token blacklist cache:

```bash
pnpm --filter @remote/signaling exec wrangler kv namespace create CACHE
```

**Output example:**
```
✨ Success!
Add the following to your configuration file:
[[kv_namespaces]]
binding = "CACHE"
id = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
```

Save the `id` value for the next step.

---

## 5. Configure Production Settings (`wrangler.prod.toml`)

To deploy from your personal machine without committing your real Cloudflare IDs to Git:

1. Copy the production template file:
   ```bash
   cp workers/wrangler.prod.example.toml workers/wrangler.prod.toml
   ```
   *(Note: `wrangler.prod.toml` is ignored in `.gitignore`, so your real IDs will never be committed).*

2. Open `workers/wrangler.prod.toml` and fill in your real `database_id` and KV `id`:

```toml
name = "ponta-remote"
main = "src/index.ts"
compatibility_date = "2024-09-01"
compatibility_flags = ["nodejs_compat"]

[vars]
ENVIRONMENT = "production"
JWT_EXPIRES_IN = "15m"
REFRESH_TOKEN_EXPIRES_IN = "7d"

[[d1_databases]]
binding = "DB"
database_name = "remote-access"
database_id = "YOUR_REAL_D1_DATABASE_ID"
migrations_dir = "db/migrations"

[[kv_namespaces]]
binding = "CACHE"
id = "YOUR_REAL_KV_NAMESPACE_ID"

[observability]
enabled = true
```

> **Security Note:** In production, do **not** put `JWT_SECRET` and `REFRESH_TOKEN_SECRET` in `[vars]`. We will set them as encrypted Cloudflare Secrets in Step 8.

---

## 6. Apply Database Migrations

Apply the database schema (6 tables: `users`, `devices`, `agents`, `sessions`, `signals`, `audit_logs`) to your remote Cloudflare D1 database:

```bash
# From root using wrangler.prod.toml
pnpm db:migrate:prod

# Or directly in workers:
pnpm --filter @remote/signaling run db:migrate:prod
```

*This executes `wrangler d1 migrations apply remote-access --remote --config wrangler.prod.toml` using migrations from `workers/db/migrations/`.*

Verify migrations by inspecting the remote database tables:
```bash
pnpm --filter @remote/signaling exec wrangler d1 execute remote-access --remote --config wrangler.prod.toml --command "SELECT name FROM sqlite_master WHERE type='table';"
```

---

## 7. Deploy the Backend Worker

Deploy the Worker package to Cloudflare edge from your machine:

```bash
# From root using wrangler.prod.toml
pnpm deploy:workers

# Or directly in workers:
pnpm --filter @remote/signaling run deploy:prod
```

*This executes `wrangler deploy --config wrangler.prod.toml`.*

Upon completion, Wrangler outputs the deployed URL:
```
Uploaded ponta-remote (x.xx sec)
Deployed ponta-remote triggers (x.xx sec)
  https://ponta-remote.<your-subdomain>.workers.dev
Current Version ID: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

---

## 8. Configure Production Secrets

> **Important:** Cloudflare requires the Worker (`ponta-remote`) to be deployed at least once (Step 7) before secrets can be attached to it. Running `wrangler secret put` on a non-existent worker will fail with an error.
> When you run `wrangler secret put`, Cloudflare securely encrypts the secret and immediately applies it to the active Worker deployment without requiring a manual redeployment.

Store your production secrets securely using Wrangler:

```bash
# Set JWT Access Token secret (minimum 32 characters)
pnpm --filter @remote/signaling exec wrangler secret put JWT_SECRET --config wrangler.prod.toml

# Set Refresh Token secret (minimum 32 characters)
pnpm --filter @remote/signaling exec wrangler secret put REFRESH_TOKEN_SECRET --config wrangler.prod.toml
```

When prompted in the terminal, paste your strong random secret strings (e.g., generated with `openssl rand -base64 32`).

---

## 9. Verify Backend Deployment

### 9.1 Health Check
Test the public health endpoint:
```bash
curl https://ponta-remote.<your-subdomain>.workers.dev/health
```
**Expected response:**
```json
{"status":"ok"}
```

### 9.2 Registration & Authentication Flow
Test user registration:
```bash
curl -X POST https://ponta-remote.<your-subdomain>.workers.dev/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "username": "admin",
    "password": "SuperSecretPassword123!",
    "publicKey": "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExamplePublicKey"
  }'
```
**Expected response (HTTP 201):**
```json
{
  "user": {
    "id": "...",
    "username": "admin",
    "publicKey": "...",
    "isActive": true
  },
  "token": "eyJhbGciOi...",
  "refreshToken": "eyJhbGciOi...",
  "expiresIn": 900
}
```

### 9.3 Stream Real-time Logs
To monitor live requests and error logs:
```bash
pnpm --filter @remote/signaling exec wrangler tail
```

---

## 10. Deploy Web Client to Cloudflare Workers (Static Assets)

The web application (`apps/web`) is a Vue 3 Single Page Application (SPA) hosted on Cloudflare using **Workers Static Assets** (defined in `apps/web/wrangler.toml`).

### 10.1 Configure Environment Variables

The web frontend communicates with the backend Worker using the `VITE_API_URL` environment variable.

1. Copy the production template:
   ```bash
   cp apps/web/.env.production.example apps/web/.env.production
   ```
   *(Note: `.env.production` is gitignored so local configurations stay private).*

2. Update `VITE_API_URL` with your deployed backend Worker URL:
   ```env
   VITE_API_URL=https://ponta-remote.<your-subdomain>.workers.dev
   ```

### 10.2 SPA Routing (`not_found_handling`)

In `apps/web/wrangler.toml`, the static assets configuration includes:
```toml
name = "ponta-remote-web"
compatibility_date = "2024-09-01"

[assets]
directory = "./dist"
not_found_handling = "single-page-application"
```
Because `vue-router` runs in HTML5 history mode (`createWebHistory()`), navigating directly or refreshing URLs like `/dashboard` or `/workspace/:agentId` requires the server to return `index.html`. The `not_found_handling = "single-page-application"` directive automatically handles this at Cloudflare edge with HTTP 200 without requiring custom rewrite functions.

### 10.3 Build and Deploy via CLI / Workers Builds

Deploy directly to Cloudflare edge:

```bash
# From repository root:
pnpm deploy:web

# Or specify VITE_API_URL inline:
VITE_API_URL=https://ponta-remote.<your-subdomain>.workers.dev pnpm deploy:web
```

*This compiles the Vue 3 bundle into `apps/web/dist` and deploys it via `wrangler deploy`.*

**Output example**:
```
✨ Read 18 files from the assets directory /.../apps/web/dist
Total Upload: xx KiB / gzip: xx KiB
Uploaded ponta-remote-web (x.xx sec)
Deployed ponta-remote-web triggers (x.xx sec)
  https://ponta-remote-web.<your-subdomain>.workers.dev
```

### 10.4 Verify Web Deployment

1. Open `https://ponta-remote-web.<your-subdomain>.workers.dev` in your browser.
2. Register a new user account or log in.
3. Test SPA reloading: navigate to `/dashboard` and press `F5` / Refresh in the browser. The page must reload smoothly without returning a 404 error.
4. Open the Developer Tools Console (`F12`) to verify network requests are successfully dispatched to your backend Worker.

---

## 11. Cloudflare Workers Builds (Git Integration) — Important Distinction

If you ever connect this repository to **Cloudflare Workers Builds** (Workers & Pages → your Worker → Settings → Builds → Connect to Git), you must understand that Cloudflare creates **two independent objects**:

| | **Workers Builds project** | **Worker service** |
|---|---|---|
| What it is | The Git-connected CI configuration | A deployed script running on Cloudflare's edge |
| Created when | The moment you connect the repository in the Dashboard | Only after a **successful** `wrangler deploy` |
| Owns the GitHub check run | Yes — via the `cloudflare-workers-and-pages` GitHub App | No |

**Consequences you should expect:**

1. **Check runs appear even with no Worker service.** The GitHub App creates a `Workers Builds: <project name>` check run on every push while the build project exists — including when no Worker of that name exists at all. In that case the build fails with a message like:
   ```
   Preview creation failed: This Worker does not exist on your account.
   ```
2. **The check run name does NOT come from `wrangler.toml`.** It comes from the build project's name, which Cloudflare derives from the repository slug / Dashboard project name. Renaming `name` in `wrangler.toml` will not rename the check run — only renaming the project in the Dashboard will.
3. **Preview builds fire on every push by default.** The **"Enable Preview Builds"** option in *Settings → Builds → Branch control* triggers a preview build for every push to a non-production branch. Disable it to stop preview builds (and their check runs) on feature branches.
4. **A failing build does not block merges** unless you explicitly add it as a required status check in GitHub branch protection.

**Why a monorepo build fails at the repository root:** the build project defaults to the **repository root** as its build root, where no Wrangler configuration exists. Also note `workers/wrangler.toml` intentionally carries *placeholder* bindings (`local-db-binding`, `local-cache-binding`) for local development and tests, so it cannot deploy to the cloud as-is.

### Resolving it

**Option A — Disconnect (recommended if you deploy via CLI):**
Dashboard → Workers & Pages → select the project → **Settings** → **Builds** → **Disconnect**. The check runs stop appearing on subsequent pushes.

**Option B — Configure it correctly for the monorepo:**
In **Settings → Builds**:
- **Root directory:** `workers`
- **Deploy command:** `npx wrangler deploy`
- Then provide cloud-appropriate bindings for the build environment (a real D1 `database_id` and KV `id`, plus the `JWT_SECRET` / `REFRESH_TOKEN_SECRET` secrets). Without real bindings the build will still fail.

> **Warning:** Never point the build's deploy command at `wrangler.prod.example.toml` — it contains placeholder values (`YOUR_REAL_D1_DATABASE_ID`) and the deploy will fail.

---

## 12. Automate Deployment with GitHub Actions (CI/CD)

To automatically deploy both backend Workers and the frontend Web Pages when merging to `main`:

### 12.1 Create Cloudflare API Token
1. Go to [Cloudflare Dashboard > My Profile > API Tokens](https://dash.cloudflare.com/profile/api-tokens).
2. Click **Create Token** > use the **Edit Cloudflare Workers** template.
3. Grant permissions:
   - Account: `Cloudflare Pages:Edit`, `Workers KV Storage:Edit`, `Workers D1:Edit`, `Workers Scripts:Edit`
4. Copy the generated API token.
5. Copy your **Account ID** from the Cloudflare Dashboard Workers overview page.

### 12.2 Add GitHub Repository Secrets & Variables
Go to your GitHub repository > **Settings > Secrets and variables > Actions**:

**Repository Secrets:**
- `CLOUDFLARE_API_TOKEN`: Your Cloudflare API Token
- `CLOUDFLARE_ACCOUNT_ID`: Your Cloudflare Account ID
- `CLOUDFLARE_D1_DATABASE_ID`: Production D1 Database UUID
- `CLOUDFLARE_KV_NAMESPACE_ID`: Production KV Namespace ID

**Repository Variables:**
- `VITE_API_URL`: Backend URL, e.g. `https://ponta-remote.<your-subdomain>.workers.dev`

### 12.3 GitHub Actions Workflow
Create `.github/workflows/deploy.yml`:

```yaml
name: Deploy Fullstack to Cloudflare

on:
  push:
    branches: [main]
    paths:
      - 'workers/**'
      - 'apps/web/**'
      - 'packages/**'
      - '.github/workflows/deploy.yml'

jobs:
  deploy-backend:
    name: Deploy Backend Worker
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup pnpm
        uses: pnpm/action-setup@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: 'pnpm'

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Run Tests
        run: pnpm test

      # wrangler.prod.toml is gitignored, so CI materializes it from secrets.
      - name: Generate production Wrangler config
        run: |
          cp workers/wrangler.prod.example.toml workers/wrangler.prod.toml
          sed -i "s|YOUR_REAL_D1_DATABASE_ID|${{ secrets.CLOUDFLARE_D1_DATABASE_ID }}|" workers/wrangler.prod.toml
          sed -i "s|YOUR_REAL_KV_NAMESPACE_ID|${{ secrets.CLOUDFLARE_KV_NAMESPACE_ID }}|" workers/wrangler.prod.toml

      - name: Apply D1 Migrations
        run: pnpm --filter @remote/signaling run db:migrate:prod
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}

      - name: Deploy Worker
        run: pnpm --filter @remote/signaling run deploy:prod
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}

  deploy-frontend:
    name: Deploy Web Client (Pages)
    needs: deploy-backend
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup pnpm
        uses: pnpm/action-setup@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: 'pnpm'

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Build Web Application
        run: pnpm --filter @remote/web build
        env:
          VITE_API_URL: ${{ vars.VITE_API_URL || 'https://ponta-remote.workers.dev' }}

      - name: Deploy to Cloudflare Workers (Static Assets)
        run: pnpm --filter @remote/web exec wrangler deploy
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
```

---

## 13. Free Tier Quotas & Monitoring

Cloudflare provides a generous Free tier suitable for testing and personal setups:

| Resource | Free Tier Daily Quota | Notes |
|---|---|---|
| **Cloudflare Pages** | **Unlimited** requests & bandwidth | 500 builds / month via Git/CI |
| **Cloudflare Workers** | 100,000 requests / day | 10ms CPU time per request |
| **Cloudflare D1 (Reads)** | 5,000,000 rows read / day | Resets at 00:00 UTC |
| **Cloudflare D1 (Writes)** | 100,000 rows written / day | Resets at 00:00 UTC |
| **Cloudflare D1 (Storage)** | 5 GB total storage | Up to 500 MB per database |
| **Workers KV (Reads)** | 100,000 reads / day | Matches Workers requests |
| **Workers KV (Writes)** | 1,000 writes / day | Only consumed upon user Logout |
| **Data Egress** | 100% Free | No egress bandwidth charges |

---

## 14. Troubleshooting & FAQ

### Issue: `Cannot find module 'cloudflare:test'`
**Solution**: Make sure `tsconfig.json` specifies `"types": ["@cloudflare/workers-types", "@cloudflare/vitest-pool-workers/types"]` (with subpath `/types`).

### Issue: `D1_ERROR: no such table: users`
**Solution**: Migrations have not been applied to the remote database. Run:
```bash
pnpm db:migrate:prod
```

### Issue: `Token has been revoked` error on valid login
**Solution**: Ensure your system clocks are synchronized. The JWT payload uses UNIX timestamps (`exp`), and KV stores revoked JTIs with TTL matching token expiration.

### Issue: Malformed JSON or 400 Bad Request
**Solution**: Ensure requests send headers `Content-Type: application/json` and valid non-empty JSON bodies.

### Issue: GitHub check run `Workers Builds: <name>` fails with "This Worker does not exist on your account"
**Cause**: A Workers Builds project (Git integration) exists for this repository, but no Worker service with that name has ever been deployed successfully. The build project creates the check run regardless of whether the Worker exists.
**Solution**: See [Section 10](#10-cloudflare-workers-builds-git-integration--important-distinction). Either disconnect the Git integration (Dashboard → the project → Settings → Builds → Disconnect), or configure the build root as `workers` with real D1/KV bindings. Deploying once from the CLI with a matching `name` in `wrangler.toml` also resolves the "does not exist" error.

### Issue: Worker deployed but the Dashboard shows a different service name than `wrangler.toml`
**Cause**: A Workers Builds project created from a Git connection takes its name from the repository slug / Dashboard project name, not from `wrangler.toml`. If the two diverge, `wrangler deploy` creates a second, separate Worker.
**Solution**: Keep `name` in `wrangler.toml` identical to the Dashboard project name. This repository standardizes on `ponta-remote` (see ADR-06 in the Phase 1 Week 2 design spec).
