# Desktop Agent Setup Guide

This guide details how to build, configure, and operate the native Rust Desktop Agent (`apps/agent`) on Linux, macOS, and Windows.

---

## 1. Overview

The desktop agent (`remote-agent`) is a lightweight daemon written in Rust that runs on the target machine you want to access remotely. Key characteristics:

- **Asynchronous Runtime**: Powered by `tokio` for low-overhead async I/O.
- **WebSocket Signaling**: Maintains a persistent connection with exponential backoff and 3-missed-ping heartbeat keepalive to `GET /api/ws/agent`.
- **Direct P2P WebRTC**: Acts as an answerer via `webrtc-rs`, performing DTLS handshakes and establishing SCTP data channels directly with the client.
- **PTY Multiplexing (`PtyManager`)**: Manages up to 10 concurrent, isolated shell sessions (`portable-pty`) multiplexed over a single WebRTC DataChannel (`"terminal"`).
- **Graceful Lifecycle Management**: Reaps exited child processes (`wait_child()`) and cleans up resources on EOF or client termination.

---

## 2. Building the Agent

### 2.1 Debug Build (Development)

```bash
cargo build --manifest-path apps/agent/Cargo.toml
```

Binary location: `apps/agent/target/debug/remote-agent`

### 2.2 Release Build (Optimized)

For production deployment, compile with optimizations:

```bash
cargo build --release --manifest-path apps/agent/Cargo.toml
```

Binary location: `apps/agent/target/release/remote-agent`

---

## 3. Command-Line Options

Run `remote-agent --help` to view all available arguments:

```
Ponta Remote Desktop Agent

Usage: remote-agent [OPTIONS] --agent-id <AGENT_ID> --server <SERVER> --credential <CREDENTIAL>

Options:
      --agent-id <AGENT_ID>      Unique ID of this agent registered in the platform
      --server <SERVER>          WebSocket URL of the signaling server (e.g. wss://example.com/api/ws/agent)
      --credential <CREDENTIAL>  Secret credential minted during agent registration (ag_<32 hex>)
      --stun <STUN>              STUN server URL for NAT traversal [default: stun:stun.cloudflare.com:3478]
      --shell <SHELL>            Default shell to launch on incoming sessions [default: /bin/bash or powershell]
      --cols <COLS>              Default columns for initial PTY viewport [default: 80]
      --rows <ROWS>              Default rows for initial PTY viewport [default: 24]
  -h, --help                     Print help
  -V, --version                  Print version
```

---

## 4. Running the Agent Interactively

Example launch against a production or local signaling endpoint:

```bash
# Local development:
./apps/agent/target/debug/remote-agent \
  --agent-id agent-myhost-01 \
  --server ws://127.0.0.1:8787/api/ws/agent \
  --credential ag_0123456789abcdef0123456789abcdef \
  --stun ""

# Production:
./apps/agent/target/release/remote-agent \
  --agent-id agent-myhost-01 \
  --server wss://signaling.yourdomain.com/api/ws/agent \
  --credential ag_0123456789abcdef0123456789abcdef \
  --stun "stun:stun.cloudflare.com:3478"
```

To enable verbose debug logs:

```bash
RUST_LOG=debug ./apps/agent/target/release/remote-agent ...
```

---

## 5. Running as a Background Daemon (Linux Systemd)

To run the agent automatically upon system startup on Linux:

1. Copy the release binary to `/usr/local/bin`:
   ```bash
   sudo cp apps/agent/target/release/remote-agent /usr/local/bin/remote-agent
   sudo chmod +x /usr/local/bin/remote-agent
   ```

2. Create an environment configuration file at `/etc/ponta-remote-agent.env` (restricted to root):
   ```bash
   sudo bash -c 'cat > /etc/ponta-remote-agent.env << EOF
   AGENT_ID=agent-myhost-01
   SERVER=wss://signaling.yourdomain.com/api/ws/agent
   CREDENTIAL=ag_0123456789abcdef0123456789abcdef
   STUN=stun:stun.cloudflare.com:3478
   RUST_LOG=info
   EOF'
   sudo chmod 600 /etc/ponta-remote-agent.env
   ```

3. Create the systemd service file at `/etc/systemd/system/ponta-remote-agent.service`:
   ```ini
   [Unit]
   Description=Ponta Remote Access Desktop Agent
   After=network-online.target
   Wants=network-online.target

   [Service]
   Type=simple
   EnvironmentFile=/etc/ponta-remote-agent.env
   ExecStart=/usr/local/bin/remote-agent \
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

4. Enable and start the service:
   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable ponta-remote-agent
   sudo systemctl start ponta-remote-agent
   ```

5. Check service status and logs:
   ```bash
   sudo systemctl status ponta-remote-agent
   sudo journalctl -u ponta-remote-agent -f
   ```

---

## 6. Security Considerations

- **Credential Storage**: The agent credential (`ag_<32 hex>`) grants machine access to authenticated account holders. Store it with restrictive permissions (`chmod 600`).
- **Process Isolation**: The agent launches commands using the user privileges of the process running `remote-agent`. Do not run the agent as `root` unless administrative system access is explicitly intended.
- **PTY Boundary**: The agent enforces a maximum of 10 concurrent active PTY sessions per host to guard against connection exhaustion.
