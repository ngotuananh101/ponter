# Desktop Agent Setup Guide

Detailed guide on building, configuring, and operating the native Rust Desktop Agent (`apps/agent`) on Linux, macOS, and Windows.

---

## 1. Overview

The desktop agent (`ponter-agent`) is a lightweight daemon written in Rust running on the target machine you wish to access remotely. Key highlights:

- **Asynchronous Runtime**: Powered by `tokio` for low-overhead async I/O
- **WebSocket Signaling**: Maintains a persistent connection with exponential backoff and heartbeats (3 missed pings) to `ws://<server>:8787/api/ws/agent`
- **Direct P2P WebRTC**: Acts as answerer via `webrtc-rs`, performing DTLS handshake and establishing SCTP data channels directly with clients
- **PTY Multiplexing (`PtyManager`)**: Manages up to 10 concurrent shell sessions, multiplexed over a single WebRTC DataChannel (`"terminal"`)
- **Graceful Lifecycle Management**: Reaps exited child processes and cleans up resources on EOF or client disconnection

---

## 2. Building the Agent

### 2.1 Debug Build (Development)

```bash
cargo build --manifest-path apps/agent/Cargo.toml
```

The binary is located at: `apps/agent/target/debug/ponter-agent`

### 2.2 Release Build (Optimized)

For production deployment:

```bash
cargo build --release --manifest-path apps/agent/Cargo.toml
```

The binary is located at: `apps/agent/target/release/ponter-agent`

---

## 3. Command-Line Options

Run `ponter-agent --help` to view all parameters:

```
Ponter Desktop Agent

Usage: ponter-agent [OPTIONS] --agent-id <AGENT_ID> --server <SERVER> --credential <CREDENTIAL>

Options:
      --agent-id <AGENT_ID>      Unique ID of the agent registered on the platform
      --server <SERVER>          WebSocket URL of the signaling server (e.g. ws://localhost:8787/api/ws/agent)
      --credential <CREDENTIAL>  Secret credential minted during agent registration (ag_<32 hex>)
      --stun <STUN>              STUN server URL for NAT traversal [default: stun:stun.l.google.com:19302]
      --shell <SHELL>            Default shell to launch upon receiving session [default: /bin/bash or powershell]
      --cols <COLS>              Default column count for initial PTY [default: 80]
      --rows <ROWS>              Default row count for initial PTY [default: 24]
      --files-root <FILES_ROOT>  Directory served for files sessions. NO default:
                                 empty = files gate closed (offer refused) [env: AGENT_FILES_ROOT]
      --allow-input              Enable mouse/keyboard injection from peer (ADR-29/ADR-42 gate). DEFAULT OFF:
                                 only when enabled AND peer identity is verified will input be injected
                                 [env: AGENT_ALLOW_INPUT]
  -h, --help                     Print help
  -V, --version                  Print version
```

> **Security:** input injection requires **two gates** (ADR-42): (A) the `--allow-input` flag enabled locally by the operator — remote peers cannot enable it; and (B) the peer must pass identity verification at admission (ADR-41, Phase 6a). Without both, all input frames are dropped. The agent always allows view-only mode. As of Phase 6a, peers for **all** sessions (including files/desktop) have their identity verified before the agent answers an offer.

### 3.1 Operating the Files Sandbox (Week 11)

#### 3.1.1 24-Hour TTL for `.ponter-part` Files

`.ponter-part` is a mechanism **applicable only to uploads** — downloads on the agent side are read-only and never create `.part` files (see `apps/agent/src/files.rs:1854`). Therefore, the TTL section below does not imply that downloads leave parts behind.

The agent runs a **janitor** (background task running every hour and at startup/session init) that scans the entire sandbox root for files ending in `.ponter-part`:

- If `SystemTime::now() - metadata.modified() > 86400 seconds` (24 h) → delete file and log `INFO`.
- If **`<= 86400 seconds`** → keep it. This represents open `resume` state; **do not delete manually** while a transfer is in progress — resume relies on `fromChunkIndex` + length validation to proceed.
- **Explicit cancellation** via `files-cancel` still **immediately deletes** `.ponter-part` even within the TTL — this action does not wait for the janitor.

In summary: young `.ponter-part` (<24 h) = resume state, preserve; old `.ponter-part` (>24 h) = stale garbage, janitor cleans up.

#### 3.1.2 Directory Operation Permissions (Sandbox Root)

`mkdir`, `delete`, and `rename` operations only apply **inside the sandbox root**:

- **Root cannot be deleted/renamed:** requests with `path == ""` (or canonicalize == root) are immediately rejected with **`PERMISSION_DENIED`** — at both syntactic and canonicalization stages.
- **Delete empty directory:** allowed if empty.
- **Delete non-empty directory:** requires `recursive: true` (API) or recursive confirmation via UI dialog before execution — otherwise returns **`DIR_NOT_EMPTY`**.
- **Rename:** both `oldPath` and `newPath` must reside inside the sandbox root (canonicalize + prefix check). If `newPath` already exists → immediately rejected with **`FILE_EXISTS`** (no overwriting — rename never overwrites).

---

## 4. Running the Agent

### 4.1 Local Development

```bash
# Run with local server:
./apps/agent/target/debug/ponter-agent \
  --agent-id agent-myhost-01 \
  --server ws://localhost:8787/api/ws/agent \
  --credential ag_0123456789abcdef0123456789abcdef \
  --stun ""
```

**Endpoint URLs:**
- **Local dev server**: `ws://localhost:8787/api/ws/agent`
- **Production server**: `wss://your-domain.com/api/ws/agent`

*(Pass `--stun ""` to restrict WebRTC to loopback candidates for local testing).*

### 4.2 Production

```bash
./apps/agent/target/release/ponter-agent \
  --agent-id agent-myhost-01 \
  --server wss://your-domain.com/api/ws/agent \
  --credential ag_0123456789abcdef0123456789abcdef \
  --stun "stun:stun.l.google.com:19302"
```

To enable debug logs:

```bash
RUST_LOG=debug ./apps/agent/target/release/ponter-agent ...
```

### 4.3 Environment Variables

The agent supports passing parameters via environment variables using a `.env` configuration file (see `apps/agent/.env.example`):

```env
AGENT_ID=agent-myhost-01
SERVER=wss://your-domain.com/api/ws/agent
CREDENTIAL=ag_0123456789abcdef0123456789abcdef
STUN=stun:stun.l.google.com:19302
# Optional: open files gate. Empty = gate closed (safe default).
# AGENT_FILES_ROOT=/srv/ponter-files
# Optional: enable mouse/keyboard injection (DEFAULT OFF — gate A of ADR-42).
# Only takes effect when peer identity is verified (gate B).
# AGENT_ALLOW_INPUT=true
RUST_LOG=info
```

---

## 5. Running as a Background Daemon (Linux Systemd)

To run the agent automatically at system boot on Linux:

### Step 1: Install Binary

```bash
sudo cp apps/agent/target/release/ponter-agent /usr/local/bin/ponter-agent
sudo chmod +x /usr/local/bin/ponter-agent
```

### Step 2: Create Environment Configuration File

Create file at `/etc/ponter-ponter-agent.env` (restricted to root):

```bash
sudo bash -c 'cat > /etc/ponter-ponter-agent.env << EOF
AGENT_ID=agent-myhost-01
SERVER=wss://your-domain.com/api/ws/agent
CREDENTIAL=ag_0123456789abcdef0123456789abcdef
STUN=stun:stun.l.google.com:19302
RUST_LOG=info
EOF'
sudo chmod 600 /etc/ponter-ponter-agent.env
```

### Step 3: Create Systemd Service

Create service file at `/etc/systemd/system/ponter-ponter-agent.service`:

```ini
[Unit]
Description=Ponter Desktop Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=/etc/ponter-ponter-agent.env
ExecStart=/usr/local/bin/ponter-agent \
  --agent-id ${AGENT_ID} \
  --server ${SERVER} \
  --credential ${CREDENTIAL} \
  --stun ${STUN}
Restart=always
RestartSec=5s
KillMode=process

[Install]
WantedBy=multi-user.target
```

### Step 4: Start Service

```bash
sudo systemctl daemon-reload
sudo systemctl enable ponter-ponter-agent
sudo systemctl start ponter-ponter-agent

# Check status
sudo systemctl status ponter-ponter-agent

# View logs
sudo journalctl -u ponter-ponter-agent -f
```

---

## 6. Windows Service (Pending)

Windows service deployment will be supported in Phase 3. Temporarily use Task Scheduler or WSL2 to run the agent.

---

## 7. macOS LaunchDaemon (Pending)

macOS daemon deployment will be supported in Phase 3.

---

## 8. Security Considerations

### Credential Storage

The agent credential (`ag_<32 hex>`) grants machine access to authenticated users. Store with restricted permissions (`chmod 600`):

```bash
chmod 600 /etc/ponter-ponter-agent.env
```

### Process Isolation

The agent spawns commands using the privileges of the user running the `ponter-agent` process. **Do not run the agent as `root`** unless there is an explicit system administration requirement.

### PTY Boundary

The agent enforces a maximum of 10 concurrent PTY sessions per host to protect against connection exhaustion.

### Network Isolation

- Agent connects outbound to server via WebSocket (WSS in production)
- WebRTC data channels are encrypted with DTLS 1.2
- In production, use a Coturn TURN server to relay traffic across symmetric NAT

### Credential Rotation

To rotate credentials:
1. Regenerate credential via `POST /api/agents` on the web dashboard
2. Stop the agent service
3. Update the credential in `.env` or systemd config
4. Restart the service

---

## 9. Troubleshooting

### Issue: Agent cannot connect to WebSocket

1. Verify exact server URL: `ws://localhost:8787/api/ws/agent` (local) or `wss://domain.com/api/ws/agent` (production)
2. Confirm valid credential — log in and create a new agent in the dashboard
3. Check firewall: port 8787 (local) or 443 (WSS) must be open
4. View logs: `RUST_LOG=debug ./ponter-agent ...`

### Issue: WebRTC connection fails

1. Ensure STUN/TURN server is accessible
2. In local dev, use `--stun ""` to force loopback candidates
3. In production, check ICE servers endpoint:
   ```bash
   curl -H "Authorization: Bearer <jwt>" https://domain.com/api/webrtc/ice-servers
   ```
4. Check UDP firewall on port 3478 (STUN/TURN) and 49152-49200 (TURN relay)

### Issue: PTY session disconnects immediately

1. Check agent logs for shell spawn errors
2. Ensure default shell exists on host (`/bin/bash` or `powershell`)
3. Check permissions: agent requires access to PTY

### Issue: Multiple agent connections

Each `agentId` permits only one concurrent WebSocket connection. A new connection automatically evicts the old one (error code 4409 "Replaced by new connection").
