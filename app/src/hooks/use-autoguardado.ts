import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Guardar solo, sin botón.
 *
 * La parte difícil no es el temporizador. Es que un guardado tarda, y mientras
 * viaja la persona sigue escribiendo: si al volver se adoptara la respuesta del
 * servidor, se perderían las pulsaciones de ese medio segundo — y se perderían
 * justo cuando alguien escribe rápido, que es cuando más duele. Por eso este
 * hook nunca devuelve texto: sólo dice en qué estado está el guardado, y quien
 * escribe sigue siendo la única fuente de lo escrito.
 *
 * La segunda: dos guardados a la vez llegan en cualquier orden, y el último en
 * llegar puede ser el más viejo. Se guarda de uno en uno, y si algo cambió
 * mientras tanto se vuelve a guardar al terminar.
 */

export type EstadoDeGuardado = "quieto" | "guardando" | "guardado" | "error";

/** Cada cuánto se guarda mientras se escribe. */
const ESPERA = 1500;

export function useAutoguardado(
  texto: string,
  guardar: (texto: string) => Promise<void>,
  activo: boolean,
) {
  const [estado, setEstado] = useState<EstadoDeGuardado>("quieto");
  // Lo último que el servidor confirmó. Sirve para no mandar lo mismo dos veces
  // —el temporizador dispara por tiempo, no por cambio— y para saber si queda
  // algo pendiente cuando se apaga el editor.
  const confirmado = useRef(texto);
  const enVuelo = useRef(false);
  // Cuántas veces el texto llegó de fuera.
  //
  // Un guardado que sale y vuelve apunta lo que mandó como «lo confirmado». Si
  // mientras viajaba alguien restauró una versión o se cambió de sección, esa
  // anotación es mentira: pisa lo que se acaba de adoptar y el hook cree que hay
  // cambios sin guardar, así que manda el texto nuevo por su cuenta. En un
  // cambio de pestaña eso significaba escribir una sección encima de otra.
  const epoca = useRef(0);
  const ultimo = useRef(texto);
  ultimo.current = texto;

  // `guardar` suele llegar como una función nueva en cada render. Guardarla en
  // una ref evita reiniciar el temporizador en cada pulsación, que es lo que
  // haría que no se guardase nunca mientras alguien escribe seguido.
  const guardarRef = useRef(guardar);
  guardarRef.current = guardar;

  const empujar = useCallback(async () => {
    if (enVuelo.current) return;
    if (ultimo.current === confirmado.current) return;
    enVuelo.current = true;
    setEstado("guardando");
    const enviado = ultimo.current;
    const miEpoca = epoca.current;
    let fue = false;
    try {
      await guardarRef.current(enviado);
      // Llegó texto de fuera mientras esto viajaba: lo que se mandó ya no es la
      // referencia de nada, y anotarlo dispararía un guardado que nadie pidió.
      if (epoca.current !== miEpoca) return;
      confirmado.current = enviado;
      fue = true;
      setEstado("guardado");
    } catch {
      setEstado("error");
    } finally {
      enVuelo.current = false;
    }
    // Cambió mientras viajaba: hay que volver a salir. Sin esto, lo escrito
    // durante el guardado se quedaría sin guardar hasta la siguiente pulsación
    // — y si esa pulsación no llega porque la persona terminó, se pierde.
    //
    // **Sólo si el guardado salió bien.** Reintentar tras un fallo se llama a sí
    // mismo para siempre: `confirmado` no avanza, así que la condición nunca deja
    // de cumplirse. Sin red, esto colgaba la pestaña entera. Tras un error se
    // espera a la siguiente pulsación, que es cuando puede haber vuelto.
    if (fue && ultimo.current !== confirmado.current) void empujar();
  }, []);

  useEffect(() => {
    if (!activo) return;
    if (texto === confirmado.current) return;
    const id = setTimeout(() => void empujar(), ESPERA);
    return () => clearTimeout(id);
  }, [texto, activo, empujar]);

  // Al salir del editor no se espera al temporizador: cerrar y perder el último
  // segundo de escritura es exactamente el fallo que el autoguardado venía a
  // quitar.
  useEffect(() => {
    if (activo) return;
    void empujar();
  }, [activo, empujar]);

  /** Para cuando el texto cambia por otra vía: restaurar una versión, cambiar de sección. */
  const adoptar = useCallback((t: string) => {
    epoca.current += 1;
    confirmado.current = t;
    ultimo.current = t;
    setEstado("quieto");
  }, []);

  return { estado, adoptar, guardarYa: empujar };
}
