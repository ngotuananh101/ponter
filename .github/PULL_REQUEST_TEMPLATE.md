## Summary

What this change does and why.

## Component(s)

- [ ] `apps/server`
- [ ] `apps/web`
- [ ] `apps/agent`
- [ ] `apps/desktop`
- [ ] `packages/*`
- [ ] `docs` / CI

## Testing

How you verified it. Include the commands you ran.

## Test-integrity checklist

- [ ] No test was deleted, skipped, or weakened.
- [ ] Any change to an existing test keeps its behavioral assertion and is
      explained above.
- [ ] If test files changed, `it()` / `expect()` counts are given before → after.

## Checklist

- [ ] `pnpm format:check` passes
- [ ] lint, typecheck, and tests pass for the affected workspace(s)
- [ ] Docs updated if behavior or setup changed
- [ ] No generated `ui/**` file was hand-edited
