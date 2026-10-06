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

### 3.6 `terminal-e2ee-hello` (Client -> Agent)

Sent by the offerer (the peer that sends the WebRTC offer — see `terminal-connect` in §3.2) to propose application-layer confidentiality for the terminal data channel. This frame carries the offerer's ECDH public key and an Ed25519 signature that binds that key to the WS2 identity, so the answerer can verify the key before adopting it.

The frame is emitted only when the browser sees `e2ee` among the capabilities it offered on the connect frame; a browser that did not offer the capability never emits it, and a peer that does not acknowledge never adopts a key. Until both sides negotiate, `terminal-data.payload.data` carries plaintext and the session behaves exactly as a pre-Phase-5 session.

```json
{
  "type": "terminal-e2ee-hello",
  "payload": {
    "terminalId": "term-1727500000000-abc123",
    "ecdhPublicKey": "<SPKI base64, P-256, 65 bytes uncompressed>",
    "signature": "<base64 Ed25519 signature over canonicalKeyBinding(ecdhPublicKey)>"
  },
  "timestamp": 1727500000123
}
```

- `ecdhPublicKey`: the offerer's ECDH P-256 public key, exported as SPKI and base64-encoded (the same format used for `user.publicKey` on the REST `/api/users` contract).
- `signature`: an Ed25519 signature over the exact string `canonicalKeyBinding(ecdhPublicKey)`, i.e. `ponter-ws1-v1\necdhPublicKey=<spki-base64>`. The signing key is the offerer's WS2 identity key.

**Canonical key-binding string** (shared constant `canonicalKeyBinding`, `packages/shared/src/types/e2ee.ts`):

```
ponter-ws1-v1
ecdhPublicKey=<spki-base64>
```

**Canonical capability token:** the literal string `e2ee`, advertised by the browser in `SignalOffer.capabilities` (`packages/shared/src/types/signaling.ts`) when the local user has an ECDH keypair to offer.

### 3.7 `terminal-e2ee-ack` (Agent -> Client)

Sent by the answerer in reply to a `terminal-e2ee-hello`. The answerer first verifies the offerer's signature against the WS2 peer identity before doing anything else: a missing, malformed, or unverifiable signature aborts the negotiation and the session stays on the plaintext path. Only on successful verification does the answerer derive a session key and reply with its own key binding, mirroring the offerer so both sides can encrypt/decrypt symmetrically.

```json
{
  "type": "terminal-e2ee-ack",
  "payload": {
    "terminalId": "term-1727500000000-abc123",
    "ecdhPublicKey": "<SPKI base64, P-256>",
    "signature": "<base64 Ed25519 signature over canonicalKeyBinding(ecdhPublicKey)>"
  },
  "timestamp": 1727500000456
}
```

- `ecdhPublicKey`: the answerer's ECDH P-256 public key, SPKI base64.
- `signature`: an Ed25519 signature over `canonicalKeyBinding(ecdhPublicKey)` with the answerer's WS2 identity key.

**Key derivation (after mutual verification):**

- ECDH P-256, 256-bit secret.
- HKDF-SHA256 (RFC 5869) with `salt` = the WebRTC session id as UTF-8 bytes and `info` = `ponter-ws1-terminal-v1`.
- Output: a 32-byte AES-256 key; `IV_BYTES = 12`.

**Ciphertext framing** inside `terminal-data.payload.data` once active: `[12-byte IV][AES-GCM ciphertext ‖ 16-byte tag]`, with a fresh random IV per frame (constants `WS1_KEY_VERSION = 'ponter-ws1-v1'` and `WS1_TERMINAL_INFO = 'ponter-ws1-terminal-v1'` in `packages/shared/src/types/e2ee.ts`; implementation `EncryptionManager` in `packages/crypto/src/encrypt.ts`).

**Peer that did not negotiate:** a peer which never sends/receives the hello/ack (or which omits `e2ee` from its `capabilities`) keeps the plaintext path — `encrypt`/`decrypt` are identity functions and `terminal-data` carries bytes unchanged.

**Agent side:** the Rust agent now produces and consumes these frames (shipped Week 16). The agent advertises `e2ee` in its answer, dispatches `"terminal-e2ee-hello"` to `accept_hello` (verifying the browser's Ed25519 binding before deriving), stores the `E2eeSession`, and flips the terminal pump to encrypted on the `E2EEAck` marker — so when the capability is negotiated, terminal data is encrypted on the session key end to end between the browser and a live agent. The cross-language E2E gate G3 (`packages/webrtc-core/test/e2e/terminal-e2ee.e2e.test.ts`) proves the two-way round trip: the Rust agent decrypts a browser-encrypted payload and the browser decrypts the agent's encrypted output. A legacy agent that does not advertise `e2ee` yields a plaintext, byte-identical terminal (offer without the capability, verified via `getRemoteCapabilities()` not containing `e2ee`).

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
