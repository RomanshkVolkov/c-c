import { useEffect, useRef } from "react";

import { useSidebar } from "@/components/ui/sidebar";
import { useVoice } from "@/store/voice.store";

/**
 * Con la sala en pantalla, quitar de en medio lo que sobra.
 *
 * El rail de espacios y la columna de canales suman 31rem que ahí no pintan
 * nada: mientras miras la llamada no estás navegando entre canales, y si
 * alguien comparte pantalla se comen el ancho justo cuando más falta hace.
 *
 * Se dispara al **entrar**, no al compartir. Empezó siendo lo segundo y era una
 * distinción que no se sostenía: el escenario ocupa el área principal en los
 * dos casos, y explicar por qué la interfaz encoge unas veces sí y otras no
 * habría sido imposible. **Minimizar la devuelve**, que es lo que hace de esto
 * algo reversible en un clic y no una imposición.
 *
 * # Las dos reglas que evitan que esto se vuelva molesto
 *
 * **Se restaura lo que había, no se abre.** Se recuerda el estado del rail al
 * encogerlo y se devuelve a ése. Quien lo tenía colapsado a propósito no se lo
 * encuentra abierto de golpe al salir; devolver «abierto» sería cómodo de
 * programar y una imposición.
 *
 * **Si lo tocas tú, esto deja de mandar.** Abrir el rail a mano durante la
 * llamada cancela la gestión hasta la siguiente: no se vuelve a cerrar, y al
 * salir no se toca. Una interfaz que te pelea el clic es peor que una
 * apretada.
 *
 * Devuelve si la columna de canales debe estar encogida; el rail lo mueve este
 * hook por su cuenta, porque su estado vive en el contexto de shadcn y no en
 * una clase.
 */
export function useEncogerEnLlamada(spaceId: string | null): boolean {
  const { open, setOpen } = useSidebar();

  // Una sola suscripción con un booleano derivado, y no cinco campos sueltos:
  // así el componente sólo se vuelve a pintar cuando la respuesta cambia, no
  // cada vez que se mueve cualquier cosa de la sala.
  // La misma condición con la que `ChannelView` decide enseñar el escenario en
  // vez del hilo. Si algún día se separan, la interfaz encogería sin sala
  // delante o al revés.
  const enLlamada = useVoice(
    (s) => s.escenario && s.estado !== "fuera" && s.spaceId !== null && s.spaceId === spaceId,
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
    if (enLlamada) {
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
    // Al salir o minimizar se olvida todo, incluida la renuncia: la próxima vez
    // que entres se vuelve a encoger, que es lo que esperarías.
    if (previo.current !== null && !soltado.current && previo.current) setOpen(true);
    previo.current = null;
    soltado.current = false;
  }, [enLlamada, open, setOpen]);

  return enLlamada;
}
