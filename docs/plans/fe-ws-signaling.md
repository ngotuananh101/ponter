# Kế hoạch triển khai chi tiết — FE WebSocket signaling (repo /mnt/Data/Ponta/remote-platform)

> Bối cảnh code đã kiểm chứng: monorepo pnpm + Turborepo (Node.js 24). Backend self-hosted Docker (`apps/server`, Hono + `ws` + SQLite), FE Vue 3 SPA trên Cloudflare Workers Static Assets (deploy bằng `wrangler deploy`). Agent Rust (`apps/agent`) không được chỉnh sửa. `RESTPollingTransport` + `POST /api/signal/{offer,answer,ice-candidate}` + `GET /api/signal/poll/:sessionId` hiện trạng: `rowid` dùng để sắp xếp nội bộ, cursor trên wire là UUID `id` của signal cuối (server map `id`→`rowid` — cùng semantics REST poll). Đọc `apps/server/src/routes/ws.ts:22` (agentConnections Map), `index.ts:109-118` (chỉ bắt `/api/ws/agent`, destroy phần còn lại), `jwt.ts:38-45` (TokenPayload chưa có `scope`), `auth.ts:52-103` (verifyTokenForUser chỉ check `type`), `app.ts:16-27` (CORS_ORIGIN parsing inline), `signal.ts:231-247` (replay rowid > afterId pattern), `terminal.ts:41-116` (RESTPollingTransport hardcoded, không có flag).

## MỤC LỤC

1. [Tóm tắt](#1-tóm-tắt)
2. [Bối cảnh & Mục tiêu](#2-bối-cảnh--mục-tiêu)
3. [Quyết định thiết kế](#3-quyết-định-thiết-kế)
4. [Protocol spec (JSON envelope, hai chiều)](#4-protocol-spec-json-envelope-hai-chiều)
5. [Phases triển khai](#5-phases-triển-khai)
   - [P1 — Server: ticket endpoint + browser WS + subscribe/replay + pushToBrowser + notify SESSION_TERMINATED + keepalive + tests](#p1--server)
   - [P2 — Shared: BrowserSocketMessage types + export](#p2--shared)
   - [P3 — FE: WebSocketSignalTransport + reconnect + fallback + flag + unit tests](#p3--fe)
   - [P4 — E2E WS variant + docs + infra](#p4--e2e-ws-variant--docs--infra-proxydocker)
   - [P5 — Rollout (server trước, flag OFF → global flip → đo lường → quyết định)](#p5--rollout)
6. [Red-team fixes đã tích hợp](#6-red-team-fixes-đã-tích-hợp-và-đã-được-plan-critic-xác-minh-lại)
7. [Rủi ro](#7-rủi-ro)
8. [Rollback](#8-rollback)
9. [Câu hỏi mở](#9-câu-hỏi-mở)
10. [Phụ lục: checklist merge / checklist bật flag prod](#10-phụ-lục-checklist-merge--checklist-bật-flag-prod)

## 1. Tóm tắt

Thay `RESTPollingTransport` (poll 200ms–2000ms) bằng `WebSocketSignalTransport` cho WebRTC signaling browser↔server, sau feature flag `VITE_BROWSER_WS_SIGNALING` (mặc định OFF), giữ REST làm fallback. Server thêm `POST /api/ws/ticket` (ticket one-time TTL 15s) + endpoint `/api/ws/browser` (subscribe/replay/push/keepalive). Agent Rust và `PeerConnection` không đổi. 5 phase: P1 server → P2 shared types → P3 FE transport → P4 E2E + infra → P5 rollout. Kế hoạch đã qua vòng verify 5 vùng code + red-team 3 lăng kính + plan-critic đối chiếu code thật.

## 2. Bối cảnh & Mục tiêu

### Tại sao bỏ polling
Polling (`RESTPollingTransport` poll 200ms–2000ms) tạo latency signal delivery ≥ 200ms, tải server tăng tuyến tính với số session hoạt động. WebSocket cung cấp delivery gần như ngay lập tức (sub-ms push qua `pushToAgent` pattern tương tự) và giảm request volume.

### Phạm vi
- **Làm được:** Server WS browser path, ticket endpoint, transport FE, types shared, tests, rollout.
- **KHÔNG làm:** Agent Rust (`apps/agent`), `PeerConnection/connection.ts` (giữ nguyên `SignalTransport` interface), REST endpoints (giữ làm fallback chính thức).

### Giới hạn thiết kế
- 1 WS connection cho mỗi signaling session (mỗi PeerConnection — tức mỗi `agentId` trong 1 page load). Nhiều tab → mỗi tab có WS riêng cho session của tab đó; server fan-out qua `browserConnections: Map<userId, Set<BrowserConnection>>`.
- Cursor trên wire = UUID `id` của signal cuối (giống REST poll). `rowid` chỉ dùng trong SQL nội bộ để sắp xếp: `ORDER BY rowid ASC` + `rowid > COALESCE((SELECT rowid FROM signals WHERE id=afterId AND session_id=sessionId), 0)` — copy pattern từ `signal.ts:231-247`.
- REST polling giữ nguyên hoạt động, chỉ được dùng khi WS fallback.

## 3. Quyết định thiết kế (decisions)

### D1. 1 WS cho mỗi signaling session (mỗi PeerConnection), không multiplex nhiều session trên 1 socket
- **Lý do:** `terminal.ts:41` tạo 1 PeerConnection (→ 1 transport) cho mỗi `agentId` per page load; transport giữ 1 `sessionId`. Mỗi tab là một page load riêng → mỗi tab có WS riêng cho session của nó. Server-side fan-out tới nhiều tab qua `Map<userId, Set<BrowserConnection>>`.
- **Lựa chọn bị loại:** Multiplex nhiều `sessionId` trên 1 WS/tab (kèm BroadcastChannel để chia sẻ giữa tab) — phức tạp hơn nhiều, không cần thiết ở scale hiện tại; giữ mô hình "1 socket ↔ 1 session" khớp với `SignalTransport` interface.

### D2. Ticket one-time, TTL 15s (giảm từ thiết kế gốc 30s)
- **Lý do:** Browser WebSocket API không set được `Authorization` header → token qua query string. TTL ngắn giảm rủi ro lộ qua access log proxy. One-time (jti registry in-memory) giảm replay window.
- **Endpoint thực tế:** `POST /api/ws/ticket` — mount một Hono router nhỏ export từ `routes/ws.ts` (`wsTicketRouter`) vào `app.ts` tại `/api/ws`. Lưu ý: KHÔNG đặt trong `routes/auth.ts` vì router đó mount tại `/api/auth` (path sẽ thành `/api/auth/ws/ticket`); giữ đúng path thiết kế bằng router riêng.
- **One-time registry:** module mới `apps/server/src/utils/ws-ticket.ts` — `registerWsTicket(jti, exp)` gọi lúc mint; `consumeWsTicket(jti): boolean` gọi lúc upgrade (true nếu hợp lệ + đánh dấu đã dùng; false nếu đã dùng/hết hạn/không tồn tại). Lazy cleanup các entry hết hạn mỗi lần register/consume. In-memory — chấp nhận được vì single-replica (xem D1/Risks).
- **Lựa chọn bị loại:** Cookie-based auth cho WS — không khả thi vì server là self-hosted, cookie cần `Secure; SameSite` phức tạp; query string `?ticket=` là chuẩn W3C WebSocket API. Subprotocol header (`Sec-WebSocket-Protocol`) tránh được access log nhưng thêm phức tạp handleProtocols — để open question.

### D3. Sắp xếp nội bộ bằng SQLite `rowid`; cursor trên wire = UUID `id`
- **Lý do:** `signals.id` là `crypto.randomUUID()` (TEXT PK, `signals.ts:92`), không monotonic nên không thể ORDER BY. `rowid` là 64-bit auto-increment, strictly monotonic 1:1 với hàng — dùng để `ORDER BY rowid ASC` và `rowid > COALESCE((SELECT rowid FROM signals WHERE id = ? AND session_id = ?), 0)` (copy nguyên pattern REST poll, `signal.ts:231-247`). Cursor trên wire vẫn là UUID `id` của signal cuối cùng (giống REST poll); server tự map sang `rowid`. `rowid` KHÔNG lên wire.
- **Lựa chọn bị loại:** Đưa `rowid` lên wire làm cursor — FE phải đổi cách đọc cursor so với REST mà không được lợi gì; `id` giữ nguyên semantics với REST poll.

### D4. Replay LIMIT 200 + `hasMore` flag
- **Lý do:** Tránh WS queue saturation khi browser offline lâu. Trùng với REST max 200 (`signal.ts:210`).
- **Lựa chọn bị loại:** Không limit — rủi ro memory exhaustion + event loop block.

### D5. Atomic subscribe: state machine `replaying → live` + buffer + dedup theo signal id
- **Lý do:** Đảm bảo ordering giữa replay và live stream. Trong lúc replay (async DB), live push cho session được **buffer** thay vì gửi ngay; sau replay, flush buffer và **bỏ các frame có `id` đã nằm trong batch replay** (dedup theo UUID id, không cần `rowid` cho live path).
- **Hệ quả:** KHÔNG cần `lastDeliveredRowid` cho live push, nên KHÔNG cần truy vấn `rowid` của signal vừa insert (`recordSignal().returning()` không có rowid — `SignalSelect` không chứa nó). `rowid` chỉ xuất hiện trong câu SQL replay nội bộ.
- **Lựa chọn bị loại:** (a) Không có bước này — race replay/live gây out-of-order delivery (WebRTC state machine order-sensitive). (b) Dedup bằng `rowid` cho từng live push — đòi hỏi query `SELECT rowid` mỗi signal và không cần thiết vì set id trong cửa sổ replay là đủ.

### D6. Outbound queue = chỉ signal CHƯA từng gửi; flush sau re-subscribe
- **Lý do:** `send()` khi WS chưa open (CONNECTING/đang reconnect) → queue. Signal đã `ws.send()` khi socket OPEN thì fire-and-forget (giống hệt REST POST hiện tại) — KHÔNG đưa vào queue, nên không bao giờ re-send → **không thể tạo duplicate phía server**. Queue giữ nguyên qua các lần close (chỉ chứa signal chưa từng gửi) và được flush ngay sau khi gửi lại `subscribe` ở lần reconnect kế tiếp.
- **Lựa chọn bị loại:** (a) Clear queue on close — làm mất signal client sinh ra trong lúc mất kết nối (server replay không bù được vì chúng chưa từng vào DB). (b) Re-send mọi thứ đã gửi — duplicate server-side (server không có dedup inbound; client phải dựa vào guard phía agent như duplicate-signals.test.ts).

### D7. Origin check (CSWSH protection)
- **Lý do:** `?ticket=` trong query string, không có CORS protection WS. Trang web A malicious có thể mở WS tới `/api/ws/browser?ticket=<stolen>`. Origin check so với `CORS_ORIGIN` (parse giống `app.ts:16-27`).
- **Lựa chọn bị loại:** Không check Origin — red-team: CSWSH risk.

### D8. Liveness = protocol-level `ws.ping()` (30s) + pong watchdog (90s)
- **Lý do:** Browser **tự động trả pong ở tầng giao thức** (RFC 6455) — không phụ thuộc JS, nên không bị throttle khi tab background (khác với app-level `{type:'ping'}` phải chờ JS xử lý). Server gọi `ws.ping()` mỗi 30s, theo dõi event `'pong'`; quá 90s không pong → `close(4408)`.
- **Vẫn chấp nhận** frame app-level `{type:'ping'}` từ client (server trả `{type:'pong'}`) — giữ tương thích pattern agent; nhưng KHÔNG cần thiết cho liveness.
- **Lý do không dùng app-level làm chính:** client phải tự setInterval + trả lời, JS bị throttle ở tab background → false disconnect. `ws` không có `pingInterval` built-in (khác `ws` client) nên phải tự đặt `setInterval` phía server — timer server không bị throttle.
- **Interval/timeout phải inject được** (factory options) để test nhanh, không chờ 90s thật.

### D9. Graceful shutdown (SIGTERM handler)
- **Lý do:** `index.ts:166` hiện không có signal handler. Docker stop gửi SIGTERM → process chết đột ngột → mất in-process Map. Graceful shutdown: dừng nhận upgrade mới, close WS 1001, flush DB, exit.
- **Lựa chọn bị loại:** Không graceful — reconnect storm mạnh, mất SESSION_TERMINATED push.

### D10. Fallback cơ chế
- **Lý do:** WS không mở được → dùng `RESTPollingTransport` (existing code). `WebSocketSignalTransport` có `fallback?: SignalTransport` option.
- **Lựa chọn bị loại:** Retry WS vĩnh viễn — UX kém, không có fallback DB-backed.

### D11. Feature flag mặc định OFF
- **Lý do:** Rollout an toàn. `terminal.ts` chọn transport theo `VITE_BROWSER_WS_SIGNALING`.
- **Lựa chọn bị loại:** Default ON — rủi ro regression toàn bộ user.

### D12. Scope separation: ticket dùng JWT_SECRET nhưng có guard chống REST accept
- **Lý do:** `TokenPayload` hiện không có `scope` (`jwt.ts:38-45`). Ticket có `type='access'` + `scope='ws-ticket'`. `authMiddleware` reject tokens có `scope='ws-ticket'` (sau `verifyTokenForUser`). `verifyWsTicket` helper kiểm tra scope độc lập.
- **Bắt buộc cả 2 chiều:** thiếu guard trong `authMiddleware` thì ticket dùng được như access token (leo thang đặc quyền); thiếu check trong `verifyWsTicket` thì access token 15 phút dùng được làm ticket. Đây là implementation step bắt buộc, không phải tùy chọn.
- **Lựa chọn bị loại:** Ticket dùng secret riêng (`WS_TICKET_SECRET`) — red-team đánh giá option (a) đủ an toàn, tránh thêm env secret mới.

### D13. Stale cursor (signal đã bị cleanup xoá) → replay time-bound, KHÔNG replay từ đầu
- **Lý do:** Cleanup xoá signal hết TTL 5 phút mỗi 15 phút (`cleanup.ts:43-46`). Nếu dùng `COALESCE(...,0)` như REST poll, cursor trỏ vào row đã xoá sẽ replay TOÀN BỘ signal còn lại của session từ đầu. Với REST poll điều này vô hại (client tự bỏ qua signal cũ); với WS replay thì tốn vô ích và có thể lẫn signal cũ vào state machine.
- **Cách xử lý:** câu replay WS thêm điều kiện `created_at > datetime('now', '-5 minutes')` (đúng bằng SIGNAL_TTL) — replay tối đa 5 phút gần nhất; nếu cursor không resolve được rowid thì vẫn time-bound. Log cảnh báo khi cursor stale. Client coi `subscribed.hasMore=false` + không nhận được signal cũ là bình thường.
- **Lựa chọn bị loại:** Reject subscribe khi cursor stale — làm hỏng reconnect đúng lúc cần nhất; session chết thì SESSION_TERMINATED sẽ tới qua live push.

## 4. Protocol spec (JSON envelope, hai chiều)

### Frame size limit
- 256KB (`MAX_INBOUND_FRAME_BYTES = 256*1024` ở `ws.ts:13`). Apply cả cho browser WS inbound (enforce pre-parse).

### Client → Server (BrowserSocketMessage C->S)

| Type | Data | Mô tả |
|------|------|-------|
| `subscribe` | `{sessionId: string, after?: string\|null}` | Đăng ký subscription. `after` = UUID signal id cuối đã nhận (null = first subscribe). |
| `signal` | `SignalMessage` | Forward signal tới agent qua `pushToAgent`. |
| `ping` | — | Heartbeat client→server. |

```json
{"type":"subscribe","data":{"sessionId":"sess_123","after":"sig_abc"}}
{"type":"signal","data":{"type":"offer","data":{"sessionId":"sess_123","sdp":"...","capabilities":["terminal"]}}}
{"type":"ping"}
```

### Server → Client (BrowserSocketMessage S->C)

| Type | Data | Mô tả |
|------|------|-------|
| `pong` | — | Trả lời client ping (app-level, optional). |
| `signal` | `{data: SignalMessage, id: string}` | Replay từ DB hoặc live push. `id` = UUID signal — client lưu làm cursor (`lastCursor = id`). |
| `subscribed` | `{sessionId: string, after: string\|null, hasMore: boolean}` | Ack sau replay. `hasMore=true` → client gửi tiếp `subscribe` với `after` = id cuối vừa nhận. |
| `error` | `{code: BrowserErrorCode}` | Lỗi (auth, not found, terminated, ...). |

```json
{"type":"pong"}
{"type":"signal","data":{"type":"offer","data":{"sessionId":"sess_123","sdp":"...","capabilities":["terminal"]}},"id":"sig_abc"}
{"type":"subscribed","data":{"sessionId":"sess_123","after":"sig_abc","hasMore":false}}
{"type":"error","code":"SESSION_TERMINATED"}
```

**Ghi chú envelope:** giữ đúng pattern `AgentSocketMessage` — `pong`/`error`/`subscribed` có `code`/`data` ở top level (không bọc trong `data`). `signal` giữ `{type, data, id}` như thiết kế gốc. `rowid` KHÔNG xuất hiện trên wire (chỉ dùng trong SQL nội bộ server).

### BrowserErrorCode
- `MALFORMED_JSON`, `VALIDATION_ERROR`, `NOT_FOUND`, `UNAUTHORIZED`, `TICKET_EXPIRED`, `SESSION_TERMINATED`, `INTERNAL_SERVER_ERROR`
- `AgentErrorCode` hiện tại không có `SESSION_TERMINATED` — thêm riêng cho browser.

### Close codes
- `4401` — Unauthorized (ticket invalid/expired/wrong scope, Origin mismatch).
- `4408` — Timeout (server ping chưa nhận pong trong 90s).
- `4409` — Replaced (không dùng cho browser, chỉ agent).

### Subscribe → replay → live flow (sequence)
```
1. Browser gửi subscribe{sessionId, after}
2. Server: validate session.userId == ticket.sub
3. Server: registry subscription + set session state = 'replaying'
   (live push cho session này được BUFFER, không gửi ngay)
4. Server: replay SQL:
     SELECT id, session_id, type, payload, created_at FROM signals
     WHERE session_id = ? AND (expires_at IS NULL OR expires_at > datetime('now'))
       AND created_at > datetime('now', '-5 minutes')      -- time-bound, chống stale cursor
       AND rowid > COALESCE((SELECT rowid FROM signals WHERE id = ? AND session_id = ?), 0)
     ORDER BY rowid ASC LIMIT 200
5. Server: gửi từng signal S->C {type:signal, data, id}
6. Server: flush buffer — gửi các frame buffered có id CHƯA nằm trong batch replay (dedup theo id)
7. Server: set session state = 'live'
8. Server: gửi {type:subscribed, data:{sessionId, after:lastId, hasMore}}
9. Live push từ đây: pushToBrowser gửi thẳng
```
Nếu `hasMore=true` (replay chạm LIMIT 200): client gửi tiếp `subscribe` với `after` = id cuối cùng nhận được; server lặp lại bước 3-8 cho trang kế.

### Reconnect flow
```
1. WS đóng (network drop / server restart)
2. Transport: giữ nguyên outbound queue (chỉ chứa signal chưa từng gửi)
3. Transport: fetch fresh ticket (401 → refresh once → retry ticket 1 lần)
4. Transport: mở WS ?ticket=
5. Transport: gửi subscribe{after: lastCursor} (lastCursor = UUID id cuối nhận được)
6. Server: replay missed signals (rowid > map(after), time-bound 5 phút) → subscribed ack
7. Transport: flush outbound queue (signal sinh ra lúc mất kết nối)
8. Transport: resume live push
Backoff: 200ms → 2000ms exponential + jitter ±50ms. Max 5 retries → fallback REST.
```

## 5. Phases triển khai

### P1 — Server: ticket endpoint + browser WS + subscribe/replay + pushToBrowser + notify SESSION_TERMINATED + keepalive + tests

**Goal:** Server sẵn sàng nhận browser WS, issue ticket, push signal tới browser, notify session terminate.

**Files:**
- `apps/server/src/utils/jwt.ts` — thêm `scope?: string` vào TokenPayload, thêm `signWsTicket()`.
- `apps/server/src/utils/auth.ts` — thêm `verifyWsTicket()`.
- `apps/server/src/utils/ws-ticket.ts` (NEW) — one-time registry `registerWsTicket()` / `consumeWsTicket()`.
- `apps/server/src/utils/env.ts` (NEW) — extract `getJwtSecret()` / `getRefreshSecret()` (hiện là private trong `routes/auth.ts:23-40`).
- `apps/server/src/middleware/auth.ts` — thêm guard reject `scope === 'ws-ticket'`.
- `apps/server/src/utils/cors.ts` (NEW) — extract `getAllowedOrigins()`.
- `apps/server/src/routes/ws.ts` — `browserConnections` Map, `BrowserConnection` interface, `wsTicketRouter` (mint endpoint), `handleBrowserUpgrade`, `pushToBrowser`, browser message handler, keepalive.
- `apps/server/src/app.ts` — mount `wsTicketRouter` tại `/api/ws` (path thật: `POST /api/ws/ticket`).
- `apps/server/src/routes/auth.ts` — dùng `getJwtSecret` từ `utils/env.ts` (thay bản private).
- `apps/server/src/index.ts` — thêm upgrade handler `/api/ws/browser`, graceful shutdown.
- `apps/server/test/ws-browser.test.ts` (NEW) — browser WS tests.

**Steps:**
1. `jwt.ts:38-45`: thêm `scope?: string` vào `TokenPayload`. Tạo `signWsTicket(userId, username, secret, expiresInSeconds=15)` — mirror shape của `signAccessToken` (trả `{ticket, jti, exp}` để caller đăng ký one-time registry):
   ```typescript
   export async function signWsTicket(
     userId: string, username: string, secret: string, expiresInSeconds = 15,
   ): Promise<{ ticket: string; jti: string; exp: number }> {
     const jti = crypto.randomUUID();
     const exp = Math.floor(Date.now() / 1000) + expiresInSeconds;
     const payload: TokenPayload = {
       sub: userId, username, type: 'access', scope: 'ws-ticket', jti, exp,
     };
     return { ticket: await sign(payload, secret), jti, exp };
   }
   ```
2. `utils/env.ts` (NEW): chuyển `getJwtSecret()` + `getRefreshSecret()` từ `routes/auth.ts` sang đây, export; `routes/auth.ts` import lại (không đổi hành vi).
3. `utils/ws-ticket.ts` (NEW): one-time registry in-memory:
   ```typescript
   const tickets = new Map<string, number>(); // jti -> expiresAtMs
   export function registerWsTicket(jti: string, ttlMs = 15_000): void {
     const now = Date.now();
     for (const [k, exp] of tickets) if (exp <= now) tickets.delete(k); // lazy cleanup
     tickets.set(jti, now + ttlMs);
   }
   export function consumeWsTicket(jti: string): boolean {
     const exp = tickets.get(jti);
     if (exp === undefined || exp <= Date.now()) return false;
     tickets.delete(jti); // one-time
     return true;
   }
   ```
4. `utils/auth.ts`: thêm `verifyWsTicket(rawToken, secret)`:
   ```typescript
   export async function verifyWsTicket(rawToken: string, secret: string): Promise<TokenPayload> {
     const payload = await verifyToken(rawToken, secret);
     if (payload.type !== 'access' || payload.scope !== 'ws-ticket') {
       throw new Error('Invalid ws-ticket');
     }
     return payload;
   }
   ```
5. `middleware/auth.ts:22-51`: sau khi `verifyTokenForUser()` trả `{payload, user}`, thêm guard (BẮT BUỘC — nếu thiếu, ws-ticket dùng được như access token):
   ```typescript
   if (payload.scope === 'ws-ticket') {
     throw new AppError('WS ticket rejected by REST', 401, 'UNAUTHORIZED');
   }
   ```
6. `utils/cors.ts` (NEW): extract logic từ `app.ts:16-27`:
   ```typescript
   export function getAllowedOrigins(): string[] | '*' {
     const corsOrigin = process.env.CORS_ORIGIN?.trim();
     if (!corsOrigin || corsOrigin === '*') return '*';
     return corsOrigin.split(',').map((o) => o.trim());
   }
   ```
7. `app.ts`: import `getAllowedOrigins` từ `utils/cors.ts`, dùng trong CORS middleware. Mount ticket router: `app.route('/api/ws', wsTicketRouter)`.
8. `routes/ws.ts`: `wsTicketRouter` (Hono nhỏ, `new Hono<AppContext>()`):
   ```typescript
   wsTicketRouter.post('/ticket', authMiddleware, async (c) => {
     const user = c.get('user');
     const { ticket, jti } = await signWsTicket(user.id, user.username, getJwtSecret(), 15);
     registerWsTicket(jti);
     return c.json({ ticket, expiresIn: 15 });
   });
   ```
9. `routes/ws.ts`: thêm `browserConnections` Map + `BrowserConnection` + `handleBrowserUpgrade` + `pushToBrowser`:
   - `BrowserConnection`: `{ userId, socket, send(data: string), subscriptions: Map<string, Subscription>, lastPongAt: number }` với `Subscription = { state: 'replaying' | 'live', replayedIds: Set<string>, buffer: BrowserSocketMessage[] }`.
   - `browserConnections = new Map<string, Set<BrowserConnection>>()`.
   - `handleBrowserUpgrade(request, socket, head, wss)`: parse `?ticket=` từ `request.url` (dùng `new URL(url, 'http://localhost')`) → `verifyWsTicket(ticket, getJwtSecret())` → `consumeWsTicket(payload.jti)` (false → 401) → Origin check qua `getAllowedOrigins()` (allowlist `'*'` → cho qua; ngược lại yêu cầu `Origin` ∈ allowlist, thiếu/sai → 403) → `wss.handleUpgrade` → đăng ký `browserConnections`. Mọi nhánh lỗi: ghi HTTP response thô + `socket.destroy()` (theo pattern `handleAgentUpgrade`, `ws.ts:52-95`).
   - `pushToBrowser(userId, sessionId, msg: BrowserSocketMessage): boolean`: iterate `browserConnections.get(userId)`; với mỗi conn có subscription cho sessionId: nếu `state === 'replaying'` → `buffer.push(msg)`; nếu `'live'` → `conn.send(JSON.stringify(msg))`. Best-effort, không throw.
10. `routes/ws.ts` browser message handler (trên socket browser): size check pre-parse (`MAX_INBOUND_FRAME_BYTES`), JSON.parse, validate envelope:
    - `subscribe{sessionId, after}`: validate session thuộc `connection.userId` (SELECT id, userId FROM sessions) → tạo/reset subscription `state='replaying'` → chạy replay SQL (time-bound 5 phút + `LIMIT 201`, trim còn 200) → gửi từng frame `{type:'signal', data, id}` + ghi `replayedIds` → flush buffer (bỏ frame signal có `id` ∈ replayedIds; các frame `error` khác đi thẳng) → set `state='live'` (**đồng bộ, không `await` giữa flush và set state** — single-threaded nên đây là điểm atomic) → gửi `{type:'subscribed', data:{sessionId, after:lastId, hasMore}}`.
    - `signal{data}`: parse bằng `parseSignalMessage` hiện có → validate session thuộc user + `agentId` khớp (như `handleInboundMessage` `ws.ts:245-290`) → `recordSignal` → `pushToAgent` + `pushToBrowser` (bỏ qua echo cho chính conn gửi).
    - `ping`: trả `{type:'pong'}`.
    - Frame lỗi → `{type:'error', code:'VALIDATION_ERROR'|'MALFORMED_JSON'|'NOT_FOUND'}`.
11. `routes/ws.ts:161-183` (agent close handler): đổi update terminate sessions thành `.returning({ id: sessions.id, userId: sessions.userId })`, rồi loop `pushToBrowser(row.userId, row.id, {type:'error', code:'SESSION_TERMINATED'})`.
12. `routes/sessions.ts:116-143` (DELETE): sau khi terminate, gọi `pushToBrowser(user.id, sessionId, {type:'error', code:'SESSION_TERMINATED'})` — import từ `./ws.js`.
13. `routes/ws.ts` keepalive (chỉ browser socket): factory nhận `{ pingIntervalMs = 30_000, pongTimeoutMs = 90_000 }` (inject được để test). `setInterval` → `socket.ping()`; event `'pong'` cập nhật `lastPongAt`; watchdog kiểm tra `Date.now() - lastPongAt > pongTimeoutMs` → `close(4408)`. Clear interval trong close handler + xoá khỏi `browserConnections`.
14. `index.ts:109-118`: thêm nhánh `/api/ws/browser` (with/without query) → `handleBrowserUpgrade(...)`; nhánh còn lại `socket.destroy()` như cũ.
15. `index.ts:166-190` (`startServer`): thêm `process.on('SIGTERM'|'SIGINT')` — `cleanup.stop()`, đóng mọi browser+agent socket bằng `close(1001, 'Server shutting down')`, `server.close(callback → process.exit(0))`, fallback forced exit sau 10s.
16. `routes/ws.ts` sau `recordSignal` (dòng ~291): `pushToBrowser(session.userId, message.data.sessionId, {type:'signal', data: message, id: inserted.id})` — KHÔNG cần `rowid` (dedup theo `id`, xem D5).

**Tests:**
- `apps/server/test/ws-browser.test.ts` (theo pattern `startOnEphemeral()` ở `signaling.test.ts:61`):
  - Ticket: 401 thiếu Bearer; mint OK trả `{ticket, expiresIn:15}`.
  - Scope separation 2 chiều: REST endpoint reject ws-ticket (401); `handleBrowserUpgrade` reject access token thường (401).
  - One-time: dùng ticket lần 2 → 401. Ticket hết hạn (inject TTL ngắn) → 401.
  - Origin: `CORS_ORIGIN` allowlist + Origin sai → 403; Origin đúng → upgrade OK.
  - Subscribe: ownership (user khác → NOT_FOUND); replay đúng thứ tự rowid; `hasMore` khi > 200; stale cursor (signal đã xoá) → không replay từ đầu (time-bound).
  - Agent→browser push: agent gửi signal qua agent WS → browser nhận `{type:'signal', id}` ngay (không qua poll).
  - Buffer/dedup: signal đến trong lúc replay không bị gửi 2 lần.
  - SESSION_TERMINATED khi agent WS đóng + khi DELETE session.
  - Keepalive: với `pingIntervalMs`/`pongTimeoutMs` inject ngắn — client không pong → close 4408.

**Verification:**
```bash
cd /mnt/Data/Ponta/remote-platform
pnpm --filter @ponter/server test
pnpm --filter @ponter/server typecheck
pnpm lint
```

**Done when:** Tất cả browser WS tests pass, typecheck xanh, không ảnh hưởng agent WS hiện có.

**Commit:** `feat(server): browser WebSocket signaling with ticket auth + replay + push`

### P2 — Shared: BrowserSocketMessage types + export

**Goal:** Các type cho WS browser message ở shared package, import server + client chung.

**Files:**
- `packages/shared/src/types/signaling.ts` — thêm `BrowserSocketMessage`, `BrowserErrorCode`, `parseBrowserMessage`.
- `packages/shared/src/types/index.ts` — thêm vào block export có sẵn từ `./signaling.js` (file dùng `export type {...}` — các type mới thêm vào block này; `parseBrowserMessage` là function nên export qua `packages/shared/src/index.ts` đã có `export * from './types/index.js'`; **không** dùng `export type` cho function).

**Steps:**
1. `signaling.ts`: thêm (giữ đúng convention file — type + validator thuần, không import runtime):
   ```typescript
   export type BrowserErrorCode =
     | 'MALFORMED_JSON' | 'VALIDATION_ERROR' | 'NOT_FOUND'
     | 'UNAUTHORIZED' | 'TICKET_EXPIRED' | 'SESSION_TERMINATED' | 'INTERNAL_SERVER_ERROR';

   /** Client -> Server */
   export type BrowserMessageInit =
     | { type: 'subscribe'; data: { sessionId: string; after?: string | null } }
     | { type: 'signal'; data: SignalMessage }
     | { type: 'ping' };

   /** Server -> Client. Envelope theo pattern AgentSocketMessage. */
   export type BrowserSocketMessage =
     | { type: 'pong' }
     | { type: 'signal'; data: SignalMessage; id: string }
     | { type: 'subscribed'; data: { sessionId: string; after: string | null; hasMore: boolean } }
     | { type: 'error'; code: BrowserErrorCode };

   export function parseBrowserMessage(raw: string): BrowserMessageInit | null { /* JSON.parse + validate type + data shape, mirror parseSignalMessage hiện có */ }
   ```
2. `types/index.ts`: thêm `BrowserSocketMessage`, `BrowserErrorCode`, `BrowserMessageInit` vào block `export type {...} from './signaling.js'`.
3. `packages/shared/src/index.ts` giữ nguyên (`export * from './types/index.js'` — star export re-export cả function lẫn type).

**Verification:** `pnpm --filter @ponter/shared typecheck`

**Commit:** `feat(shared): add BrowserSocketMessage + BrowserErrorCode types`

### P3 — FE: WebSocketSignalTransport + reconnect + fallback + flag + unit tests

**Goal:** `WebSocketSignalTransport` implement `SignalTransport`, reconnect với backoff + jitter, fallback REST khi thất bại, chọn transport theo flag.

**Files:**
- `packages/webrtc-core/src/transport.ts` — thêm `WebSocketSignalTransport`.
- `packages/webrtc-core/src/index.ts` — export (dòng 5 tự động).
- `apps/web/src/stores/terminal.ts` — chọn transport theo flag.
- `apps/web/env.d.ts` — thêm `VITE_BROWSER_WS_SIGNALING`.
- `apps/web/.env.example`, `.env.production.example` — thêm flag.
- `packages/webrtc-core/test/ws-transport.test.ts` (NEW) — unit tests.

**Steps:**
1. `transport.ts`: thêm class (giữ convention file — không import `import.meta.env`; mọi thứ inject qua options):
   ```typescript
   export interface WebSocketSignalTransportOptions {
     baseUrl: string;
     sessionId: string;
     /** Lấy access token hiện tại (để mint ticket). Trả null nếu không có. */
     getToken: () => Promise<string | null>;
     /** Called on 401 khi mint ticket — refresh access token, trả null nếu thất bại. */
     onUnauthorized?: () => Promise<string | null>;
     /** Bật reconnect (mặc định true). false → dùng cho test hoặc fallback-only. */
     reconnect?: boolean;
     /** Chuyển hẳn sang transport này sau khi WS thất bại N lần. */
     fallback?: SignalTransport;
     fetch?: typeof fetch;
     maxRetries?: number; // default 5
   }
   export class WebSocketSignalTransport implements SignalTransport {
     private ws: WebSocket | null = null;
     private pending: SignalMessage[] = [];   // CHỈ signal chưa từng gửi
     private retries = 0;
     private lastCursor: string | null = null; // UUID id signal cuối
     private subscribers: Array<(msg: SignalMessage) => void> = [];
     private activeTransport: SignalTransport | null = null; // set khi fallback
     // ...
   }
   ```
   - `wsUrl()`: `this.opts.baseUrl.replace(/^http/, 'ws')` + `/api/ws/browser?ticket=${encodeURIComponent(ticket)}` — http→ws, https→wss (một biểu thức, không cần option riêng).
   - `subscribe(handler)`: fetch ticket (`POST ${baseUrl}/api/ws/ticket` với `Authorization: Bearer ${await getToken()}`; 401 → `onUnauthorized()` → retry đúng 1 lần, theo pattern `withTokenRefresh` của `RESTPollingTransport`, `transport.ts:85-97`) → mở WS → on open gửi `subscribe{sessionId, after: lastCursor}` → on message: `signal` → `lastCursor = id`, fan-out handler; `subscribed` → flush `pending`; `error SESSION_TERMINATED` → close + reconnect (hoặc fallback nếu hết retries).
   - `send(msg)`: WS OPEN → `ws.send(JSON.stringify({type:'signal', data:msg}))` (fire-and-forget, không queue); ngược lại `pending.push(msg)`.
   - Queue: giữ nguyên qua close; **flush sau khi gửi lại `subscribe`** ở lần reconnect kế tiếp; KHÔNG clear (xem D6).
   - Reconnect: `delay = Math.min(200 * 2^retries, 2000) + (Math.random() * 100 - 50)` (jitter ±50ms), `retries++`; `retries > maxRetries` → chuyển sang `fallback` (nếu có) bằng cách `activeTransport = fallback; fallback.subscribe(handler); flush pending qua fallback` — từ đó mọi `send`/`subscribe` delegate sang fallback vĩnh viễn cho session này.
   - `close()`: `ws?.close(1000, 'normal')`, clear timers, `activeTransport?.close()`, không throw.
2. `terminal.ts:53`: chọn transport:
   ```typescript
   const useWs = import.meta.env.VITE_BROWSER_WS_SIGNALING === 'true';
   const restTransport = () =>
     new RESTPollingTransport({
       baseUrl: apiClient.http.baseUrl,
       sessionId: sessionResp.id,
       token: token ?? '',
       onUnauthorized: async () => apiClient.http.refreshAccessToken(),
     });
   const transport = useWs
     ? new WebSocketSignalTransport({
         baseUrl: apiClient.http.baseUrl,
         sessionId: sessionResp.id,
         getToken: () => tokenStorage.getAccessToken(),
         onUnauthorized: async () => apiClient.http.refreshAccessToken(),
         reconnect: true,
         fallback: restTransport(),
       })
     : restTransport();
   ```
3. `env.d.ts`: `readonly VITE_BROWSER_WS_SIGNALING?: string;` (thêm vào `ImportMetaEnv`, giữ `VITE_API_URL?` nguyên trạng).
4. `apps/web/.env.example` + `.env.production.example`: thêm `VITE_BROWSER_WS_SIGNALING=false`.

**Tests:**
- `packages/webrtc-core/test/ws-transport.test.ts` (mock `WebSocket` global + mock fetch; có thể dùng `vi.useFakeTimers` như `transport.test.ts`):
  - Backoff công thức: 200→400→800→1600→2000 (cap), jitter trong ±50ms.
  - Ticket flow: mint OK; 401 → onUnauthorized → retry 1 lần; refresh fail → fallback (không loop).
  - Queue: send khi chưa open → không mất; flush sau `subscribed`; signal đã gửi khi OPEN không bao giờ gửi lại (không duplicate).
  - `lastCursor` cập nhật từ `id` trong frame `signal`; subscribe lần sau gửi đúng `after`.
  - Fallback sau `maxRetries`: handler chuyển sang fallback transport, `send` delegate.
  - `close()` idempotent, không throw khi WS chưa mở.

**Verification:**
```bash
cd /mnt/Data/Ponta/remote-platform
pnpm --filter @ponter/webrtc-core run test
pnpm --filter @ponter/web typecheck
pnpm --filter @ponter/web build
```

**Commit:** `feat(webrtc-core): WebSocketSignalTransport with reconnect + fallback`

### P4 — E2E WS variant + docs + infra (proxy/docker)

**Goal:** E2E test chạy server thật + browser WS; cấu hình proxy/Docker để WS sống ổn định; cập nhật docs.

**Files:**
- `packages/webrtc-core/test/e2e/terminal-ws.e2e.test.ts` (NEW) — E2E variant dùng WS transport.
- `apps/server/src/index.ts` — request log filter `ticket=` → `[REDACTED]` (nếu có log; nếu chưa có request logging thì thêm dòng log tối thiểu ở `handleBrowserUpgrade` nhánh lỗi, không log full URL).
- `docker/Caddyfile` — thêm WS timeout/keepalive.
- `docker/docker-compose.prod.yml`, `docker-compose.tunnel.yml`, `docker-compose.local.yml` — thêm `stop_grace_period: 15s` cho service `server` (Docker mặc định 10s rồi SIGKILL — không đủ cho graceful shutdown D9).
- `docker/docker-compose.tunnel.yml` — cloudflared: mount `config.yml` với `originRequest.maxIdleDuration: 300s` (không set được qua env; `tunnel run --token` bỏ qua per-service env config).
- `docs/guides/deployment.md` — mục mới: browser WS path, flag, stop_grace_period, tunnel config.

**Steps:**
1. `terminal-ws.e2e.test.ts` — copy `terminal.e2e.test.ts` (`test/e2e/terminal.e2e.test.ts:349` khởi tạo `RESTPollingTransport`), thay bằng `WebSocketSignalTransport` (không cần flag — E2E chỉ định trực tiếp). Verify: signal qua WS, reconnect sau khi server restart, SESSION_TERMINATED nhận được.
2. `Caddyfile` — Caddy 2 tự xử lý Upgrade cho mọi path, nhưng cần explicit timeout. Sửa site block:
   ```
   {$DOMAIN:localhost} {
       @ws path /api/ws/*
       reverse_proxy @ws server:8787 {
           transport http {
               read_buffer 65536
               keepalive 300s
           }
       }
       reverse_proxy server:8787
   }
   ```
   (Lưu ý: `header_regexp ConnectionUpgrade Upgrade` trong bản nháp cũ SAI cú pháp — dùng `path /api/ws/*` matcher.)
3. Request log redaction: nếu `index.ts`/`app.ts` không có request logging, chỉ cần đảm bảo `handleBrowserUpgrade` log lỗi KHÔNG chứa `?ticket=` (log `req.url.split('?')[0]`). Nếu có logger, thêm filter `ticket=[^&]*` → `ticket=[REDACTED]`.
4. Docker compose: thêm `stop_grace_period: 15s` dưới service `server` ở cả 3 file compose.
5. CF Tunnel: tạo `docker/cloudflared/config.yml`:
   ```yaml
   originRequest:
     maxIdleDuration: 300s
   ```
   và trong compose đổi `command: tunnel run` → `command: tunnel --config /etc/cloudflared/config.yml run`, mount `./cloudflared:/etc/cloudflared:ro`. (TUNNEL_TOKEN vẫn dùng qua env.)
6. `docs/guides/deployment.md`: thêm mục về `/api/ws/browser`, `VITE_BROWSER_WS_SIGNALING`, `stop_grace_period`, tunnel `maxIdleDuration`.
7. Graceful shutdown verify thủ công: `docker stop` → log thấy close 1001 + process exit 0 (không bị SIGKILL).

**Verification:**
```bash
cd /mnt/Data/Ponta/remote-platform
pnpm --filter @ponter/webrtc-core run test:e2e
pnpm --filter @ponter/server typecheck
# compose files valid
docker compose -f docker/docker-compose.prod.yml config >/dev/null && echo OK
```

**Commit:** `test(e2e): add WebSocket signaling E2E variant + proxy/docker WS config`

### P5 — Rollout (server trước, flag OFF → global flip → đo lường → quyết định)

**Goal:** Rollout an toàn, zero-downtime, có thể rollback.

**Files:**
- `.github/workflows/deploy.yml` — thêm `VITE_BROWSER_WS_SIGNALING` env vào bước Build (dòng ~45-47).
- `apps/web/env.d.ts` + `.env.example` + `.env.production.example` — đã thêm ở P3.
- `docker/docker-compose.tunnel.yml` — verify single replica (đã có từ P4).

**Steps:**
1. Deploy server P1 (flag OFF) — REST hoạt động như cũ; browser WS endpoint tồn tại nhưng không có traffic.
2. **Global flip (đã chốt — không canary theo %):** `VITE_BROWSER_WS_SIGNALING` là build-time → một bundle chỉ có một giá trị cho toàn bộ user; muốn canary % phải thêm runtime config hoặc CF gradual deployments (2 versions + version affinity + `run_worker_first`) — không tương xứng nhu cầu. Thay vào đó: smoke test trước (E2E P4 + server P1 đã deploy không traffic) → set `VITE_BROWSER_WS_SIGNALING=true` trong bước Build của `.github/workflows/deploy.yml` → CI rebuild + `wrangler deploy` → theo dõi metrics (step 3).
3. Sau flip, giữ flag ON khi: reconnect rate < 1%, SESSION_TERMINATED không bị mất, WS fallback rate < 0.1%. Không đạt → rollback: set lại `false` + rebuild + redeploy.
4. Đo lường: latency signal delivery (target < 10ms WS vs 200-2000ms polling), error rate 4408/4401, reconnect count per session.
5. Quyết định: giữ flag ON nếu metrics tốt, hoặc giữ OFF + cải tiếp nếu có vấn đề.

**Verification:**
```bash
cd /mnt/Data/Ponta/remote-platform
pnpm lint
grep VITE_BROWSER_WS_SIGNALING .github/workflows/deploy.yml
```

**Commit:** `ci(deploy): add VITE_BROWSER_WS_SIGNALING to deploy workflow`

## 6. Red-team fixes đã tích hợp (và đã được plan-critic xác minh lại)

Bảng dưới ghi fix → nơi áp dụng trong plan. Cột "Nguồn" đánh dấu phát hiện từ red-team workflow hay từ vòng kiểm tra plan-critic/tự kiểm tra.

| Fix | Mức độ | Code change | Nơi xuất hiện | Nguồn |
|------|--------|-------------|---------------|-------|
| Token scope separation: `TokenPayload` thêm `scope`, `signWsTicket()`, `authMiddleware` reject `scope='ws-ticket'`, `verifyWsTicket()` | CRITICAL | `jwt.ts`, `utils/auth.ts`, `middleware/auth.ts` | D12 + P1 steps 1,4,5 | red-team + critic |
| **Ticket endpoint mount đúng path**: router riêng mount tại `/api/ws` → `POST /api/ws/ticket` (KHÔNG đặt trong `routes/auth.ts` vì mount tại `/api/auth` sẽ thành `/api/auth/ws/ticket`) | CRITICAL | `routes/ws.ts` (`wsTicketRouter`) + `app.ts` | D2 + P1 steps 8,9 | tự kiểm tra (critic bỏ sót) |
| **Không cần `rowid` cho live push**: dedup theo signal `id` + buffer trong lúc replay → `recordSignal().returning()` đủ dùng (SignalSelect không có rowid) | CRITICAL | `pushToBrowser` + subscription state machine | D5 + P1 steps 9,10,16 | critic |
| **Cursor semantics thống nhất**: wire = UUID `id`; `rowid` chỉ trong SQL nội bộ (map `id`→`rowid` y hệt REST poll) | CRITICAL | protocol spec + replay SQL | D3 + protocol spec | red-team + tự kiểm tra |
| Origin check cho browser WS upgrade (CSWSH) | HIGH | `handleBrowserUpgrade` (allowlist từ `getAllowedOrigins()`) | D7 + P1 step 9 | red-team |
| Ticket TTL 15s + one-time (jti registry in-memory) + log redaction | HIGH | `utils/ws-ticket.ts`, `handleBrowserUpgrade`, log filter | D2 + P1 steps 3,9 + P4 step 3 | red-team |
| Stale cursor (signal đã bị cleanup xoá) → replay time-bound 5 phút, không replay từ đầu | HIGH | replay SQL (`created_at > datetime('now','-5 minutes')`) | D13 + P1 step 10 | red-team + critic |
| Server-initiated liveness: protocol-level `ws.ping()` 30s + pong watchdog 90s (browser tự trả pong, không bị throttle) | HIGH | keepalive với interval inject được | D8 + P1 step 13 | red-team + critic |
| Atomic subscribe: state `replaying → live` + buffer + dedup theo `id` | HIGH | subscription state machine | D5 + P1 step 10 | red-team |
| Outbound queue chỉ chứa signal CHƯA gửi; flush sau re-subscribe (không clear, không re-send) | HIGH | transport queue logic | D6 + P3 step 1 | red-team + critic |
| Graceful SIGTERM handler (`cleanup.stop()`, close 1001, `server.close`, forced exit 10s) | HIGH | `index.ts` signal handler | D9 + P1 step 15 | red-team |
| Docker `stop_grace_period: 15s` (mặc định 10s → SIGKILL giữa graceful shutdown) | HIGH | 3 file compose | P4 step 4 | critic |
| Caddy WS timeout (`path /api/ws/*` matcher + `transport http { read_buffer 65536; keepalive 300s }`) | HIGH | `docker/Caddyfile` | P4 step 2 | red-team + critic |
| CF Tunnel `originRequest.maxIdleDuration: 300s` qua config.yml (không set được bằng env) | HIGH | `docker/cloudflared/config.yml` + compose | P4 step 5 | critic |
| `getToken()` callback thay vì static token (access token hết hạn giữa session) | MEDIUM | `WebSocketSignalTransportOptions` + `terminal.ts` | P3 steps 1,2 | critic |
| Replay LIMIT 200 + `hasMore` → client subscribe tiếp (pagination) | HIGH | replay SQL + `subscribed` frame | D4 + P1 step 10 | red-team |
| SESSION_TERMINATED: `.returning()` ở agent close + push ở DELETE session | MEDIUM | agent close handler + `routes/sessions.ts` | P1 steps 11,12 | red-team |
| Session ownership check khi subscribe (`session.userId === payload.sub`) | MEDIUM | browser message handler | P1 step 10 | red-team |
| Feature flag thread đủ: `env.d.ts` + `.env.example` + `.env.production.example` + `deploy.yml` | MEDIUM | 4 file | P3 step 3,4 + P5 | critic |
| Multi-tab độc lập: mỗi tab 1 WS riêng, server fan-out theo `Map<userId, Set<BrowserConnection>>` | MEDIUM | `browserConnections` | D1 + P1 step 9 | red-team |
| `agents.ts:26` shadow `agentConnections` Map (latent bug, ngoài phạm vi) | LOW | — | Open question | critic |

## 7. Rủi ro

- **Multi-replica break push:** `browserConnections` Map in-process. Nếu deploy nhiều replica, browser A WebSocket tới replica-1 nhưng signal đến replica-2 → không push được. Mitigation: single replica cho P1; REST fallback vẫn multi-replica-safe. Deploy docker-compose hiện tại là single replica.
- **Reconnect storm:** Server restart → hàng trăm browser đồng thời reconnect. Mitigation: jitter ±50ms + cap backoff 2000ms + max 5 retries + graceful shutdown 1001 (client backoff ngay từ đầu, không đập cửa).
- **Ticket leak qua query string:** `?ticket=` xuất hiện trong access log proxy. Mitigation: TTL 15s + one-time + log filter redact. (Subprotocol negotiation là alternative nếu cần siết hơn — open question.)
- **CSWSH:** Page malicious mở WS tới `/api/ws/browser?ticket=<stolen>`. Mitigation: Origin allowlist + ticket one-time 15s.
- **Replay/live race:** Nếu order sai → signal out-of-order → WebRTC handshake fail. Mitigation: subscription state machine `replaying → live`, buffer + dedup theo id (D5).
- **Stale cursor sau cleanup:** signal cursor bị xoá (TTL 5 phút) → replay time-bound, không replay từ đầu (D13).
- **Background tab:** JS bị throttle → không dùng app-level ping làm liveness; dùng protocol-level `ws.ping()`/pong do browser tự trả (D8).
- **Memory leak:** `browserConnections` không được xoá khi browser đóng WS. Mitigation: close handler cleanup + keepalive watchdog 4408.
- **Queue unbounded growth:** signal sinh ra trong lúc mất kết nối lâu → queue phình. Mitigation: backoff có trần + max 5 retries → fallback REST (queue flush qua REST, không tích luỹ vô hạn).
- **Ticket registry rò rỉ (in-memory):** entry hết hạn chỉ bị xoá khi có register/consume mới (lazy). Mitigation: lazy cleanup mỗi lần register; chấp nhận được ở scale hiện tại (vài ticket/giây tối đa).

## 8. Rollback

1. **Tắt flag:** Set `VITE_BROWSER_WS_SIGNALING=false` (hoặc xoá) trong `deploy.yml` → CI rebuild + `wrangler deploy` → browser dùng `RESTPollingTransport` (existing code path, không đổi). Vì flag là build-time, rollback là all-or-nothing (một lần deploy cho toàn bộ user).
2. **Server side:** Browser WS endpoint (`/api/ws/browser`) vẫn tồn tại nhưng không có traffic. Không ảnh hưởng agent WS / REST.
3. **DB:** Không migration schema — chỉ thêm endpoint + helper. Rollback = revert commit P1 (không cần sửa data).
4. **Thứ tự deploy:** Server P1 (flag OFF) trước → client flag sau. Rollback client trước (tắt flag), server sau (an toàn vì endpoint vô hại khi không ai gọi).
5. **Quick revert:** Nếu lỗi nghiêm trọng sau flip → tắt flag (hiệu lực sau lần build + deploy kế tiếp, vài phút) + revert commit P1 nếu lỗi phía server.

## 9. Câu hỏi mở

- **Nhiều replica trong tương lai:** cần Redis Pub/Sub hay sticky session cho `browserConnections`? (Hiện single-instance, đã document.)
- **Canary theo % user — đã chốt:** không làm canary (Vite env build-time → % canary cần runtime config hoặc CF gradual deployments; không tương xứng). Dùng global flip qua rebuild — xem P5 step 2.
- **Ticket qua subprotocol:** `Sec-WebSocket-Protocol` tránh được access log hoàn toàn — có đáng đổi không nếu siết bảo mật hơn?
- **CSP `_headers` trên Cloudflare Workers Static Assets:** thêm `connect-src wss://...` khi bật flag? (Hiện chưa có CSP nào.)
- **`agents.ts:26` shadow `agentConnections` Map:** latent bug (agents list luôn báo offline) — sửa ngoài phạm vi plan này, nên tạo issue riêng.
- **Protocol-level ping và agent WS:** agent hiện dùng app-level `{type:'ping'}` — có nên chuyển agent sang `ws.ping()` luôn cho đồng nhất? (Ngoài phạm vi.)

## 10. Phụ lục: checklist merge / checklist bật flag prod

### Checklist merge (P1-P5)
- [ ] `pnpm --filter @ponter/server typecheck` xanh
- [ ] `pnpm --filter @ponter/server test` xanh (bao gồm `ws-browser.test.ts` mới)
- [ ] `pnpm --filter @ponter/webrtc-core run test` xanh (bao gồm `ws-transport.test.ts` mới)
- [ ] `pnpm --filter @ponter/webrtc-core run test:e2e` xanh (P4)
- [ ] `pnpm --filter @ponter/web build` xanh
- [ ] `pnpm lint` xanh (toàn repo)
- [ ] Review signoff: scope separation 2 chiều (authMiddleware guard + verifyWsTicket), Origin allowlist, one-time ticket
- [ ] Integration test: agent→browser signal latency < 10ms
- [ ] No regression REST polling (existing `signaling.test.ts` still pass)
- [ ] `docker compose config` valid cho cả 3 compose files
- [ ] Manual: `docker stop` server → graceful (close 1001, exit 0, không SIGKILL)

### Checklist bật flag prod (global flip)
- [ ] Deploy server P1 (flag OFF) — verify no crash, REST không đổi
- [ ] Smoke test WS path (E2E P4 + tay: ticket → subscribe → signal) trước khi flip
- [ ] Set `VITE_BROWSER_WS_SIGNALING=true` trong `deploy.yml` → merge → CI rebuild + deploy
- [ ] Verify sau flip: reconnect rate < 1%; SESSION_TERMINATED delivery (đóng agent → tab hiện lỗi ngay); error rate 4408/4401 ≈ 0
- [ ] Fallback REST rate < 0.1%
- [ ] Rollback path sẵn sàng: set lại `false` + rebuild (all-or-nothing)
- [ ] Khi ổn định: remove flag logic (optional)

<!-- END OF PLAN -->