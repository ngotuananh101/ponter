# Local Development Guide

This guide walks you through setting up, running, testing, and developing across the entire Ponta Remote Access Platform monorepo locally.

---

## 1. Prerequisites

Ensure the following tools are installed on your workstation:

| Tool | Version Requirement | Purpose |
|------|---------------------|---------|
| **Node.js** | `>= 24.0.0` (LTS or current) | JavaScript/TypeScript runtime |
| **pnpm** | `>= 12.0.0` | Monorepo package manager (`corepack enable pnpm`) |
| **Rust & Cargo** | Stable (`>= 1.80.0`) | Native agent daemon & Tauri client development |
| **Git** | Modern version | Version control |

Verify your environment:

```bash
node -v    # v24.x or later
pnpm -v    # 12.x or later
cargo -V   # cargo 1.80+ (stable)
```

---

## 2. Installation & Scaffolding

Clone the repository and install all workspace dependencies:

```bash
git clone https://github.com/ngotuananh101/ponta-remote.git
cd ponta-remote

# Install dependencies across all 11 packages and apps
pnpm install
```

Build the native Rust agent binary in debug mode:

```bash
cargo build --manifest-path apps/agent/Cargo.toml
```

The compiled binary will be placed at `apps/agent/target/debug/remote-agent`.

---

## 3. Running Services Locally

The platform consists of three core components running concurrently:
1. **Signaling Server & REST API** (`workers/`)
2. **Web Client Workspace** (`apps/web`)
3. **Native Desktop Agent Daemon** (`apps/agent`)

### 3.1 Start the Backend (Signaling & REST API)

In Terminal 1:

```bash
pnpm --filter @remote/signaling dev
```

- **URL:** `http://127.0.0.1:8787`
- Runs a local Cloudflare Worker instance via Wrangler Miniflare with in-memory/local SQLite (D1) and KV storage.
- Health check:
  ```bash
  curl http://127.0.0.1:8787/health
  # {"status":"ok"}
  ```

### 3.2 Start the Web Application

In Terminal 2:

```bash
pnpm --filter @remote/web dev
```

- **URL:** `http://127.0.0.1:5173`
- Starts Vite dev server with Hot Module Replacement (HMR).
- Accessible in any modern browser.

### 3.3 Register and Start the Desktop Agent

To connect a local desktop agent to your development stack:

1. **Register a User Account**:
   Navigate to `http://127.0.0.1:5173/register` and create an account.

2. **Register an Agent**:
   In the web dashboard, click **Add Agent** to register a new host, or use the REST API:
   ```bash
   # Retrieve your auth token after login, then:
   curl -X POST http://127.0.0.1:8787/api/agents \
     -H "Authorization: Bearer <YOUR_ACCESS_TOKEN>" \
     -H "Content-Type: application/json" \
     -d '{
       "id": "agent-local-01",
       "publicKey": "pk_dummy_dev_key",
       "capabilities": ["terminal"]
     }'
   ```
   Note the `credential` returned in the response (e.g., `ag_0123456789abcdef...`).

3. **Start the Agent Daemon**:
   In Terminal 3:
   ```bash
   cargo run --manifest-path apps/agent/Cargo.toml -- \
     --agent-id agent-local-01 \
     --server ws://127.0.0.1:8787/api/ws/agent \
     --credential <AGENT_CREDENTIAL> \
     --stun ""
   ```
   *(Passing `--stun ""` restricts WebRTC to loopback candidates for local offline testing).*

4. **Open Terminal in Web UI**:
   Navigate to `http://127.0.0.1:5173/workspace/agent-local-01` or click **Open Terminal** on the dashboard. A live PTY terminal session multiplexed over WebRTC DataChannel will launch immediately.

---

## 4. Verification & Testing

The monorepo uses Turborepo for task caching and orchestrates tests across TypeScript, Vue, and Rust.

### 4.1 Unit & Component Tests

Run tests across all packages:

```bash
# Run all unit tests
pnpm -w test

# Run Rust unit tests specifically
cargo test --manifest-path apps/agent/Cargo.toml
```

### 4.2 Type Checking & Linting

```bash
# Run TypeScript and Vue compiler checks across all packages
pnpm -w typecheck

# Run ESLint across web and TypeScript packages
pnpm -w lint

# Run Rust Clippy checks (enforcing zero warnings)
cargo clippy --all-targets --manifest-path apps/agent/Cargo.toml -- -D warnings

# Check code formatting (Prettier & Rustfmt)
pnpm format:check
cargo fmt --check --manifest-path apps/agent/Cargo.toml
```

### 4.3 Automated End-to-End (E2E) Integration Tests

The cross-language E2E test spins up a real Wrangler dev worker, spawns the native Rust agent binary, initiates DTLS/SCTP handshakes via Node.js (`werift`), and verifies bidirectional PTY data and window resizing:

```bash
pnpm --filter @remote/webrtc-core test:e2e
```

---

## 5. Development Workflows

### 5.1 Database Migrations (D1 & Drizzle)

The SQLite schema lives in `workers/src/db/schema.ts`. When making schema changes:

1. Update table definitions in `workers/src/db/schema.ts`.
2. Generate migration SQL files:
   ```bash
   pnpm --filter @remote/signaling db:generate
   ```
3. Apply migration to local D1 instance:
   ```bash
   pnpm --filter @remote/signaling exec wrangler d1 migrations apply remote-access --local
   ```

### 5.2 Adding Shared Message Types

All wire protocol types and data envelope definitions reside in `packages/shared/src/types/`:
- `signaling.ts`: Signaling payloads (`offer`, `answer`, `candidate`).
- `terminal.ts`: Terminal wire framing (`terminal-create`, `terminal-data`, `terminal-resize`, `terminal-close`, `terminal-exit`).
- `agent.ts`: Agent status and credential definitions.

After modifying `@remote/shared`, packages automatically resolve updated types via pnpm workspace references. Run `pnpm -w typecheck` to verify consistency.
