import { useCallback, useLayoutEffect, useRef, useState } from "react";

/**
 * Que un hilo se lea como un hilo.
 *
 * Un chat se mira desde abajo: lo último está al final, y para ver lo anterior
 * se sube y va cargando. Suena obvio y no lo era — `ChannelView` y `DMThread`
 * tenían este bloque **duplicado carácter a carácter**, y ninguno de los dos
 * hacía lo que hace falta.
 *
 * Las tres reglas, que son las que distinguen un hilo de una lista cualquiera:
 *
 * 1. **Si estabas abajo, sigues abajo.** Llega un mensaje y lo ves sin tocar
 *    nada.
 * 2. **Si estabas leyendo hacia arriba, no te mueves.** Que llegue un mensaje
 *    mientras lees historia no puede arrancarte de donde estás; es la diferencia
 *    entre poder leer hacia atrás y no poder.
 * 3. **Al anteponer una página vieja, te quedas mirando lo mismo.** Sin esto,
 *    subir para cargar más te devolvería al final en cada página.
 *
 * Y un detalle que sólo se ve con imágenes: el markdown de un mensaje puede
 * crecer *después* de que midamos, así que el final se vuelve a fijar cuando el
 * contenido cambia de tamaño.
 */

/** Margen para «estás abajo». Exigir igualdad exacta falla con subpíxeles. */
const MARGEN = 24;

/** Cuánto hay que subir desde arriba para pedir la página anterior. */
const UMBRAL_DE_CARGA = 40;

export function useAnclajeDeScroll<T>({
  items,
  hayMas,
  cargando,
  cargarAnteriores,
}: {
  /** La lista pintada. Cada cambio de identidad decide el anclaje. */
  items: T[];
  hayMas: boolean;
  cargando: boolean;
  cargarAnteriores: () => void;
}) {
  const caja = useRef<HTMLDivElement>(null);
  const altoAntes = useRef<number | null>(null);
  /**
   * Si estabas abajo **justo antes** de esta actualización.
   *
   * Se lee en el render, no en el efecto: para cuando el efecto corre el DOM ya
   * tiene los mensajes nuevos y la respuesta sería siempre «no».
   */
  const estabaAbajo = useRef(true);
  const [hayNuevos, setHayNuevos] = useState(false);

  const alFinal = useCallback(() => {
    const el = caja.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    estabaAbajo.current = true;
    setHayNuevos(false);
  }, []);

  const enScroll = useCallback(() => {
    const el = caja.current;
    if (!el) return;
    estabaAbajo.current = el.scrollHeight - el.scrollTop - el.clientHeight <= MARGEN;
    if (estabaAbajo.current) setHayNuevos(false);
    if (el.scrollTop > UMBRAL_DE_CARGA || !hayMas || cargando) return;
    altoAntes.current = el.scrollHeight;
    cargarAnteriores();
  }, [hayMas, cargando, cargarAnteriores]);

  useLayoutEffect(() => {
    const el = caja.current;
    if (!el) return;

    if (altoAntes.current !== null) {
      // Se antepuso una página: quedarse mirando la misma línea.
      el.scrollTop = el.scrollHeight - altoAntes.current;
      altoAntes.current = null;
      return;
    }
    if (estabaAbajo.current) {
      el.scrollTop = el.scrollHeight;
      return;
    }
    // Leyendo hacia arriba: no se toca nada, y se avisa de que hay algo nuevo.
    setHayNuevos(true);
  }, [items]);

  // El markdown con imágenes crece después de medir. Sin esto el final se queda
  // a medio camino en cuanto un mensaje trae una captura.
  useLayoutEffect(() => {
    const el = caja.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (estabaAbajo.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(el);
    for (const hijo of Array.from(el.children)) ro.observe(hijo);
    return () => ro.disconnect();
  }, [items]);

  return { caja, enScroll, alFinal, hayNuevos };
}
