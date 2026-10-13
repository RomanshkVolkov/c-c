import { useVoice } from "@/store/voice.store";

/**
 * Quién anda por los canales de voz, preguntado mientras alguien lo mire.
 *
 * Se pregunta cada quince segundos en vez de escuchar eventos: la ocupación
 * sólo importa para decidir si entrar, y quince segundos de retraso en esa
 * decisión no los nota nadie. Un canal de webhooks con estado propio para
 * esto sería mucha maquinaria por muy poco, y una que puede mentir.
 *
 * **Contado por suscriptores.** Lo miran el panel de Comunicación y la
 * pantalla de Canales a la vez (en el teléfono no hay panel, y con el panel
 * plegado durante una llamada la pantalla es la que queda), y cada uno con su
 * propio intervalo eran dos preguntas cada quince segundos. El primero que se
 * suscribe arranca el reloj, el último que se va lo para, y suscribirse con
 * otra org lo reinicia en ésa: la ocupación es de una org, y la de la
 * anterior no le sirve a nadie.
 *
 * Fuera de `voice.store.ts` a propósito: aquello es la llamada, y esto sólo
 * decide cada cuánto se pregunta.
 */
const PERIOD_MS = 15_000;

let watchers = 0;
let watchedOrg: string | null | undefined;
let timer: ReturnType<typeof setInterval> | null = null;

function start(orgId: string | null | undefined) {
  if (timer) clearInterval(timer);
  watchedOrg = orgId;
  const ask = () => void useVoice.getState().refrescarOcupacion(orgId);
  ask();
  timer = setInterval(ask, PERIOD_MS);
}

/** Empieza a vigilar la ocupación de `orgId`; lo que devuelve deja de hacerlo. */
export function watchOccupancy(orgId: string | null | undefined): () => void {
  watchers += 1;
  if (watchers === 1 || orgId !== watchedOrg) start(orgId);

  let released = false;
  return () => {
    if (released) return;
    released = true;
    watchers -= 1;
    if (watchers === 0 && timer) {
      clearInterval(timer);
      timer = null;
      watchedOrg = undefined;
    }
  };
}
