import { create } from "zustand";
import { api } from "@/lib/api";
import type { APIResponse } from "@/types/auth";

/**
 * What happened while you were away.
 *
 * Distinct from `notifications.store`, which is a delivery log: that one
 * answers "did the OS notification fire, and if not why", and only ever knows
 * about the session it lived in. This one is the server's record, so the badge
 * can finally mean "since you last read it" instead of "since you last launched
 * the app" — which is the complaint this whole feature exists to fix.
 */

export interface InboxItem {
  id: string;
  orgId: string;
  kind: string;
  title: string;
  body: string;
  link: string;
  readAt?: string | null;
  createdAt: string;
  /**
   * Quién lo causó: vacío la app, `"mcp"` un agente.
   *
   * Ausente en todo lo anterior a esta columna, y está bien: aquello no lo
   * escribió ningún agente. Lo declara el cliente que hizo la petición, así que
   * dice de dónde vino, no quién tenía permiso.
   */
  via?: string;
  /**
   * De qué conversación es, para plegarla con las suyas. Lo manda el servidor;
   * ver `lib/notification-groups.ts`.
   *
   * Ausente en las filas anteriores a esta columna **y en las que el servidor no
   * supo agrupar** —un recordatorio de reunión de antes, por ejemplo—. Sin ella
   * la fila se pinta suelta, que es como estaba todo antes de plegar nada.
   */
  groupKey?: string;
  /** Cómo se llama esa conversación: «#portento», «Ana», el título de la tarea. */
  groupLabel?: string;
}

/**
 * Cuántos avisos hay de una conversación, contados sobre **toda** la bandeja.
 *
 * El feed trae una página de 50 y no pagina, así que contar los miembros que
 * llegaron diría «#portento (50)» habiendo trescientos guardados.
 */
export interface GroupTally {
  key: string;
  label: string;
  total: number;
  unread: number;
}

export interface InboxPrefs {
  mentions: boolean;
  dms: boolean;
  comments: boolean;
  reports: boolean;
  /**
   * Invertido, y es el único: apaga los avisos de tu propio trabajo.
   *
   * Al derecho habría llegado en `false` para todo el que ya tuviera
   * preferencias guardadas —una columna nueva nace en el cero de su tipo—, es
   * decir apagado justo para quien más lo usa. Así el cero significa «no lo he
   * apagado», que es lo que se quiere decir.
   */
  workQuiet?: boolean;
  /** Lo corriente de los canales que sigues. Sólo llega de ahí. */
  messages: boolean;
  /**
   * Invertido como `workQuiet`, y por lo mismo: apaga los recordatorios de
   * reuniones periódicas.
   *
   * Existe porque una reunión suena **y vuelve a sonar cada semana**. Un aviso
   * suelto que no interesa se ignora una vez; uno recurrente que no se puede
   * callar acaba con la campana entera silenciada.
   */
  meetingsQuiet?: boolean;
}

interface InboxState {
  items: InboxItem[];
  unread: number;
  /** Recuento por conversación sobre toda la bandeja, no sobre la página. */
  groups: GroupTally[];
  loading: boolean;
  orgId: string | null;

  load: (orgId: string | null) => Promise<void>;
  markRead: (ids: string[]) => Promise<void>;
  /**
   * Toda una conversación de una vez, **por clave y no por ids**.
   *
   * Los ids que tiene el cliente son los que cupieron en la página: con un grupo
   * de cuarenta y siete y una página de doce, marcar por ids dejaría la fila
   * diciendo cero y el badge en treinta y cinco. Quien sabe cuántas hay es el
   * servidor.
   */
  markReadGroup: (key: string) => Promise<void>;
  markAllRead: () => Promise<void>;
  prefs: InboxPrefs | null;
  loadPrefs: () => Promise<void>;
  savePrefs: (p: InboxPrefs) => Promise<void>;
}

export const useInboxStore = create<InboxState>((set, get) => ({
  items: [],
  unread: 0,
  groups: [],
  loading: false,
  orgId: null,

  load: async (orgId) => {
    set({ loading: true, orgId });
    try {
      const q = orgId ? `?orgId=${orgId}&limit=50` : "?limit=50";
      const res = await api.get<
        APIResponse<{ items: InboxItem[]; unread: number; groups?: GroupTally[] }>
      >(`/api/v1/notifications/${q}`, true);
      set({
        items: res.data?.items ?? [],
        unread: res.data?.unread ?? 0,
        groups: res.data?.groups ?? [],
        loading: false,
      });
    } catch {
      // Silent: an inbox that failed to load is a badge that doesn't update,
      // not something to interrupt somebody with.
      set({ loading: false });
    }
  },

  markRead: async (ids) => {
    if (ids.length === 0) return;
    // Optimistic, because reading is the one action nobody wants to wait for.
    // The count is recomputed from the rows rather than decremented, so a
    // double click can't drive it below zero.
    set((s) => {
      const items = s.items.map((i) => (ids.includes(i.id) ? { ...i, readAt: "now" } : i));
      return { items, unread: Math.max(0, s.unread - ids.filter((id) =>
        s.items.some((i) => i.id === id && !i.readAt)).length) };
    });
    await api.post<APIResponse<unknown>>("/api/v1/notifications/read", { ids }, true);
  },

  markReadGroup: async (key) => {
    if (!key) return;
    // Optimista igual que `markRead`, y con la misma aritmética no negativa:
    // se limpian **todas** las de esa conversación que hubiera cargadas, y el
    // contador baja por las que estaban sin leer.
    set((s) => {
      const suyas = s.items.filter((i) => i.groupKey === key && !i.readAt);
      return {
        items: s.items.map((i) => (i.groupKey === key ? { ...i, readAt: i.readAt ?? "now" } : i)),
        // El tally es del servidor y sabe cuántas hay de verdad; si está, manda.
        unread: Math.max(
          0,
          s.unread - (s.groups.find((g) => g.key === key)?.unread ?? suyas.length),
        ),
        groups: s.groups.map((g) => (g.key === key ? { ...g, unread: 0 } : g)),
      };
    });
    await api.post<APIResponse<unknown>>(
      "/api/v1/notifications/read",
      { group: key, orgId: get().orgId ?? "" },
      true,
    );
  },

  prefs: null,

  loadPrefs: async () => {
    try {
      const res = await api.get<APIResponse<InboxPrefs>>("/api/v1/notifications/preferences", true);
      if (res.data) set({ prefs: res.data });
    } catch {
      // Silent: not knowing your preferences is a dialog that opens with the
      // defaults, not something to interrupt anybody about.
    }
  },

  savePrefs: async (p) => {
    // Optimistic, and the server's answer wins: it forces mentions back on, so
    // taking its reply is how the dialog stops claiming something untrue.
    set({ prefs: p });
    const res = await api.patch<APIResponse<InboxPrefs>>(
      "/api/v1/notifications/preferences",
      p,
      true,
    );
    if (res.data) set({ prefs: res.data });
  },

  markAllRead: async () => {
    const orgId = get().orgId;
    set((s) => ({ items: s.items.map((i) => ({ ...i, readAt: i.readAt ?? "now" })), unread: 0 }));
    const q = orgId ? `?orgId=${orgId}` : "";
    await api.post<APIResponse<unknown>>(`/api/v1/notifications/read-all${q}`, {}, true);
  },
}));
