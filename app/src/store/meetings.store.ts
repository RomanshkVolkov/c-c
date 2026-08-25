import { create } from "zustand";

import { api } from "@/lib/api";
import type { APIResponse } from "@/types/auth";

/**
 * Las reuniones periódicas de una organización.
 *
 * Lo que hay que entender de este modelo: **la hora no es un instante**. Se
 * guarda «09:00» y la zona en la que esas nueve significan algo, porque «todos
 * los lunes a las nueve» es una hora de pared y no un momento fijo del
 * calendario universal — el día que cambie el horario de verano, un instante
 * fijo se le movería una hora a alguien.
 *
 * `nextFireAt` sí es un instante: es el próximo, ya calculado por el servidor
 * en la zona de la reunión. Se pinta, no se calcula aquí.
 */
export interface Meeting {
  id: string;
  orgId: string;
  title: string;
  /** "09:00" — hora de pared, en `timezone`. */
  wallTime: string;
  /** Zona IANA, p. ej. "America/Mexico_City". */
  timezone: string;
  freq: "daily" | "weekly" | "monthly";
  interval: number;
  /** Números de día de la semana separados por coma: "1,3,5". Sólo semanal. */
  weekdays?: string;
  /** 1..31, sólo mensual; el servidor lo recorta al último día del mes. */
  monthDay?: number;
  /** Fecha local "2006-01-02" que ancla el ciclo cuando el intervalo es > 1. */
  anchor?: string;
  /** La sala a la que lleva el aviso, si tiene. */
  spaceId?: string;
  spaceName?: string;
  nextFireAt: string;
  lastFiredAt?: string;
  paused: boolean;
  /** A quién **no** le llega. Todos los demás están convocados. */
  excludedUserIds: string[];
}

export interface MeetingDraft {
  title: string;
  wallTime: string;
  timezone: string;
  freq: Meeting["freq"];
  interval?: number;
  weekdays?: string;
  monthDay?: number;
  anchor?: string;
  spaceId?: string;
}

/**
 * El aviso que acaba de sonar.
 *
 * Lo manda el servidor por el mismo canal que el timbre de una llamada, con la
 * sala ya resuelta por nombre para que la tarjeta se pinte sin ir a buscar
 * nada, y con la hora a la que caduca.
 */
export interface ReunionEntrante {
  meetingId: string;
  title: string;
  spaceId?: string;
  spaceName?: string;
  wallTime: string;
  timezone: string;
  firesAt: string;
  expiresAt: string;
}

/**
 * Una vez concreta de una reunión, para el calendario.
 *
 * Las expande **el servidor**. Hacerlo aquí obligaría a reescribir la regla de
 * repetición en TypeScript —con sus dos cambios de hora al año— y dos
 * implementaciones acaban discrepando: el calendario diría martes y el timbre
 * sonaría el miércoles, sin forma de saber cuál miente.
 */
export interface MeetingOccurrence {
  meetingId: string;
  title: string;
  spaceId?: string;
  spaceName?: string;
  timezone: string;
  paused: boolean;
  at: string;
}

interface MeetingsState {
  meetings: Meeting[];
  /** Las ocurrencias de la ventana que se está pintando. */
  agenda: MeetingOccurrence[];
  fetchAgenda: (orgId: string, days?: number) => Promise<void>;
  loading: boolean;
  /** La reunión que está sonando ahora mismo, si hay alguna. */
  entrante: ReunionEntrante | null;
  alSonar: (t: ReunionEntrante) => void;
  descartar: () => void;
  fetch: (orgId: string) => Promise<void>;
  create: (orgId: string, draft: MeetingDraft) => Promise<void>;
  update: (id: string, orgId: string, patch: Partial<MeetingDraft> & { paused?: boolean }) => Promise<void>;
  remove: (id: string, orgId: string) => Promise<void>;
  /** Reemplaza la lista de excluidos: quién no recibe el aviso. */
  setExcluded: (id: string, orgId: string, userIds: string[]) => Promise<void>;
}

/** El reloj que apaga la tarjeta sola. Uno, y se reemplaza. */
let relojEntrante: ReturnType<typeof setTimeout> | null = null;

export const useMeetingsStore = create<MeetingsState>((set, get) => ({
  meetings: [],
  agenda: [],
  loading: false,
  entrante: null,

  fetchAgenda: async (orgId, days = 60) => {
    const res = await api.get<APIResponse<MeetingOccurrence[]>>(
      `/api/v1/organizations/${orgId}/meetings/agenda?days=${days}`,
    );
    set({ agenda: res.data ?? [] });
  },

  alSonar: (t) => {
    if (relojEntrante) clearTimeout(relojEntrante);
    set({ entrante: t });
    // Se apaga sola a la hora que dijo el servidor, como el timbre de una
    // llamada. Sin esto, una reunión a la que nadie hace caso deja la tarjeta
    // tapando la pantalla hasta que alguien la cierre — y quien no estaba
    // delante vuelve a un ordenador bloqueado por un aviso de hace una hora.
    const falta = Math.max(0, new Date(t.expiresAt).getTime() - Date.now());
    relojEntrante = setTimeout(() => {
      // Comprobar de quién es el reloj antes de apagar nada.
      //
      // Hoy es cinturón sobre tirantes: el `clearTimeout` de arriba ya cancela
      // el anterior, así que a este punto sólo llega el reloj de la reunión que
      // se está viendo — no hay forma de provocar lo contrario desde fuera, y
      // un mutante que quite esta comprobación sobrevive. Se queda porque es lo
      // que hace `voice.store` con el timbre de las llamadas, y porque el día
      // que alguien añada otra vía para poner `entrante` esto es lo que impide
      // que un reloj viejo apague un aviso nuevo.
      set((s) => (s.entrante?.meetingId === t.meetingId ? { entrante: null } : s));
    }, falta);
  },

  descartar: () => {
    if (relojEntrante) clearTimeout(relojEntrante);
    set({ entrante: null });
  },

  fetch: async (orgId) => {
    set({ loading: true });
    try {
      const res = await api.get<APIResponse<Meeting[]>>(
        `/api/v1/organizations/${orgId}/meetings/`,
      );
      set({ meetings: res.data ?? [] });
    } finally {
      set({ loading: false });
    }
  },

  create: async (orgId, draft) => {
    await api.post<APIResponse<unknown>>(`/api/v1/organizations/${orgId}/meetings/`, draft, true);
    await get().fetch(orgId);
  },

  // Sólo lo que cambió: el servidor deja como está lo que no se menciona, así
  // que cambiarle el título a una reunión no puede moverle la hora.
  update: async (id, orgId, patch) => {
    await api.patch<APIResponse<unknown>>(`/api/v1/meetings/${id}/`, patch, true);
    await get().fetch(orgId);
  },

  remove: async (id, orgId) => {
    await api.delete<APIResponse<unknown>>(`/api/v1/meetings/${id}/`);
    await get().fetch(orgId);
  },

  setExcluded: async (id, orgId, userIds) => {
    await api.put<APIResponse<unknown>>(`/api/v1/meetings/${id}/recipients`, {
      excludedUserIds: userIds,
    });
    await get().fetch(orgId);
  },
}));
