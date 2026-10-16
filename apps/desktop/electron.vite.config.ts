import { resolve } from 'path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import vue from '@vitejs/plugin-vue';
import tailwindcss from '@tailwindcss/vite';

// The `@ponter/*` workspace packages are consumed as raw TypeScript: their
// `package.json` `main`/`exports` point straight at `./src/index.ts` (no build
// step, no `dist`). `externalizeDepsPlugin` externalizes every runtime
// `dependency` by default — including these — which makes the main/preload
// bundles emit `import { ... } from "@ponter/api-client"` at runtime. Electron's
// Node loader then throws `ERR_UNKNOWN_FILE_EXTENSION: Unknown file extension
// ".ts"` and the app dies before the first window. The renderer already bundles
// them (Vite transpiles TS natively); the main/preload bundles must do the same,
// so the workspace packages are excluded from externalization and inlined.
const WORKSPACE_PACKAGES = [
  '@ponter/api-client',
  '@ponter/shared',
  '@ponter/webrtc-core',
  '@ponter/ui-components',
];

// `electron-updater` is CommonJS-only and exposes `autoUpdater` through a
// getter (`Object.defineProperty(exports, "autoUpdater", ...)`), which Node's
// ESM named-export detection cannot see. Because the main bundle is ESM (the
// package is `"type": "module"`), leaving it external emits
// `import { autoUpdater } from "electron-updater"` and the app dies at startup
// with `SyntaxError: Named export 'autoUpdater' not found`. Bundling it lets
// rolldown resolve the CommonJS named export at build time. It is the only
// third-party dependency the main process imports directly.
const BUNDLED_CJS_DEPS = ['electron-updater'];

// Every dependency the main/preload bundles must inline rather than externalize.
const BUNDLED_DEPS = [...WORKSPACE_PACKAGES, ...BUNDLED_CJS_DEPS];

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: BUNDLED_DEPS })],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: BUNDLED_DEPS })],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
        },
        output: {
          format: 'cjs',
          entryFileNames: '[name].js',
        },
      },
    },
  },
  renderer: {
    root: '.',
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'index.html'),
        },
      },
    },
    resolve: {
      alias: {
        '@/lib/utils': resolve(
          __dirname,
          '../../packages/ui-components/src/lib/utils',
        ),
        '@/components/ui': resolve(
          __dirname,
          '../../packages/ui-components/src/components/ui',
        ),
        '@': resolve(__dirname, 'src/renderer'),
      },
    },
    plugins: [vue(), tailwindcss()],
  },
});
