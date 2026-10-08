import { create } from "zustand";

import { api, apiUrl, codigoDe } from "@/lib/api";
import type { APIResponse } from "@/types/auth";

/**
 * Las grabaciones de un canal: empezarlas, pararlas y verlas.
 *
 * Lo que hay que entender de este modelo: **el botón no enciende el chip REC**.
 * Lo enciende el motor de voz cuando el SFU dice que el metadata de la sala
 * cambió (`voice.store`, `kind: "recording"`). Por eso `start` y `stop` no
 * son optimistas: el botón gira hasta que la señal da la vuelta entera.
 *
 * La alternativa —pintar el chip al pulsar— parece más ágil y miente: si el
 * servidor rechaza, o si otro empezó primero, la pantalla de quien pulsó diría
 * que se está recording y las demás dirían que no. Un aviso de grabación en el
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
  /** Por qué no se puede aquí: hoy, `recording-needs-space`. */
  reason?: string;
}

/**
 * De qué sala son la política y el botón: el id de un canal, o `meet:<id>` para
 * una reunión con invitados (W3). Un canal y una reunión que cuelga de él son
 * dos salas y se graban por separado; con el id del canal solo, la reunión
 * vería el REC del canal como suyo.
 */
export const meetScope = (inviteId: string) => `meet:${inviteId}`;

function recordingsPath(scope: string): string {
  return scope.startsWith("meet:")
    ? `/api/v1/call-invites/${scope.slice("meet:".length)}/recordings`
    : `/api/v1/task-spaces/${scope}/recordings`;
}

interface RecordingsState {
  /** Por sala (ver `meetScope`): la política, para saber si el botón existe. */
  policy: Record<string, RecordingPolicy>;
  /** Por espacio: lo ya grabado. */
  bySpace: Record<string, Recording[]>;
  /** El espacio cuya petición está en vuelo, para que el botón gire. */
  inFlight: string | null;
  loading: Record<string, boolean>;
  error: string | null;

  loadPolicy: (scope: string) => Promise<void>;
  start: (scope: string) => Promise<boolean>;
  stop: (recordingId: string) => Promise<void>;
  load: (spaceId: string) => Promise<void>;
  remove: (recordingId: string, spaceId: string) => Promise<boolean>;
  /**
   * Un `call:status` del SSE: refresca sin volver a pedir la bySpace entera.
   * `spaceId` es el canal donde se lista, que en una reunión no es la sala.
   */
  onStatus: (scope: string, recording: Recording | null, spaceId?: string) => void;
  clearError: () => void;
}

export const useRecordings = create<RecordingsState>((set, get) => ({
  policy: {},
  bySpace: {},
  inFlight: null,
  loading: {},
  error: null,

  loadPolicy: async (scope) => {
    try {
      const r = await api.get<APIResponse<RecordingPolicy>>(`${recordingsPath(scope)}/policy`, true);
      if (r.success && r.data) {
        set((s) => ({ policy: { ...s.policy, [scope]: r.data as RecordingPolicy } }));
      }
    } catch {
      // Un fallo aquí esconde el botón, que es lo mismo que hace `enabled:
      // false`. No hay nada que decirle a nadie: no se pidió nada.
      set((s) => ({ policy: { ...s.policy, [scope]: { enabled: false, active: null } } }));
    }
  },

  start: async (scope) => {
    set({ inFlight: scope, error: null });
    try {
      await api.post<APIResponse<Recording>>(recordingsPath(scope), {}, true);
      // **No se pinta nada aquí.** El chip lo enciende el motor cuando llega
      // el metadata de la sala; lo que sí se refresca es la política, que es
      // de donde sale «ya hay una activa» para quien no está en la llamada.
      await get().loadPolicy(scope);
      return true;
    } catch (e) {
      set({ error: codigoDe(e) });
      // «Ya se está recording» no es un fallo que merezca una pantalla roja:
      // alguien pulsó primero. Se relee la política y el chip aparece solo.
      if (codigoDe(e) === "already-recording") await get().loadPolicy(scope);
      return false;
    } finally {
      set({ inFlight: null });
    }
  },

  stop: async (recordingId) => {
    set({ inFlight: recordingId, error: null });
    try {
      await api.post<APIResponse<Recording>>(`/api/v1/recordings/${recordingId}/stop`, {}, true);
    } catch (e) {
      set({ error: codigoDe(e) });
    } finally {
      set({ inFlight: null });
    }
  },

  load: async (spaceId) => {
    set((s) => ({ loading: { ...s.loading, [spaceId]: true } }));
    try {
      const r = await api.get<APIResponse<Recording[]>>(
        `/api/v1/task-spaces/${spaceId}/recordings`,
        true,
      );
      set((s) => ({ bySpace: { ...s.bySpace, [spaceId]: r.data ?? [] } }));
    } catch (e) {
      set({ error: codigoDe(e) });
    } finally {
      set((s) => ({ loading: { ...s.loading, [spaceId]: false } }));
    }
  },

  remove: async (recordingId, spaceId) => {
    try {
      await api.delete<APIResponse<null>>(`/api/v1/recordings/${recordingId}`);
      set((s) => ({
        bySpace: {
          ...s.bySpace,
          [spaceId]: (s.bySpace[spaceId] ?? []).filter((r) => r.id !== recordingId),
        },
      }));
      return true;
    } catch (e) {
      // La fila **no se quita** si el borrado falló: el servidor no borra la
      // grabación cuando no consigue remove sus ficheros, así que quitarla de
      // la pantalla diría que ya no está cuando sigue ahí.
      set({ error: codigoDe(e) });
      return false;
    }
  },

  onStatus: (scope, recording, listSpaceId) => {
    const spaceId = listSpaceId ?? scope;
    set((s) => {
      const politica = s.policy[scope];
      const bySpace = s.bySpace[spaceId];
      return {
        // La política, para el botón.
        policy: politica ? { ...s.policy, [scope]: { ...politica, active: recording } } : s.policy,
        // Y la fila de la bySpace, si esa pantalla ya la tenía cargada: es lo que
        // hace que «procesando…» pase a verse solo, sin que nadie recargue.
        bySpace:
          bySpace && recording
            ? {
                ...s.bySpace,
                [spaceId]: bySpace.some((r) => r.id === recording.id)
                  ? bySpace.map((r) => (r.id === recording.id ? { ...r, ...recording } : r))
                  : [recording, ...bySpace],
              }
            : s.bySpace,
      };
    });
  },

  clearError: () => set({ error: null }),
}));

/**
 * La URL del fichero, para un `<video>` o un `<audio>`.
 *
 * **Siempre por el proxy de cac, nunca por el bucket.** Una URL firmada de S3
 * que se escapa de una pantalla sigue valiendo hasta que caduca, y esto es una
 * reunión entera; el proxy pide credencial en cada petición y se puede cortar.
 *
 * La credencial va en la consulta porque un `<video src>` de un webview **no
 * puede mandar cabeceras**, y por eso es un pase de adjuntos y no el token de
 * acceso: una URL acaba en los logs (ver lib/url-ticket.ts). También en el
 * escritorio: este `<video>` no pasa por el esquema propio de Rust.
 */
export function mediaUrl(recordingId: string, ticket: string): string {
  return apiUrl(`/api/v1/recordings/${recordingId}/media?token=${encodeURIComponent(ticket)}`);
}
