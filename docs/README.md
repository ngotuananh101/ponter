# Ponter Documentation

Welcome to the Ponter technical documentation.

---

## 📚 Documentation Index

### 1. Architecture & Specifications

- **[Master Architecture Document](ARCHITECTURE.md)**: Comprehensive system architecture, security invariants, data models, protocols, and roadmap.
- **[Security Audit — E2EE & Zero-Trust (2026-10-01)](security/2026-10-01-e2ee-zero-trust-audit.md)**: Adversarially verified audit findings (28 confirmed gaps with file:line evidence) and the Phase 5 (E2EE & Security & Polish) work list.
- **[Design Specifications](superpowers/specs/)**: Detailed architectural design documents and ADRs created for implementation milestones.
- **[Implementation Plans](superpowers/plans/)**: Step-by-step implementation plans executed across the monorepo.

### 2. Operational & Developer Guides

- **[Local Development Guide](guides/development.md)**: Setup, running the backend (`@ponter/server`), Vue 3 web workspace, native agent, and cross-language E2E tests.
- **[Deployment Guide](guides/deployment.md)**: All-in-one self-hosted Docker deployment publishing port 8080 (standard and Coturn TURN relay setups).
- **[Self-Hosting & Fork Guide](guides/self-hosting.md)**: Fork the repo, repoint or disable the desktop updater, and build/publish your own Docker image.
- **[Desktop Agent Setup Guide](guides/agent-setup.md)**: Compiling, configuring CLI options, and running the native Rust daemon interactively or as a systemd background service.
- **[Terminal Multiplexing & Wire Protocol](guides/terminal-protocol.md)**: Wire framing protocol specification for WebRTC DataChannel shell multiplexing.

---

## 🏗️ Repository Layout

```
ponter/
├── apps/
│   ├── web/               # Vue 3 + Vite + Pinia web workspace (Xterm.js, TabBar, Sidebar)
│   ├── desktop/           # Native egui/eframe desktop shell (pure Rust, cross-platform)
│   ├── mobile/            # Tauri mobile shell (iOS, Android)
│   ├── agent/             # Native Rust desktop agent daemon (portable-pty, webrtc-rs, tokio)
│   └── server/            # Self-hosted backend (@ponter/server): Node.js 24 + Hono + SQLite + ws
├── packages/
│   ├── shared/            # Shared TypeScript types, schemas, and wire protocol models
│   ├── api-client/        # Type-safe HTTP & WebSocket client SDK with token auto-refresh
│   ├── crypto/            # Web Crypto key generation & local key storage (E2EE planned, Phase 5)
│   ├── terminal-core/     # Headless pure TypeScript terminal manager (RingBuffer, TerminalClient)
│   ├── webrtc-core/       # WebRTC connection orchestration & DataChannel management
│   └── ui-components/     # Shared Vue 3 UI component library
├── docker/                # All-in-one Docker packaging (Backend + Web + Nginx)
│   ├── Dockerfile         # Multi-stage build (node:24-alpine)
│   ├── docker-compose.yml # Standard all-in-one deployment (port 8080)
│   ├── docker-compose.coturn.yml # Production VPS with integrated Coturn TURN
│   ├── nginx.web.conf     # Reverse proxy & static SPA configuration
│   ├── supervisord.conf   # Process supervisor configuration
│   ├── entrypoint.sh      # Container entrypoint & runtime config generator
│   ├── .env.example
│   └── README.md
├── docs/
│   ├── ARCHITECTURE.md    # Master architecture specification
│   ├── README.md          # Documentation index (this file)
│   ├── guides/            # Operational, setup, and protocol guides
│   └── superpowers/       # Design specs and plans
├── package.json           # Root package.json (workspaces)
├── pnpm-workspace.yaml    # pnpm workspace config
├── turbo.json             # Turborepo config
└── tsconfig.base.json     # Base TS config
```