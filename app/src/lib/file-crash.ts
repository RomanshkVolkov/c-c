import { api } from "@/lib/api";
import { useAuthStore } from "@/store/auth.store";

/**
 * Levantar una tarjeta en cac cuando algo se rompe.
 *
 * Vivía dentro de `ErrorBoundary`, que sólo caza *throws* de render. Pero un
 * fallo no siempre tira la pantalla: `openTask` se tragaba el error de red y
 * pintaba «Could not load this task», un callejón sin motivo, sin código y sin
 * rastro. Un reporte de cliente estuvo una semana sin aterrizar en ningún
 * tablero y nadie se enteró hasta que una notificación apuntó a él.
 *
 * Así que el fichado sale aquí y lo usan los dos: el que caza un throw y el que
 * simplemente no pudo cargar algo.
 */

/**
 * Command and control → App → tasks. Comprobado antes de fijarlo: la lista no
 * tiene canal, así que nada de lo que se levante aquí llega a un cliente — lo
 * que importa, porque una traza es justo lo que no puede salir.
 */
const CRASH_LIST = "ca0bfd49-0909-43eb-8135-bc8ecd0f282c";

/**
 * Un nombre estable para un mismo fallo.
 *
 * El servidor lo toma como clave de idempotencia: el mismo fallo es una tarjeta,
 * pase las veces que pase. Se construye del **motivo**, nunca del id de lo que
 * falló — si mañana fallan cuarenta reportes por lo mismo, eso es un problema,
 * no cuarenta.
 */
export function signature(texto: string): string {
  let h = 5381;
  for (let i = 0; i < texto.length; i++) h = ((h << 5) + h + texto.charCodeAt(i)) | 0;
  return `crash-${(h >>> 0).toString(16)}`;
}

export type Fichado = "no" | "filing" | "done" | "failed";

export async function fileCrash(opts: {
  title: string;
  description: string;
  /** Lo que hace que veinte clics sean una tarjeta. Ver `signature`. */
  key: string;
}): Promise<Fichado> {
  // Sin sesión no hay con qué fichar, y en dev esto ensuciaría el tablero de
  // verdad con fallos que alguien está provocando a propósito.
  if (!useAuthStore.getState().accessToken || import.meta.env.DEV) return "no";
  try {
    await api.post(
      `/api/v1/task-lists/${CRASH_LIST}/tasks`,
      {
        title: opts.title.slice(0, 200),
        description: opts.description,
        priority: "high",
        // Cinturón y tirantes. La lista no tiene canal, así que todo lo de
        // dentro es interno igualmente; decirlo impide que vincularla algún día
        // convierta las trazas en algo que lee un cliente.
        visibility: "internal",
        idempotencyKey: opts.key,
      },
      true,
    );
    return "done";
  } catch {
    // Reportar un fallo no puede causar otro. La pantalla ya le dice a la
    // persona qué pasó; la tarjeta es un extra, no el mecanismo.
    return "failed";
  }
}

/** La ruta en la que estaba, que es la mitad de reproducir cualquier cosa. */
export function rutaActual(): string {
  return window.location.hash || window.location.pathname;
}
