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
   - **WebSocket**: In-memory `Map<agentId, AgentConnection>` dispatcher
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
docker compose -f docker-compose.tunnel.yml up --build
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
docker compose -f docker-compose.prod.yml up --build -d
```

Caddy sẽ tự động yêu cầu chứng chỉ Let's Encrypt cho `DOMAIN`. Máy chủ Coturn sử dụng `TURN_SECRET` làm shared secret RFC 5766; endpoint `GET /api/webrtc/ice-servers` trên server sẽ tạo thông tin xác thực HMAC-SHA1 thời gian giới hạn cho mỗi người dùng.

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
| `CORS_ORIGIN` | No | `*` | CORS allow-origin cho API. |
| `JWT_EXPIRES_IN` | No | `900` (15m) | Access token TTL (giây). |
| `REFRESH_TOKEN_EXPIRES_IN` | No | `604800` (7d) | Refresh token TTL (giây). |
| `TURN_SECRET` | Prod only | — | Shared secret cho Coturn long-term auth. |
| `TURN_URL` | Prod only | `turn:${DOMAIN}:3478` | TURN URL quảng bá cho clients. |
| `STUN_URL` | Prod only | `stun:${DOMAIN}:3478` | STUN URL quảng bá cho clients. |
| `DOMAIN` | Prod only | — | Domain công cộng cho Caddy TLS + TURN realm. |
| `CLOUDFLARE_TUNNEL_TOKEN` | Tunnel only | — | Cloudflare Tunnel token. |
| `VITE_API_URL` | Web only | `http://localhost:8787` | API URL cho web frontend. |

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

### Issue: GitHub Actions deploy fails with "This Worker does not exist"

**Cause**: Lỗi này chỉ áp dụng cho Cloudflare Workers backend cũ. Với kiến trúc self-hosted Docker, backend không còn deploy lên Cloudflare Workers nữa.

**Solution**: Chỉ cần triển khai frontend lên Cloudflare Pages và backend qua Docker Compose. Xem [GitHub Actions workflow](../.github/workflows/deploy.yml) để cấu hình CI/CD.