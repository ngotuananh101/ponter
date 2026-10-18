# @ponter/ui-components

The shared design layer for every Ponter UI (web today; the Electron desktop
renderer next). ADR-88.

## What lives here

- `src/styles/tokens.css` — the single source of truth for design tokens: the
  semantic `@theme` mapping, the light/dark custom-property palettes, the base
  layer, and the additive brand palette. Extracted from the web app.
- `src/components/ui/**` — generated shadcn-vue primitives. Do not hand-edit
  (the directory is `.prettierignore`d and kept byte-identical to the registry).
- `src/components/app/**` — environment-independent presentational components
  (props/emits only; no store/router/API-client **import**). They may use a
  globally-registered `<router-link>`, which the host app must provide or stub.
  Includes `LoginForm` (supporting an accessible "Remember me" checkbox, emitting
  `{ username, password, rememberMe }`), `RegisterForm`, and `ThemeToggle`.
- `src/composables/useTheme.ts` — the storage-agnostic theme composable.

## How an app consumes it

1. Depend on the package (`"@ponter/ui-components": "workspace:*"`).
2. Alias `@/lib/utils` to `packages/ui-components/src/lib/utils` and
   `@/components/ui/*` to `packages/ui-components/src/components/ui/*` (the
   primitives import `cn` and each other through those aliases). Do this in the
   app's `vite.config.ts`, `vitest.config.ts`, and `tsconfig.json` `paths`.
3. Import the tokens from the Tailwind entry, after the framework imports:

   ```css
   @import 'tailwindcss';
   @import 'tw-animate-css';
   @import 'shadcn-vue/tailwind.css';
   @import '@ponter/ui-components/styles/tokens.css';
   @source "../../../packages/ui-components/src";
   ```

4. Configure the theme storage once at startup (importing the module that calls
   it is enough):

   ```ts
   import { configureThemeStorage } from '@ponter/ui-components';
   configureThemeStorage(myStorageAdapter); // web: localStorage; desktop: IPC
   ```

## Adding a component to `app/`

Only lift a component that communicates purely through props and emits. If it
imports a store, `vue-router`, or an API client, it stays in its app. Using a
globally-registered `<router-link>` (no import) is fine — the host app supplies
it, and the component's tests stub it.
