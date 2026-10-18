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
  const ref = useRef<T>(null);
  const [rect, setRect] = useState<IndicatorRect | null>(null);
  const seen = useRef(false);

  useLayoutEffect(() => {
    const box = ref.current;
    if (!box) return;
    const measure = () => {
      const el = box.querySelector<HTMLElement>(ACTIVE);
      setRect(
        el && el.offsetWidth > 0 ? { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight } : null,
      );
    };
    measure();
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    ro?.observe(box);
    return () => ro?.disconnect();
  }, [dep]);

  const first = !seen.current;
  if (rect) seen.current = true;
  return { ref, rect, first };
}
