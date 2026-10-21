import { invoke } from "@tauri-apps/api/core";
import i18next from "i18next";
import { toast } from "sonner";

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
 * En escritorio va por `open_url` (`src-tauri/src/host.rs`) y no por el plugin
 * de Tauri: el plugin lanza `xdg-open` con el entorno de la AppImage, y tras
 * actualizar el sistema ese `bash` ya no arranca con las bibliotecas de la
 * imagen. Ningún enlace abría y nada lo decía (21-oct-2026). Por eso, además,
 * si no se puede abrir se avisa aquí: cinco de los botones que llaman a esto
 * descartan el error, y un clic que no hace nada no se distingue de un botón
 * roto. La promesa se rechaza igual, por si quien llama quiere hacer algo más.
 *
 * `noopener` en web para que la página abierta no pueda tocar la nuestra.
 */
export async function openExternal(url: string): Promise<void> {
  if (!isTauri) {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  try {
    await invoke("open_url", { url });
  } catch (e) {
    toast.error(i18next.t("common:last.openLinkFailed"), { description: String(e) });
    throw e;
  }
}
