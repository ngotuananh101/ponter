# Local Development Guide

Detailed guide on setting up, running, testing, and developing across the entire Ponter monorepo.

---

## 1. Prerequisites

Install the following tools:

| Tool | Required Version | Purpose |
|------|------------------|---------|
| **Node.js** | `>= 24.0.0` (LTS) | JavaScript/TypeScript runtime |
| **pnpm** | `>= 12.0.0` (`corepack enable pnpm`) | Monorepo package manager |
| **Rust & Cargo** | Stable (`>= 1.80.0`) | Native agent daemon |
| **Git** | Modern version | Version control |
| **Docker** | `>= 25.0.0` | Containerization (optional, for testing) |

Verify your environment:

```bash
node -v    # v24.x or higher
pnpm -v    # 12.x or higher
cargo -V   # cargo 1.80+ (stable)
```

---

## 2. Installation & Scaffolding

```bash
git clone https://github.com/ngotuananh101/ponter.git
cd ponter

# Install dependencies across the entire workspace
pnpm install

# Build native Rust agent (debug mode)
cargo build --manifest-path apps/agent/Cargo.toml
```

The binary is located at `apps/agent/target/debug/ponter-agent`.

---

## 3. Running Services Locally

The platform consists of three main components running concurrently:
1. **Signaling Server & REST API** (`@ponter/server` - Node.js + Hono + SQLite)
2. **Web Client** (`@ponter/web` - Vue 3 + Vite)
3. **Native Desktop Agent Daemon** (`apps/agent` - Rust)

### 3.1 Start the Backend (Node.js + Hono + SQLite)

In Terminal 1:

```bash
pnpm --filter @ponter/server dev
```

- **URL:** `http://127.0.0.1:8787`
- Runs Node.js server with SQLite in-memory (or local file)
- WebSocket server listens at `ws://127.0.0.1:8787/api/ws/agent`
- Health check:
  ```bash
  curl http://127.0.0.1:8787/health
  # {"status":"ok"}
  ```

### 3.2 Start the Web Application

In Terminal 2:

```bash
pnpm --filter @ponter/web dev
```

- **URL:** `http://127.0.0.1:5173`
- Starts Vite dev server with Hot Module Replacement (HMR)
- Accessible in any modern browser

### 3.3 Register and Start the Desktop Agent

To connect a local agent:

1. **Register an account**:
   Navigate to `http://127.0.0.1:5173/register` and create an account.

2. **Register the agent**:
   In the web dashboard, click **Add Agent** to register a new host, or use the REST API:
   ```bash
   curl -X POST http://127.0.0.1:8787/api/agents \
     -H "Authorization: Bearer <YOUR_ACCESS_TOKEN>" \
     -H "Content-Type: application/json" \
     -d '{
       "id": "agent-local-01",
       "publicKey": "pk_dummy_dev_key",
       "capabilities": ["terminal"]
     }'
   ```
   Note the `credential` returned in the response (e.g. `ag_0123456789abcdef...`).

3. **Start the agent daemon**:
   In Terminal 3:
   ```bash
   cargo run --manifest-path apps/agent/Cargo.toml -- \
     --agent-id agent-local-01 \
     --server ws://127.0.0.1:8787/api/ws/agent \
     --credential <AGENT_CREDENTIAL> \
     --stun ""
   ```
   *(Passing `--stun ""` restricts WebRTC to loopback candidates for offline testing).*

4. **Open Terminal in Web UI**:
   Navigate to `http://127.0.0.1:5173/workspace/agent-local-01` or click **Open Terminal** on the dashboard. A live PTY terminal session starts immediately over the WebRTC DataChannel.

---

## 4. Verification & Testing

The monorepo uses Turborepo to cache tasks and orchestrate tests.

### 4.1 Unit & Component Tests

```bash
# Run all unit tests across the entire workspace
pnpm -w test

# Run tests specifically for @ponter/server
pnpm --filter @ponter/server test

# Rust unit tests
cargo test --manifest-path apps/agent/Cargo.toml
```

### 4.2 Type Checking & Linting

```bash
# TypeScript & Vue compiler checks
pnpm -w typecheck

# ESLint on web and TypeScript packages
pnpm -w lint

# Rust Clippy (zero warnings)
cargo clippy --all-targets --manifest-path apps/agent/Cargo.toml -- -D warnings
```

### 4.3 Code Formatting

```bash
# Prettier (JS/TS)
pnpm format:check

# Rustfmt
cargo fmt --check --manifest-path apps/agent/Cargo.toml
```

### 4.4 Automated End-to-End (E2E) Integration Tests

The cross-language E2E test spins up a real Node.js server, spawns the native Rust agent binary, performs the DTLS/SCTP handshake via `werift`, and verifies bidirectional PTY data:

```bash
pnpm --filter @ponter/webrtc-core test:e2e
```

---

## 5. Development Workflows

### 5.1 Database Schema (SQLite)

Database schema is defined inline in `apps/server/src/db/client.ts` via the `runMigrations()` function. When modifying schema:

1. Update the table definition in `apps/server/src/db/client.ts` (or `apps/server/src/db/schema.ts` if using Drizzle ORM).
2. Generate migration:
   ```bash
   pnpm --filter @ponter/server db:generate
   ```
3. Apply migration:
   ```bash
   # SQLite automatically migrates on startup so no manual step is needed
   # To inspect the schema:
   sqlite3 data/remote.db ".schema"
   ```

### 5.2 Adding Shared Message Types

All wire protocol types and data envelope definitions reside in `packages/shared/src/types/`:
- `signaling.ts`: Signal payloads (`offer`, `answer`, `candidate`)
- `terminal.ts`: Terminal framing (`terminal-create`, `terminal-data`, `terminal-resize`, `terminal-close`, `terminal-exit`)
- `agent.ts`: Agent status and credential definitions

After modifying `@ponter/shared`, consumer packages automatically resolve updated types through pnpm workspace references. Run `pnpm -w typecheck` to verify consistency.

### 5.3 Server Development Scripts

| Script | Description |
|--------|-------------|
| `pnpm --filter @ponter/server dev` | Run server in watch mode (tsx) |
| `pnpm --filter @ponter/server build` | Compile TypeScript to JS (dist/) |
| `pnpm --filter @ponter/server start` | Run server from compiled dist/ |
| `pnpm --filter @ponter/server test` | Run vitest test suite |
| `pnpm --filter @ponter/server lint` | Run ESLint check |
| `pnpm --filter @ponter/server typecheck` | Run TypeScript type check |

### 5.4 Docker Development

To run the server in a container for testing:

```bash
# Local
cd docker
docker compose -f docker-compose.local.yml up --build
```

---

## 6. Debugging Tips

### WebSocket Connection Debug

Use `wscat` to verify WebSocket connectivity:

```bash
npx wscat -c ws://127.0.0.1:8787/api/ws/agent
# Send: {"type":"ping"}
# Receive: {"type":"pong"}
```

### SQLite Debug

```bash
# Open database for direct querying
sqlite3 data/remote.db

# Inspect agents table
SELECT id, user_id, is_online, last_ping_at FROM agents;

# Inspect sessions
SELECT id, user_id, agent_id, status FROM sessions;

# Inspect signals
SELECT session_id, type, created_at FROM signals ORDER BY created_at DESC LIMIT 10;

# Inspect revoked tokens
SELECT jti, expires_at FROM revoked_tokens;
```

### Server Logs

Server logs with verbose detail:

```bash
# Run with DEBUG=1 for detailed logs
DEBUG=1 pnpm --filter @ponter/server dev
```

Logs include:
- HTTP requests
- WebSocket upgrade events
- Signal dispatch (`pushToAgent`)
- Database operations
- Authentication failures

---

## 7. Building Release Artifacts from Source

This section builds a production artifact for each of the four apps. It assumes
the prerequisites from §1 (Node.js 24, pnpm 12, Rust stable). For Docker images,
see `docker/README.md`; for a fork that repoints the desktop updater, see
`docs/guides/self-hosting.md`.

### 7.1 Server (`apps/server`)

```bash
pnpm install --frozen-lockfile
pnpm --filter @ponter/server build
```

Output: `apps/server/dist/` (compiled JavaScript). Run it with:

```bash
node apps/server/dist/index.js
```

Required environment: `JWT_SECRET`, `REFRESH_TOKEN_SECRET` (each ≥ 32 chars).
`DATABASE_PATH` defaults to `:memory:` — data is lost on restart. To persist to
a file, create the directory first (the server does not create it) and point at
the file:

```bash
mkdir -p data
DATABASE_PATH=./data/remote.db node apps/server/dist/index.js
```

### 7.2 Web (`apps/web`)

```bash
pnpm --filter @ponter/web build
```

Output: `apps/web/dist/` (static assets). Set `VITE_API_URL` (and, if you use
WebSocket signaling, `VITE_BROWSER_WS_SIGNALING=true`) **before** the build —
they are compiled in. Serve `dist/` from any static host.

### 7.3 Agent (`apps/agent`)

```bash
cargo build --release --manifest-path apps/agent/Cargo.toml
```

Output: `apps/agent/target/release/ponter-agent`. See
`docs/guides/agent-setup.md` for CLI options and systemd setup.

### 7.4 Desktop (`apps/desktop`)

The desktop app is Tauri v2. A self-built copy inherits the author's updater
key/endpoint from `apps/desktop/src-tauri/tauri.conf.json` unless you change it —
read `docs/guides/self-hosting.md` first.

```bash
pnpm --filter @ponter/desktop build          # frontend assets -> apps/desktop/dist
pnpm --filter @ponter/desktop tauri build    # native bundle
```

Output: installers under `apps/desktop/src-tauri/target/release/bundle/`
(`.deb` + `.AppImage` + `.rpm` on Linux, `.dmg` on macOS, `.msi` + `.exe` on Windows).
Building a signed auto-update bundle requires your own signing key; building
without one is supported (auto-update simply stays inert). `pnpm tauri build`
needs the platform's Tauri prerequisites (system webkit/gtk packages on Linux).