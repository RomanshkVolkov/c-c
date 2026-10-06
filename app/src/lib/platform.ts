import { openUrl as tauriOpenUrl } from "@tauri-apps/plugin-opener";

/**
 * Dónde corre esta interfaz: dentro de la app de escritorio (Tauri) o en un
 * navegador (la versión web de `/app`).
 *
 * La pregunta estaba copiada en seis ficheros con la misma línea. Una sola
 * respuesta aquí: el día que cambie cómo se detecta Tauri, cambia en un sitio,
 * y las pantallas preguntan «¿esto va en web?» y no «¿existe tal global?».
 *
 * Se evalúa una vez al cargar: no cambia en la vida de la página.
 */
export const isTauri: boolean = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** En un navegador corriente: la versión web, o el `vite dev` sin Tauri. */
export const isWeb: boolean = !isTauri;

/**
 * Este bundle **es** la versión web (`vite build --mode web`).
 *
 * Distinto de `isWeb`, y a propósito: `isWeb` lo decide el entorno al cargar
 * —un `vite dev` en Chrome también es web—, y esto lo decide el build. Es una
 * constante que Vite sustituye al compilar, así que las ramas de escritorio
 * que dependen de ella se quedan fuera del bundle web en vez de esconderse en
 * tiempo de ejecución.
 */
export const isWebBuild: boolean = import.meta.env.VITE_TARGET === "web";

/**
 * Abrir un enlace fuera de la app: el navegador del sistema en escritorio, una
 * pestaña nueva en web.
 *
 * El plugin de Tauri sin Tauri rechaza la promesa y el clic no hace nada, que
 * es el fallo que tenían cinco botones al probar la interfaz en un navegador.
 * `noopener` para que la página abierta no pueda tocar la nuestra.
 */
export async function openExternal(url: string): Promise<void> {
  if (isTauri) {
    await tauriOpenUrl(url);
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}
