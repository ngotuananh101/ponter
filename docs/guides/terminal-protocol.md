# Terminal Multiplexing & Wire Protocol

This technical specification details the multiplexed WebRTC DataChannel wire protocol implemented in Phase 2 Week 6 (ADR-09, ADR-10).

---

## 1. Architectural Principles

- **Single Ordered Reliable DataChannel**: Rather than negotiating new WebRTC SCTP streams or triggering ICE renegotiations for every shell instance, all terminal sessions between a client and an agent share a single WebRTC DataChannel labeled `"terminal"`.
- **Client-Driven ID Generation**: Terminal sessions are keyed by an opaque, unique `terminalId` string chosen by the client upon session creation.
- **Binary Payload Preservation**: All raw PTY terminal output and keystroke input are base64-encoded strings within JSON frames to ensure multi-byte UTF-8 sequences (accents, emojis, CJK) and arbitrary binary escape codes are never corrupted when split across network chunks.
- **Bounded Frame Ceiling**: Inbound frames are capped at 64 KiB (`MAX_FRAME_BYTES`) before JSON parsing to protect against memory exhaustion attacks.

---

## 2. Frame Structure

Every message sent across the `"terminal"` DataChannel is wrapped in a standard envelope:

```typescript
export interface DataChannelMessage<T = unknown> {
  type: string;
  payload: T;
  timestamp?: number;
}
```

---

## 3. Message Lifecycle & Payloads

### 3.1 `terminal-create` (Client -> Agent)
Requests the agent to spawn a new pseudo-terminal process with the specified dimensions and optional shell executable.

```json
{
  "type": "terminal-create",
  "payload": {
    "terminalId": "term-1727500000000-abc123",
    "cols": 120,
    "rows": 40,
    "shell": "/bin/bash"
  }
}
```

- `cols`: Terminal columns (must be `>= 1`).
- `rows`: Terminal rows (must be `>= 1`).
- `shell` *(optional)*: Explicit binary path. If omitted, defaults to host system's shell (`/bin/bash` or `powershell.exe`).

### 3.2 `terminal-data` (Bidirectional)
Transports keystrokes from client to agent, or raw PTY output from agent to client.

```json
{
  "type": "terminal-data",
  "payload": {
    "terminalId": "term-1727500000000-abc123",
    "data": "bHMgLWxhCg=="
  },
  "timestamp": 1727500001234
}
```

- `data`: Base64-encoded binary chunk (`STANDARD` base64).

### 3.3 `terminal-resize` (Client -> Agent)
Notifies the agent that the browser viewport or terminal grid has resized.

```json
{
  "type": "terminal-resize",
  "payload": {
    "terminalId": "term-1727500000000-abc123",
    "cols": 100,
    "rows": 30
  }
}
```

- Clients apply a 100ms debounce to prevent flooding the network during rapid window drags.

### 3.4 `terminal-close` (Client -> Agent)
Instructs the agent to terminate the PTY child process and close the session immediately.

```json
{
  "type": "terminal-close",
  "payload": {
    "terminalId": "term-1727500000000-abc123"
  }
}
```

### 3.5 `terminal-exit` (Agent -> Client)
Sent by the agent when the child process exits (via user command like `exit`, crash, or SIGTERM).

```json
{
  "type": "terminal-exit",
  "payload": {
    "terminalId": "term-1727500000000-abc123",
    "exitCode": 0
  },
  "timestamp": 1727500005678
}
```

- `exitCode`: Exit status returned by the operating system (`None` or numeric code).

---

## 4. State Machines

### 4.1 Client TerminalSession States
```
          [init]
             │
             ▼
       ┌───────────┐
       │connecting │
       └─────┬─────┘
             │ (channel open & session created)
             ▼
       ┌───────────┐
       │  active   │
       └─────┬─────┘
             │
      ┌──────┴──────┐
      │ (on exit)   │ (on user close)
      ▼             ▼
┌───────────┐ ┌───────────┐
│  exited   │ │  closed   │
└───────────┘ └───────────┘
```

### 4.2 Agent Resource Management (`PtyManager`)
- Maximum concurrent PTY sessions per agent: **10** (configurable).
- On process termination, the reader thread reaches EOF, triggers `session.wait_child()` to reap the operating system child, deletes the session from the active map, and frees the session slot.
