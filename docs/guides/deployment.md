# Cloudflare Deployment Guide

This guide covers step-by-step instructions to deploy the backend services (`@remote/signaling`) of the Remote Access Platform to Cloudflare Workers, Cloudflare D1 (SQLite database), and Cloudflare Workers KV.

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
7. [Deploy the Worker](#7-deploy-the-worker)
8. [Configure Production Secrets](#8-configure-production-secrets)
9. [Verify Deployment](#9-verify-deployment)
10. [Automate Deployment with GitHub Actions (CI/CD)](#10-automate-deployment-with-github-actions-cicd)
11. [Free Tier Quotas & Monitoring](#11-free-tier-quotas--monitoring)
12. [Troubleshooting & FAQ](#12-troubleshooting--faq)

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

The backend is built as a unified Cloudflare Worker located at `workers/signaling/`:
- **Framework**: Hono (`hono/quick-start`)
- **Database**: Cloudflare D1 (Serverless SQLite) with Drizzle ORM
- **Cache**: Cloudflare Workers KV (`CACHE` namespace) for token revocation blacklist
- **Auth**: PBKDF2-HMAC-SHA256 password hashing + stateless JWT access (15m) & refresh (7d) tokens

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
   cp workers/signaling/wrangler.prod.example.toml workers/signaling/wrangler.prod.toml
   ```
   *(Note: `wrangler.prod.toml` is ignored in `.gitignore`, so your real IDs will never be committed).*

2. Open `workers/signaling/wrangler.prod.toml` and fill in your real `database_id` and KV `id`:

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

# Or directly in workers/signaling:
pnpm --filter @remote/signaling run db:migrate:prod
```

*This executes `wrangler d1 migrations apply remote-access --remote --config wrangler.prod.toml` using migrations from `workers/signaling/db/migrations/`.*

Verify migrations by inspecting the remote database tables:
```bash
pnpm --filter @remote/signaling exec wrangler d1 execute remote-access --remote --config wrangler.prod.toml --command "SELECT name FROM sqlite_master WHERE type='table';"
```

---

## 7. Deploy the Worker

Deploy the Worker package to Cloudflare edge from your machine:

```bash
# From root using wrangler.prod.toml
pnpm deploy:workers

# Or directly in workers/signaling:
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

## 9. Verify Deployment

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

## 10. Automate Deployment with GitHub Actions (CI/CD)

To automatically deploy when merging to `main`:

### 10.1 Create Cloudflare API Token
1. Go to [Cloudflare Dashboard > My Profile > API Tokens](https://dash.cloudflare.com/profile/api-tokens).
2. Click **Create Token** > use the **Edit Cloudflare Workers** template.
3. Grant permissions:
   - Account: `Cloudflare Pages:Edit`, `Workers KV Storage:Edit`, `Workers D1:Edit`, `Workers Scripts:Edit`
4. Copy the generated API token.
5. Copy your **Account ID** from the Cloudflare Dashboard Workers overview page.

### 10.2 Add GitHub Repository Secrets
Go to your GitHub repository > **Settings > Secrets and variables > Actions** and add:
- `CLOUDFLARE_API_TOKEN`: Your Cloudflare API Token
- `CLOUDFLARE_ACCOUNT_ID`: Your Cloudflare Account ID

### 10.3 GitHub Actions Workflow
Create `.github/workflows/deploy-workers.yml`:

```yaml
name: Deploy Workers

on:
  push:
    branches: [main]
    paths:
      - 'workers/signaling/**'
      - 'packages/shared/**'
      - '.github/workflows/deploy-workers.yml'

jobs:
  deploy:
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

      - name: Apply D1 Migrations
        run: pnpm --filter @remote/signaling run db:migrate:remote
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}

      - name: Deploy Worker
        run: pnpm --filter @remote/signaling run deploy
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
```

---

## 11. Free Tier Quotas & Monitoring

Cloudflare provides a generous Free tier suitable for testing and personal setups:

| Resource | Free Tier Daily Quota | Notes |
|---|---|---|
| **Cloudflare Workers** | 100,000 requests / day | 10ms CPU time per request |
| **Cloudflare D1 (Reads)** | 5,000,000 rows read / day | Resets at 00:00 UTC |
| **Cloudflare D1 (Writes)** | 100,000 rows written / day | Resets at 00:00 UTC |
| **Cloudflare D1 (Storage)** | 5 GB total storage | Up to 500 MB per database |
| **Workers KV (Reads)** | 100,000 reads / day | Matches Workers requests |
| **Workers KV (Writes)** | 1,000 writes / day | Only consumed upon user Logout |
| **Data Egress** | 100% Free | No egress bandwidth charges |

---

## 12. Troubleshooting & FAQ

### Issue: `Cannot find module 'cloudflare:test'`
**Solution**: Make sure `tsconfig.json` specifies `"types": ["@cloudflare/workers-types", "@cloudflare/vitest-pool-workers/types"]` (with subpath `/types`).

### Issue: `D1_ERROR: no such table: users`
**Solution**: Migrations have not been applied to the remote database. Run:
```bash
pnpm --filter @remote/signaling run db:migrate:remote
```

### Issue: `Token has been revoked` error on valid login
**Solution**: Ensure your system clocks are synchronized. The JWT payload uses UNIX timestamps (`exp`), and KV stores revoked JTIs with TTL matching token expiration.

### Issue: Malformed JSON or 400 Bad Request
**Solution**: Ensure requests send headers `Content-Type: application/json` and valid non-empty JSON bodies.
