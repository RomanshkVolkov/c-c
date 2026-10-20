import { useAudioPrefs } from "@/store/audio-prefs.store";
import { useVoice } from "@/store/voice.store";

/**
 * El tono de un aviso del sistema.
 *
 * Lo pone la app y no el sistema: en Linux, que una notificación suene lo
 * decide el servidor de avisos, y dunst (el de bspwm) no suena aunque se lo
 * pidan. Sintetizado como el timbre (`components/voice/ringtone.ts`), sin
 * ficheros que empaquetar.
 *
 * Dos tonos, elegidos con jose oyéndolos (20-oct-2026): «gota» para los
 * mensajes, que llegan seguidos y no pueden cansar, y «dos notas» (Mi → La)
 * para lo demás. Lo que ya tiene timbre propio —una llamada, la reunión que
 * empieza— no suena aquí: se pisarían.
 */
export type NotifyTone = "drop" | "twoNotes";

const QUIET_KINDS = new Set(["voice.ring", "meeting:reminder"]);
const MESSAGE_KINDS = new Set(["chat:message", "dm:message"]);

export function toneFor(kind: string): NotifyTone | null {
  if (QUIET_KINDS.has(kind)) return null;
  return MESSAGE_KINDS.has(kind) ? "drop" : "twoNotes";
}

/**
 * Entre dos tonos, como mínimo. Diez avisos en un segundo (un deploy que
 * termina, un canal animado) suenan una vez, no diez.
 */
export const MIN_GAP_MS = 1500;

let lastAt = -Infinity;
let ctx: AudioContext | null = null;

/** Sólo para las pruebas: olvidar el último tono. */
export function resetNotifySound() {
  lastAt = -Infinity;
}

function audio(): AudioContext | null {
  if (ctx) return ctx;
  const C = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!C) return null;
  try {
    ctx = new C();
  } catch {
    return null;
  }
  return ctx;
}

/**
 * Una nota con ataque corto y caída exponencial. La caída hasta casi cero, y
 * no un corte, es lo que evita el chasquido (ver la rampa del timbre).
 */
function note(c: AudioContext, hz: number, start: number, dur: number, gain: number, glide?: number) {
  const o = c.createOscillator();
  const g = c.createGain();
  const at = c.currentTime + start;
  o.frequency.setValueAtTime(hz, at);
  if (glide) o.frequency.exponentialRampToValueAtTime(glide, at + dur);
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(gain, at + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  o.connect(g).connect(c.destination);
  o.start(at);
  o.stop(at + dur + 0.05);
}

/** Suena el tono, sin mirar preferencias: para el interruptor, al encenderlo. */
export function playTone(tone: NotifyTone) {
  const c = audio();
  if (!c) return;
  // Un contexto creado sin gesto puede nacer suspendido; pedirle que siga
  // no cuesta nada si ya está en marcha.
  void c.resume?.().catch(() => {});
  if (tone === "drop") {
    note(c, 1046, 0, 0.25, 0.15, 880);
  } else {
    note(c, 659, 0, 0.22, 0.13);
    note(c, 880, 0.12, 0.35, 0.13);
  }
}

/**
 * El tono del aviso `kind`, si toca. Devuelve si sonó.
 *
 * Calla si está apagado en este equipo, si estás en una llamada (pisaría las
 * voces) o sordo (pediste que el ordenador se callara), y si acaba de sonar.
 */
export function playNotifySound(kind: string, now = Date.now()): boolean {
  const tone = toneFor(kind);
  if (!tone || !useAudioPrefs.getState().notifySound) return false;
  const v = useVoice.getState();
  if (v.spaceId || v.meetId || v.sordo) return false;
  if (now - lastAt < MIN_GAP_MS) return false;
  lastAt = now;
  playTone(tone);
  return true;
}
