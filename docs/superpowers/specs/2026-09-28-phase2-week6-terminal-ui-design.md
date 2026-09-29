# Phase 2 Week 6 — Terminal UI Design Specification

**Status:** Draft — Ready for review  
**Date:** 2026-09-28  
**Author:** Ngo Tuan Anh & Claude  
**Target:** Phase 2 Week 6 of `docs/ARCHITECTURE.md` (Section 8: "Tuần 6: Terminal UI")

---

## 1. Overview & Objectives

Week 6 completes **Phase 2 (WebRTC & Terminal)** of the Ponter Platform. Following the foundation laid in Week 4 (`packages/webrtc-core`, signaling transport) and Week 5 (`apps/agent` Rust PTY agent, data channel framing, agent credentials, and automated E2E tests), Week 6 delivers the interactive terminal interface and multi-shell capabilities.

### 1.1 Core Goals
1. **Headless Terminal Core Package (`packages/terminal-core`)**: Provide a pure TypeScript, DOM-independent terminal session manager that bridges WebRTC data channels with terminal emulators. Maintain session lifecycle, output buffering (ring buffer), and base64 framing.
2. **Multi-Shell Multiplexing over Single DataChannel**: Extend the Rust agent (`apps/agent`) and the terminal protocol to support multiple independent PTY shell processes multiplexed over the single `"terminal"` WebRTC DataChannel using `terminalId`.
3. **End-to-End Terminal Resizing**: Propagate terminal viewport changes from frontend (`FitAddon` + `ResizeObserver`) to the agent's PTY via `terminal-resize` messages and `portable-pty`'s `master.resize()`.
4. **Interactive Web Workspace (`apps/web`)**:
   - Deliver a dedicated `/workspace` view with an Agent Sidebar, responsive Tab Bar, and xterm.js terminal viewport.
   - Multi-tab management supporting both multiple shells on the same agent and concurrent connections to different agents.
   - Terminal styling with dark mode theme, monospace fonts, and web link detection.
5. **Mobile Keyboard Accessory Bar**: Provide an on-screen accessory toolbar for mobile touch devices (Esc, Tab, Ctrl, Alt, Arrow keys, pipe, shortcuts like Ctrl+C) with non-blurring touch interactions.
6. **Comprehensive Automated Testing**: Unit tests for `packages/terminal-core`, unit tests for `apps/agent` resize and multi-session management, component tests for Vue terminal components, and cross-language integration tests.

### 1.2 Non-Goals (Explicitly Deferred)
- **Desktop Screen Streaming (`desktop` channel / Video capture)**: Owned by Phase 3 (Weeks 7–9).
- **File Transfer (`files` channel)**: Owned by Phase 4 (Weeks 10–11).
- **Custom Shell Upload / Binary Transfer**: Shells are spawned from existing binaries installed on the host agent system.
- **Physical Approval Prompts**: Security policy check remains automated based on session ownership; interactive UI approval prompts belong to Week 12.

---

## 2. Wire Protocol & Contract Specifications

All terminal communication flows over the single WebRTC DataChannel with label `"terminal"` (ordered, reliable, adhering to ADR-09). Messages adhere to `DataChannelMessage<T>` from `packages/shared/src/types/webrtc.ts`:

```typescript
export interface DataChannelMessage<T = unknown> {
  type: string;
  channel: 'terminal';
  payload: T;
  timestamp: number;
}
```

### 2.1 Message Schemas (`packages/shared/src/types/terminal.ts`)

#### 1. `terminal-create` (Browser $\to$ Agent)
Sent when the user opens a new terminal tab for an agent.
```typescript
export interface TerminalCreateMessage {
  terminalId: string; // Client-generated UUID v4
  cols: number;       // Initial columns (default 80)
  rows: number;       // Initial rows (default 24)
  shell?: string;     // Optional custom shell executable path
}
```

#### 2. `terminal-data` (Bidirectional)
Transports PTY raw bytes. Payload data is standard base64 encoded string (`base64::prelude::BASE64_STANDARD` in Rust, `atob`/`btoa` or base64 utils in TypeScript).
```typescript
export interface TerminalDataMessage {
  terminalId: string;
  data: string; // Base64 encoded byte stream
}
```

#### 3. `terminal-resize` (Browser $\to$ Agent)
Sent whenever the container dimensions change or on window resize.
```typescript
export interface TerminalResizeMessage {
  terminalId: string;
  cols: number; // Target column count (>= 1)
  rows: number; // Target row count (>= 1)
}
```

#### 4. `terminal-close` (Browser $\to$ Agent)
Sent when the user explicitly closes a terminal tab in the UI.
```typescript
export interface TerminalCloseMessage {
  terminalId: string;
}
```

#### 5. `terminal-exit` (Agent $\to$ Browser)
Sent when the underlying shell process exits (e.g., user runs `exit` or process crashes).
```typescript
export interface TerminalExitMessage {
  terminalId: string;
  exitCode?: number; // OS process exit code, if available
}
```

### 2.2 Backward Compatibility & Safety Constraints
- **Implicit Session Spawn:** If the Rust agent receives `terminal-data` with a `terminalId` that was not explicitly initialized via `terminal-create` (e.g. from legacy Week 5 tests), the agent creates a default shell session using that `terminalId` and default size (80x24).
- **Buffer Limits:** Maximum frame size is strictly enforced at `MAX_FRAME_BYTES = 64 * 1024` (64 KiB) before JSON parsing. Base64 decoded payload chunks are capped at 16 KiB raw bytes.
- **Resource Limits:** Maximum of 10 concurrent active PTY sessions per agent process to prevent PTY exhaustion and denial of service.

---

## 3. Architecture & Component Design

```
+---------------------------------------------------------------------------------+
|                                    BROWSER                                      |
|                                                                                 |
|  +---------------------------------------------------------------------------+  |
|  |                            apps/web (Vue 3)                               |  |
|  |                                                                           |  |
|  |  +----------------------+  +-------------------------------------------+  |  |
|  |  |   WorkspaceView      |  |           useTerminalStore (Pinia)        |  |  |
|  |  |                      |  +-------------------------------------------+  |  |
|  |  |  [Agent Sidebar]     |                        |                        |  |
|  |  |  [Tab Bar]           |                        v                        |  |
|  |  |  [XtermTerminal.vue] | <--->  +-------------------------------------+  |  |
|  |  |  [MobileAccessoryBar]|        |       packages/terminal-core        |  |  |
|  |  +----------------------+        |   TerminalClient / TerminalSession  |  |  |
|  |                                  +-------------------------------------+  |  |
|  +-----------------------------------------------------|---------------------+  |
|                                                        v                        |
|                                     +-------------------------------------+     |
|                                     |        packages/webrtc-core         |     |
|                                     |    PeerConnection / DataChannels    |     |
|                                     +-------------------------------------+     |
+--------------------------------------------------------|------------------------+
                                                         | WebRTC DataChannel ("terminal")
                                                         v
+---------------------------------------------------------------------------------+
|                                 apps/agent (Rust)                               |
|                                                                                 |
|  +---------------------------------------------------------------------------+  |
|  |                             PtyManager (main.rs)                          |  |
|  |                                                                           |  |
|  |    Frame Router (terminal-create, terminal-data, terminal-resize, close)  |  |
|  |                                     |                                     |  |
|  |         +---------------------------+---------------------------+         |  |
|  |         |                                                       |         |  |
|  |         v                                                       v         |  |
|  |  +-----------------------------+                         +-------------+  |  |
|  |  | PtySession (terminalId: t1) |                         | PtySession  |  |  |
|  |  | MasterPty -> Reader thread  |                         |  ... (t2)   |  |  |
|  |  | Child process (bash/sh)    |                         +-------------+  |  |
|  |  +-----------------------------+                                          |  |
|  +---------------------------------------------------------------------------+  |
+---------------------------------------------------------------------------------+
```

---

## 4. Detailed Component Specifications

### 4.1 Package: `packages/terminal-core`

`packages/terminal-core` is a shared headless TypeScript library.

#### Directory Structure:
```
packages/terminal-core/
├── package.json
├── tsconfig.json
├── vitest.config.ts
└── src/
    ├── index.ts
    ├── session.ts          # TerminalSession class & ring buffer
    ├── client.ts           # TerminalClient connecting to DataChannelManager
    ├── buffer.ts           # Output ring buffer implementation
    └── types.ts            # Options, events, and session states
```

#### Core Classes & Interfaces:

1. **`RingBuffer` (`src/buffer.ts`)**:
   - Fixed-size circular buffer (default 64 KiB capacity).
   - Keeps recent terminal output while a tab is inactive or before the terminal UI emulator attaches.
   - Provides `push(chunk: Uint8Array): void` and `getAll(): Uint8Array`.

2. **`TerminalSession` (`src/session.ts`)**:
   - Represents a single shell instance identified by `id` (`terminalId`).
   - Maintains state: `connecting` | `active` | `exited` | `closed`.
   - Stores output history in `RingBuffer`.
   - Event emitter pattern for:
     - `onData(cb: (chunk: Uint8Array) => void): Unsubscribe`
     - `onExit(cb: (code?: number) => void): Unsubscribe`
     - `onStateChange(cb: (state: SessionState) => void): Unsubscribe`
   - Exposes methods:
     - `write(data: string | Uint8Array): void`
     - `resize(cols: number, rows: number): void`
     - `close(): void`

3. **`TerminalClient` (`src/client.ts`)**:
   - Bound to a `DataChannelManager` (from `webrtc-core`) and an `agentId`.
   - Manages active `Map<string, TerminalSession>`.
   - Subscribes to `"terminal"` typed messages:
     - `terminal-data`: Decodes base64 payload to `Uint8Array`, dispatches to session.
     - `terminal-exit`: Marks session as `exited`, fires `onExit`.
   - Provides session creation:
     - `createSession(options?: { cols?: number; rows?: number; shell?: string }): TerminalSession`
     - Constructs unique `terminalId` (UUID v4), sends `terminal-create` frame, instantiates `TerminalSession`.
   - Clean teardown: `dispose()` sends `terminal-close` for all active sessions and unsubscribes channel listeners.

---

### 4.2 Desktop Agent: `apps/agent` (Rust)

#### Modifications in `pty.rs`:
1. **Expose PTY Resize:**
   ```rust
   impl PtySession {
       pub fn resize(&self, cols: u16, rows: u16) -> Result<()> {
           self.master.resize(PtySize {
               rows,
               cols,
               pixel_width: 0,
               pixel_height: 0,
           }).context("pty resize")
       }
   }
   ```
2. **Exit Notification Channel:**
   - Reader thread monitors child process exit or EOF from PTY reader.
   - When EOF is reached, child is waited via `child.wait()`.
   - Agent formats and sends `terminal-exit`:
     ```rust
     pub fn frame_pty_exit(terminal_id: &str, exit_code: Option<u32>, timestamp_ms: i64) -> String
     ```

#### Modifications in `main.rs`:
1. **Multi-Session Management:**
   - Replace single `PtySession` with `PtyManager`:
     ```rust
     struct ActivePty {
         input_tx: mpsc::Sender<Vec<u8>>,
         master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
         child: Arc<Mutex<Box<dyn Child + Send + Sync>>>,
     }
     type PtyRegistry = Arc<RwLock<HashMap<String, ActivePty>>>;
     ```
2. **Inbound Dispatcher:**
   - Parse inbound JSON string into `DataChannelMessage<serde_json::Value>`.
   - Match message `type`:
     - `"terminal-create"`: Spawn new PTY, spawn reader thread pumping to outbound channel, insert into registry. If session count >= 10, drop or send error.
     - `"terminal-data"`: Lookup `terminalId`, decode base64, send to PTY input channel.
     - `"terminal-resize"`: Lookup `terminalId`, call `master.resize(cols, rows)`.
     - `"terminal-close"`: Remove from registry, closing writer and killing child process.
3. **Connection Teardown Cleanup:**
   - When DataChannel closes or ICE disconnects, drop all `ActivePty` entries to terminate all running child shells.

---

### 4.3 Frontend Web Application: `apps/web`

#### 1. Routing & State Management
- **Route:** Add `/workspace` and `/workspace/:agentId?` to `src/router/index.ts` with `requiresAuth: true`.
- **Pinia Store (`src/stores/terminal.ts`)**:
  - `activeAgentId`: Currently viewed agent.
  - `activeTabId`: Currently active tab ID.
  - `tabs`: Array of `TabItem`:
    ```typescript
    export interface TabItem {
      id: string; // Unique tab id
      agentId: string;
      terminalId: string;
      title: string;
      status: 'connecting' | 'active' | 'exited' | 'error';
      exitCode?: number;
      session: TerminalSession;
    }
    ```
  - `connections`: `Map<string, { connection: PeerConnection; client: TerminalClient }>`
  - Actions:
    - `connectAgent(agentId: string): Promise<TerminalClient>`
    - `openTab(agentId: string, shell?: string): Promise<string>`
    - `closeTab(tabId: string): void`
    - `setActiveTab(tabId: string): void`
    - `disconnectAgent(agentId: string): void`

#### 2. Components
1. **`WorkspaceView.vue` (`src/views/WorkspaceView.vue`)**:
   - Layout: Collapsible left sidebar for Agents list + main terminal work area.
   - Handles empty state when no agent is connected.
2. **`WorkspaceSidebar.vue` (`src/components/terminal/WorkspaceSidebar.vue`)**:
   - List of user's registered agents (online/offline indicator, hostname, OS, IP/tags).
   - "Connect" button and quick actions to open a new tab.
3. **`TerminalTabBar.vue` (`src/components/terminal/TerminalTabBar.vue`)**:
   - Tab header list with status dot, title, close button (`x`), and add button (`+`).
   - Keyboard shortcuts: `Ctrl+Shift+T` (new tab), `Ctrl+W` (close tab), `Alt+1..9` (switch tab).
4. **`XtermTerminal.vue` (`src/components/terminal/XtermTerminal.vue`)**:
   - Encapsulates `@xterm/xterm`, `@xterm/addon-fit`, and `@xterm/addon-web-links`.
   - Hooks:
     - On mount: Create `Terminal`, attach `FitAddon`, open in DOM container.
     - Playback buffered output from `TerminalSession.buffer`.
     - Bind `session.onData(data => term.write(data))`.
     - Bind `term.onData(data => session.write(data))`.
     - `ResizeObserver`: Call `fitAddon.fit()`, get `term.cols` and `term.rows`, call `session.resize(cols, rows)`.
     - On unmount: Dispose addons, retain session in store so switching tabs does not kill shell.
5. **`MobileAccessoryBar.vue` (`src/components/terminal/MobileAccessoryBar.vue`)**:
   - Renders a horizontal bar above virtual keyboard on touch screens.
   - Keys: `Esc`, `Tab`, `Ctrl`, `Alt`, `↑`, `↓`, `←`, `→`, `|`, `/`, `~`, `Ctrl+C`.
   - Handles `touch`/`pointerdown` with `preventDefault()` to prevent loss of terminal keyboard focus.

---

## 5. Security & Error Handling

1. **Authentication & Authorization**:
   - Browser authenticates to Signaling via existing JWT (`Authorization: Bearer <token>`).
   - Agent authenticates via its scoped token (`Authorization: Bearer ag_<hex>`).
   - Signaling verifies both belong to the same `userId` before routing SDP/ICE messages.
2. **DataChannel Isolation**:
   - The Rust agent only processes channels with label `"terminal"`. Any other label is refused and closed immediately (ADR-09).
3. **Frame Bounds & Malformed Message Defense**:
   - Every frame must not exceed `MAX_FRAME_BYTES` (64 KiB).
   - Invalid JSON or invalid base64 payloads are logged at debug level and discarded without crashing the agent.
4. **Child Process Sandboxing & Graceful Teardown**:
   - When a tab is closed, `SIGTERM` / EOF is sent to the PTY. If not exited within 3 seconds, `SIGKILL` is sent.
   - Maximum active PTY limit (10) protects against resource exhaustion.
5. **Network Interruption & Disconnection**:
   - If WebRTC PeerConnection drops (ICE failure or timeout), UI tabs mark status as `error` with a "Reconnect" button.
   - Terminal sessions do not hang indefinitely; teardown is triggered after timeout.

---

## 6. Testing & Quality Assurance Plan

### 6.1 Unit Tests
- **`packages/terminal-core`**:
  - `buffer.test.ts`: Ring buffer capacity, overflow eviction, and complete byte retrieval.
  - `session.test.ts`: State machine transitions, event dispatching, and output buffering.
  - `client.test.ts`: Framing of `terminal-create`, `terminal-resize`, base64 encoding/decoding, and channel dispatch.
- **`apps/agent`**:
  - `pty_resize_test`: Test `PtySession::resize()` applies without errors.
  - `pty_multi_session_test`: Test spawning multiple independent shells with distinct `terminalId`s.
  - `pty_exit_test`: Assert that terminating the child process produces a valid `terminal-exit` message.

### 6.2 Frontend Component Tests (`apps/web`)
- `XtermTerminal.test.ts`: Mounting xterm, initializing fit addon, receiving data, and emitting resize events.
- `TerminalTabBar.test.ts`: Switching tabs, adding tabs, closing tabs, and rendering status badges.
- `MobileAccessoryBar.test.ts`: Key presses emit correct escape sequences without blurring terminal.
- `useTerminalStore.test.ts`: Tab state mutations, active tab tracking, and session lifecycle.

### 6.3 End-to-End & Integration Tests
- **Cross-language E2E (`packages/webrtc-core/test/e2e/terminal.e2e.test.ts`)**:
  - Update and verify existing E2E tests with real Rust agent binary.
  - Test multi-terminal session: Open two separate `terminalId`s on the same WebRTC DataChannel and verify independent echo outputs.
  - Test resize end-to-end: Send `terminal-resize` (cols: 120, rows: 40) and verify with `stty size` command in shell.

---

## 7. Deliverables & Acceptance Criteria

| Item | Criteria |
|---|---|
| **`packages/terminal-core`** | Fully implemented, 100% test coverage for core logic, builds with Turbo. |
| **`apps/agent` Multi-Shell & Resize** | Rust agent handles `terminal-create`, `terminal-resize`, `terminal-close`, multiplexes >= 2 shells, reports `terminal-exit`. |
| **`apps/web` Workspace** | Route `/workspace` live, dark-theme xterm.js rendering, multi-tab switching, auto-fit on window resize. |
| **Mobile Support** | `MobileAccessoryBar` renders on touch devices, sends Esc/Ctrl/Tab/Arrow keys properly. |
| **Monorepo Build & Tests** | `pnpm -w test`, `cargo test`, and `pnpm -w typecheck` all pass with zero errors. |
