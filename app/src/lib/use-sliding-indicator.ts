import { useLayoutEffect, useRef, useState } from "react";

export interface IndicatorRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Lo que cuenta como «la pestaña activa», venga de donde venga. */
const ACTIVE =
  '[data-active="true"], [aria-current="page"], [aria-selected="true"], [aria-pressed="true"]';

/**
 * Dónde está la pestaña activa dentro de su barra, para que un indicador se
 * deslice hasta ella en vez de apagarse en una y encenderse en otra.
 *
 * La barra tiene que ser `relative`: las medidas son respecto a ella
 * (`offsetLeft`/`offsetTop`). Se vuelve a medir al cambiar `dep` (el valor
 * activo) y cuando la barra cambia de tamaño. Sin layout (jsdom) no hay
 * medida y el indicador no se pinta: quien lo usa deja su marca de siempre.
 *
 * `first` dice si es la primera medida: entonces el indicador aparece en su
 * sitio sin deslizarse desde la esquina.
 */
export function useSlidingIndicator<T extends HTMLElement>(dep: unknown) {
  // Un `ref` de función y el elemento en estado, no un `useRef`: la barra
  // puede aparecer después que el componente (unas pestañas que sólo existen
  // cuando hay respuesta, la barra del teléfono al cerrar el teclado), y con
  // un `useRef` nadie se enteraría de que ya está para medirla.
  const [el, ref] = useState<T | null>(null);
  const [rect, setRect] = useState<IndicatorRect | null>(null);
  const seen = useRef(false);

  useLayoutEffect(() => {
    if (!el) {
      setRect(null);
      return;
    }
    const measure = () => {
      const active = el.querySelector<HTMLElement>(ACTIVE);
      setRect(
        active && active.offsetWidth > 0
          ? { x: active.offsetLeft, y: active.offsetTop, w: active.offsetWidth, h: active.offsetHeight }
          : null,
      );
    };
    measure();
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [el, dep]);

  const first = !seen.current;
  if (rect) seen.current = true;
  return { ref, rect, first };
}
