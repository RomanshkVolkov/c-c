import { useEffect, useState } from "react";

/**
 * Lo que tarda en irse algo que se cierra. Las salidas de index.css
 * (`[data-closing]`) duran esto o menos: si duraran más, se cortarían.
 */
export const EXIT_MS = 160;

const reducedMotion = () =>
  typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Mantiene montado algo que se cierra el rato que tarda en irse.
 *
 * React lo quita del DOM en cuanto deja de pintarse, así que lo que entraba
 * con muelle (`motion-pop-in`, `motion-rise-in`…) desaparecía de golpe. Con
 * esto, al cerrarse sigue montado `EXIT_MS` con `closing` a true: quien lo
 * pinta pone `data-closing` y su clase hace la salida (ver `[data-closing]`
 * en index.css). Si se vuelve a abrir mientras se va, se queda.
 *
 * Con movimiento reducido se va en el acto.
 */
export function usePresence(open: boolean, exitMs: number = EXIT_MS) {
  const [mounted, setMounted] = useState(open);

  useEffect(() => {
    if (open) {
      setMounted(true);
      return;
    }
    if (!mounted) return;
    if (reducedMotion() || exitMs <= 0) {
      setMounted(false);
      return;
    }
    const t = setTimeout(() => setMounted(false), exitMs);
    return () => clearTimeout(t);
    // `mounted` fuera a propósito: sólo cuenta que se abra o se cierre.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, exitMs]);

  return {
    /** Si hay que pintarlo: abierto, o yéndose. */
    present: open || mounted,
    /** Se está yendo: va en `data-closing`. */
    closing: !open && mounted,
  };
}

/**
 * Para lo que se cierra desde dentro y cuyo dueño lo quita en el acto (el
 * detalle de una tarea, los visores): primero la salida (`leaving`, para
 * `data-closing`) y, al acabar, `close` de verdad.
 *
 * Sustituye a las View Transitions que hacían esto: el WebKitGTK 2.54 de
 * escritorio dice tenerlas, pero el proceso de la página aborta al usarlas
 * (SIGABRT en WebKitWebProcess al cerrar una tarea, 18-oct-2026), y la app
 * entera se recargaba.
 */
export function useExitThen(close: () => void, exitMs: number = EXIT_MS) {
  const [leaving, setLeaving] = useState(false);
  const leave = () => {
    if (leaving) return;
    if (reducedMotion() || exitMs <= 0) {
      close();
      return;
    }
    setLeaving(true);
    setTimeout(() => {
      setLeaving(false);
      close();
    }, exitMs);
  };
  return { leaving, leave };
}
