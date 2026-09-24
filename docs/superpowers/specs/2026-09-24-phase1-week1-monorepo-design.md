# Phase 1, Tuần 1 — Monorepo Scaffold

**Ngày:** 2026-09-24
**Trạng thái:** chờ duyệt
**Nguồn:** `docs/ARCHITECTURE.md`, mục 8, "Tuần 1: Monorepo Setup"

## Mục tiêu

Dựng khung monorepo để các tuần sau cắm code vào, không viết tính năng.
Thành công khi:

- `pnpm install` chạy xong và tạo lockfile.
- `pnpm lint`, `pnpm typecheck`, `pnpm format:check` đều xanh ở local và trên GitHub Actions.
- `@remote/shared` export được các type contract dùng chung.

## Ngoài phạm vi

Cloudflare Workers, D1, Vue app, Tailwind, agent Rust, Vitest, script
deploy, test. Những phần này thuộc tuần 2 trở đi.

## Quyết định đã chốt

- Scaffold toàn bộ cây thư mục trong tài liệu, kể cả package chưa có code.
- Dùng bản mới nhất còn tương thích với nhau, không bám version 2024 trong tài liệu.

## Toolchain

| Công cụ | Bản | Lý do chọn |
|---|---|---|
| Node | 24 (máy dev đang chạy 24.21.0) | Current, còn trong vòng hỗ trợ |
| pnpm | 12.6.0 | Mới nhất |
| Turborepo | 2.11.3 | Mới nhất |
| TypeScript | 6.0.3 | Mới nhất mà typescript-eslint nhận (`<6.1.0`). 7.0.2 bị loại |
| ESLint | 10.11.0 | Mới nhất, flat config |
| typescript-eslint | 8.70.1 | Mới nhất |
| Prettier | 3.9.9 | Mới nhất |
| @types/node | 24.13.6 | Types của đúng Node 24, không lấy bản 26 |

`engines` ở root: `node >= 24`, `pnpm >= 12`. `packageManager`: `pnpm@12.6.0`.
Root `package.json` có `"type": "module"` để nạp `eslint.config.js` không bị cảnh báo.

## Cấu trúc

`pnpm-workspace.yaml` trỏ `apps/*`, `packages/*`, `workers/*`.

Mỗi workspace có `package.json` với `name` theo `@remote/<tên>`, `private: true`,
`version: 0.1.0`. Package chưa có code chỉ khai báo script `lint` và `typecheck`
bằng `echo` (no-op, exit 0) và không có dependency. Format không phải task của
từng package: Prettier chạy một lần ở root.

Danh sách placeholder, đúng tên trong tài liệu:

- apps: `web`, `desktop`, `mobile`, `agent`
- packages: `api-client`, `webrtc-core`, `terminal-core`, `ui-components`, `crypto`
- workers: `signaling`, `api`

`apps/agent` là Rust nhưng vẫn có `package.json` placeholder để workspace
đồng nhất; `Cargo.toml` để tuần 5.

Thư mục không phải package (`scripts/`, `tests/e2e`, `tests/unit`,
`tests/integration`, `docs/guides`, `docs/architecture`, `.github/workflows`)
được tạo kèm `.gitkeep`. Không viết nội dung script hay test.

## `packages/shared`

Package duy nhất có code. `tsconfig.json` kế thừa `tsconfig.base.json`.

Files:

- `src/types/user.ts` — `User`, `Device`, `Agent`
- `src/types/session.ts` — `Session`, `SessionStatus`
- `src/types/webrtc.ts` — `IceServer`, mô tả data/media channel
- `src/types/terminal.ts` — `TerminalSession`, `TerminalSize`
- `src/types/files.ts` — `RemoteFile`, `FileTransfer`, `TransferDirection`
- `src/types/auth.ts` — `LoginRequest`, `LoginResponse`, `RegisterRequest`
- `src/types/signaling.ts` — `SignalOffer`, `SignalAnswer`, `IceCandidate`
- `src/types/index.ts` — re-export
- `src/index.ts` — re-export `types`

`auth.ts` và `signaling.ts` không có trong checklist tuần 1 nhưng có trong
mục 6 của tài liệu. Gộp vào đây vì là contract thuần, không kéo theo runtime.

Chỉ interface và union type. Không có hàm, không có test. `typecheck` chạy
`tsc --noEmit`.

## TypeScript

`tsconfig.base.json`: `strict`, `target` ES2024, `module` "esnext", `moduleResolution`
"bundler", `verbatimModuleSyntax`, `noUncheckedIndexedAccess`, `skipLibCheck`.
Không emit (`noEmit`) ở base; package nào build sau này tự bật.
Chọn `bundler` thay vì `nodenext` vì các package sau này đều bundle (Vite/esbuild)
và cho phép import không bắt buộc đuôi file.

## Lint và format

- `eslint.config.js` flat config ở root, dùng `typescript-eslint`, áp cho
  `packages/**/*.ts`, `apps/**/*.ts`, `workers/**/*.ts`. Bật các rule
  recommended, không thêm rule phong cách (Prettier lo phần đó).
- `.prettierrc.json`: mặc định, `singleQuote: true`.
- `.prettierignore`: `pnpm-lock.yaml`, `dist`, `target`, `.turbo`, `node_modules`, `docs`.
  Bỏ qua toàn bộ `docs/` theo quyết định của người dùng để không sửa file
  `docs/ARCHITECTURE.md` có sẵn và không ép spec/plan theo format code.
- Root scripts: `lint` = `turbo run lint`, `typecheck` = `turbo run typecheck`,
  `format:check` = `prettier --check .`.

## Turborepo

`turbo.json` với task `lint` và `typecheck`. Không có `build` hay `dev` vì
chưa có package nào làm việc đó, và không có `format:check` vì Prettier chạy
một lần ở root chứ không theo từng package. `typecheck` phụ thuộc
`^typecheck` để sau này package lá được kiểm tra trước.

## CI

`.github/workflows/ci.yml`: chạy khi push và pull request vào `main`.

Một job, `ubuntu-latest`, Node 24, pnpm 12.6.0:

1. `pnpm install --frozen-lockfile`
2. `pnpm lint`
3. `pnpm typecheck`
4. `pnpm format:check`

Không có job build hay deploy.

## `.gitignore`

`node_modules`, `dist`, `.turbo`, `target`, `.env`, file log, file OS,
cùng `.remember/` và `.claude/settings.local.json` (dữ liệu local của phiên
làm việc, người dùng chọn bỏ qua). Giữ `pnpm-lock.yaml`.

## Kiểm chứng

Chạy tại chỗ, theo thứ tự: `pnpm install`, `pnpm typecheck`, `pnpm lint`,
`pnpm format:check`. Cả bốn phải exit 0. Không có test để chạy.
