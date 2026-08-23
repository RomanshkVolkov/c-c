import { useEffect, useRef } from "react";

import { useSidebar } from "@/components/ui/sidebar";
import { useVoice } from "@/store/voice.store";

/**
 * Cuando hay una pantalla en el escenario, quitar de en medio lo que sobra.
 *
 * Compartir es justo el momento en que el ancho hace más falta, y es cuando el
 * rail de espacios y la columna de canales se lo comen: 16rem + 15rem sobre una
 * imagen que ya viene reducida. En un portátil eso deja el contenido compartido
 * ilegible.
 *
 * Vale tanto la pantalla propia como la ajena. Mirar la de otro estorba igual
 * que enseñar la tuya, y distinguirlas sería una regla que nadie podría
 * explicar.
 *
 * # Las dos reglas que evitan que esto se vuelva molesto
 *
 * **Se restaura lo que había, no se abre.** Se recuerda el estado del rail al
 * encogerlo y se devuelve a ése. Quien lo tenía colapsado a propósito no se lo
 * encuentra abierto de golpe al dejar de compartir; devolver «abierto» sería
 * cómodo de programar y una imposición.
 *
 * **Si lo tocas tú, esto deja de mandar.** Abrir el rail a mano durante la
 * compartición cancela la gestión hasta la siguiente: no se vuelve a cerrar, y
 * al terminar no se toca. Una interfaz que te pelea el clic es peor que una
 * apretada.
 *
 * Devuelve si la columna de canales debe estar encogida; el rail lo mueve este
 * hook por su cuenta, porque su estado vive en el contexto de shadcn y no en
 * una clase.
 */
export function useEncogerAlCompartir(spaceId: string | null): boolean {
  const { open, setOpen } = useSidebar();

  // Una sola suscripción con un booleano derivado, y no cinco campos sueltos:
  // así el componente sólo se vuelve a pintar cuando la respuesta cambia, no
  // cada vez que se mueve cualquier cosa de la sala.
  const hayPantalla = useVoice(
    (s) =>
      s.escenario &&
      s.estado !== "fuera" &&
      s.spaceId !== null &&
      s.spaceId === spaceId &&
      (s.compartiendo || s.pantalla !== null),
  );

  // El estado al que hay que volver, o `null` si todavía no hemos tocado nada.
  const previo = useRef<boolean | null>(null);
  // Y una bandera aparte para «lo tocaste tú, me aparto».
  //
  // Dos variables y no una: usar `previo === null` para las dos cosas parece
  // más limpio y no lo es — soltar el mando dejaría de ser duradero, porque el
  // siguiente clic tuyo lo volvería a activar y esto acabaría restaurando un
  // estado intermedio tuyo al terminar. Se ve en la prueba «manda tu última
  // decisión».
  const soltado = useRef(false);

  useEffect(() => {
    if (hayPantalla) {
      if (soltado.current) return;
      if (previo.current === null) {
        previo.current = open;
        if (open) setOpen(false);
        return;
      }
      // Estaba encogido por nosotros y ahora aparece abierto: sólo ha podido
      // abrirlo alguien a mano. A partir de aquí manda quien lo tocó.
      if (open) {
        soltado.current = true;
        previo.current = null;
      }
      return;
    }
    // Fuera de la compartición se olvida todo, incluida la renuncia: la próxima
    // vez que compartas se vuelve a encoger, que es lo que esperarías.
    if (previo.current !== null && !soltado.current && previo.current) setOpen(true);
    previo.current = null;
    soltado.current = false;
  }, [hayPantalla, open, setOpen]);

  return hayPantalla;
}
