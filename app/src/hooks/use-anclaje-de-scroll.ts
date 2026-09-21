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
 * 4. **Al volver, sigues donde estabas.** Salir a otra pestaña desmonta la
 *    caja; al volver, la nueva empieza en cero y el hilo aparecía por el
 *    principio. El hook no se desmonta con ella —vive arriba—, así que el
 *    enganche del nodo es el único momento en el que puede enterarse. Abajo si
 *    estabas abajo, y en tu sitio si estabas leyendo: volver de mirar una
 *    imagen no puede sacarte del punto que estabas leyendo.
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
  const cajaRef = useRef<HTMLDivElement | null>(null);
  const altoAntes = useRef<number | null>(null);
  /**
   * Si estabas abajo **justo antes** de esta actualización.
   *
   * Se lee en el render, no en el efecto: para cuando el efecto corre el DOM ya
   * tiene los mensajes nuevos y la respuesta sería siempre «no».
   */
  const estabaAbajo = useRef(true);
  /** Por dónde ibas cuando la caja se fue, para devolverte ahí. */
  const posicion = useRef<number | null>(null);
  /**
   * Ref de función, y no de objeto, por la regla 4.
   *
   * La caja se desmonta y se vuelve a montar —cambiar de pestaña y volver— sin
   * que el hook se entere: vive en el componente de arriba, que no se
   * desmonta. El efecto de abajo depende de `items`, que en ese viaje no
   * cambia, así que no corre nadie y el navegador deja la caja nueva en cero:
   * el hilo aparecía **por el principio**, como una lista cualquiera.
   *
   * Aquí sí hay un momento en el que enterarse: cuando el nodo se engancha.
   */
  const caja = useCallback((el: HTMLDivElement | null) => {
    if (el === null) {
      // Se va: la caja vieja todavía está en `cajaRef`, así que es el último
      // momento para apuntar por dónde ibas. Después el nodo ya no existe.
      const vieja = cajaRef.current;
      if (vieja) posicion.current = vieja.scrollTop;
      cajaRef.current = null;
      return;
    }
    cajaRef.current = el;
    // Abajo si estabas abajo; y si no, donde estabas. Volver de mirar una
    // imagen no puede sacarte del punto que estabas leyendo.
    el.scrollTop = estabaAbajo.current ? el.scrollHeight : (posicion.current ?? 0);
  }, []);
  const [hayNuevos, setHayNuevos] = useState(false);

  const alFinal = useCallback(() => {
    const el = cajaRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    estabaAbajo.current = true;
    setHayNuevos(false);
  }, []);

  const enScroll = useCallback(() => {
    const el = cajaRef.current;
    if (!el) return;
    estabaAbajo.current = el.scrollHeight - el.scrollTop - el.clientHeight <= MARGEN;
    if (estabaAbajo.current) setHayNuevos(false);
    if (el.scrollTop > UMBRAL_DE_CARGA || !hayMas || cargando) return;
    altoAntes.current = el.scrollHeight;
    cargarAnteriores();
  }, [hayMas, cargando, cargarAnteriores]);

  useLayoutEffect(() => {
    const el = cajaRef.current;
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
    const el = cajaRef.current;
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
