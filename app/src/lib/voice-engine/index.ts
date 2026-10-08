import { isWebBuild } from "@/lib/platform";

import { browserEngine } from "./browser";
import { tauriEngine } from "./tauri";
import type { VoiceEngine } from "./types";

export type * from "./types";

/**
 * El motor de esta build. Lo decide **el build**, no el entorno: un `vite dev`
 * en Chrome sigue siendo la app de escritorio sin Tauri, y las pruebas también.
 * `livekit-client` sólo se carga cuando el motor del navegador entra a una
 * sala (import dinámico), así que el escritorio no lo arrastra.
 */
export const engine: VoiceEngine = isWebBuild ? browserEngine : tauriEngine;
