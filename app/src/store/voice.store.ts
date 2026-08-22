import { create } from "zustand";
import { Channel, invoke } from "@tauri-apps/api/core";
import { api } from "@/lib/api";
import type { APIResponse } from "@/types/auth";

/**
 * La sala de voz en la que estás, y quién está contigo.
 *
 * El motor vive en Rust —el webview de Linux no tiene WebRTC, ver `docs/voz.md`—
 * así que aquí no hay media: sólo el estado que la pantalla pinta y las órdenes
 * que se le mandan. Lo mismo que el terminal, y por el mismo motivo: lo que se
 * puede probar sin un navegador de verdad vive en el store.
 */

export type VoiceEvent =
  | { kind: "connected"; identity: string }
  | { kind: "joined"; identity: string; name: string }
  | { kind: "left"; identity: string }
  | { kind: "speaking"; identities: string[] }
  | { kind: "muted"; identity: string; muted: boolean }
  | { kind: "latency"; ms: number }
  | { kind: "video"; identity: string; enabled: boolean }
  | { kind: "disconnected"; reason: string };

export interface VoicePeer {
  identity: string;
  name: string;
}

/** Lo que llega por el stream de eventos cuando alguien te llama. */
export interface TimbreEntrante {
  ringId: string;
  spaceId: string;
  spaceName: string;
  from: { id: string; name: string };
  /** ISO. Pasada esa hora la tarjeta se va sola, llame quien llame. */
  expiresAt: string;
}

/** Una llamada tuya que todavía no ha contestado nadie. */
export interface TimbreSaliente {
  identity: string;
  name: string;
  /** Cuándo empezó a sonar, para el contador de la pantalla. */
  desde: number;
  /** Se rindió: veinte segundos sin respuesta, o el otro lado dijo que no. */
  sinRespuesta: boolean;
}

/**
 * Cuánto suena un timbre antes de rendirse. **Tiene que coincidir con
 * `service.TimbreTTL` del backend**, que es quien pone el `expiresAt`.
 *
 * El tope vive en los dos lados a propósito: el servidor no guarda el timbre en
 * ninguna parte —es un evento, no un registro— así que no hay nadie vigilando
 * el reloj. Cada extremo se rinde por su cuenta, y por eso un timbre sobrevive
 * a que la app de quien llamaba se cierre de golpe.
 */
export const TIMBRE_MS = 20_000;

interface VoiceState {
  /** El espacio cuya sala está abierta, o null. Una a la vez. */
  spaceId: string | null;
  /** "entrando" mientras se pide el token y se conecta. */
  estado: "fuera" | "entrando" | "dentro";
  /**
   * ¿Está abierta la pantalla de la sala?
   *
   * Estar conectado y estar mirando la llamada son dos cosas distintas, y con
   * un solo booleano no se pueden distinguir: minimizar acabaría colgando. Con
   * `estado` se sabe si el micrófono está abierto; con esto, si la sala ocupa
   * la pantalla. Salir apaga los dos; minimizar sólo éste.
   */
  escenario: boolean;
  /** Quién está dentro, tú incluido. */
  gente: VoicePeer[];
  /** Quién habla ahora mismo. */
  hablando: string[];
  /**
   * Quién tiene el micrófono cerrado, por identidad.
   *
   * Un mapa y no una lista porque «no sé nada de esta persona» y «esta persona
   * está abierta» no son lo mismo: hasta que el motor reporta su pista, la
   * pantalla no debe afirmar ninguna de las dos.
   */
  mudos: Record<string, boolean>;
  /** Ida y vuelta al SFU en milisegundos, o null mientras no se sepa. */
  latencia: number | null;
  /**
   * Quién está publicando vídeo.
   *
   * Sólo dice que hay pista, no que haya llegado una trama. El mosaico pone el
   * lienzo con esto y el avatar se queda debajo hasta que se pinte algo: entre
   * suscribirse y la primera imagen pasa medio segundo, y un rectángulo negro
   * durante medio segundo se lee como una cámara rota.
   */
  video: Record<string, boolean>;
  /** A quién estás llamando y todavía no contesta. */
  llamando: TimbreSaliente | null;
  /** Quién te llama a ti. */
  entrante: TimbreEntrante | null;
  yo: string | null;
  mic: boolean;
  /** Sordera: ni oyes ni te oyen. */
  sordo: boolean;
  /** Tu cámara. */
  cam: boolean;
  error: string | null;
  /**
   * Quién está en cada canal de voz, **sin haber entrado**.
   *
   * Es lo que rompe el círculo del canal vacío: si no ves que hay alguien
   * dentro no entras, y si nadie entra nunca hay a quien ver.
   *
   * Se pregunta al servidor y él al SFU, en vez de llevar la cuenta por aquí:
   * un recuento propio se desincroniza con el primer evento perdido y entonces
   * la lista miente sin que nada falle.
   */
  ocupacion: Record<string, VoicePeer[]>;

  entrar: (spaceId: string) => Promise<void>;
  salir: () => Promise<void>;
  /** Volver a la llamada sin reconectar: sólo abre la pantalla. */
  abrirEscenario: () => void;
  /** Minimizar. No cuelga: el audio sigue. */
  cerrarEscenario: () => void;
  alternarMic: () => Promise<void>;
  alternarSordera: () => Promise<void>;
  alternarCam: () => Promise<void>;
  /** Refresca quién anda por los canales. La pantalla decide cada cuánto. */
  refrescarOcupacion: (orgId?: string | null) => Promise<void>;
  /** Lo que reporta el motor. Público para poder probarlo sin Tauri. */
  alRecibir: (ev: VoiceEvent) => void;

  /** Hacer sonar el escritorio de un compañero para que entre a esta sala. */
  timbrar: (userId: string, nombre: string) => Promise<void>;
  /** Dejar de llamar. También sirve para quitar el «no contestó» de en medio. */
  cancelarTimbre: () => Promise<void>;
  /** Te llaman. Lo invoca el stream de eventos. */
  alTimbrar: (t: TimbreEntrante) => void;
  /** El que llamaba colgó, o rechazaste tú y el eco vuelve. */
  alColgarTimbre: (de: string) => void;
  aceptarEntrante: () => Promise<void>;
  rechazarEntrante: () => Promise<void>;
}

const VACIO = {
  spaceId: null,
  estado: "fuera" as const,
  escenario: false,
  gente: [],
  hablando: [],
  mudos: {},
  latencia: null,
  video: {},
  llamando: null,
  yo: null,
  mic: true,
  sordo: false,
  cam: false,
  error: null,
};

/**
 * Los dos relojes del timbre, fuera del store.
 *
 * No son estado que nadie pinte —lo que se pinta es `sinRespuesta` y que la
 * tarjeta esté o no— y meterlos dentro obligaría a arrastrar identificadores de
 * temporizador por el `set` y a acordarse de no serializarlos nunca.
 */
let relojSaliente: ReturnType<typeof setTimeout> | null = null;
let relojEntrante: ReturnType<typeof setTimeout> | null = null;

function pararReloj(cual: "saliente" | "entrante") {
  const r = cual === "saliente" ? relojSaliente : relojEntrante;
  if (r) clearTimeout(r);
  if (cual === "saliente") relojSaliente = null;
  else relojEntrante = null;
}

export const useVoice = create<VoiceState>((set, get) => ({
  ...VACIO,
  entrante: null,
  // Fuera de `VACIO` a propósito: salir de una sala no vacía los demás canales.
  ocupacion: {},

  entrar: async (spaceId) => {
    // Ya dentro de ésta: no se reconecta. Volver a entrar cortaría la
    // conversación en curso para dejarla exactamente igual.
    if (get().spaceId === spaceId && get().estado !== "fuera") return;
    // En otra: se sale primero. Dos micrófonos abiertos a la vez es un fallo
    // que sólo se nota cuando alguien te oye desde donde no estabas.
    if (get().spaceId) await get().salir();

    // El escenario se abre ya, mientras conecta: entrar a una llamada lleva un
    // segundo largo y sin nada que mirar parece que el botón no hizo nada.
    set({ ...VACIO, spaceId, estado: "entrando", escenario: true });
    try {
      const res = await api.post<APIResponse<{ url: string; token: string; room: string }>>(
        `/api/v1/task-spaces/${spaceId}/voice/token`,
        {},
        true,
      );
      if (!res.success || !res.data) throw new Error(res.error ?? "no se pudo pedir la entrada");

      const canal = new Channel<VoiceEvent>();
      canal.onmessage = (ev) => get().alRecibir(ev);
      const yo = await invoke<string>("voice_join", {
        url: res.data.url,
        token: res.data.token,
        onEvent: canal,
      });
      // Puede haberse pulsado «salir» mientras conectaba; entonces esto ya no
      // es la sala actual y dejarlo entrar dejaría un micrófono abierto.
      if (get().spaceId !== spaceId) {
        void invoke("voice_leave").catch(() => {});
        return;
      }
      set({ estado: "dentro", yo, mic: true });
    } catch (e) {
      const motivo = e instanceof Error ? e.message : String(e);
      set({ ...VACIO, error: motivo });
    }
  },

  salir: async () => {
    // Colgar mientras llamas a alguien tiene que callarle el teléfono: si no,
    // le sigue sonando veinte segundos una invitación a una sala vacía.
    if (get().llamando) await get().cancelarTimbre();
    pararReloj("saliente");
    set({ ...VACIO });
    await invoke("voice_leave").catch(() => {});
  },

  abrirEscenario: () => {
    // Sin sala no hay nada que enseñar, y un escenario vacío con la barra de
    // controles encima invita a pulsar botones que no van a ninguna parte.
    if (get().estado === "fuera") return;
    set({ escenario: true });
  },

  cerrarEscenario: () => set({ escenario: false }),

  refrescarOcupacion: async (orgId) => {
    try {
      const res = await api.get<APIResponse<Record<string, VoicePeer[]>>>(
        `/api/v1/chat/voice-presence${orgId ? `?orgId=${orgId}` : ""}`,
        true,
      );
      set({ ocupacion: res.data ?? {} });
    } catch {
      // Silencio: esto es informativo y se reintenta solo. Una pantalla roja
      // porque el SFU tardó sería peor que no saber quién hay.
    }
  },

  alternarMic: async () => {
    const siguiente = !get().mic;
    // Optimista: silenciarse tiene que sentirse instantáneo, y el motor no
    // puede fallar en apagar algo que ya tiene abierto.
    //
    // Se pinta también en `mudos` para que tu mosaico y el de los demás salgan
    // del mismo sitio; el motor confirma con su propio evento un instante
    // después y escribe encima lo mismo.
    const yo = get().yo;
    set((s) => ({
      mic: siguiente,
      mudos: yo ? { ...s.mudos, [yo]: !siguiente } : s.mudos,
    }));
    await invoke("voice_set_mic", { enabled: siguiente }).catch(() => {});
  },

  /**
   * Sordera.
   *
   * Silencia el micrófono además de los altavoces, y no lo devuelve al
   * quitarla: quien se pone sordo en mitad de una llamada casi siempre se está
   * apartando de ella, y volver hablando sin querer es el accidente que este
   * botón existe para evitar. Reabrir el micro es un gesto aparte, deliberado.
   */
  alternarSordera: async () => {
    const siguiente = !get().sordo;
    set(siguiente ? { sordo: true, mic: false } : { sordo: false });
    await invoke("voice_set_deaf", { enabled: siguiente }).catch(() => {});
    if (siguiente) await invoke("voice_set_mic", { enabled: false }).catch(() => {});
  },

  timbrar: async (userId, nombre) => {
    const spaceId = get().spaceId;
    if (!spaceId) return;
    pararReloj("saliente");
    set({ llamando: { identity: userId, name: nombre, desde: Date.now(), sinRespuesta: false } });
    try {
      const res = await api.post<APIResponse<{ ringId: string }>>(
        `/api/v1/task-spaces/${spaceId}/voice/ring`,
        { userId },
        true,
      );
      if (!res.success) throw new Error(res.error ?? "no se pudo llamar");
    } catch (e) {
      // Se cae la fila entera en vez de dejarla sonando: una llamada que el
      // servidor rechazó no está sonando en ninguna parte, y enseñarla como si
      // sonara es la peor de las mentiras posibles aquí.
      set({ llamando: null, error: e instanceof Error ? e.message : String(e) });
      return;
    }
    // El tope lo pone también el cliente porque el servidor no guarda el
    // timbre: nadie está mirando el reloj por nosotros.
    relojSaliente = setTimeout(() => {
      set((s) => (s.llamando ? { llamando: { ...s.llamando, sinRespuesta: true } } : s));
    }, TIMBRE_MS);
  },

  cancelarTimbre: async () => {
    const { spaceId, llamando } = get();
    // Parar el reloj aquí no cambia nada que se vea: el callback comprueba que
    // siga habiendo llamada, así que uno que llegue tarde no hace nada. Es por
    // no dejar veinte segundos de temporizador colgando, no por corrección — y
    // se dice para que nadie quite el `if` de ahí abajo creyendo que sobra.
    pararReloj("saliente");
    set({ llamando: null });
    if (!spaceId || !llamando) return;
    await api
      .delete(`/api/v1/task-spaces/${spaceId}/voice/ring/${llamando.identity}`, true)
      .catch(() => {});
  },

  alTimbrar: (t) => {
    // Ya estás dentro de esa sala: la llamada llegó tarde o cruzada, y una
    // tarjeta que te invita a donde ya estás sólo tapa la conversación.
    if (get().spaceId === t.spaceId && get().estado !== "fuera") return;
    pararReloj("entrante");
    set({ entrante: t });
    // Se apaga sola a la hora que dijo el servidor. Es lo que hace que un
    // timbre sobreviva a que la app de quien llamaba muera de golpe: nadie
    // mandará la cancelación, y aun así deja de sonar.
    const falta = Math.max(0, new Date(t.expiresAt).getTime() - Date.now());
    relojEntrante = setTimeout(() => {
      set((s) => (s.entrante?.ringId === t.ringId ? { entrante: null } : s));
    }, falta);
  },

  alColgarTimbre: (de) => {
    set((s) => {
      const cambios: Partial<VoiceState> = {};
      // Colgó quien te llamaba.
      if (s.entrante?.from.id === de) {
        pararReloj("entrante");
        cambios.entrante = null;
      }
      // O al revés: a quien tú llamabas dijo que no, y su rechazo vuelve por
      // el mismo camino que una cancelación. Se queda «no contestó» en vez de
      // desaparecer, porque una fila que se esfuma sola no dice si te
      // rechazaron o si el botón nunca llegó a hacer nada.
      if (s.llamando?.identity === de) {
        pararReloj("saliente");
        cambios.llamando = { ...s.llamando, sinRespuesta: true };
      }
      return cambios;
    });
  },

  aceptarEntrante: async () => {
    const t = get().entrante;
    if (!t) return;
    pararReloj("entrante");
    set({ entrante: null });
    await get().entrar(t.spaceId);
  },

  rechazarEntrante: async () => {
    const t = get().entrante;
    if (!t) return;
    pararReloj("entrante");
    set({ entrante: null });
    // Decir que no en vez de dejar que expire: quien llamaba se entera ahora y
    // no dentro de veinte segundos. Va por el mismo endpoint —«deja de sonar
    // entre tú y yo»— y llega como una cancelación con tu id.
    await api
      .delete(`/api/v1/task-spaces/${t.spaceId}/voice/ring/${t.from.id}`, true)
      .catch(() => {});
  },

  /**
   * Encender o apagar tu cámara.
   *
   * **No es optimista, al revés que el micrófono.** Silenciarse no puede
   * fallar —el motor ya tiene el micro abierto— pero la cámara sí: puede no
   * haber ninguna, puede estar cogida por otro programa, y en macOS puede
   * faltar el permiso. Pintar el botón encendido y que no salga imagen deja a
   * alguien saludando a nadie.
   *
   * Y si falla, **se queda como estaba**, que no es lo mismo que apagarse. Si
   * lo que falló fue apagarla, la cámara probablemente sigue publicando:
   * pintarla apagada te diría que nadie te ve mientras te siguen viendo, que
   * es el peor de los dos errores posibles. El mismo criterio que el micro.
   */
  alternarCam: async () => {
    const siguiente = !get().cam;
    try {
      await invoke("voice_set_camera", { enabled: siguiente });
      set({ cam: siguiente, error: null });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },

  alRecibir: (ev) => {
    switch (ev.kind) {
      case "connected":
        set({ yo: ev.identity, estado: "dentro" });
        break;
      case "joined":
        set((s) =>
          s.gente.some((p) => p.identity === ev.identity)
            ? s
            : { gente: [...s.gente, { identity: ev.identity, name: ev.name }] },
        );
        break;
      case "left":
        set((s) => {
          // Fuera del mapa de mudos también: dejar la entrada haría que quien
          // se fue mudo y vuelve abierto apareciera silenciado hasta que se le
          // ocurriera tocar el botón.
          const mudos = { ...s.mudos };
          delete mudos[ev.identity];
          const video = { ...s.video };
          delete video[ev.identity];
          return {
            video,
            gente: s.gente.filter((p) => p.identity !== ev.identity),
            // Y fuera de los que hablan: sin esto, quien se va mientras habla
            // deja su punto encendido para siempre.
            hablando: s.hablando.filter((id) => id !== ev.identity),
            mudos,
          };
        });
        break;
      case "muted":
        set((s) => ({ mudos: { ...s.mudos, [ev.identity]: ev.muted } }));
        break;
      case "latency":
        set({ latencia: ev.ms });
        break;
      case "video":
        set((s) => ({ video: { ...s.video, [ev.identity]: ev.enabled } }));
        break;
      case "speaking":
        // La lista entera, no un delta: reconstruirla a base de altas y bajas
        // es cómo se acaba con un indicador encendido por un evento perdido.
        set({ hablando: ev.identities });
        break;
      case "disconnected":
        set({ ...VACIO, error: ev.reason === "Unknown" ? null : ev.reason });
        break;
    }
  },
}));
