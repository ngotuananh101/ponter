# Deployment Guide

Hướng dẫn triển khai nền tảng Remote Access. Backend (`@ponter/server`) là một ứng dụng Node.js self-hosted chạy trong Docker. Frontend web (`apps/web`) là Vue 3 SPA được triển khai lên Cloudflare Pages.

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [Architecture Overview](#2-architecture-overview)
3. [Docker Deployment (Backend Server)](#3-docker-deployment-backend-server)
   - [Scenario 1: Local LAN](#scenario-1-local-lan)
   - [Scenario 2: Homelab (Cloudflare Tunnel)](#scenario-2-homelab-cloudflare-tunnel)
   - [Scenario 3: Production VPS (Caddy + Coturn)](#scenario-3-production-vps-caddy--coturn)
   - [Browser WebSocket Signaling (proxy & idle timeouts)](#32-browser-websocket-signaling-proxy--idle-timeouts)
4. [Deploying the Web Frontend to Cloudflare Pages](#4-deploying-the-web-frontend-to-cloudflare-pages)
   - [Configure Environment Variables](#41-configure-environment-variables)
   - [Build and Deploy](#42-build-and-deploy)
   - [Verify Web Deployment](#43-verify-web-deployment)
5. [Environment Variables Reference](#5-environment-variables-reference)
6. [Troubleshooting](#6-troubleshooting)

---

## 1. Prerequisites

Trước khi triển khai, hãy đảm bảo bạn có:

- **Docker**: `>= 25.0.0` ([cài đặt](https://docs.docker.com/get-docker/))
- **Docker Compose**: `>= 2.20.0` (đi kèm với Docker Desktop; dùng `docker compose` trên Linux)
- **Cloudflare Account**: [Đăng ký](https://dash.cloudflare.com/sign-up) (chỉ cần thiết cho deployment frontend)
- **pnpm**: `>= 12.0.0` (chỉ cần thiết cho deployment frontend)
- **Node.js**: `>= 24.0.0` (chỉ cần thiết cho deployment frontend)

---

## 2. Architecture Overview

Production deployment bao gồm các thành phần sau:

1. **Frontend Web Client (`apps/web`)**:
   - **Hosting**: Cloudflare Pages (static CDN hosting, không chạy backend logic)
   - **Framework**: Vue 3 SPA + Vite + Tailwind CSS + Pinia
   - **Kết nối backend**: Cấu hình qua `VITE_API_URL` trỏ tới self-hosted server

2. **Backend Server (`@ponter/server`)**:
   - **Runtime**: Node.js 24 LTS + @hono/node-server + `ws` library
   - **Database**: SQLite (better-sqlite3 + Drizzle ORM) với WAL mode
   - **WebSocket**: hai kênh — `/api/ws/agent` (agent ↔ server) và `/api/ws/browser` (browser signaling, push thay cho poll)
   - **Token Revocation**: SQLite table `revoked_tokens` (thay thế Cloudflare KV)
   - **ICE Servers**: Dynamic STUN/TURN credentials qua `GET /api/webrtc/ice-servers`
   - **Containerization**: Docker multi-stage image

3. **TURN Server (Production)**: Coturn cho WebRTC NAT traversal (symmetric NAT)

---

## 3. Docker Deployment (Backend Server)

Tất cả các tệp Docker nằm trong thư mục `docker/`.

### Scenario 1: Local LAN

Dành cho testing trong mạng LAN cục bộ. Server lắng nghe trên `http://localhost:8787` với SQLite tạm thời và STUN công cộng Google. Không có TURN relay.

```bash
cd docker
docker compose -f docker-compose.local.yml up --build
```

Server sẽ chạy tại `http://localhost:8787`. 

> **Scenario 1 là ngoại lệ duy nhất còn build từ source.** Image được publish sẵn bởi CI lên Docker Hub (`<tên Docker Hub của bạn>/ponter:latest`) và Scenario 2/3 chỉ `pull` image đó — nên không cần build lại trên máy deploy. Scenario 1 giữ `--build` để thấy đúng code local, kể cả phần chưa commit. Xem [Deploy phiên bản mới](#deploy-phien-ban-moi).

**Health check:**
```bash
curl http://localhost:8787/health
# {"status":"ok"}
```

### Scenario 2: Homelab (Cloudflare Tunnel)

Phơi bày server tới internet thông qua Cloudflare Tunnel. Phù hợp cho máy tính ở nhà muốn truy cập từ bên ngoài mà không cần mở port hoặc cấu hình DNS.

**Bước 1:** Tạo Cloudflare Tunnel:
```bash
cloudflared tunnel create my-tunnel
cloudflared tunnel token my-tunnel
```

**Bước 2:** Cấu hình `.env`:
```bash
cd docker
cp .env.example .env
# Edit .env: set JWT_SECRET, REFRESH_TOKEN_SECRET, CLOUDFLARE_TUNNEL_TOKEN, CORS_ORIGIN
```

**Bước 3:** Khởi động:
```bash
docker compose -f docker-compose.tunnel.yml pull
docker compose -f docker-compose.tunnel.yml up -d
```

### Scenario 3: Production VPS (Caddy + Coturn)

Triển khai đầy đủ trên VPS với HTTPS tự động (Caddy + Let's Encrypt) và máy chủ TURN (Coturn) cho WebRTC NAT traversal.

**Bước 1:** Trỏ domain của bạn (`A`/`CNAME`) tới VPS.

**Bước 2:** Cấu hình `.env`:
```bash
cd docker
cp .env.example .env
# Edit .env: set JWT_SECRET, REFRESH_TOKEN_SECRET, DOMAIN, TURN_SECRET
```

**Bước 3:** Khởi động:
```bash
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
```

Caddy sẽ tự động yêu cầu chứng chỉ Let's Encrypt cho `DOMAIN`. Máy chủ Coturn sử dụng `TURN_SECRET` làm shared secret RFC 5766; endpoint `GET /api/webrtc/ice-servers` trên server sẽ tạo thông tin xác thựng HMAC-SHA1 thời gian giới hạn cho mỗi người dùng.

#### Chọn TURN provider

Server chọn nhà cung cấp TURN qua biến `TURN_PROVIDER`:

| Giá trị | Mô tả |
|---|---|
| `coturn` (mặc định) | Coturn tự host, thông tin xác thực RFC 5766 từ `TURN_SECRET` + `TURN_URL`. Giữ nguyên hành vi các phase trước. |
| `cloudflare` | Cloudflare Calls TURN (hosted). Cần `TURN_KEY_ID` + `TURN_KEY_API_TOKEN`. Server tự mint credential qua API Cloudflare và cache theo TTL. **Lưu ý:** media đi qua hạ tầng Cloudflare (bên thứ ba), tính phí ~$0.05/GB — khác với mô hình tự host. |
| `none` | Chỉ STUN, không relay. Peer sau symmetric NAT có thể không kết nối được. |

Khi Cloudflare lỗi (thiếu config, non-2xx, lỗi mạng), server tự hạ cấp về STUN-only và ghi warning — kết nối không bị chặn.

---

## 3.1 Deploy phiên bản mới

Các Scenario 2 và 3 chạy image đã build sẵn, được publish bởi workflow **Docker Publish** (`.github/workflows/docker-publish.yml`).

**Bước 0 — Trỏ compose tới image của bạn.** Tài khoản Docker Hub không trùng với tên GitHub, nên namespace lấy từ secret `DOCKERHUB_USERNAME` mà workflow đọc, còn Compose đọc biến `DOCKERHUB_IMAGE` trong `docker/.env`. Giá trị mặc định đã trỏ sẵn vào repo đã publish; chỉ ghi đè khi publish dưới namespace khác:

```bash
cd docker
# trong .env (tạo từ .env.example):
DOCKERHUB_IMAGE=ngotuananh2101/ponter
```

**Bước 1 — Publish image:** trên GitHub, vào Actions → *Docker Publish* → *Run workflow*, chọn branch cần build.

Workflow build `linux/amd64` và `linux/arm64` trên hai runner native riêng rồi gộp thành một manifest multi-arch, nên cùng một image chạy được trên VPS x86 lẫn máy ARM (Oracle Cloud, Ampere, Raspberry Pi) mà không cần QEMU.

Image được push lên `<ten-dockerhub-cua-ban>/ponter` (hiện tại là `ngotuananh2101/ponter`). **Phải tạo repo đó trên Docker Hub trước** — Docker Hub không tự tạo repo khi push vào tên chưa tồn tại, mà trả về lỗi authorization.

Ba tag có thể được sinh ra:

| Tag                                             | Khi nào được cập nhật                     | Dùng để                                             |
| ----------------------------------------------- | ----------------------------------------- | --------------------------------------------------- |
| `<ten-dockerhub-cua-ban>/ponter:latest`         | Chỉ khi chạy trên `main`                  | Tag mà các file compose trỏ tới.                    |
| `<ten-dockerhub-cua-ban>/ponter:sha-<sha>`      | Mỗi lần chạy; **chỉ giữ 3 bản gần nhất**  | Ghim một build cụ thể, hoặc rollback về bản trước.  |
| `<ten-dockerhub-cua-ban>/ponter:<tag>`          | Khi cung cấp input `tag` (giữ lâu dài)    | Tag có tên người đọc được (vd `v1.2.3`).            |

Chạy từ feature branch không bao giờ sinh tag `latest`, nên thử nghiệm không thể làm dịch chuyển image mà production đang dùng. Mỗi lần publish không nhập input `tag` sẽ prune các tag `sha-` cũ, chỉ giữ lại ba bản gần nhất.

### 3.1.1 Publish your own image (fork)

The shipped `DOCKERHUB_IMAGE` points at the upstream image. To deploy an image
you built yourself:

```bash
docker build -f docker/Dockerfile.server -t <your-namespace>/ponter:latest .
docker push <your-namespace>/ponter:latest
# then set DOCKERHUB_IMAGE=<your-namespace>/ponter:latest in docker/.env
```

See `docs/guides/self-hosting.md` §2 for the full fork walkthrough.

**Bước 2 — Pull và restart trên máy deploy:**
```bash
cd docker
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
```

**Bước 3 — Kiểm tra:**
```bash
curl https://<your-domain>/health
# {"status":"ok"}
```

**Rollback:** vì `latest` là tag mutable, nếu bản mới lỗi thì sửa dòng `image:` trong file compose thành tag `sha-` của bản trước, rồi `pull && up -d`.

> **Repository secrets:** workflow cần `DOCKERHUB_USERNAME` và `DOCKERHUB_TOKEN` (Docker Hub **access token** tại Account Settings → Personal Access Tokens, quyền Read/Write **và Delete** — không phải mật khẩu account). Bước prune xoá các tag `sha-` cũ qua Docker Hub API, nên token thiếu quyền Delete sẽ làm bước prune đỏ (image vẫn publish thành công).

---

## 3.2 Browser WebSocket Signaling (proxy & idle timeouts)

Browser signaling dùng WebSocket thay cho REST polling. Tab mint một ticket qua `POST /api/ws/ticket` (TTL 15s, one-time) rồi mở `GET /api/ws/browser?ticket=...`; server đẩy signal tới tab ngay khi signal được ghi, không còn vòng poll 200ms–2000ms. REST (`/api/signal/*`) vẫn hoạt động và là fallback khi WS thất bại.

Bật đường WS cho web bằng biến build-time `VITE_BROWSER_WS_SIGNALING` (mặc định `false`):

```env
# apps/web/.env.production
VITE_API_URL=https://your-domain.com
VITE_BROWSER_WS_SIGNALING=true
```

Đây là biến **build-time**: một bundle chỉ mang một giá trị cho toàn bộ user, nên muốn bật/tắt phải rebuild + redeploy frontend (xem [mục 4](#4-deploying-the-web-frontend-to-cloudflare-pages)).

### Vì sao cần cấu hình proxy/Docker

Socket signaling **im lặng khi không có signal đang bay** — đó là trạng thái bình thường khi terminal đang mở. Mọi tầng ở giữa (reverse proxy, Cloudflare Tunnel, Docker) đều có idle timeout mặc định, và hết hạn thì socket bị cắt giữa phiên. Ba chỗ đã được cấu hình sẵn trong repo:

| Tầng | Cấu hình | File |
|---|---|---|
| Caddy (Scenario 3) | matcher `path /api/ws/*` + `transport http { read_buffer 65536; keepalive 300s }` | `docker/Caddyfile` |
| Cloudflare Tunnel (Scenario 2) | `originRequest.maxIdleDuration: 300s` | `docker/cloudflared/config.yml` (mount read-only, truyền qua `--config`) |
| Docker (cả 3 scenario) | `stop_grace_period: 15s` cho service `server` | `docker/docker-compose.*.yml` |

- **Caddy** phải tách block `/api/ws/*` để đặt `keepalive 300s`; mặc định của Caddy thấp hơn và sẽ cắt socket im lặng.
- **Cloudflare Tunnel**: `maxIdleDuration` **không có biến môi trường tương đương** — phải nằm trong `config.yml` và cloudflared phải được chạy với `--config /etc/cloudflared/config.yml`. Chỉ dùng `TUNNEL_TOKEN` (không `--config`) sẽ bỏ qua file này.
- **Docker**: mặc định 10s rồi `SIGKILL`. Server có graceful shutdown (đóng mọi signaling socket bằng close code 1001 rồi drain `server.close`); `stop_grace_period: 15s` cho nó thời gian hoàn tất, nên một lần redeploy không trông giống như mạng bị rớt với mọi tab/agent đang kết nối.

### Xác minh

Sau khi deploy, xác nhận socket sống qua một khoảng im lặng (để terminal mở, không thao tác ~2 phút) rồi kiểm tra tab vẫn kết nối trong DevTools → Network → WS (`/api/ws/browser`). Nếu socket bị đóng định kỳ, tăng `maxIdleDuration`/`keepalive` tương ứng và đảm bảo proxy đang dùng đúng file cấu hình.

Kiểm tra graceful shutdown thủ công:

```bash
docker compose -f docker-compose.prod.yml stop server
docker compose -f docker-compose.prod.yml logs server | tail -20
# Log phải cho thấy socket đóng với code 1001; container thoát 0, không bị SIGKILL.
```

---

## 4. Deploying the Web Frontend to Cloudflare Pages

Frontend `apps/web` là Vue 3 SPA được triển khai như static assets trên Cloudflare Pages. Đây là phần duy nhất của hệ thống sử dụng Cloudflare.

### 4.1 Configure Environment Variables

Web frontend giao tiếp với self-hosted backend thông qua biến môi trường `VITE_API_URL`.

1. Copy template:
   ```bash
   pnpm --filter @ponter/web exec cp .env.production.example .env.production
   ```
   (`.env.production` được gitignored để cấu hình địa phương luôn riêng tư)

2. Cập nhật `VITE_API_URL` với URL của self-hosted server:
   ```env
   VITE_API_URL=https://your-domain.com
   ```

### 4.2 Build and Deploy

```bash
# Build web application
pnpm --filter @ponter/web build

# Deploy to Cloudflare Pages
pnpm --filter @ponter/web exec wrangler deploy
```

### 4.3 Verify Web Deployment

1. Mở `https://<your-pages-project>.pages.dev` trong trình duyệt
2. Đăng ký tài khoản hoặc đăng nhập
3. Test SPA reload: điều hướng tới `/dashboard` và nhấn `F5`. Trang phải tải lại mượt mà mà không lỗi 404.
4. Mở Developer Tools (`F12`) để kiểm tra network requests được gửi tới backend server.

---

## 5. Environment Variables Reference

| Variable | Required | Default | Description |
|---|---|---|---|
| `PORT` | No | `8787` | Server listen port (trong container). |
| `DATABASE_PATH` | No | `/app/data/remote.db` | Đường dẫn file SQLite. |
| `JWT_SECRET` | Yes | — | HMAC secret cho access tokens. Tối thiểu 32 ký tự. |
| `REFRESH_TOKEN_SECRET` | Yes | — | HMAC secret cho refresh tokens. Tối thiểu 32 ký tự. |
| `CORS_ORIGIN` | No | `*` | CORS allow-origin cho API. **Đặt tường minh trong production**: `*` vừa cho phép mọi origin qua CORS, vừa **tắt** Origin check của WebSocket signaling (`/api/ws/browser` — CSWSH defense, xem [mục 3.2](#32-browser-websocket-signaling-proxy--idle-timeouts)). |
| `JWT_EXPIRES_IN` | No | `900` (15m) | Access token TTL (giây). |
| `REFRESH_TOKEN_EXPIRES_IN` | No | `604800` (7d) | Refresh token TTL (giây). |
| `TURN_SECRET` | Prod only | — | Shared secret cho Coturn long-term auth. |
| `TURN_URL` | Prod only | `turn:${DOMAIN}:3478` | TURN URL quảng bá cho clients. Ghi đè trong `.env` để dùng IP thay cho domain. |
| `STUN_URL` | Prod only | `stun:${DOMAIN}:3478` | STUN URL quảng bá cho clients. Ghi đè trong `.env` để dùng IP thay cho domain. |
| `DOMAIN` | Prod only | — | Domain công cộng cho Caddy TLS + TURN realm. |
| `TURN_PROVIDER` | No | `coturn` | Nhà cung cấp TURN: `coturn` \| `cloudflare` \| `none`. |
| `TURN_KEY_ID` | Cloudflare only | — | Cloudflare Calls TURN key ID. Bắt buộc khi `TURN_PROVIDER=cloudflare`. |
| `TURN_KEY_API_TOKEN` | Cloudflare only | — | Cloudflare TURN API token (Bearer). Bắt buộc khi `TURN_PROVIDER=cloudflare`. |
| `CLOUDFLARE_TUNNEL_TOKEN` | Tunnel only | — | Cloudflare Tunnel token. |
| `VITE_API_URL` | Web only | `http://localhost:8787` | API URL cho web frontend. |
| `VITE_BROWSER_WS_SIGNALING` | Web only | `false` | Bật signaling qua WebSocket (`/api/ws/browser`) thay vì REST poll. Build-time — rebuild để đổi. Xem [mục 3.2](#32-browser-websocket-signaling-proxy--idle-timeouts). |

---

## 6. Troubleshooting

### Issue: Container fails to start with "permission denied" on SQLite file

**Cause**: Volume mount quá chặt chẽ hoặc thư mục `data` chưa tồn tại.

**Solution**: Đảm bảo thư mục `data` tồn tại và có quyền ghi:
```bash
mkdir -p docker/data
chmod 755 docker/data
```

### Issue: CORS error when web app calls API

**Cause**: `CORS_ORIGIN` không khớp với domain web app.

**Solution**: Cập nhật `CORS_ORIGIN` trong `.env` để khớp với production domain:
```env
CORS_ORIGIN=https://your-app.pages.dev
```

### Issue: WebRTC connection fails in production

**Cause**: TURN server chưa cấu hình đúng hoặc firewall chặn port UDP.

**Solution**:
1. Đảm bảo `TURN_SECRET` được cài đặt trong `.env`
2. Mở port UDP 3478 và range 49152-49200 trên firewall
3. Kiểm tra endpoint ICE servers:
   ```bash
   curl -H "Authorization: Bearer <jwt>" https://your-domain.com/api/webrtc/ice-servers
   ```

### Issue: Agent cannot connect to WebSocket

**Cause**: Agent đang kết nối tới URL sai hoặc credential không hợp lệ.

**Solution**:
1. Đảm bảo agent kết nối tới `ws://<host>:8787/api/ws/agent` (hoặc `wss://` qua tunnel/Caddy)
2. Kiểm tra credential agent hợp lệ trong database:
   ```bash
   sqlite3 data/remote.db "SELECT id, user_id FROM agents;"
   ```
3. Xem log server để tìm lỗi xác thực.

### Issue: Browser signaling socket (`/api/ws/browser`) keeps disconnecting

**Cause**: Một tầng proxy/tunnel ở giữa cắt kết nối im lặng theo idle timeout mặc định.

**Solution**: Xem [mục 3.2](#32-browser-websocket-signaling-proxy--idle-timeouts). Kiểm tra Caddy đang dùng block `/api/ws/*` với `keepalive 300s`, và Cloudflare Tunnel đang chạy với `--config /etc/cloudflared/config.yml` (chỉ `TUNNEL_TOKEN` sẽ bỏ qua `maxIdleDuration`).

### Issue: GitHub Actions deploy fails with "This Worker does not exist"

**Cause**: Lỗi này chỉ áp dụng cho Cloudflare Workers backend cũ. Với kiến trúc self-hosted Docker, backend không còn deploy lên Cloudflare Workers nữa.

**Solution**: Chỉ cần triển khai frontend lên Cloudflare Pages và backend qua Docker Compose. Xem [GitHub Actions workflow](../.github/workflows/deploy.yml) để cấu hình CI/CD.