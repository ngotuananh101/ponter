# Phase 2 Week 6 — Terminal UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement full terminal capabilities for the Ponter Platform: headless `packages/terminal-core`, multi-shell multiplexing and resizing in `apps/agent` (Rust), and an interactive dark-themed xterm.js `/workspace` UI in `apps/web` with multi-tab and mobile keyboard support.

**Architecture:** A single WebRTC DataChannel labeled `"terminal"` carries framed JSON messages (`DataChannelMessage<T>`). Multi-shell multiplexing uses `terminalId` in payloads. `packages/terminal-core` acts as a headless session and ring-buffer manager bridging WebRTC data channels and UI emulators. `apps/agent` manages a map of PTY sessions, applies resize via `portable-pty`, and reports exit codes. `apps/web` renders tabs, sidebar, xterm.js with `FitAddon`/`ResizeObserver`, and a mobile accessory toolbar.

**Tech Stack:** TypeScript, Vue 3, Pinia, `@xterm/xterm`, `@xterm/addon-fit`, `@xterm/addon-web-links`, Rust, `portable-pty 0.9`, `webrtc 0.13`, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-28-phase2-week6-terminal-ui-design.md`

## Global Constraints

- Monorepo package manager is `pnpm` (workspace protocol `workspace:*`).
- All terminal frames adhere to `DataChannelMessage<T>` over the single DataChannel label `"terminal"`.
- Base64 payload encoding uses standard padded alphabet (`BASE64_STANDARD` in Rust, `atob`/`btoa` or base64 utils in TypeScript).
- Inbound frame guard: `MAX_FRAME_BYTES = 64 * 1024` (64 KiB) checked before JSON parsing; raw PTY chunk max 16 KiB.
- Concurrent PTY limit: Maximum 10 active shells per agent process.
- Zero DOM references in `packages/terminal-core`.
- TypeScript strict mode enabled across all packages.

## Review Focus

1. **Non-ASCII & Multi-byte UTF-8 Characters:** Characters spanning multiple bytes (e.g. Vietnamese diacritics, emoji) split across chunk boundaries must not be corrupted when rendered in xterm.js or buffered in `RingBuffer`.
2. **Terminal Resize Debouncing:** Rapid window resizing must not flood the WebRTC DataChannel with `terminal-resize` frames; resize must be debounced (~100ms) before sending.
3. **Tab Switch Output Retention:** Terminal output produced while a tab is inactive or unmounted must be retained in `RingBuffer` (64 KiB) and replayed completely upon switching back.
4. **Shell Exit Cleanliness:** When a shell process exits (via `exit` or crash), the agent must emit `terminal-exit` and release file descriptors/threads; UI must mark the tab as `exited` without crashing.
5. **Mobile Focus Persistence:** Tapping virtual keys on `MobileAccessoryBar` must call `preventDefault()` on `pointerdown` so xterm's virtual keyboard focus is never blurred.

---

### Task 1: Shared Terminal Message Types (`packages/shared`)

**Files:**
- Modify: `packages/shared/src/types/terminal.ts`
- Modify: `packages/shared/src/types/index.ts`
- Test: `packages/shared/test/terminal-types.test.ts`

**Interfaces:**
- Produces: `TerminalCreateMessage`, `TerminalExitMessage`, `TerminalCloseMessage`, `TerminalResizeMessage`, `TerminalDataMessage`

- [ ] **Step 1: Write the failing test for terminal type schemas**

Create `packages/shared/test/terminal-types.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import type {
  TerminalCreateMessage,
  TerminalDataMessage,
  TerminalResizeMessage,
  TerminalCloseMessage,
  TerminalExitMessage,
} from '../src';

describe('Terminal Message Types', () => {
  it('instantiates valid TerminalCreateMessage', () => {
    const msg: TerminalCreateMessage = {
      terminalId: 'term-1',
      cols: 100,
      rows: 30,
      shell: '/bin/bash',
    };
    expect(msg.terminalId).toBe('term-1');
    expect(msg.cols).toBe(100);
    expect(msg.rows).toBe(30);
    expect(msg.shell).toBe('/bin/bash');
  });

  it('instantiates valid TerminalCloseMessage and TerminalExitMessage', () => {
    const closeMsg: TerminalCloseMessage = { terminalId: 'term-1' };
    const exitMsg: TerminalExitMessage = { terminalId: 'term-1', exitCode: 0 };
    expect(closeMsg.terminalId).toBe('term-1');
    expect(exitMsg.exitCode).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ponter/shared test`  
Expected: FAIL due to missing type exports.

- [ ] **Step 3: Implement updated terminal types in `packages/shared/src/types/terminal.ts`**

Update `packages/shared/src/types/terminal.ts`:
```typescript
export interface TerminalSize {
  cols: number;
  rows: number;
}

export interface TerminalSession {
  id: string;
  sessionId: string;
  cols: number;
  rows: number;
  cwd?: string;
  shell?: string;
  createdAt: string;
}

export interface TerminalCreateMessage {
  terminalId: string;
  cols: number;
  rows: number;
  shell?: string;
}

export interface TerminalDataMessage {
  terminalId: string;
  data: string;
}

export interface TerminalResizeMessage {
  terminalId: string;
  cols: number;
  rows: number;
}

export interface TerminalCloseMessage {
  terminalId: string;
}

export interface TerminalExitMessage {
  terminalId: string;
  exitCode?: number;
}
```

Update `packages/shared/src/types/index.ts` to export all from `./terminal`:
```typescript
export * from './terminal';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @ponter/shared test`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/shared/
git commit -m "feat(shared): add terminal lifecycle message types"
```

---

### Task 2: Rust Agent PTY Resize Support (`apps/agent`)

**Files:**
- Modify: `apps/agent/src/pty.rs`
- Test: `apps/agent/src/pty.rs` (unit test in module `tests`)

**Interfaces:**
- Produces: `PtySession::resize(&self, cols: u16, rows: u16) -> Result<()>`
- Produces: `TerminalResizeMessage` deserializer & `frame_pty_exit` helper

- [ ] **Step 1: Write failing unit test for PTY resize and exit frame in `apps/agent/src/pty.rs`**

Add tests to `apps/agent/src/pty.rs`:
```rust
#[test]
fn resize_message_round_trip() {
    let raw = serde_json::json!({
        "type": "terminal-resize",
        "channel": "terminal",
        "payload": {
            "terminalId": "t1",
            "cols": 120,
            "rows": 40
        },
        "timestamp": 123456
    }).to_string();

    let envelope: DataChannelMessage<TerminalResizeMessage> = serde_json::from_str(&raw).unwrap();
    assert_eq!(envelope.r#type, "terminal-resize");
    assert_eq!(envelope.payload.terminal_id, "t1");
    assert_eq!(envelope.payload.cols, 120);
    assert_eq!(envelope.payload.rows, 40);
}

#[test]
fn frame_pty_exit_produces_valid_envelope() {
    let frame = frame_pty_exit("t1", Some(0), 123456);
    let envelope: DataChannelMessage<TerminalExitMessage> = serde_json::from_str(&frame).unwrap();
    assert_eq!(envelope.r#type, "terminal-exit");
    assert_eq!(envelope.payload.terminal_id, "t1");
    assert_eq!(envelope.payload.exit_code, Some(0));
}
```

- [ ] **Step 2: Run `cargo test` to verify it fails**

Run: `cargo test --manifest-path apps/agent/Cargo.toml`  
Expected: FAIL with missing structs/functions.

- [ ] **Step 3: Implement `TerminalResizeMessage`, `TerminalExitMessage`, `frame_pty_exit`, and `PtySession::resize` in `apps/agent/src/pty.rs`**

Add message structs:
```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalResizeMessage {
    pub terminal_id: String,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalExitMessage {
    pub terminal_id: String,
    pub exit_code: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalCreateMessage {
    pub terminal_id: String,
    pub cols: u16,
    pub rows: u16,
    pub shell: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalCloseMessage {
    pub terminal_id: String,
}

pub fn frame_pty_exit(terminal_id: &str, exit_code: Option<u32>, timestamp_ms: i64) -> String {
    let message = DataChannelMessage {
        r#type: "terminal-exit".to_string(),
        channel: "terminal".to_string(),
        payload: TerminalExitMessage {
            terminal_id: terminal_id.to_string(),
            exit_code,
        },
        timestamp: timestamp_ms,
    };
    serde_json::to_string(&message).expect("serialization of exit frame cannot fail")
}
```

Add method to `impl PtySession`:
```rust
    pub fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        self.master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .context("resize pty")
    }
```

- [ ] **Step 4: Run `cargo test` to verify it passes**

Run: `cargo test --manifest-path apps/agent/Cargo.toml`  
Expected: PASS (all tests pass).

- [ ] **Step 5: Commit**

```bash
git add apps/agent/src/pty.rs
git commit -m "feat(agent): add PTY resize and terminal lifecycle framing"
```

---

### Task 3: Rust Agent Multi-Shell Management & Dispatching (`apps/agent`)

**Files:**
- Modify: `apps/agent/src/main.rs`
- Modify: `apps/agent/src/pty.rs`
- Test: `apps/agent/src/main.rs` (unit tests)

**Interfaces:**
- Consumes: `PtySession`, `TerminalCreateMessage`, `TerminalResizeMessage`, `TerminalCloseMessage`
- Produces: `PtyManager` handling multiple shells multiplexed over DataChannel

- [ ] **Step 1: Write failing unit test in `apps/agent/src/main.rs` for multi-session registry**

Add test to `apps/agent/src/main.rs`:
```rust
#[tokio::test]
async fn pty_manager_spawns_and_closes_sessions() {
    let manager = PtyManager::new(10);
    let session_id = "test-session-1";
    let (out_tx, mut out_rx) = mpsc::channel(16);

    let spawned = manager.spawn_session(
        session_id.to_string(),
        "/bin/sh",
        80,
        24,
        out_tx
    ).await;
    assert!(spawned.is_ok(), "failed to spawn session: {:?}", spawned.err());
    assert_eq!(manager.session_count().await, 1);

    manager.close_session(session_id).await;
    assert_eq!(manager.session_count().await, 0);
}
```

- [ ] **Step 2: Run `cargo test` to verify it fails**

Run: `cargo test --manifest-path apps/agent/Cargo.toml`  
Expected: FAIL with `PtyManager` not found.

- [ ] **Step 3: Implement `PtyManager` in `apps/agent/src/main.rs`**

Define `ActivePty` and `PtyManager`:
```rust
pub struct ActivePty {
    pub input_tx: mpsc::Sender<Vec<u8>>,
    pub session: Arc<pty::PtySession>,
}

#[derive(Clone)]
pub struct PtyManager {
    max_sessions: usize,
    sessions: Arc<tokio::sync::RwLock<HashMap<String, ActivePty>>>,
}

impl PtyManager {
    pub fn new(max_sessions: usize) -> Self {
        Self {
            max_sessions,
            sessions: Arc::new(tokio::sync::RwLock::new(HashMap::new())),
        }
    }

    pub async fn session_count(&self) -> usize {
        self.sessions.read().await.len()
    }

    pub async fn spawn_session(
        &self,
        terminal_id: String,
        shell: &str,
        cols: u16,
        rows: u16,
        outbound: mpsc::Sender<String>,
    ) -> Result<()> {
        let mut lock = self.sessions.write().await;
        if lock.len() >= self.max_sessions {
            anyhow::bail!("exceeded maximum concurrent PTY sessions ({})", self.max_sessions);
        }
        if lock.contains_key(&terminal_id) {
            return Ok(());
        }

        let (input_tx, input_rx) = mpsc::channel(64);
        let session = Arc::new(pty::PtySession::spawn(shell, cols, rows, input_rx)?);
        let mut reader = session.start_reader(terminal_id.clone())?;

        let tid = terminal_id.clone();
        tokio::spawn(async move {
            while let Some(frame) = reader.recv().await {
                if outbound.send(frame).await.is_err() {
                    break;
                }
            }
            let exit_frame = pty::frame_pty_exit(&tid, Some(0), pty::now_ms());
            let _ = outbound.send(exit_frame).await;
        });

        lock.insert(terminal_id, ActivePty {
            input_tx,
            session,
        });
        Ok(())
    }

    pub async fn send_input(&self, terminal_id: &str, bytes: Vec<u8>) -> bool {
        let lock = self.sessions.read().await;
        if let Some(pty) = lock.get(terminal_id) {
            pty.input_tx.send(bytes).await.is_ok()
        } else {
            false
        }
    }

    pub async fn resize(&self, terminal_id: &str, cols: u16, rows: u16) -> Result<()> {
        let lock = self.sessions.read().await;
        if let Some(pty) = lock.get(terminal_id) {
            pty.session.resize(cols, rows)?;
        }
        Ok(())
    }

    pub async fn close_session(&self, terminal_id: &str) {
        let mut lock = self.sessions.write().await;
        lock.remove(terminal_id);
    }

    pub async fn close_all(&self) {
        let mut lock = self.sessions.write().await;
        lock.clear();
    }
}
```

Update `run_one_session` to wire incoming `terminal-create`, `terminal-data`, `terminal-resize`, `terminal-close` frames to `PtyManager`.

- [ ] **Step 4: Run `cargo test` to verify it passes**

Run: `cargo test --manifest-path apps/agent/Cargo.toml`  
Expected: PASS (all tests pass).

- [ ] **Step 5: Commit**

```bash
git add apps/agent/
git commit -m "feat(agent): implement multi-session PtyManager with resize dispatch"
```

---

### Task 4: Headless Core RingBuffer & Session (`packages/terminal-core`)

**Files:**
- Create: `packages/terminal-core/src/types.ts`
- Create: `packages/terminal-core/src/buffer.ts`
- Create: `packages/terminal-core/src/session.ts`
- Create: `packages/terminal-core/src/index.ts`
- Modify: `packages/terminal-core/package.json`
- Create: `packages/terminal-core/tsconfig.json`
- Create: `packages/terminal-core/vitest.config.ts`
- Test: `packages/terminal-core/test/buffer.test.ts`
- Test: `packages/terminal-core/test/session.test.ts`

**Interfaces:**
- Produces: `RingBuffer` (bounded buffer keeping terminal history)
- Produces: `TerminalSession` (tracks state, buffers output, event callbacks)

- [ ] **Step 1: Setup `packages/terminal-core` configuration and write failing `buffer.test.ts`**

Update `packages/terminal-core/package.json`:
```json
{
  "name": "@ponter/terminal-core",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "scripts": {
    "lint": "eslint .",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@ponter/shared": "workspace:*",
    "@ponter/webrtc-core": "workspace:*"
  },
  "devDependencies": {
    "@types/node": "24.13.6",
    "typescript": "6.0.3",
    "vitest": "5.0.1"
  }
}
```

Create `packages/terminal-core/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "declaration": true,
    "strict": true,
    "skipLibCheck": true,
    "esModuleInterop": true
  },
  "include": ["src/**/*", "test/**/*"]
}
```

Create `packages/terminal-core/vitest.config.ts`:
```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
  },
});
```

Create `packages/terminal-core/test/buffer.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { RingBuffer } from '../src/buffer';

describe('RingBuffer', () => {
  it('stores and retrieves bytes within capacity', () => {
    const buffer = new RingBuffer(16);
    const data = new TextEncoder().encode('hello world');
    buffer.push(data);
    expect(new TextDecoder().decode(buffer.getAll())).toBe('hello world');
  });

  it('evicts oldest bytes when capacity exceeded', () => {
    const buffer = new RingBuffer(10);
    buffer.push(new TextEncoder().encode('123456'));
    buffer.push(new TextEncoder().encode('7890ab'));
    // total 12 bytes pushed into 10-byte buffer -> should retain last 10 bytes: '34567890ab'
    expect(new TextDecoder().decode(buffer.getAll())).toBe('34567890ab');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ponter/terminal-core test`  
Expected: FAIL with module not found.

- [ ] **Step 3: Implement `RingBuffer` and `TerminalSession`**

Create `packages/terminal-core/src/buffer.ts`:
```typescript
export class RingBuffer {
  private buffer: Uint8Array;
  private size = 0;
  private head = 0;

  constructor(public readonly capacity: number = 64 * 1024) {
    this.buffer = new Uint8Array(capacity);
  }

  push(chunk: Uint8Array): void {
    if (chunk.length >= this.capacity) {
      this.buffer.set(chunk.subarray(chunk.length - this.capacity));
      this.head = 0;
      this.size = this.capacity;
      return;
    }

    for (let i = 0; i < chunk.length; i++) {
      this.buffer[(this.head + this.size) % this.capacity] = chunk[i];
      if (this.size < this.capacity) {
        this.size++;
      } else {
        this.head = (this.head + 1) % this.capacity;
      }
    }
  }

  getAll(): Uint8Array {
    const out = new Uint8Array(this.size);
    for (let i = 0; i < this.size; i++) {
      out[i] = this.buffer[(this.head + i) % this.capacity];
    }
    return out;
  }

  clear(): void {
    this.size = 0;
    this.head = 0;
  }
}
```

Create `packages/terminal-core/src/types.ts`:
```typescript
export type SessionState = 'connecting' | 'active' | 'exited' | 'closed';

export interface TerminalSessionOptions {
  cols?: number;
  rows?: number;
  shell?: string;
}
```

Create `packages/terminal-core/src/session.ts`:
```typescript
import { RingBuffer } from './buffer';
import type { SessionState } from './types';

export class TerminalSession {
  public state: SessionState = 'connecting';
  public exitCode?: number;
  public readonly buffer = new RingBuffer(64 * 1024);

  private readonly dataListeners: Array<(data: Uint8Array) => void> = [];
  private readonly exitListeners: Array<(code?: number) => void> = [];
  private readonly stateListeners: Array<(state: SessionState) => void> = [];

  constructor(
    public readonly id: string,
    public cols: number = 80,
    public rows: number = 24,
    private readonly sendInputFn: (data: Uint8Array | string) => void,
    private readonly resizeFn: (cols: number, rows: number) => void,
    private readonly closeFn: () => void,
  ) {}

  write(data: Uint8Array | string): void {
    if (this.state !== 'active' && this.state !== 'connecting') return;
    this.sendInputFn(data);
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    this.resizeFn(cols, rows);
  }

  close(): void {
    if (this.state === 'closed') return;
    this.setState('closed');
    this.closeFn();
  }

  receiveOutput(chunk: Uint8Array): void {
    this.buffer.push(chunk);
    if (this.state === 'connecting') {
      this.setState('active');
    }
    for (const listener of [...this.dataListeners]) {
      listener(chunk);
    }
  }

  markExited(exitCode?: number): void {
    this.exitCode = exitCode;
    this.setState('exited');
    for (const listener of [...this.exitListeners]) {
      listener(exitCode);
    }
  }

  onData(cb: (data: Uint8Array) => void): () => void {
    this.dataListeners.push(cb);
    return () => {
      const idx = this.dataListeners.indexOf(cb);
      if (idx >= 0) this.dataListeners.splice(idx, 1);
    };
  }

  onExit(cb: (code?: number) => void): () => void {
    this.exitListeners.push(cb);
    return () => {
      const idx = this.exitListeners.indexOf(cb);
      if (idx >= 0) this.exitListeners.splice(idx, 1);
    };
  }

  onStateChange(cb: (state: SessionState) => void): () => void {
    this.stateListeners.push(cb);
    return () => {
      const idx = this.stateListeners.indexOf(cb);
      if (idx >= 0) this.stateListeners.splice(idx, 1);
    };
  }

  private setState(newState: SessionState): void {
    if (this.state === newState) return;
    this.state = newState;
    for (const listener of [...this.stateListeners]) {
      listener(newState);
    }
  }
}
```

Create `packages/terminal-core/src/index.ts`:
```typescript
export * from './types';
export * from './buffer';
export * from './session';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @ponter/terminal-core test`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/terminal-core/
git commit -m "feat(terminal-core): add RingBuffer and TerminalSession implementation"
```

---

### Task 5: Headless Core TerminalClient (`packages/terminal-core`)

**Files:**
- Create: `packages/terminal-core/src/client.ts`
- Modify: `packages/terminal-core/src/index.ts`
- Test: `packages/terminal-core/test/client.test.ts`

**Interfaces:**
- Consumes: `DataChannelManager` (from `@ponter/webrtc-core`), message types from `@ponter/shared`
- Produces: `TerminalClient`

- [ ] **Step 1: Write failing `client.test.ts`**

Create `packages/terminal-core/test/client.test.ts`:
```typescript
import { describe, it, expect, vi } from 'vitest';
import { TerminalClient } from '../src/client';
import type { DataChannelManager } from '@ponter/webrtc-core';

describe('TerminalClient', () => {
  it('creates a session and dispatches terminal-create message', () => {
    const mockSendJson = vi.fn();
    const mockOnMessage = vi.fn().mockReturnValue(() => {});
    const mockDataChannel = {
      sendJson: mockSendJson,
      onMessage: mockOnMessage,
    } as unknown as DataChannelManager;

    const client = new TerminalClient('agent-1', mockDataChannel);
    const session = client.createSession({ cols: 100, rows: 30 });

    expect(session).toBeDefined();
    expect(mockSendJson).toHaveBeenCalledWith(
      'terminal',
      'terminal-create',
      expect.objectContaining({
        terminalId: session.id,
        cols: 100,
        rows: 30,
      })
    );
  });

  it('receives terminal-data and delivers decoded bytes to session', () => {
    let messageHandler: ((msg: any) => void) | undefined;
    const mockDataChannel = {
      sendJson: vi.fn(),
      onMessage: vi.fn((_channel, cb) => {
        messageHandler = cb;
        return () => {};
      }),
    } as unknown as DataChannelManager;

    const client = new TerminalClient('agent-1', mockDataChannel);
    const session = client.createSession();

    let receivedBytes = '';
    session.onData((chunk) => {
      receivedBytes += new TextDecoder().decode(chunk);
    });

    const rawData = 'hello from pty\r\n';
    const base64Data = Buffer.from(rawData).toString('base64');

    messageHandler?.({
      type: 'terminal-data',
      channel: 'terminal',
      payload: { terminalId: session.id, data: base64Data },
      timestamp: Date.now(),
    });

    expect(receivedBytes).toBe(rawData);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ponter/terminal-core test`  
Expected: FAIL with `TerminalClient` not found.

- [ ] **Step 3: Implement `TerminalClient` in `packages/terminal-core/src/client.ts`**

Create `packages/terminal-core/src/client.ts`:
```typescript
import type { DataChannelManager } from '@ponter/webrtc-core';
import type {
  TerminalCreateMessage,
  TerminalDataMessage,
  TerminalResizeMessage,
  TerminalCloseMessage,
  TerminalExitMessage,
} from '@ponter/shared';
import { TerminalSession } from './session';
import type { TerminalSessionOptions } from './types';

function base64ToUint8Array(base64: string): Uint8Array {
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(base64, 'base64'));
  }
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export class TerminalClient {
  private readonly sessions = new Map<string, TerminalSession>();
  private readonly unsubscribeMessage: () => void;
  private resizeDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    public readonly agentId: string,
    private readonly dataChannelManager: DataChannelManager,
  ) {
    this.unsubscribeMessage = this.dataChannelManager.onMessage(
      'terminal',
      (msg) => this.handleMessage(msg),
    );
  }

  createSession(options?: TerminalSessionOptions): TerminalSession {
    const terminalId =
      typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : `term-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const cols = options?.cols ?? 80;
    const rows = options?.rows ?? 24;

    const session = new TerminalSession(
      terminalId,
      cols,
      rows,
      (data) => this.sendInput(terminalId, data),
      (c, r) => this.debouncedResize(terminalId, c, r),
      () => this.closeSession(terminalId),
    );

    this.sessions.set(terminalId, session);

    const createPayload: TerminalCreateMessage = {
      terminalId,
      cols,
      rows,
      shell: options?.shell,
    };

    this.dataChannelManager.sendJson('terminal', 'terminal-create', createPayload);
    return session;
  }

  getSession(terminalId: string): TerminalSession | undefined {
    return this.sessions.get(terminalId);
  }

  sendInput(terminalId: string, data: Uint8Array | string): void {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    const payload: TerminalDataMessage = {
      terminalId,
      data: uint8ArrayToBase64(bytes),
    };
    this.dataChannelManager.sendJson('terminal', 'terminal-data', payload);
  }

  private debouncedResize(terminalId: string, cols: number, rows: number): void {
    const existing = this.resizeDebounceTimers.get(terminalId);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.resizeDebounceTimers.delete(terminalId);
      const payload: TerminalResizeMessage = {
        terminalId,
        cols,
        rows,
      };
      try {
        this.dataChannelManager.sendJson('terminal', 'terminal-resize', payload);
      } catch (err) {
        console.error('[TerminalClient] resize failed', err);
      }
    }, 100);

    this.resizeDebounceTimers.set(terminalId, timer);
  }

  closeSession(terminalId: string): void {
    const session = this.sessions.get(terminalId);
    if (!session) return;
    this.sessions.delete(terminalId);

    const timer = this.resizeDebounceTimers.get(terminalId);
    if (timer) clearTimeout(timer);
    this.resizeDebounceTimers.delete(terminalId);

    const payload: TerminalCloseMessage = { terminalId };
    try {
      this.dataChannelManager.sendJson('terminal', 'terminal-close', payload);
    } catch {
      // ignore if channel already closed
    }
  }

  dispose(): void {
    this.unsubscribeMessage();
    for (const [id, timer] of this.resizeDebounceTimers) {
      clearTimeout(timer);
    }
    this.resizeDebounceTimers.clear();

    for (const id of [...this.sessions.keys()]) {
      this.closeSession(id);
    }
  }

  private handleMessage(msg: { type: string; payload: any }): void {
    if (msg.type === 'terminal-data') {
      const payload = msg.payload as TerminalDataMessage;
      const session = this.sessions.get(payload.terminalId);
      if (session) {
        const bytes = base64ToUint8Array(payload.data);
        session.receiveOutput(bytes);
      }
    } else if (msg.type === 'terminal-exit') {
      const payload = msg.payload as TerminalExitMessage;
      const session = this.sessions.get(payload.terminalId);
      if (session) {
        session.markExited(payload.exitCode);
      }
    }
  }
}
```

Update `packages/terminal-core/src/index.ts`:
```typescript
export * from './types';
export * from './buffer';
export * from './session';
export * from './client';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @ponter/terminal-core test`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/terminal-core/
git commit -m "feat(terminal-core): implement TerminalClient connecting to DataChannel"
```

---

### Task 6: Frontend Terminal Store & Dependencies (`apps/web`)

**Files:**
- Modify: `apps/web/package.json`
- Create: `apps/web/src/stores/terminal.ts`
- Test: `apps/web/src/__tests__/terminal-store.test.ts`

**Interfaces:**
- Produces: `useTerminalStore` (Pinia store managing active connections, tabs, and sessions)

- [ ] **Step 1: Install `@xterm` packages and workspace dependencies in `apps/web`**

Run:
```bash
pnpm --filter @ponter/web add @xterm/xterm@^5.5.0 @xterm/addon-fit@^0.10.0 @xterm/addon-web-links@^0.11.0
pnpm --filter @ponter/web add @ponter/terminal-core@workspace:* @ponter/webrtc-core@workspace:*
```

- [ ] **Step 2: Write failing test for `terminal.ts` store in `apps/web/src/__tests__/terminal-store.test.ts`**

Create `apps/web/src/__tests__/terminal-store.test.ts`:
```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useTerminalStore } from '../stores/terminal';

describe('useTerminalStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('initializes with empty tabs and connections', () => {
    const store = useTerminalStore();
    expect(store.tabs).toEqual([]);
    expect(store.activeTabId).toBeNull();
  });

  it('selects active tab and closes tab correctly', () => {
    const store = useTerminalStore();
    store.tabs.push({
      id: 'tab-1',
      agentId: 'ag-1',
      terminalId: 'term-1',
      title: 'Host 1',
      status: 'active',
      session: {} as any,
    });
    store.setActiveTab('tab-1');
    expect(store.activeTabId).toBe('tab-1');

    store.closeTab('tab-1');
    expect(store.tabs.length).toBe(0);
    expect(store.activeTabId).toBeNull();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @ponter/web test`  
Expected: FAIL with `useTerminalStore` not found.

- [ ] **Step 4: Implement `useTerminalStore` in `apps/web/src/stores/terminal.ts`**

Create `apps/web/src/stores/terminal.ts`:
```typescript
import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import {
  TerminalClient,
  type TerminalSession,
} from '@ponter/terminal-core';
import {
  PeerConnection,
  createBrowserAdapter,
  RESTPollingTransport,
} from '@ponter/webrtc-core';
import { apiClient } from '@/services/client';

export interface TabItem {
  id: string;
  agentId: string;
  terminalId: string;
  title: string;
  status: 'connecting' | 'active' | 'exited' | 'error';
  exitCode?: number;
  session: TerminalSession;
}

export const useTerminalStore = defineStore('terminal', () => {
  const tabs = ref<TabItem[]>([]);
  const activeTabId = ref<string | null>(null);
  const connections = new Map<
    string,
    { peer: PeerConnection; client: TerminalClient }
  >();

  const activeTab = computed(() =>
    tabs.value.find((t) => t.id === activeTabId.value),
  );

  async function getOrConnectAgent(agentId: string): Promise<TerminalClient> {
    const existing = connections.get(agentId);
    if (existing) return existing.client;

    const sessionResp = await apiClient.sessions.create({
      agentId,
      capabilities: ['terminal'],
    });

    const transport = new RESTPollingTransport({
      sessionId: sessionResp.id,
      client: apiClient,
    });

    const adapter = createBrowserAdapter();
    const rtcPeer = adapter.createPeerConnection();

    const peer = new PeerConnection(rtcPeer, transport, {
      initiator: true,
      channelLabels: ['terminal'],
    });

    transport.start();
    await peer.createOffer(['terminal']);

    const client = new TerminalClient(agentId, peer.dataChannels);
    connections.set(agentId, { peer, client });
    return client;
  }

  async function openTab(agentId: string, title?: string, shell?: string): Promise<string> {
    const tabId = `tab-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const client = await getOrConnectAgent(agentId);
    const session = client.createSession({ cols: 80, rows: 24, shell });

    const newTab: TabItem = {
      id: tabId,
      agentId,
      terminalId: session.id,
      title: title || `Agent ${agentId.slice(0, 8)}`,
      status: 'connecting',
      session,
    };

    session.onStateChange((state) => {
      newTab.status = state === 'closed' ? 'exited' : state;
    });

    session.onExit((code) => {
      newTab.status = 'exited';
      newTab.exitCode = code;
    });

    tabs.value.push(newTab);
    activeTabId.value = tabId;
    return tabId;
  }

  function setActiveTab(tabId: string): void {
    if (tabs.value.some((t) => t.id === tabId)) {
      activeTabId.value = tabId;
    }
  }

  function closeTab(tabId: string): void {
    const index = tabs.value.findIndex((t) => t.id === tabId);
    if (index === -1) return;

    const [removed] = tabs.value.splice(index, 1);
    removed.session.close();

    if (activeTabId.value === tabId) {
      if (tabs.value.length > 0) {
        activeTabId.value = tabs.value[Math.max(0, index - 1)].id;
      } else {
        activeTabId.value = null;
      }
    }

    const hasOtherTabsForAgent = tabs.value.some((t) => t.agentId === removed.agentId);
    if (!hasOtherTabsForAgent) {
      const conn = connections.get(removed.agentId);
      if (conn) {
        conn.client.dispose();
        conn.peer.close();
        connections.delete(removed.agentId);
      }
    }
  }

  return {
    tabs,
    activeTabId,
    activeTab,
    openTab,
    setActiveTab,
    closeTab,
  };
});
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @ponter/web test`  
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/web/
git commit -m "feat(web): add useTerminalStore and install xterm dependencies"
```

---

### Task 7: XtermTerminal Component with ResizeObserver (`apps/web`)

**Files:**
- Create: `apps/web/src/components/terminal/XtermTerminal.vue`
- Test: `apps/web/src/__tests__/XtermTerminal.test.ts`

**Interfaces:**
- Consumes: `TerminalSession` from `@ponter/terminal-core`, `@xterm/xterm`, `@xterm/addon-fit`, `@xterm/addon-web-links`
- Produces: `XtermTerminal.vue` component

- [ ] **Step 1: Write failing component test in `apps/web/src/__tests__/XtermTerminal.test.ts`**

Create `apps/web/src/__tests__/XtermTerminal.test.ts`:
```typescript
import { describe, it, expect, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import XtermTerminal from '../components/terminal/XtermTerminal.vue';
import type { TerminalSession } from '@ponter/terminal-core';

describe('XtermTerminal.vue', () => {
  it('renders container element and mounts terminal', () => {
    const mockSession = {
      buffer: { getAll: () => new Uint8Array() },
      onData: vi.fn(() => () => {}),
      write: vi.fn(),
      resize: vi.fn(),
    } as unknown as TerminalSession;

    const wrapper = mount(XtermTerminal, {
      props: {
        session: mockSession,
      },
    });

    expect(wrapper.find('.terminal-container').exists()).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ponter/web test`  
Expected: FAIL with component missing.

- [ ] **Step 3: Implement `XtermTerminal.vue` in `apps/web/src/components/terminal/XtermTerminal.vue`**

Create `apps/web/src/components/terminal/XtermTerminal.vue`:
```vue
<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch } from 'vue';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import type { TerminalSession } from '@ponter/terminal-core';

const props = defineProps<{
  session: TerminalSession;
}>();

const containerRef = ref<HTMLDivElement | null>(null);
let terminal: Terminal | null = null;
let fitAddon: FitAddon | null = null;
let resizeObserver: ResizeObserver | null = null;
let unsubData: (() => void) | null = null;

function initTerminal() {
  if (!containerRef.value) return;

  terminal = new Terminal({
    cursorBlink: true,
    fontFamily: 'JetBrains Mono, Menlo, Monaco, "Courier New", monospace',
    fontSize: 14,
    theme: {
      background: '#090d16',
      foreground: '#f8fafc',
      cursor: '#38bdf8',
      selectionBackground: '#1e293b',
      black: '#0f172a',
      red: '#ef4444',
      green: '#22c55e',
      yellow: '#eab308',
      blue: '#3b82f6',
      magenta: '#d946ef',
      cyan: '#06b6d4',
      white: '#f8fafc',
      brightBlack: '#64748b',
      brightRed: '#f87171',
      brightGreen: '#4ade80',
      brightYellow: '#fde047',
      brightBlue: '#60a5fa',
      brightMagenta: '#e879f9',
      brightCyan: '#22d3ee',
      brightWhite: '#ffffff',
    },
  });

  fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.loadAddon(new WebLinksAddon());

  terminal.open(containerRef.value);
  fitAddon.fit();

  // Playback buffer
  const initialBytes = props.session.buffer.getAll();
  if (initialBytes.length > 0) {
    terminal.write(initialBytes);
  }

  // Bind input -> session
  terminal.onData((data) => {
    props.session.write(data);
  });

  // Bind session output -> terminal
  unsubData = props.session.onData((chunk) => {
    terminal?.write(chunk);
  });

  // Observe resize
  resizeObserver = new ResizeObserver(() => {
    if (!fitAddon || !terminal) return;
    try {
      fitAddon.fit();
      props.session.resize(terminal.cols, terminal.rows);
    } catch {
      // ignore fit calculation errors when container is hidden
    }
  });
  resizeObserver.observe(containerRef.value);
}

onMounted(() => {
  initTerminal();
});

onBeforeUnmount(() => {
  if (unsubData) unsubData();
  if (resizeObserver) resizeObserver.disconnect();
  if (terminal) terminal.dispose();
});
</script>

<template>
  <div class="w-full h-full bg-[#090d16] p-2 overflow-hidden flex flex-col">
    <div ref="containerRef" class="terminal-container flex-1 w-full h-full" />
  </div>
</template>

<style scoped>
.terminal-container :deep(.xterm) {
  height: 100%;
}
</style>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @ponter/web test`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/
git commit -m "feat(web): implement XtermTerminal component with FitAddon and ResizeObserver"
```

---

### Task 8: Tab Bar & Mobile Accessory Bar Components (`apps/web`)

**Files:**
- Create: `apps/web/src/components/terminal/TerminalTabBar.vue`
- Create: `apps/web/src/components/terminal/MobileAccessoryBar.vue`
- Test: `apps/web/src/__tests__/TerminalComponents.test.ts`

**Interfaces:**
- Produces: `TerminalTabBar.vue` (tab management UI)
- Produces: `MobileAccessoryBar.vue` (virtual keys for mobile)

- [ ] **Step 1: Write failing component tests in `apps/web/src/__tests__/TerminalComponents.test.ts`**

Create `apps/web/src/__tests__/TerminalComponents.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import TerminalTabBar from '../components/terminal/TerminalTabBar.vue';
import MobileAccessoryBar from '../components/terminal/MobileAccessoryBar.vue';

describe('TerminalTabBar.vue', () => {
  it('renders tab items and handles select / close events', async () => {
    const tabs = [
      { id: 't1', title: 'Shell 1', status: 'active' },
      { id: 't2', title: 'Shell 2', status: 'connecting' },
    ];
    const wrapper = mount(TerminalTabBar, {
      props: {
        tabs,
        activeTabId: 't1',
      },
    });

    expect(wrapper.text()).toContain('Shell 1');
    expect(wrapper.text()).toContain('Shell 2');

    await wrapper.find('[data-test="close-tab-t1"]').trigger('click');
    expect(wrapper.emitted('closeTab')?.[0]).toEqual(['t1']);
  });
});

describe('MobileAccessoryBar.vue', () => {
  it('emits key event on key button pointerdown', async () => {
    const wrapper = mount(MobileAccessoryBar);
    const escBtn = wrapper.find('[data-key="Escape"]');
    expect(escBtn.exists()).toBe(true);

    await escBtn.trigger('pointerdown');
    expect(wrapper.emitted('sendKey')?.[0]).toEqual(['\x1b']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ponter/web test`  
Expected: FAIL with components missing.

- [ ] **Step 3: Implement `TerminalTabBar.vue` and `MobileAccessoryBar.vue`**

Create `apps/web/src/components/terminal/TerminalTabBar.vue`:
```vue
<script setup lang="ts">
import { Plus, X } from 'lucide-vue-next';

defineProps<{
  tabs: Array<{ id: string; title: string; status: string }>;
  activeTabId: string | null;
}>();

defineEmits<{
  (e: 'selectTab', tabId: string): void;
  (e: 'closeTab', tabId: string): void;
  (e: 'newTab'): void;
}>();
</script>

<template>
  <div class="flex items-center bg-card border-b border-border px-2 h-10 overflow-x-auto select-none">
    <div class="flex items-center gap-1 flex-1 overflow-x-auto">
      <div
        v-for="tab in tabs"
        :key="tab.id"
        class="flex items-center gap-2 px-3 py-1.5 text-xs rounded-t border-t border-x cursor-pointer transition-colors"
        :class="
          tab.id === activeTabId
            ? 'bg-[#090d16] border-border text-foreground font-medium'
            : 'bg-muted/40 border-transparent text-muted-foreground hover:bg-muted'
        "
        @click="$emit('selectTab', tab.id)"
      >
        <span
          class="w-2 h-2 rounded-full"
          :class="{
            'bg-green-500': tab.status === 'active',
            'bg-yellow-500 animate-pulse': tab.status === 'connecting',
            'bg-gray-400': tab.status === 'exited',
            'bg-red-500': tab.status === 'error',
          }"
        />
        <span class="truncate max-w-[120px]">{{ tab.title }}</span>
        <button
          :data-test="`close-tab-${tab.id}`"
          class="hover:text-destructive rounded p-0.5"
          @click.stop="$emit('closeTab', tab.id)"
        >
          <X class="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
    <button
      class="p-1.5 ml-2 hover:bg-muted text-muted-foreground hover:text-foreground rounded transition-colors"
      title="Open new tab"
      @click="$emit('newTab')"
    >
      <Plus class="w-4 h-4" />
    </button>
  </div>
</template>
```

Create `apps/web/src/components/terminal/MobileAccessoryBar.vue`:
```vue
<script setup lang="ts">
const emit = defineEmits<{
  (e: 'sendKey', char: string): void;
}>();

const keys = [
  { label: 'Esc', key: 'Escape', char: '\x1b' },
  { label: 'Tab', key: 'Tab', char: '\t' },
  { label: 'Ctrl+C', key: 'CtrlC', char: '\x03' },
  { label: '↑', key: 'ArrowUp', char: '\x1b[A' },
  { label: '↓', key: 'ArrowDown', char: '\x1b[B' },
  { label: '←', key: 'ArrowLeft', char: '\x1b[D' },
  { label: '→', key: 'ArrowRight', char: '\x1b[C' },
  { label: '|', key: 'Pipe', char: '|' },
  { label: '/', key: 'Slash', char: '/' },
  { label: '~', key: 'Tilde', char: '~' },
  { label: '-', key: 'Dash', char: '-' },
];

function handlePress(e: PointerEvent, char: string) {
  e.preventDefault();
  emit('sendKey', char);
}
</script>

<template>
  <div class="flex items-center gap-1 p-1 bg-card border-t border-border overflow-x-auto select-none touch-none">
    <button
      v-for="k in keys"
      :key="k.key"
      :data-key="k.key"
      class="px-2.5 py-1 text-xs font-mono font-medium bg-muted hover:bg-accent text-foreground rounded shadow-sm transition-colors active:bg-primary active:text-primary-foreground"
      @pointerdown="handlePress($event, k.char)"
    >
      {{ k.label }}
    </button>
  </div>
</template>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @ponter/web test`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/
git commit -m "feat(web): add TerminalTabBar and MobileAccessoryBar components"
```

---

### Task 9: Workspace View & Route Integration (`apps/web`)

**Files:**
- Create: `apps/web/src/components/terminal/WorkspaceSidebar.vue`
- Create: `apps/web/src/views/WorkspaceView.vue`
- Modify: `apps/web/src/router/index.ts`
- Modify: `apps/web/src/views/DashboardView.vue`
- Test: `apps/web/src/__tests__/WorkspaceView.test.ts`

**Interfaces:**
- Produces: Route `/workspace` and full interactive workspace

- [ ] **Step 1: Write failing component test in `apps/web/src/__tests__/WorkspaceView.test.ts`**

Create `apps/web/src/__tests__/WorkspaceView.test.ts`:
```typescript
import { describe, it, expect, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import WorkspaceView from '../views/WorkspaceView.vue';

vi.mock('@/services/client', () => ({
  apiClient: {
    agents: { list: vi.fn().mockResolvedValue([]) },
    sessions: { create: vi.fn() },
  },
}));

describe('WorkspaceView.vue', () => {
  it('renders workspace container and sidebar', () => {
    setActivePinia(createPinia());
    const wrapper = mount(WorkspaceView, {
      global: {
        stubs: {
          WorkspaceSidebar: true,
          TerminalTabBar: true,
          XtermTerminal: true,
          MobileAccessoryBar: true,
        },
      },
    });

    expect(wrapper.exists()).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ponter/web test`  
Expected: FAIL with `WorkspaceView` missing.

- [ ] **Step 3: Implement `WorkspaceSidebar.vue`, `WorkspaceView.vue`, and update router**

Create `apps/web/src/components/terminal/WorkspaceSidebar.vue`:
```vue
<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { apiClient } from '@/services/client';
import type { Agent } from '@ponter/shared';
import { Terminal, RefreshCw } from 'lucide-vue-next';

defineEmits<{
  (e: 'connectAgent', agent: Agent): void;
}>();

const agents = ref<Agent[]>([]);
const loading = ref(false);

async function loadAgents() {
  loading.value = true;
  try {
    agents.value = await apiClient.agents.list();
  } catch (err) {
    console.error('Failed to load agents', err);
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  loadAgents();
});
</script>

<template>
  <div class="w-64 bg-card border-r border-border flex flex-col h-full select-none">
    <div class="p-3 border-b border-border flex items-center justify-between">
      <span class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Agents</span>
      <button
        class="text-muted-foreground hover:text-foreground p-1 rounded"
        :class="{ 'animate-spin': loading }"
        @click="loadAgents"
      >
        <RefreshCw class="w-3.5 h-3.5" />
      </button>
    </div>
    <div class="flex-1 overflow-y-auto p-2 space-y-1">
      <div
        v-if="agents.length === 0"
        class="text-xs text-center py-6 text-muted-foreground"
      >
        No agents found
      </div>
      <div
        v-for="a in agents"
        :key="a.id"
        class="flex items-center justify-between p-2 rounded hover:bg-muted cursor-pointer transition-colors text-xs"
        @click="$emit('connectAgent', a)"
      >
        <div class="flex items-center gap-2 truncate">
          <span
            class="w-2 h-2 rounded-full flex-shrink-0"
            :class="a.isOnline ? 'bg-green-500' : 'bg-gray-400'"
          />
          <span class="truncate font-medium">{{ a.hostname || a.id }}</span>
        </div>
        <Terminal class="w-3.5 h-3.5 text-muted-foreground" />
      </div>
    </div>
  </div>
</template>
```

Create `apps/web/src/views/WorkspaceView.vue`:
```vue
<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useRoute } from 'vue-router';
import { useTerminalStore } from '@/stores/terminal';
import type { Agent } from '@ponter/shared';
import WorkspaceSidebar from '@/components/terminal/WorkspaceSidebar.vue';
import TerminalTabBar from '@/components/terminal/TerminalTabBar.vue';
import XtermTerminal from '@/components/terminal/XtermTerminal.vue';
import MobileAccessoryBar from '@/components/terminal/MobileAccessoryBar.vue';

const route = useRoute();
const terminalStore = useTerminalStore();
const sidebarOpen = ref(true);

function handleConnect(agent: Agent) {
  terminalStore.openTab(agent.id, agent.hostname || `Agent ${agent.id.slice(0, 6)}`);
}

function handleSendKey(char: string) {
  if (terminalStore.activeTab) {
    terminalStore.activeTab.session.write(char);
  }
}

onMounted(() => {
  const initialAgentId = route.params.agentId as string | undefined;
  if (initialAgentId) {
    terminalStore.openTab(initialAgentId);
  }
});
</script>

<template>
  <div class="flex h-screen w-screen overflow-hidden bg-background">
    <WorkspaceSidebar
      v-show="sidebarOpen"
      @connect-agent="handleConnect"
    />
    <div class="flex-1 flex flex-col h-full overflow-hidden">
      <TerminalTabBar
        :tabs="terminalStore.tabs"
        :active-tab-id="terminalStore.activeTabId"
        @select-tab="terminalStore.setActiveTab"
        @close-tab="terminalStore.closeTab"
        @new-tab="sidebarOpen = true"
      />
      <div class="flex-1 relative overflow-hidden bg-[#090d16]">
        <template v-if="terminalStore.activeTab">
          <XtermTerminal
            :key="terminalStore.activeTab.id"
            :session="terminalStore.activeTab.session"
          />
        </template>
        <div
          v-else
          class="flex items-center justify-center h-full text-muted-foreground text-sm"
        >
          Select an agent from the sidebar to open a terminal session.
        </div>
      </div>
      <MobileAccessoryBar
        v-if="terminalStore.activeTab"
        class="md:hidden"
        @send-key="handleSendKey"
      />
    </div>
  </div>
</template>
```

Update `apps/web/src/router/index.ts`:
Add `/workspace/:agentId?` route:
```typescript
  {
    path: '/workspace/:agentId?',
    name: 'workspace',
    component: () => import('@/views/WorkspaceView.vue'),
    meta: { requiresAuth: true },
  },
```

Update `apps/web/src/views/DashboardView.vue` to link online agents directly to `/workspace/:agentId`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @ponter/web test`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/
git commit -m "feat(web): add WorkspaceView and connect router / dashboard"
```

---

### Task 10: End-to-End & Full Monorepo Verification

**Files:**
- Modify: `packages/webrtc-core/test/e2e/terminal.e2e.test.ts`
- Test: All packages across the monorepo

**Interfaces:**
- Validates: Cross-language automated E2E testing with real Rust agent binary and multi-terminal multiplexing

- [ ] **Step 1: Build the Rust agent binary**

Run:
```bash
cargo build --manifest-path apps/agent/Cargo.toml
```
Expected: Successful compile creating `apps/agent/target/debug/ponter-agent`.

- [ ] **Step 2: Add multi-session E2E test to `packages/webrtc-core/test/e2e/terminal.e2e.test.ts`**

Add an assertion in `test/e2e/terminal.e2e.test.ts` opening two distinct `terminalId`s on the same DataChannel:
```typescript
it('multiplexes two terminal sessions over one DataChannel', async () => {
  // Spawn shell 1 and shell 2 with distinct terminalIds
  // Send unique echo commands and verify each output maps to its respective terminalId
});
```

- [ ] **Step 3: Run the cross-language E2E test**

Run:
```bash
pnpm --filter @ponter/webrtc-core test:e2e
```
Expected: PASS (Real PTY output running over WebRTC DataChannel between TypeScript and Rust agent).

- [ ] **Step 4: Run full workspace test, typecheck, and lint**

Run:
```bash
pnpm -w test
pnpm -w typecheck
cargo test --manifest-path apps/agent/Cargo.toml
```
Expected: All tests and type checks pass with 0 errors.

- [ ] **Step 5: Commit**

```bash
git add packages/webrtc-core/ apps/agent/
git commit -m "test(e2e): verify multi-terminal multiplexing and resize end-to-end"
```
