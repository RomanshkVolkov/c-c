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
  | { kind: "disconnected"; reason: string };

export interface VoicePeer {
  identity: string;
  name: string;
}

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
  yo: string | null;
  mic: boolean;
  /** Sordera: ni oyes ni te oyen. */
  sordo: boolean;
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
  /** Refresca quién anda por los canales. La pantalla decide cada cuánto. */
  refrescarOcupacion: (orgId?: string | null) => Promise<void>;
  /** Lo que reporta el motor. Público para poder probarlo sin Tauri. */
  alRecibir: (ev: VoiceEvent) => void;
}

const VACIO = {
  spaceId: null,
  estado: "fuera" as const,
  escenario: false,
  gente: [],
  hablando: [],
  mudos: {},
  latencia: null,
  yo: null,
  mic: true,
  sordo: false,
  error: null,
};

export const useVoice = create<VoiceState>((set, get) => ({
  ...VACIO,
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
          return {
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
