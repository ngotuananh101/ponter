/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  readonly VITE_BROWSER_WS_SIGNALING?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
