import { create } from "zustand";

import { api, apiUrl, codigoDe } from "@/lib/api";
import { useAuthStore } from "@/store/auth.store";
import type { APIResponse } from "@/types/auth";

/**
 * Las grabaciones de un canal: empezarlas, pararlas y verlas.
 *
 * Lo que hay que entender de este modelo: **el botón no enciende el chip REC**.
 * Lo enciende el motor de voz cuando el SFU dice que el metadata de la sala
 * cambió (`voice.store`, `kind: "recording"`). Por eso `empezar` y `parar` no
 * son optimistas: el botón gira hasta que la señal da la vuelta entera.
 *
 * La alternativa —pintar el chip al pulsar— parece más ágil y miente: si el
 * servidor rechaza, o si otro empezó primero, la pantalla de quien pulsó diría
 * que se está grabando y las demás dirían que no. Un aviso de grabación en el
 * que no se puede confiar es peor que ninguno.
 */

export type RecordingStatus = "recording" | "finalizing" | "ready" | "partial" | "failed";

export interface RecordingTrack {
  id: string;
  trackSid: string;
  participantIdentity: string;
  source: string;
  status: string;
  startedAt?: string;
  endedAt?: string;
  bytes?: number;
}

export interface Recording {
  id: string;
  orgId: string;
  spaceId: string;
  startedBy: string;
  startedByName?: string;
  status: RecordingStatus;
  startedAt: string;
  endedAt?: string;
  /** `video/mp4` o `audio/mp4` — decide si se pinta `<video>` o `<audio>`. */
  finalContentType?: string;
  finalBytes?: number;
  durationMs?: number;
  hasScreen: boolean;
  error?: string;
  tracks?: RecordingTrack[];
}

/**
 * Lo que la app pregunta antes de pintar el botón.
 *
 * `enabled: false` lo esconde entero. Una instalación sin grabación montada no
 * debe enseñar un botón que siempre falla — y distinguir «no está montado» de
 * «se cayó» es precisamente lo que este endpoint evita tener que hacer en la
 * pantalla.
 */
export interface RecordingPolicy {
  enabled: boolean;
  active: Recording | null;
}

interface RecordingsState {
  /** Por espacio: la política, para saber si el botón existe. */
  policy: Record<string, RecordingPolicy>;
  /** Por espacio: lo ya grabado. */
  lista: Record<string, Recording[]>;
  /** El espacio cuya petición está en vuelo, para que el botón gire. */
  enVuelo: string | null;
  cargando: Record<string, boolean>;
  error: string | null;

  cargarPolitica: (spaceId: string) => Promise<void>;
  empezar: (spaceId: string) => Promise<boolean>;
  parar: (recordingId: string) => Promise<void>;
  cargar: (spaceId: string) => Promise<void>;
  borrar: (recordingId: string, spaceId: string) => Promise<boolean>;
  /** Un `call:status` del SSE: refresca sin volver a pedir la lista entera. */
  alCambiarEstado: (spaceId: string, recording: Recording | null) => void;
  limpiarError: () => void;
}

export const useRecordings = create<RecordingsState>((set, get) => ({
  policy: {},
  lista: {},
  enVuelo: null,
  cargando: {},
  error: null,

  cargarPolitica: async (spaceId) => {
    try {
      const r = await api.get<APIResponse<RecordingPolicy>>(
        `/api/v1/task-spaces/${spaceId}/recordings/policy`,
        true,
      );
      if (r.success && r.data) {
        set((s) => ({ policy: { ...s.policy, [spaceId]: r.data as RecordingPolicy } }));
      }
    } catch {
      // Un fallo aquí esconde el botón, que es lo mismo que hace `enabled:
      // false`. No hay nada que decirle a nadie: no se pidió nada.
      set((s) => ({ policy: { ...s.policy, [spaceId]: { enabled: false, active: null } } }));
    }
  },

  empezar: async (spaceId) => {
    set({ enVuelo: spaceId, error: null });
    try {
      await api.post<APIResponse<Recording>>(
        `/api/v1/task-spaces/${spaceId}/recordings`,
        {},
        true,
      );
      // **No se pinta nada aquí.** El chip lo enciende el motor cuando llega
      // el metadata de la sala; lo que sí se refresca es la política, que es
      // de donde sale «ya hay una activa» para quien no está en la llamada.
      await get().cargarPolitica(spaceId);
      return true;
    } catch (e) {
      set({ error: codigoDe(e) });
      // «Ya se está grabando» no es un fallo que merezca una pantalla roja:
      // alguien pulsó primero. Se relee la política y el chip aparece solo.
      if (codigoDe(e) === "already-recording") await get().cargarPolitica(spaceId);
      return false;
    } finally {
      set({ enVuelo: null });
    }
  },

  parar: async (recordingId) => {
    set({ enVuelo: recordingId, error: null });
    try {
      await api.post<APIResponse<Recording>>(`/api/v1/recordings/${recordingId}/stop`, {}, true);
    } catch (e) {
      set({ error: codigoDe(e) });
    } finally {
      set({ enVuelo: null });
    }
  },

  cargar: async (spaceId) => {
    set((s) => ({ cargando: { ...s.cargando, [spaceId]: true } }));
    try {
      const r = await api.get<APIResponse<Recording[]>>(
        `/api/v1/task-spaces/${spaceId}/recordings`,
        true,
      );
      set((s) => ({ lista: { ...s.lista, [spaceId]: r.data ?? [] } }));
    } catch (e) {
      set({ error: codigoDe(e) });
    } finally {
      set((s) => ({ cargando: { ...s.cargando, [spaceId]: false } }));
    }
  },

  borrar: async (recordingId, spaceId) => {
    try {
      await api.delete<APIResponse<null>>(`/api/v1/recordings/${recordingId}`);
      set((s) => ({
        lista: {
          ...s.lista,
          [spaceId]: (s.lista[spaceId] ?? []).filter((r) => r.id !== recordingId),
        },
      }));
      return true;
    } catch (e) {
      // La fila **no se quita** si el borrado falló: el servidor no borra la
      // grabación cuando no consigue borrar sus ficheros, así que quitarla de
      // la pantalla diría que ya no está cuando sigue ahí.
      set({ error: codigoDe(e) });
      return false;
    }
  },

  alCambiarEstado: (spaceId, recording) => {
    set((s) => {
      const politica = s.policy[spaceId];
      const lista = s.lista[spaceId];
      return {
        // La política, para el botón.
        policy: politica ? { ...s.policy, [spaceId]: { ...politica, active: recording } } : s.policy,
        // Y la fila de la lista, si esa pantalla ya la tenía cargada: es lo que
        // hace que «procesando…» pase a verse solo, sin que nadie recargue.
        lista:
          lista && recording
            ? {
                ...s.lista,
                [spaceId]: lista.some((r) => r.id === recording.id)
                  ? lista.map((r) => (r.id === recording.id ? { ...r, ...recording } : r))
                  : [recording, ...lista],
              }
            : s.lista,
      };
    });
  },

  limpiarError: () => set({ error: null }),
}));

/**
 * La URL del fichero, para un `<video>` o un `<audio>`.
 *
 * **Siempre por el proxy de cac, nunca por el bucket.** Una URL firmada de S3
 * que se escapa de una pantalla sigue valiendo hasta que caduca, y esto es una
 * reunión entera; el proxy pide credencial en cada petición y se puede cortar.
 *
 * El token va en la consulta porque un `<video src>` de un webview **no puede
 * mandar cabeceras** — es el mismo camino que los adjuntos del chat.
 */
export function urlDelMedia(recordingId: string): string {
  const token = useAuthStore.getState().accessToken ?? "";
  return apiUrl(`/api/v1/recordings/${recordingId}/media?token=${encodeURIComponent(token)}`);
}
