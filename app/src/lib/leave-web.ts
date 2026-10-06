import { revokeSession } from "@/lib/api";
import { disablePush } from "@/lib/push";

/**
 * Salir en la web. Un navegador puede ser compartido, así que no queda nada de
 * la persona: ni el dispositivo suscrito a su campana, ni lo que los stores
 * guardaron para abrir rápido (notas, avisos, mi trabajo…), ni la sesión.
 *
 * El orden importa. La baja del push y la del refresh van **antes** de borrar
 * nada, porque la primera necesita el token; y al final se recarga, porque la
 * memoria de los stores volvería a escribir lo borrado en cuanto cambiaran.
 * Cada paso de red tiene un tope: salir no puede quedarse colgado.
 */
export async function leaveWeb(refreshToken: string | null, reload: () => void = reloadApp): Promise<void> {
  await bounded(disablePush());
  await bounded(revokeSession(refreshToken));
  forgetThisBrowser(localStorage);
  reload();
}

/** Lo que se queda al salir: cómo se ve y en qué idioma, que no son de nadie. */
const KEEP = new Set(["cac-theme", "cac-locale"]);

/** Borra del almacenamiento todo lo de cac menos el tema y el idioma. */
export function forgetThisBrowser(storage: Storage): void {
  const keys: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const k = storage.key(i);
    if (k && (k.startsWith("cac-") || k === "access_token") && !KEEP.has(k)) keys.push(k);
  }
  for (const k of keys) storage.removeItem(k);
}

function bounded(p: Promise<unknown>, ms = 3000): Promise<unknown> {
  return Promise.race([p.catch(() => {}), new Promise((r) => setTimeout(r, ms))]);
}

function reloadApp() {
  window.location.replace(import.meta.env.BASE_URL);
}
