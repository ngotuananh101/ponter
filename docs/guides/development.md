# Local Development Guide

Hướng dẫn chi tiết cách thiết lập, chạy, test và phát triển trên toàn bộ monorepo Ponter.

---

## 1. Prerequisites

Cài đặt các công cụ sau:

| Tool | Yêu cầu phi bản | Mục đích |
|------|-----------------|---------|
| **Node.js** | `>= 24.0.0` (LTS) | JavaScript/TypeScript runtime |
| **pnpm** | `>= 12.0.0` (`corepack enable pnpm`) | Monorepo package manager |
| **Rust & Cargo** | Stable (`>= 1.80.0`) | Native agent daemon |
| **Git** | Modern version | Version control |
| **Docker** | `>= 25.0.0` | Containerization (optional, cho testing) |

Kiểm tra môi trường:

```bash
node -v    # v24.x trở lên
pnpm -v    # 12.x trở lên
cargo -V   # cargo 1.80+ (stable)
```

---

## 2. Installation & Scaffolding

```bash
git clone https://github.com/ngotuananh101/ponter.git
cd ponter

# Cài đặt dependencies cho toàn bộ workspace
pnpm install

# Build native Rust agent (debug mode)
cargo build --manifest-path apps/agent/Cargo.toml
```

Binary được đặt tại `apps/agent/target/debug/ponter-agent`.

---

## 3. Running Services Locally

Nền tảng bao gồm ba thành phần chính chạy đồng thời:
1. **Signaling Server & REST API** (`@ponter/server` - Node.js + Hono + SQLite)
2. **Web Client** (`@ponter/web` - Vue 3 + Vite)
3. **Native Desktop Agent Daemon** (`apps/agent` - Rust)

### 3.1 Start the Backend (Node.js + Hono + SQLite)

Trong Terminal 1:

```bash
pnpm --filter @ponter/server dev
```

- **URL:** `http://127.0.0.1:8787`
- Chạy Node.js server với SQLite in-memory (hoặc file local)
- WebSocket server lắng nghe tại `ws://127.0.0.1:8787/api/ws/agent`
- Health check:
  ```bash
  curl http://127.0.0.1:8787/health
  # {"status":"ok"}
  ```

### 3.2 Start the Web Application

Trong Terminal 2:

```bash
pnpm --filter @ponter/web dev
```

- **URL:** `http://127.0.0.1:5173`
- Khởi động Vite dev server với Hot Module Replacement (HMR)
- Truy cập trong bất kỳ trình duyệt hiện đại nào

### 3.3 Register and Start the Desktop Agent

Để kết nối một agent địa phương:

1. **Đăng ký tài khoản**:
   Điều hướng tới `http://127.0.0.1:5173/register` và tạo tài khoản.

2. **Đăng ký agent**:
   Trong web dashboard, click **Add Agent** để đăng ký host mới, hoặc dùng REST API:
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
   Lưu ý `credential` trả về trong response (ví dụ: `ag_0123456789abcdef...`).

3. **Khởi động agent daemon**:
   Trong Terminal 3:
   ```bash
   cargo run --manifest-path apps/agent/Cargo.toml -- \
     --agent-id agent-local-01 \
     --server ws://127.0.0.1:8787/api/ws/agent \
     --credential <AGENT_CREDENTIAL> \
     --stun ""
   ```
   *(Truyền `--stun ""` giới hạn WebRTC ở candidate loopback cho testing offline).*

4. **Mở Terminal trong Web UI**:
   Điều hướng tới `http://127.0.0.1:5173/workspace/agent-local-01` hoặc click **Open Terminal** trên dashboard. Phiên terminal PTY sống sẽ khởi động ngay lập tức qua WebRTC DataChannel.

---

## 4. Verification & Testing

Monorepo sử dụng Turborepo để cache task và orchestrate tests.

### 4.1 Unit & Component Tests

```bash
# Chạy tất cả unit tests trên toàn bộ workspace
pnpm -w test

# Chạy tests cho @ponter/server cụ thể
pnpm --filter @ponter/server test

# Rust unit tests
cargo test --manifest-path apps/agent/Cargo.toml
```

### 4.2 Type Checking & Linting

```bash
# TypeScript & Vue compiler checks
pnpm -w typecheck

# ESLint trên web và TypeScript packages
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

Cross-language E2E test khởi động một Node.js server thực, spawn native Rust agent binary, thực hiện DTLS/SCTP handshake qua `werift`, và xác minh PTY data bidirection:

```bash
pnpm --filter @ponter/webrtc-core test:e2e
```

---

## 5. Development Workflows

### 5.1 Database Schema (SQLite)

Database schema được định nghĩa inline trong `apps/server/src/db/client.ts` thông qua hàm `runMigrations()`. Khi thay đổi schema:

1. Cập nhật định nghĩa bảng trong `apps/server/src/db/client.ts` (hoặc `apps/server/src/db/schema.ts` nếu sử dụng Drizzle ORM).
2. Chạy migration:
   ```bash
   pnpm --filter @ponter/server db:generate
   ```
3. Áp dụng migration:
   ```bash
   # SQLite tự động migrate trên startup nên không cần bước thủ công
   # Để kiểm tra schema:
   sqlite3 data/remote.db ".schema"
   ```

### 5.2 Thêm Shared Message Types

Tất cả wire protocol types và data envelope definitions nằm trong `packages/shared/src/types/`:
- `signaling.ts`: Signal payloads (`offer`, `answer`, `candidate`)
- `terminal.ts`: Terminal framing (`terminal-create`, `terminal-data`, `terminal-resize`, `terminal-close`, `terminal-exit`)
- `agent.ts`: Agent status và credential definitions

Sau khi sửa `@ponter/shared`, các packages tự động resolve updated types qua pnpm workspace references. Chạy `pnpm -w typecheck` để kiểm tra độ nhất quán.

### 5.3 Server Development Scripts

| Script | Mô tả |
|--------|-------|
| `pnpm --filter @ponter/server dev` | Chạy server ở chế độ watch (tsx) |
| `pnpm --filter @ponter/server build` | Compile TypeScript thành JS (dist/) |
| `pnpm --filter @ponter/server start` | Chạy server từ dist/ đã build |
| `pnpm --filter @ponter/server test` | Chạy vitest test suite |
| `pnpm --filter @ponter/server lint` | ESLint check |
| `pnpm --filter @ponter/server typecheck` | TypeScript type check |

### 5.4 Docker Development

Để chạy server trong container cho testing:

```bash
# Local
cd docker
docker compose -f docker-compose.local.yml up --build
```

---

## 6. Debugging Tips

### WebSocket Connection Debug

Sử dụng `wscat` để kiểm tra kết nối WebSocket:

```bash
npx wscat -c ws://127.0.0.1:8787/api/ws/agent
# Gửi: {"type":"ping"}
# Nhận: {"type":"pong"}
```

### SQLite Debug

```bash
# Mở database để query trực tiếp
sqlite3 data/remote.db

# Xem bảng agents
SELECT id, user_id, is_online, last_ping_at FROM agents;

# Xem sessions
SELECT id, user_id, agent_id, status FROM sessions;

# Xem signals
SELECT session_id, type, created_at FROM signals ORDER BY created_at DESC LIMIT 10;

# Xem revoked tokens
SELECT jti, expires_at FROM revoked_tokens;
```

### Server Logs

Server log với độ chi tiết cao:

```bash
# Chạy với DEBUG=1 để xem log chi tiết
DEBUG=1 pnpm --filter @ponter/server dev
```

Log bao gồm:
- HTTP requests
- WebSocket upgrade events
- Signal dispatch (`pushToAgent`)
- Database operations
- Authentication failures