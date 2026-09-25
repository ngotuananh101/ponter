# Remote Access Platform

[![CI](https://github.com/ngotuananh101/ponta-remote/actions/workflows/ci.yml/badge.svg)](https://github.com/ngotuananh101/ponta-remote/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Turborepo](https://img.shields.io/badge/monorepo-Turborepo-ef4444.svg)](https://turbo.build)
[![Cloudflare Workers](https://img.shields.io/badge/backend-Cloudflare%20Workers-f38020.svg)](https://workers.cloudflare.com)
[![Hono](https://img.shields.io/badge/framework-Hono-E36002.svg)](https://hono.dev)

A comprehensive, low-latency, zero-trust remote access platform featuring **Remote Terminal** (< 10ms latency), **Remote Desktop** (60fps streaming), and **Remote File Manager** with end-to-end encryption (E2EE).

---

## 🚀 Key Features & Principles

- **Zero-Trust & E2EE**: Secure by default with end-to-end cryptographic verification, PBKDF2-HMAC-SHA256 password hashing (constant-time XOR comparison against timing attacks), and KV-backed instant token revocation.
- **Edge-First Backend**: Unified backend service running on Cloudflare Workers and Hono with zero cold-start latency.
- **Serverless SQLite**: Cloudflare D1 with Drizzle ORM for type-safe schema definitions and migration management.
- **Cross-Platform**: Web (Vue 3 + Vite), Desktop (Tauri 2.0 + Rust), Mobile (Tauri Mobile for iOS/Android), and Native Desktop Agent (Rust).
- **Fast P2P Data Channels**: Direct WebRTC connections via STUN/TURN for high throughput and sub-10ms interactive latency.

---

## 📦 Monorepo Architecture

Managed via **Turborepo** and **pnpm workspaces**:

```
remote-access-platform/
├── apps/
│   ├── web/               # Vue 3 web client
│   ├── desktop/           # Tauri 2.0 desktop application (Linux, macOS, Windows)
│   ├── mobile/            # Tauri mobile client (iOS, Android)
│   └── agent/             # High-performance native desktop agent (Rust)
├── packages/
│   ├── shared/            # Shared TypeScript types, schemas, and constants
│   ├── api/               # API contract types and router definitions
│   ├── api-client/        # HTTP & WebSocket client SDK
│   ├── crypto/            # Client-side cryptographic primitives (E2EE, keys)
│   ├── terminal-core/     # Terminal emulation and state management
│   ├── webrtc-core/       # WebRTC connection orchestration and DataChannel management
│   └── ui-components/     # Shared Vue 3 UI component library
├── workers/
│   └── signaling/         # Unified Cloudflare Worker (REST API, Auth, D1, KV cache, Signaling)
└── docs/
    ├── ARCHITECTURE.md    # Master architecture specification
    └── guides/
        └── deployment.md  # Complete Cloudflare deployment guide
```

---

## 🛠️ Tech Stack

| Layer                 | Technologies                                                             |
| --------------------- | ------------------------------------------------------------------------ |
| **Backend Runtime**   | Cloudflare Workers, Hono, TypeScript                                     |
| **Database & Cache**  | Cloudflare D1 (SQLite), Drizzle ORM, Cloudflare Workers KV               |
| **Authentication**    | Web Crypto PBKDF2, JWT (access + refresh), KV Token Revocation Blacklist |
| **Frontend Clients**  | Vue 3, Vite, Pinia, TailwindCSS, Tauri 2.0 (Rust)                        |
| **Desktop Agent**     | Rust (tokio, webrtc-rs, portable-pty)                                    |
| **Testing**           | Vitest, `@cloudflare/vitest-pool-workers` (native `workerd` isolate)     |
| **Build & Toolchain** | Turborepo, pnpm, Biome / Prettier, ESLint                                |

---

## ⚡ Quick Start (Local Development)

### 1. Prerequisites

- **Node.js**: `>= 24.0.0`
- **pnpm**: `>= 12.0.0`
- **Rust toolchain** (optional, for native agent/Tauri development): `rustup default stable`

### 2. Install Dependencies

```bash
pnpm install
```

### 3. Run Checks & Tests

```bash
# Run code formatting check
pnpm format:check

# Run linting across all packages
pnpm lint

# Run typechecking across all packages
pnpm typecheck

# Run full test suite (including workerd-isolated Worker tests)
pnpm test
```

### 4. Start Local Backend

To run the signaling and REST API worker locally using Wrangler and local D1/KV simulators:

```bash
pnpm --filter @remote/signaling dev
```

The worker starts at `http://127.0.0.1:8787`. You can test the health endpoint:

```bash
curl http://127.0.0.1:8787/health
# {"status":"ok"}
```

---

## 🌐 API Overview

The unified worker mounts the following REST endpoints under `/api`:

### Authentication (`/api/auth`)

- `POST /api/auth/register` — Register new user with username, password, and public key.
- `POST /api/auth/login` — Authenticate and receive 15m access token + 7d refresh token.
- `POST /api/auth/refresh` — Issue a new access token using a valid refresh token.
- `POST /api/auth/logout` — Revoke token immediately via KV blacklist.
- `POST /api/auth/webauthn/options` — WebAuthn challenge options (Phase 2 stub, 501).
- `POST /api/auth/webauthn/verify` — WebAuthn verification (Phase 2 stub, 501).

### User Profile (`/api/users`)

- `GET /api/users/me` — Retrieve the authenticated user's profile.

### Devices (`/api/devices`)

- `GET /api/devices` — List user's registered devices.
- `POST /api/devices` — Register new device (`desktop` | `mobile` | `web`).
- `DELETE /api/devices/:id` — Remove device and detach referencing sessions.

### Agents (`/api/agents`)

- `GET /api/agents` — List user's registered desktop agents.
- `POST /api/agents` — Register or update desktop agent status.
- `GET /api/agents/:id` — Get detailed agent information.

### Sessions (`/api/sessions`)

- `GET /api/sessions` — List user's active/pending remote sessions.
- `POST /api/sessions` — Initiate connection session between device and agent.
- `GET /api/sessions/:id` — Retrieve session details and status.
- `DELETE /api/sessions/:id` — Terminate session.

---

## 🚀 Deployment Guide

Detailed step-by-step instructions for provisioning Cloudflare D1 databases, creating KV namespaces, managing production secrets, running migrations, and setting up GitHub Actions CI/CD can be found in:

👉 **[Cloudflare Deployment Guide](docs/guides/deployment.md)**

---

## 📜 Documentation

- **[Master Architecture Document](docs/ARCHITECTURE.md)**: System design, security model, and implementation roadmap.
- **[Phase 1 Week 2 Design Spec](docs/superpowers/specs/2026-09-25-phase1-week2-backend-design.md)**: Backend foundation specification and ADRs.
- **[Cloudflare Deployment Guide](docs/guides/deployment.md)**: Complete production deployment runbook.

---

## 📄 License

This project is licensed under the [MIT License](LICENSE).
