# Ponta Remote Access Platform

[![CI](https://github.com/ngotuananh101/ponta-remote/actions/workflows/ci.yml/badge.svg)](https://github.com/ngotuananh101/ponta-remote/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Turborepo](https://img.shields.io/badge/monorepo-Turborepo-ef4444.svg)](https://turbo.build)
[![Cloudflare Workers](https://img.shields.io/badge/backend-Cloudflare%20Workers-f38020.svg)](https://workers.cloudflare.com)
[![Hono](https://img.shields.io/badge/framework-Hono-E36002.svg)](https://hono.dev)
[![Rust](https://img.shields.io/badge/agent-Rust-DEA584.svg)](https://www.rust-lang.org)
[![Vue 3](https://img.shields.io/badge/frontend-Vue%203-4FC08D.svg)](https://vuejs.org)

A high-performance, low-latency, zero-trust remote access platform featuring **Multi-Shell Remote Terminal** (< 10ms latency, PTY virtualization), **Remote Desktop**, and **Remote File Manager** with end-to-end encryption (E2EE).

---

## 🚀 Key Architectural Highlights

- **Zero-Trust & E2EE**: Secure by default with client-side public-key verification, PBKDF2-HMAC-SHA256 password hashing (with constant-time XOR comparison against timing attacks), and Cloudflare KV-backed instant token revocation.
- **Edge-First Backend**: Unified backend service running on Cloudflare Workers and Hono with zero cold-start latency, integrating D1 serverless SQLite and Drizzle ORM.
- **Direct P2P WebRTC DataChannels**: Peer-to-peer data transport over DTLS/SCTP via STUN/TURN, delivering sub-10ms interactive shell performance without relay bottleneck.
- **Multi-Shell Multiplexing (ADR-09, ADR-10)**: Multiplexes multiple independent shell instances across a single ordered WebRTC DataChannel (`"terminal"`), preserving binary byte sequences and scrollback history via a headless 64 KiB `RingBuffer`.
- **Native Rust Agent Daemon**: High-efficiency background agent (`apps/agent`) built with `tokio`, `webrtc-rs`, and `portable-pty`, featuring automatic child process lifecycle management and zombie process reaping.
- **Modern Responsive Workspace**: Tabbed Vue 3 terminal UI with `@xterm/xterm`, dynamic viewport auto-fitting (`ResizeObserver` + FitAddon), collapsible sidebar, desktop keyboard shortcuts, and touch-optimized mobile accessory keys.

---

## 📦 Monorepo Architecture

Managed with **Turborepo** and **pnpm workspaces**:

```
ponta-remote/
├── apps/
│   ├── web/               # Vue 3 + Vite + Pinia workspace (Xterm.js, TabBar, Sidebar)
│   ├── desktop/           # Tauri 2.0 cross-platform desktop shell (Linux, macOS, Windows)
│   ├── mobile/            # Tauri mobile client shell (iOS, Android)
│   └── agent/             # Native Rust desktop agent daemon (portable-pty, webrtc-rs, tokio)
├── packages/
│   ├── shared/            # Shared TypeScript types, schemas, and wire protocol definitions
│   ├── api-client/        # Type-safe HTTP & WebSocket client SDK with token auto-refresh
│   ├── crypto/            # Client-side cryptographic primitives (Web Crypto, E2EE)
│   ├── terminal-core/     # Headless pure TypeScript terminal manager (RingBuffer, TerminalClient)
│   ├── webrtc-core/       # WebRTC connection orchestration & DataChannel management
│   └── ui-components/     # Shared Vue 3 UI component library
├── workers/               # Unified Cloudflare Worker (REST API, Auth, D1 SQLite, KV, Signaling)
└── docs/
    ├── ARCHITECTURE.md    # Master architecture specification
    ├── README.md          # Documentation index
    └── guides/            # Developer, deployment, and protocol guides
```

---

## 🛠️ Tech Stack

| Layer                  | Technologies                                                              |
| ---------------------- | ------------------------------------------------------------------------- |
| **Backend Runtime**    | Cloudflare Workers, Hono, TypeScript                                      |
| **Database & Cache**   | Cloudflare D1 (SQLite), Drizzle ORM, Cloudflare Workers KV                |
| **Authentication**     | Web Crypto PBKDF2, Stateless JWT (15m access / 7d refresh), KV Blacklist  |
| **Web Client**         | Vue 3, Vite, Pinia, Tailwind CSS, `@xterm/xterm`, `@xterm/addon-fit`      |
| **Desktop Agent**      | Rust (edition 2021), `tokio`, `webrtc-rs`, `portable-pty`, `serde_json`   |
| **WebRTC & Transport** | W3C WebRTC DataChannels, `werift` (Node.js test harness), DTLS 1.2, SCTP  |
| **Testing**            | Vitest, `@cloudflare/vitest-pool-workers`, Cargo test, Cross-language E2E |
| **Build & Toolchain**  | Turborepo, pnpm v12, ESLint, Prettier, Cargo Clippy, rustfmt              |

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

Run each component in a separate terminal:

```bash
# Terminal 1: Start the Backend (Cloudflare Worker on http://127.0.0.1:8787)
pnpm --filter @remote/signaling dev

# Terminal 2: Start the Web Client (Vite on http://127.0.0.1:5173)
pnpm --filter @remote/web dev

# Terminal 3: Run the Native Agent Daemon
cargo run --manifest-path apps/agent/Cargo.toml -- \
  --agent-id agent-local-01 \
  --server ws://127.0.0.1:8787/api/ws/agent \
  --credential <AGENT_CREDENTIAL> \
  --stun ""
```

_For detailed instructions on registering an agent and obtaining credentials, see the [Local Development Guide](docs/guides/development.md)._

---

## 🧪 Verification & Testing Suite

```bash
# Run all unit & component tests across the monorepo
pnpm -w test

# Run Rust unit tests (PTY multiplexing, framing, limits)
cargo test --manifest-path apps/agent/Cargo.toml

# Run TypeScript & Vue compiler checks
pnpm -w typecheck

# Run linters (ESLint & Cargo Clippy with zero warnings)
pnpm -w lint
cargo clippy --all-targets --manifest-path apps/agent/Cargo.toml -- -D warnings

# Check code formatting (Prettier & rustfmt)
pnpm format:check
cargo fmt --check --manifest-path apps/agent/Cargo.toml

# Run cross-language automated E2E integration test (Rust Agent + Worker + werift)
pnpm --filter @remote/webrtc-core test:e2e
```

---

## 🌐 API & Protocol Overview

### REST API Endpoints (`workers`)

- **Authentication**: `POST /api/auth/register`, `POST /api/auth/login`, `POST /api/auth/refresh`, `POST /api/auth/logout`.
- **Agents**: `GET /api/agents` (list online status), `POST /api/agents` (register/mint credentials), `GET /api/agents/:id`.
- **Sessions & WebRTC Signaling**:
  - `POST /api/sessions` — Initiate remote session.
  - `POST /api/sessions/:id/signal` — Send SDP offer/answer or ICE candidate.
  - `GET /api/sessions/:id/signals?cursor=<id>` — Long-polling signaling cursor for browser clients.
- **Agent WebSocket**: `GET /api/ws/agent` — Persistent bi-directional WebSocket connection for desktop agents.

### Terminal Wire Protocol (`"terminal"` DataChannel)

- `terminal-create` — Spawn pseudo-terminal session with requested columns, rows, and shell binary.
- `terminal-data` — Bi-directional base64-encoded binary chunk transport for keystrokes and PTY output.
- `terminal-resize` — Debounced viewport resizing payload (`cols`, `rows`).
- `terminal-close` — Gracefully terminate a specific terminal session.
- `terminal-exit` — Agent notification carrying child process exit code.

_Full specification available in the [Terminal Multiplexing & Wire Protocol Guide](docs/guides/terminal-protocol.md)._

---

## 📚 Documentation & Guides

- **[Documentation Index](docs/README.md)**
- **[Master Architecture Document](docs/ARCHITECTURE.md)**: Full system architecture, security models, and roadmap.
- **[Local Development Guide](docs/guides/development.md)**: Comprehensive local setup, testing, and debugging.
- **[Cloudflare Deployment Guide](docs/guides/deployment.md)**: Production deployment to Cloudflare Pages (web frontend) and Workers (backend, D1, KV).
- **[Desktop Agent Setup Guide](docs/guides/agent-setup.md)**: Building and configuring the Rust daemon as a systemd service.
- **[Terminal Multiplexing Protocol](docs/guides/terminal-protocol.md)**: Detailed wire specification for WebRTC DataChannels.

---

## 📄 License

This project is licensed under the [MIT License](LICENSE).
