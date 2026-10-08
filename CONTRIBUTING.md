# Contributing to Ponter

Thanks for your interest. Ponter is MIT-licensed; contributions are welcome.

## Development setup

See [`docs/guides/development.md`](docs/guides/development.md) for the full
setup (Node.js ≥ 24, pnpm ≥ 12, Rust stable).

## Before you open a pull request

Run the same gates CI runs:

```bash
pnpm install --frozen-lockfile
pnpm exec turbo run lint --filter='!@ponter/agent'
pnpm exec turbo run typecheck --filter='!@ponter/agent'
pnpm format:check
pnpm exec turbo run test --filter='!@ponter/agent'
```

For the Rust agent:

```bash
cargo fmt --manifest-path apps/agent/Cargo.toml --check
cargo clippy --manifest-path apps/agent/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path apps/agent/Cargo.toml
```

## Guidelines

- Keep changes focused; one concern per pull request.
- **Never delete, skip, or weaken a test to make a suite pass.** If a test must
  change, keep its behavioral assertion and say in the PR why.
- Match the existing code style; `pnpm format` and `cargo fmt` fix most of it.
- Use English for code, comments, commit messages, and repo docs.
- Do not hand-edit generated shadcn-vue components under
  `packages/ui-components/src/components/ui/**`; wrap them instead.

## Commit messages

Conventional Commits (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `ci:`,
`chore:`), imperative mood, scoped where useful (e.g. `fix(server): ...`).

## Reporting security issues

Do **not** open a public issue. See [`SECURITY.md`](SECURITY.md).
