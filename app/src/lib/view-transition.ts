import { flushSync } from "react-dom";

/**
 * Hace un cambio de pantalla con una View Transition si el WebKit la tiene:
 * el navegador fotografía lo de antes y lo de después y los anima entre sí
 * (ver `::view-transition-*` en index.css). Sirve para lo que desaparece de
 * golpe al desmontarse, como el detalle de una tarea al cerrarlo, sin tener
 * que mantenerlo montado a mano mientras sale.
 *
 * Sin soporte (un WebKitGTK viejo en la AppImage) o con movimiento reducido,
 * el cambio se hace tal cual, en el acto.
 */
export function withViewTransition(change: () => void) {
  const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown };
  const reduced = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!doc.startViewTransition || reduced) {
    change();
    return;
  }
  // `flushSync`: la foto de «después» se hace al volver de la función, así que
  // React tiene que haber pintado el cambio para entonces.
  doc.startViewTransition(() => flushSync(change));
}
