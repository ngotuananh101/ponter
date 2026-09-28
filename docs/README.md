# Ponta Remote Platform Documentation

Welcome to the Ponta Remote Access Platform technical documentation.

---

## 📚 Documentation Index

### 1. Architecture & Specifications
- **[Master Architecture Document](ARCHITECTURE.md)**: Comprehensive system architecture, security invariants, data models, protocols, and multi-week roadmap.
- **[Design Specifications](superpowers/specs/)**: Detailed architectural design documents and ADRs created for each implementation milestone (Phase 1 Weeks 1–3, Phase 2 Weeks 4–6).
- **[Implementation Plans](superpowers/plans/)**: Step-by-step TDD implementation plans executed across the monorepo.

### 2. Operational & Developer Guides
- **[Local Development Guide](guides/development.md)**: Setup, running backend workers, Vue 3 web workspace, native agent, and running cross-language E2E test suites.
- **[Cloudflare Deployment Guide](guides/deployment.md)**: Production runbook for deploying the web client to Cloudflare Pages and backend services to Cloudflare Workers, D1 databases, and KV namespaces.
- **[Desktop Agent Setup Guide](guides/agent-setup.md)**: Compiling, configuring CLI options, and running the native Rust daemon interactively or as a systemd background service.
- **[Terminal Multiplexing & Wire Protocol](guides/terminal-protocol.md)**: Wire framing protocol specification (ADR-09, ADR-10) for WebRTC DataChannel shell multiplexing.

---

## 🏗️ Repository Layout

```
ponta-remote/
├── apps/
│   ├── web/               # Vue 3 + Vite + Pinia web workspace (Xterm.js, TabBar, Sidebar)
│   ├── desktop/           # Tauri 2.0 desktop shell (cross-platform desktop app)
│   ├── mobile/            # Tauri mobile shell (iOS, Android)
│   └── agent/             # Native Rust desktop agent daemon (portable-pty, webrtc-rs, tokio)
├── packages/
│   ├── shared/            # Shared TypeScript types, schemas, wire protocol models
│   ├── api-client/        # Type-safe HTTP & WebSocket client SDK
│   ├── crypto/            # Client-side cryptographic primitives (E2EE, Web Crypto keys)
│   ├── terminal-core/     # Headless pure TypeScript terminal manager (RingBuffer, TerminalClient)
│   ├── webrtc-core/       # WebRTC connection orchestration & DataChannel management
│   └── ui-components/     # Shared Vue 3 component library
├── workers/               # Unified Cloudflare Worker (REST API, Auth, D1 SQLite, KV, Signaling)
└── docs/
    ├── ARCHITECTURE.md    # Master architecture specification
    ├── README.md          # Documentation index (this file)
    ├── guides/            # Operational, setup, and protocol guides
    └── superpowers/       # Design specs and plans
```
