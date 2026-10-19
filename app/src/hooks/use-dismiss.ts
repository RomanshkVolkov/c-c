import { useEffect, useRef } from "react";

/**
 * Cierra un panel flotante hecho a mano al pulsar fuera de él o con Escape,
 * como cualquier menú. Los paneles de la llamada (ajustes de audio, invitar)
 * sólo se cerraban volviendo a pulsar su botón (jose, 18-oct-2026).
 *
 * El botón que lo abre lleva `data-toggles={id}`: pulsarlo no cuenta como
 * «fuera», o el panel se cerraría aquí y el propio botón lo volvería a abrir
 * en el mismo clic. Devuelve el `ref` del panel.
 */
export function useDismiss<T extends HTMLElement>(open: boolean, onDismiss: () => void, id: string) {
  const ref = useRef<T>(null);
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      const target = e.target as Element | null;
      if (!target || ref.current?.contains(target)) return;
      if (target.closest?.(`[data-toggles="${id}"]`)) return;
      dismiss.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") dismiss.current();
    };
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, id]);

  return ref;
}
