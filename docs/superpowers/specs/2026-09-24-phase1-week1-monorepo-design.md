# Phase 1, Week 1 — Monorepo Scaffold

**Date:** 2026-09-24
**Status:** Pending Approval
**Source:** `docs/ARCHITECTURE.md`, Section 8, "Week 1: Monorepo Setup"

## Objective

Scaffold monorepo structure so subsequent weeks can integrate code without writing feature logic.
Success criteria:

- `pnpm install` completes and generates lockfile.
- `pnpm lint`, `pnpm typecheck`, and `pnpm format:check` all pass locally and in GitHub Actions.
- `@ponter/shared` exports shared contract types.

## Out of Scope

Cloudflare Workers, D1, Vue app, Tailwind, Rust agent, Vitest, deploy scripts,
tests. These items belong to Week 2 and beyond.

## Key Decisions

- Scaffold the entire directory tree from the architecture doc, including packages without code.
- Use the latest compatible versions, rather than sticking to legacy 2024 versions in documentation.

## Toolchain

| Tool | Version | Reason |
|---|---|---|
| Node | 24 (dev machine runs 24.21.0) | Current LTS, fully supported |
| pnpm | 12.6.0 | Latest |
| Turborepo | 2.11.3 | Latest |
| TypeScript | 6.0.3 | Latest supported by typescript-eslint (`<6.1.0`); 7.0.2 excluded |
| ESLint | 10.11.0 | Latest, flat config |
| typescript-eslint | 8.70.1 | Latest |
| Prettier | 3.9.9 | Latest |
| @types/node | 24.13.6 | Exact Node 24 types, not 26 |

`engines` in root: `node >= 24`, `pnpm >= 12`. `packageManager`: `pnpm@12.6.0`.
Root `package.json` has `"type": "module"` so `eslint.config.js` loads without warnings.

## Structure

`pnpm-workspace.yaml` points to `apps/*`, `packages/*`, `workers/*`.

Each workspace contains `package.json` with `name` format `@ponter/<name>`, `private: true`,
`version: 0.1.0`. Packages without code only declare `lint` and `typecheck` scripts
using `echo` (no-op, exit 0) and have no dependencies. Formatting is not a per-package task:
Prettier runs once at root.

List of placeholders matching architecture docs:

- apps: `web`, `desktop`, `mobile`, `agent`
- packages: `api-client`, `webrtc-core`, `terminal-core`, `ui-components`, `crypto`
- workers: `signaling`, `api`

`apps/agent` is Rust but retains a placeholder `package.json` for workspace
uniformity; `Cargo.toml` is deferred to Week 5.

Non-package directories (`scripts/`, `tests/e2e`, `tests/unit`,
`tests/integration`, `docs/guides`, `docs/architecture`, `.github/workflows`)
are created with `.gitkeep`. No scripts or tests written.

## `packages/shared`

Only package containing code. `tsconfig.json` inherits from `tsconfig.base.json`.

Files:

- `src/types/user.ts` — `User`, `Device`, `Agent`
- `src/types/session.ts` — `Session`, `SessionStatus`
- `src/types/webrtc.ts` — `IceServer`, data/media channel descriptors
- `src/types/terminal.ts` — `TerminalSession`, `TerminalSize`
- `src/types/files.ts` — `RemoteFile`, `FileTransfer`, `TransferDirection`
- `src/types/auth.ts` — `LoginRequest`, `LoginResponse`, `RegisterRequest`
- `src/types/signaling.ts` — `SignalOffer`, `SignalAnswer`, `IceCandidate`
- `src/types/index.ts` — re-export
- `src/index.ts` — re-export `types`

`auth.ts` and `signaling.ts` are not in Week 1 checklist but appear in
Section 6 of architecture docs. Included here because they are pure contracts without runtime dependencies.

Only interfaces and union types. No functions, no tests. `typecheck` runs
`tsc --noEmit`.

## TypeScript

`tsconfig.base.json`: `strict`, `target` ES2024, `module` "esnext", `moduleResolution`
"bundler", `verbatimModuleSyntax`, `noUncheckedIndexedAccess`, `skipLibCheck`.
`noEmit` in base; packages that build later will enable emit individually.
Chose `bundler` instead of `nodenext` because all downstream packages bundle (Vite/esbuild)
and it permits imports without file extensions.

## Linting and Formatting

- `eslint.config.js` flat config at root, using `typescript-eslint`, targeting
  `packages/**/*.ts`, `apps/**/*.ts`, `workers/**/*.ts`. Enables recommended rules,
  omits stylistic rules (handled by Prettier).
- `.prettierrc.json`: default, `singleQuote: true`.
- `.prettierignore`: `pnpm-lock.yaml`, `dist`, `target`, `.turbo`, `node_modules`, `docs`.
  Ignores `docs/` by user decision to avoid modifying existing file
  `docs/ARCHITECTURE.md` and avoid forcing code formatting onto specs/plans.
- Root scripts: `lint` = `turbo run lint`, `typecheck` = `turbo run typecheck`,
  `format:check` = `prettier --check .`.

## Turborepo

`turbo.json` with tasks `lint` and `typecheck`. No `build` or `dev` because
no packages build yet, and no `format:check` because Prettier runs
once at root rather than per-package. `typecheck` depends on
`^typecheck` so leaf packages are checked first.

## CI

`.github/workflows/ci.yml`: runs on push and pull request to `main`.

Single job, `ubuntu-latest`, Node 24, pnpm 12.6.0:

1. `pnpm install --frozen-lockfile`
2. `pnpm lint`
3. `pnpm typecheck`
4. `pnpm format:check`

No build or deploy jobs.

## `.gitignore`

`node_modules`, `dist`, `.turbo`, `target`, `.env`, log files, OS files,
along with `.remember/` and `.claude/settings.local.json` (session local data,
user opted to ignore). Keeps `pnpm-lock.yaml`.

## Verification

Run locally in order: `pnpm install`, `pnpm typecheck`, `pnpm lint`,
`pnpm format:check`. All four must exit 0. No tests to run.
