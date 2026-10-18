import { useCallback, useLayoutEffect, useRef } from "react";

/** Lo que se considera «abajo»: un par de líneas de holgura. */
const NEAR_BOTTOM_PX = 32;

/**
 * Una caja de log que baja sola con cada línea nueva, como `tail -f`.
 *
 * Sólo mientras se está abajo: si quien la lee sube a mirar una línea de
 * antes, la caja se queda donde la dejó y no le arranca la vista con la
 * siguiente que llegue; al volver abajo, sigue otra vez. Antes no seguía
 * nunca y había que ir bajando a mano mientras desplegaba (jose, 18-oct-2026).
 *
 * `content` es lo que crece (el texto del log): al cambiar, se baja.
 */
export function useFollowLog<T extends HTMLElement>(content: unknown) {
  const ref = useRef<T>(null);
  const following = useRef(true);

  const onScroll = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    following.current = el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX;
  }, []);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el && following.current) el.scrollTop = el.scrollHeight;
  }, [content]);

  return { ref, onScroll };
}
