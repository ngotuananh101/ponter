# Desktop Agent Setup Guide

Hướng dẫn chi tiết cách build, cấu hình và vận hành native Rust Desktop Agent (`apps/agent`) trên Linux, macOS, và Windows.

---

## 1. Overview

Desktop agent (`remote-agent`) là một daemon nhẹ viết bằng Rust chạy trên máy tính mục tiêu bạn muốn truy cập từ xa. Các đặc điểm chính:

- **Asynchronous Runtime**: Được hỗ trợ bởi `tokio` cho async I/O low-overhead
- **WebSocket Signaling**: Duy trì kết nối bền vững với exponential backoff và heartbeat (3 missed pings) tới `ws://<server>:8787/api/ws/agent`
- **Direct P2P WebRTC**: Hoạt động như answerer qua `webrtc-rs`, thực hiện DTLS handshake và thiết lập SCTP data channels trực tiếp với client
- **PTY Multiplexing (`PtyManager`)**: Quản lý tới 10 phiên shell đồng thời, được multiplex trên một WebRTC DataChannel (`"terminal"`) duy nhất
- **Graceful Lifecycle Management**: Reaps exited child processes và dọn dẹp tài nguyên trên EOF hoặc khi client ngắt kết nối

---

## 2. Building the Agent

### 2.1 Debug Build (Development)

```bash
cargo build --manifest-path apps/agent/Cargo.toml
```

Binary nằm tại: `apps/agent/target/debug/remote-agent`

### 2.2 Release Build (Optimized)

Đối với production deployment:

```bash
cargo build --release --manifest-path apps/agent/Cargo.toml
```

Binary nằm tại: `apps/agent/target/release/remote-agent`

---

## 3. Command-Line Options

Chạy `remote-agent --help` để xem tất cả tham số:

```
Ponta Remote Desktop Agent

Usage: remote-agent [OPTIONS] --agent-id <AGENT_ID> --server <SERVER> --credential <CREDENTIAL>

Options:
      --agent-id <AGENT_ID>      Unique ID của agent đã đăng ký trên platform
      --server <SERVER>          WebSocket URL của signaling server (e.g. ws://localhost:8787/api/ws/agent)
      --credential <CREDENTIAL>  Secret credential minted during agent registration (ag_<32 hex>)
      --stun <STUN>              STUN server URL cho NAT traversal [default: stun:stun.l.google.com:19302]
      --shell <SHELL>            Shell mặc định để khởi chạy khi nhận session [default: /bin/bash or powershell]
      --cols <COLS>              Số cột mặc định cho PTY ban đầu [default: 80]
      --rows <ROWS>              Số hàng mặc định cho PTY ban đầu [default: 24]
  -h, --help                     In ra help
  -V, --version                  In ra version
```

---

## 4. Running the Agent

### 4.1 Local Development

```bash
# Chạy với local server:
./apps/agent/target/debug/remote-agent \
  --agent-id agent-myhost-01 \
  --server ws://localhost:8787/api/ws/agent \
  --credential ag_0123456789abcdef0123456789abcdef \
  --stun ""
```

**Endpoint URLs:**
- **Local dev server**: `ws://localhost:8787/api/ws/agent`
- **Production server**: `wss://your-domain.com/api/ws/agent`

*(Truyền `--stun ""` để giới hạn WebRTC ở candidate loopback cho local testing).*

### 4.2 Production

```bash
./apps/agent/target/release/remote-agent \
  --agent-id agent-myhost-01 \
  --server wss://your-domain.com/api/ws/agent \
  --credential ag_0123456789abcdef0123456789abcdef \
  --stun "stun:stun.l.google.com:19302"
```

Để bật debug logs:

```bash
RUST_LOG=debug ./apps/agent/target/release/remote-agent ...
```

### 4.3 Environment Variables

Agent hỗ trợ việc chuyển các tham số qua environment variables thông qua file cấu hình `.env` (xem `apps/agent/.env.example`):

```env
AGENT_ID=agent-myhost-01
SERVER=wss://your-domain.com/api/ws/agent
CREDENTIAL=ag_0123456789abcdef0123456789abcdef
STUN=stun:stun.l.google.com:19302
RUST_LOG=info
```

---

## 5. Running as a Background Daemon (Linux Systemd)

Để chạy agent tự động khi khởi động hệ thống trên Linux:

### Bước 1: Cài đặt binary

```bash
sudo cp apps/agent/target/release/remote-agent /usr/local/bin/remote-agent
sudo chmod +x /usr/local/bin/remote-agent
```

### Bước 2: Tạo file cấu hình môi trường

Tạo file tại `/etc/ponta-remote-agent.env` (giới hạn root):

```bash
sudo bash -c 'cat > /etc/ponta-remote-agent.env << EOF
AGENT_ID=agent-myhost-01
SERVER=wss://your-domain.com/api/ws/agent
CREDENTIAL=ag_0123456789abcdef0123456789abcdef
STUN=stun:stun.l.google.com:19302
RUST_LOG=info
EOF'
sudo chmod 600 /etc/ponta-remote-agent.env
```

### Bước 3: Tạo systemd service

Tạo file service tại `/etc/systemd/system/ponta-remote-agent.service`:

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

### Bước 4: Khởi động service

```bash
sudo systemctl daemon-reload
sudo systemctl enable ponta-remote-agent
sudo systemctl start ponta-remote-agent

# Kiểm tra trạng thái
sudo systemctl status ponta-remote-agent

# Xem logs
sudo journalctl -u ponta-remote-agent -f
```

---

## 6. Windows Service (Pending)

Windows service deployment sẽ được hỗ trợ trong Phase 3. Tạm thời sử dụng Task Scheduler hoặc WSL2 để chạy agent.

---

## 7. macOS LaunchDaemon (Pending)

macOS daemon deployment sẽ được hỗ trợ trong Phase 3.

---

## 8. Security Considerations

### Credential Storage

Agent credential (`ag_<32 hex>`) cấp quyền truy cập máy tính cho người dùng đã xác thực. Lưu trữ với quyền hạn chế (`chmod 600`):

```bash
chmod 600 /etc/ponta-remote-agent.env
```

### Process Isolation

Agent khởi chạy lệnh bằng quyền người dùng chạy process `remote-agent`. **Không chạy agent với quyền `root`** trừ khi có nhu cầu quản trị hệ thống rõ rệt.

### PTY Boundary

Agent ép buộc tối đa 10 phiên PTY đồng thời trên mỗi host để bảo vệ trước connection exhaustion.

### Network Isolation

- Agent kết nối ra server qua WebSocket (WSS trong production)
- WebRTC data channels được mã hoá DTLS 1.2
- Trong production, sử dụng Coturn TURN server để relay traffic qua symmetric NAT

### Credential Rotation

Để quay lại credential mới:
1. Regenerate credential qua `POST /api/agents` trên web dashboard
2. Dừng agent service
3. Cập nhật credential trong `.env` hoặc systemd config
4. Khởi động lại service

---

## 9. Troubleshooting

### Issue: Agent cannot connect to WebSocket

1. Kiểm tra URL server chính xác: `ws://localhost:8787/api/ws/agent` (local) hoặc `wss://domain.com/api/ws/agent` (production)
2. Xác nhận credential hợp lệ - đăng nhập và tạo agent mới trong dashboard
3. Kiểm tra firewall: port 8787 (local) hoặc 443 (WSS) phải mở
4. Xem log: `RUST_LOG=debug ./remote-agent ...`

### Issue: WebRTC connection fails

1. Đảm bảo STUN/TURN server đủ tiếp cận
2. Trong local dev, dùng `--stun ""` để force loopback candidates
3. Trong production, kiểm tra endpoint ICE servers:
   ```bash
   curl -H "Authorization: Bearer <jwt>" https://domain.com/api/webrtc/ice-servers
   ```
4. Kiểm tra firewall UDP trên port 3478 (STUN/TURN) và 49152-49200 (TURN relay)

### Issue: PTY session disconnects immediately

1. Kiểm tra log agent để tìm lỗi shell spawn
2. Đảm bảo shell mặc định tồn tại trên host (`/bin/bash` hoặc `powershell`)
3. Kiểm tra quyền: agent cần quyền truy cập PTY

### Issue: Multiple agent connections

Mỗi `agentId` chỉ có một kết nối WebSocket đồng thời. Kết nối mới sẽ tự động thay thế kết nối cũ (mã lỗi 4409 "Replaced by new connection").