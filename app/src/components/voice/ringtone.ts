/**
 * Los dos tonos del timbre, sintetizados.
 *
 * Sin ficheros de audio a propósito: son dos senos y una envolvente, pesan cero
 * en el instalador y no hay que decidir formato ni licencia. Un mp3 de dos
 * segundos que hay que empaquetar para tres sistemas operativos es más cosas
 * que pueden salir mal que esto.
 *
 * La **rampa de 30 ms** al entrar y al salir no es un detalle estético: cortar
 * una onda en seco produce un salto de amplitud que el altavoz reproduce como
 * un chasquido, y un chasquido cada 1,6 segundos es peor que el propio timbre.
 */

/** Un tono en curso, con lo justo para poder pararlo. */
export interface Tono {
  parar: () => void;
}

const RAMPA = 0.03;

type Ctx = AudioContext;

function ctxNuevo(): Ctx | null {
  const C = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!C) return null;
  try {
    return new C();
  } catch {
    return null;
  }
}

/** Un pitido: frecuencias a la vez, con su rampa a los dos lados. */
function pitido(ctx: Ctx, hz: number[], desde: number, dura: number, ganancia: number) {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, desde);
  g.gain.linearRampToValueAtTime(ganancia, desde + RAMPA);
  g.gain.setValueAtTime(ganancia, desde + dura - RAMPA);
  g.gain.linearRampToValueAtTime(0, desde + dura);
  g.connect(ctx.destination);
  for (const f of hz) {
    const o = ctx.createOscillator();
    o.frequency.value = f;
    o.connect(g);
    o.start(desde);
    o.stop(desde + dura);
  }
}

/**
 * El tono de «estoy llamando», el que oye quien llama.
 *
 * 440 + 480 Hz, 1,2 s sonando y 2,4 s callado — el patrón del teléfono
 * americano. Se elige por reconocible, no por bonito: nadie tiene que aprender
 * qué significa.
 */
export function tonoSaliente(): Tono {
  const ctx = ctxNuevo();
  if (!ctx) return { parar: () => {} };
  const ciclo = 3.6;
  let t = ctx.currentTime + 0.05;
  const timer = setInterval(() => {
    pitido(ctx, [440, 480], t, 1.2, 0.05);
    t += ciclo;
  }, ciclo * 1000);
  pitido(ctx, [440, 480], t, 1.2, 0.05);
  t += ciclo;
  return {
    parar: () => {
      clearInterval(timer);
      void ctx.close();
    },
  };
}

/**
 * El tono de «te llaman», dos notas ascendentes cada 1,6 s.
 *
 * Ascendente y no un zumbido plano porque tiene que distinguirse de cualquier
 * otra cosa que haga ruido en el escritorio, y porque una llamada entrante pide
 * una respuesta: un sonido que sube se oye como una pregunta.
 */
export function tonoEntrante(): Tono {
  const ctx = ctxNuevo();
  if (!ctx) return { parar: () => {} };
  const ciclo = 1.6;
  let t = ctx.currentTime + 0.05;
  const sonar = () => {
    pitido(ctx, [880], t, 0.26, 0.045);
    pitido(ctx, [1174], t + 0.3, 0.32, 0.045);
    t += ciclo;
  };
  const timer = setInterval(sonar, ciclo * 1000);
  sonar();
  return {
    parar: () => {
      clearInterval(timer);
      void ctx.close();
    },
  };
}
