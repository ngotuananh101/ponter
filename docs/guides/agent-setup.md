# Desktop Agent Setup Guide

Hướng dẫn chi tiết cách build, cấu hình và vận hành native Rust Desktop Agent (`apps/agent`) trên Linux, macOS, và Windows.

---

## 1. Overview

Desktop agent (`ponter-agent`) là một daemon nhẹ viết bằng Rust chạy trên máy tính mục tiêu bạn muốn truy cập từ xa. Các đặc điểm chính:

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

Binary nằm tại: `apps/agent/target/debug/ponter-agent`

### 2.2 Release Build (Optimized)

Đối với production deployment:

```bash
cargo build --release --manifest-path apps/agent/Cargo.toml
```

Binary nằm tại: `apps/agent/target/release/ponter-agent`

---

## 3. Command-Line Options

Chạy `ponter-agent --help` để xem tất cả tham số:

```
Ponter Desktop Agent

Usage: ponter-agent [OPTIONS] --agent-id <AGENT_ID> --server <SERVER> --credential <CREDENTIAL>

Options:
      --agent-id <AGENT_ID>      Unique ID của agent đã đăng ký trên platform
      --server <SERVER>          WebSocket URL của signaling server (e.g. ws://localhost:8787/api/ws/agent)
      --credential <CREDENTIAL>  Secret credential minted during agent registration (ag_<32 hex>)
      --stun <STUN>              STUN server URL cho NAT traversal [default: stun:stun.l.google.com:19302]
      --shell <SHELL>            Shell mặc định để khởi chạy khi nhận session [default: /bin/bash or powershell]
      --cols <COLS>              Số cột mặc định cho PTY ban đầu [default: 80]
      --rows <ROWS>              Số hàng mặc định cho PTY ban đầu [default: 24]
      --files-root <FILES_ROOT>  Thư mục được phục vụ cho các session files. KHÔNG có mặc định:
                                 bỏ trống = cổng files đóng (offer bị từ chối) [env: AGENT_FILES_ROOT]
  -h, --help                     In ra help
  -V, --version                  In ra version
```

> **Bảo mật:** `--files-root` mở quyền đọc/ghi file trong đúng thư mục đó cho phiên đã xác thực nhưng **peer chưa được định danh** (H3 — Phase 5). Chỉ trỏ vào thư mục bạn chủ đích chia sẻ; không có mặc định, cổng đóng khi cờ vắng mặt.

### 3.1 Vận hành sandbox files (Tuần 11)

#### 3.1.1 TTL 24 giờ cho file `.ponter-part`

`.ponter-part` là một cơ chế **chỉ áp dụng cho upload** — download phía agent là read-only và không tạo `.part` nào (xem `apps/agent/src/files.rs:1854`). Do đó phần TTL dưới đây không ám chỉ download để lại parts.

Agent chạy một **janitor** (task nền, chạy mỗi giờ và khi khởi động/session init) quét toàn bộ sandbox root tìm các file kết thúc bằng `.ponter-part`:

- Nếu `SystemTime::now() - metadata.modified() > 86400 giây` (24 h) → xóa file và ghi log `INFO`.
- Nếu **`<= 86400 giây`** → giữ lại. Đây là trạng thái mở `resume`; **không được xóa tay** trong lúc transfer đang diễn ra — resume sẽ dựa vào `fromChunkIndex` + length validation để tiếp tục.
- **Hủy tường minh (explicit cancel)** qua `files-cancel` vẫn **xóa ngay** `.ponter-part` kể cả khi còn trong TTL — hành vi này không chờ janitor.

Tóm lại: `.ponter-part` trẻ (<24 h) = trạng thái resume, để nguyên; `.ponter-part` già (>24 h) = rác, janitor dọn.

#### 3.1.2 Quyền thao tác thư mục (sandbox root)

Các phép toán `mkdir`, `delete`, `rename` chỉ áp dụng **bên trong sandbox root**:

- **Root không thể bị xóa/đổi tên:** yêu cầu `path == ""` (hoặc canonicalize == root) bị từ chối ngay với lỗi **`PERMISSION_DENIED`** — ở cả giai đoạn syntactic và canonicalization.
- **Delete thư mục rỗng:** được phép nếu là rỗng.
- **Delete thư mục không rỗng:** yêu cầu `recursive: true` (API) hoặc xác nhận recursive qua UI dialog trước khi thực hiện — nếu không, trả về **`DIR_NOT_EMPTY`**.
- **Rename:** cả `oldPath` và `newPath` phải nằm trong sandbox root (canonicalize + prefix check). Nếu `newPath` đã tồn tại → từ chối ngay với lỗi **`FILE_EXISTS`** (không ghi đè — rename không bao giờ overwrite).

---

## 4. Running the Agent

### 4.1 Local Development

```bash
# Chạy với local server:
./apps/agent/target/debug/ponter-agent \
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
./apps/agent/target/release/ponter-agent \
  --agent-id agent-myhost-01 \
  --server wss://your-domain.com/api/ws/agent \
  --credential ag_0123456789abcdef0123456789abcdef \
  --stun "stun:stun.l.google.com:19302"
```

Để bật debug logs:

```bash
RUST_LOG=debug ./apps/agent/target/release/ponter-agent ...
```

### 4.3 Environment Variables

Agent hỗ trợ việc chuyển các tham số qua environment variables thông qua file cấu hình `.env` (xem `apps/agent/.env.example`):

```env
AGENT_ID=agent-myhost-01
SERVER=wss://your-domain.com/api/ws/agent
CREDENTIAL=ag_0123456789abcdef0123456789abcdef
STUN=stun:stun.l.google.com:19302
# Tùy chọn: mở cổng files. Bỏ trống = cổng đóng (mặc định an toàn).
# AGENT_FILES_ROOT=/srv/ponter-files
RUST_LOG=info
```

---

## 5. Running as a Background Daemon (Linux Systemd)

Để chạy agent tự động khi khởi động hệ thống trên Linux:

### Bước 1: Cài đặt binary

```bash
sudo cp apps/agent/target/release/ponter-agent /usr/local/bin/ponter-agent
sudo chmod +x /usr/local/bin/ponter-agent
```

### Bước 2: Tạo file cấu hình môi trường

Tạo file tại `/etc/ponter-ponter-agent.env` (giới hạn root):

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

### Bước 3: Tạo systemd service

Tạo file service tại `/etc/systemd/system/ponter-ponter-agent.service`:

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

### Bước 4: Khởi động service

```bash
sudo systemctl daemon-reload
sudo systemctl enable ponter-ponter-agent
sudo systemctl start ponter-ponter-agent

# Kiểm tra trạng thái
sudo systemctl status ponter-ponter-agent

# Xem logs
sudo journalctl -u ponter-ponter-agent -f
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
chmod 600 /etc/ponter-ponter-agent.env
```

### Process Isolation

Agent khởi chạy lệnh bằng quyền người dùng chạy process `ponter-agent`. **Không chạy agent với quyền `root`** trừ khi có nhu cầu quản trị hệ thống rõ rệt.

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
4. Xem log: `RUST_LOG=debug ./ponter-agent ...`

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