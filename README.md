# Ponter

[![CI](https://github.com/ngotuananh101/ponter/actions/workflows/ci.yml/badge.svg)](https://github.com/ngotuananh101/ponter/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Turborepo](https://img.shields.io/badge/monorepo-Turborepo-ef4444.svg)](https://turbo.build)
[![Node.js 24](https://img.shields.io/badge/runtime-Node.js%2024-68A063.svg)](https://nodejs.org)
[![Hono](https://img.shields.io/badge/framework-Hono-E36002.svg)](https://hono.dev)
[![SQLite](https://img.shields.io/badge/database-SQLite-003B57.svg)](https://sqlite.org)
[![Rust](https://img.shields.io/badge/agent-Rust-DEA584.svg)](https://www.rust-lang.org)
[![Vue 3](https://img.shields.io/badge/frontend-Vue%203-4FC08D.svg)](https://vuejs.org)

A high-performance, low-latency, zero-trust remote access platform featuring **Multi-Shell Remote Terminal** (< 10ms latency, PTY virtualization), **Remote Desktop**, and **Remote File Manager** with end-to-end encryption (E2EE).

---

## 🚀 Key Architectural Highlights

- **Zero-Trust & E2EE**: Secure by default with client-side public-key verification, PBKDF2-HMAC-SHA256 password hashing (with constant-time XOR comparison against timing attacks), and SQLite `revoked_tokens` table for instant token revocation.
- **Self-Hosted Backend**: Unified backend service running on Node.js 24 LTS + Hono, backed by local SQLite (better-sqlite3 + Drizzle ORM) with WAL mode. In-memory WebSocket dispatch for sub-1ms signal forwarding.
- **Direct P2P WebRTC DataChannels**: Peer-to-peer data transport over DTLS/SCTP via STUN/TURN, delivering sub-10ms interactive shell performance without relay bottleneck.
- **Multi-Shell Multiplexing**: Multiplexes multiple independent shell instances across a single ordered WebRTC DataChannel (`"terminal"`), preserving binary byte sequences and scrollback history via a headless 64 KiB `RingBuffer`.
- **Native Rust Agent Daemon**: High-efficiency background agent (`apps/agent`) built with `tokio`, `webrtc-rs`, and `portable-pty`, featuring automatic child process lifecycle management and zombie process reaping.
- **Modern Responsive Workspace**: Tabbed Vue 3 terminal UI with `@xterm/xterm`, dynamic viewport auto-fitting (`ResizeObserver` + FitAddon), collapsible sidebar, desktop keyboard shortcuts, and touch-optimized mobile accessory keys.
- **Docker Deployment**: Three Docker Compose setups for Local LAN, Homelab (Cloudflare Tunnel), and Production VPS (Caddy + Coturn TURN).

---

## 📦 Monorepo Architecture

Managed with **Turborepo** and **pnpm workspaces**:

```
ponter/
├── apps/
│   ├── web/               # Vue 3 + Vite + Pinia workspace (Xterm.js, TabBar, Sidebar)
│   ├── desktop/           # Tauri 2.0 cross-platform desktop shell (Linux, macOS, Windows)
│   ├── mobile/            # Tauri mobile client shell (iOS, Android)
│   ├── agent/             # Native Rust desktop agent daemon (portable-pty, webrtc-rs, tokio)
│   └── server/            # Self-hosted backend (@ponter/server): Node.js 24 + Hono + SQLite + ws
├── packages/
│   ├── shared/            # Shared TypeScript types, schemas, and wire protocol definitions
│   ├── api-client/        # Type-safe HTTP & WebSocket client SDK with token auto-refresh
│   ├── crypto/            # Client-side cryptographic primitives (Web Crypto, E2EE)
│   ├── terminal-core/     # Headless pure TypeScript terminal manager (RingBuffer, TerminalClient)
│   ├── webrtc-core/       # WebRTC connection orchestration & DataChannel management
│   └── ui-components/     # Shared Vue 3 UI component library
├── docker/                # Docker packaging: Dockerfile + 3 Compose setups (local, tunnel, prod)
├── workers/               # Legacy Cloudflare Worker (deprecated - use apps/server instead)
└── docs/
    ├── ARCHITECTURE.md    # Master architecture specification
    ├── README.md          # Documentation index
    └── guides/            # Developer, deployment, and protocol guides
```

---

## 🛠️ Tech Stack

| Layer                    | Technologies                                                             |
| ------------------------ | ------------------------------------------------------------------------ |
| **Backend Runtime**      | Node.js 24 LTS, Hono, TypeScript, `ws` (WebSocket)                       |
| **Database**             | SQLite (better-sqlite3 + Drizzle ORM, WAL mode)                          |
| **Token Revocation**     | SQLite `revoked_tokens` table (replaces Cloudflare KV blacklist)         |
| **Authentication**       | PBKDF2-HMAC-SHA256, Stateless JWT (15m access / 7d refresh)              |
| **Web Client**           | Vue 3, Vite, Pinia, Tailwind CSS, `@xterm/xterm`                         |
| **Desktop Agent**        | Rust (edition 2021), `tokio`, `webrtc-rs`, `portable-pty`, `serde_json`  |
| **WebRTC & Transport**   | W3C WebRTC DataChannels, `werift` (Node.js test harness), DTLS 1.2, SCTP |
| **TURN/STUN**            | Coturn (RFC 5766 shared secret), Google STUN (local dev)                 |
| **Containerization**     | Docker (multi-stage), Docker Compose (3 setups)                          |
| **Web Frontend Hosting** | Cloudflare Pages (static assets only)                                    |
| **Testing**              | Vitest, Cargo test, Cross-language E2E                                   |
| **Build & Toolchain**    | Turborepo, pnpm v12, ESLint, Prettier, Cargo Clippy, rustfmt             |

---

## ⚡ Quick Start (Local Development)

### 1. Prerequisites

- **Node.js**: `>= 24.0.0`
- **pnpm**: `>= 12.0.0` (`corepack enable pnpm`)
- **Rust Toolchain**: Stable (`>= 1.80.0`)

### 2. Install Dependencies & Build Agent

```bash
# Install all JS/TS workspace packages
pnpm install

# Build the native Rust agent
cargo build --manifest-path apps/agent/Cargo.toml
```

### 3. Start Local Development Services

Chạy từng thành phần trong terminal riêng:

```bash
# Terminal 1: Start the Backend (Node.js + Hono + SQLite on http://127.0.0.1:8787)
pnpm --filter @ponter/server dev

# Terminal 2: Start the Web Client (Vite on http://127.0.0.1:5173)
pnpm --filter @ponter/web dev

# Terminal 3: Run the Native Agent Daemon
cargo run --manifest-path apps/agent/Cargo.toml -- \
  --agent-id agent-local-01 \
  --server ws://127.0.0.1:8787/api/ws/agent \
  --credential <AGENT_CREDENTIAL> \
  --stun ""
```

_Để biết chi tiết cách đăng ký agent và lấy credential, xem [Local Development Guide](docs/guides/development.md)._

### 4. Docker (Alternative)

```bash
# Chạy backend trong Docker (local LAN setup)
cd docker
docker compose -f docker-compose.local.yml up --build
```

Xem [Deployment Guide](docs/guides/deployment.md) để biết chi tiết về cả ba môi trường Docker Compose.

---

## 🧪 Verification & Testing Suite

```bash
# Chạy tất cả unit & integration tests
pnpm -w test

# Server-specific tests
pnpm --filter @ponter/server test

# Rust unit tests
cargo test --manifest-path apps/agent/Cargo.toml

# TypeScript & Vue type checks
pnpm -w typecheck

# Linters
pnpm -w lint
cargo clippy --all-targets --manifest-path apps/agent/Cargo.toml -- -D warnings

# Code formatting
pnpm format:check
cargo fmt --check --manifest-path apps/agent/Cargo.toml

# Cross-language E2E tests
pnpm --filter @ponter/webrtc-core test:e2e
```

---

## 🌐 API & Protocol Overview

### REST API Endpoints (`@ponter/server`)

- **Authentication**: `POST /api/auth/register`, `POST /api/auth/login`, `POST /api/auth/refresh`, `POST /api/auth/logout`
- **Agents**: `GET /api/agents`, `POST /api/agents` (register & mint credentials), `GET /api/agents/:id`
- **Sessions & WebRTC Signaling**:
  - `POST /api/sessions` — Initiate remote session
  - `POST /api/signal/offer` — Send WebRTC offer
  - `POST /api/signal/answer` — Send WebRTC answer
  - `POST /api/signal/ice-candidate` — Send ICE candidate
  - `GET /api/signal/poll/:sessionId` — Polling signaling for browser clients
  - `GET /api/webrtc/ice-servers` — Dynamic ICE server configuration
- **Agent WebSocket**: `GET /api/ws/agent` — Persistent bi-directional WebSocket (Bearer `ag_` credential, not JWT)

### Terminal Wire Protocol (`"terminal"` DataChannel)

- `terminal-create` — Spawn PTY session
- `terminal-data` — Bi-directional base64 binary transport
- `terminal-resize` — Debounced viewport resizing
- `terminal-close` — Graceful terminate session
- `terminal-exit` — Agent notification with exit code

_Xem đầy đủ thông số tại [Terminal Multiplexing & Wire Protocol Guide](docs/guides/terminal-protocol.md)._

---

## 🐳 Deployment

### Self-Hosted Backend (Docker)

```bash
# Local LAN
cd docker
docker compose -f docker-compose.local.yml up --build

# Homelab (Cloudflare Tunnel)
docker compose -f docker-compose.tunnel.yml up --build

# Production VPS (Caddy + Coturn)
docker compose -f docker-compose.prod.yml up --build -d
```

### Web Frontend (Cloudflare Pages)

```bash
pnpm --filter @ponter/web build
pnpm --filter @ponter/web exec wrangler deploy
```

Xem [Deployment Guide](docs/guides/deployment.md) để biết chi tiết.

---

## 📚 Documentation & Guides

- **[Documentation Index](docs/README.md)**
- **[Master Architecture Document](docs/ARCHITECTURE.md)**: Full system architecture, security models, and roadmap.
- **[Local Development Guide](docs/guides/development.md)**: Setup, running backend, web workspace, native agent, and testing.
- **[Deployment Guide](docs/guides/deployment.md)**: Self-hosted Docker Compose setups (local, tunnel, prod) and Cloudflare Pages static web deployment.
- **[Desktop Agent Setup Guide](docs/guides/agent-setup.md)**: Building and configuring the Rust daemon as a systemd service.
- **[Terminal Multiplexing Protocol](docs/guides/terminal-protocol.md)**: Detailed wire specification for WebRTC DataChannels.

---

## 📄 License

This project is licensed under the [MIT License](LICENSE).
