/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** `web` en el build de la versión web (`vite build --mode web`); vacío en la app de escritorio. */
  readonly VITE_TARGET?: string;
  /** La API. Vacío en web: mismo origen (cac.guz-studio.dev/app habla con cac.guz-studio.dev). */
  readonly VITE_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
