import { create } from "zustand";
import { persist } from "zustand/middleware";
import { api } from "@/lib/api";
import type { APIResponse } from "@/types/auth";
import type { OpenTask } from "@/types/task";

/**
 * "My work": everything open across every space, asked one question at a time.
 *
 * Until now the only cross-list view was the dashboard's eight-line summary,
 * and anything more meant opening lists one by one and remembering. The four
 * lenses are the questions people actually ask — what is mine, what did I
 * raise, what am I keeping an eye on, and what came from a client — and each is
 * a server-side filter rather than a slice of a big download, because "all the
 * open work in the organization" is not something a client should be holding.
 */

export type WorkLens = "assigned" | "created" | "watching" | "clients" | "all";

/**
 * What the tree has narrowed this view to, if anything.
 *
 * Picking a list used to take you to its board — a different screen with a
 * different question on it. Narrowing instead keeps the question you were
 * asking ("what is mine", "what am I following") and just points it somewhere
 * smaller, which is what makes the tree a filter rather than a menu.
 */
export interface WorkScope {
  kind: "space" | "list";
  id: string;
  name: string;
}

/**
 * The query each lens asks. Kept here so the page never builds URLs.
 *
 * Todas mandan `origin=any` menos la de clientes. El servidor, si no le dicen
 * nada, deja fuera lo que entró por un canal de cliente —tiene sentido para el
 * resumen del escritorio, que es de dónde viene ese comportamiento— pero aquí
 * mentía dos veces: una lista de cliente con siete tareas abiertas salía como
 * «0 visible» bajo una lente llamada **All**, y «asignadas a mí» se callaba un
 * ticket asignado a mí sólo porque lo levantó un cliente. Quién lo levantó es
 * otra pregunta, y tiene su propia lente.
 */
const LENS_QUERY: Record<WorkLens, string> = {
  assigned: "assignee=me&origin=any",
  created: "creator=me&origin=any",
  watching: "watcher=me&origin=any",
  clients: "origin=clients",
  all: "origin=any",
};

interface MyWorkState {
  lens: WorkLens;
  scope: WorkScope | null;
  /**
   * La organización de la que son las tareas que hay cargadas.
   *
   * Sólo para saber **cuándo cambia**. No se persiste: al arrancar no hay nada
   * cargado, así que la primera carga siempre es un cambio.
   */
  loadedOrgId: string | null;
  includeClosed: boolean;
  tasks: OpenTask[];
  loading: boolean;
  error: string | null;

  setLens: (lens: WorkLens) => void;
  setScope: (scope: WorkScope | null) => void;
  setIncludeClosed: (on: boolean) => void;
  load: (orgId: string | null) => Promise<void>;
  /** Follow or unfollow, and drop the row when it leaves the lens you're in. */
  setWatching: (taskId: string, on: boolean) => Promise<void>;
  /**
   * Esa tarea ya no existe: quítala de aquí.
   *
   * Sin esto, borrar desde «My work» dejaba la tarjeta en pantalla —esta lista
   * la sirve su propio endpoint, y refrescar el tablero no la toca— así que
   * seguía pulsable y lo único que decía que había desaparecido era un «not
   * found» al abrirla. Quien lo veía volvía a borrar, y en una lista de tareas
   * parecidas el segundo intento se lleva la equivocada.
   *
   * Local y no una recarga: la fila ya no puede estar, y pedir la lista entera
   * para quitar una que sabemos que se fue es más lento y puede fallar.
   */
  olvidar: (taskId: string) => void;
}

export const useMyWorkStore = create<MyWorkState>()(
  persist(
    (set, get) => ({
      lens: "assigned",
      scope: null,
      loadedOrgId: null,
      includeClosed: false,
      tasks: [],
      loading: false,
      error: null,

      setLens: (lens) => set({ lens }),
      setScope: (scope) => set({ scope }),
      setIncludeClosed: (includeClosed) => set({ includeClosed }),

      load: async (orgId) => {
        // Cambiar de organización tira el filtro de lista o espacio.
        //
        // Una lista es de una organización concreta, así que al cambiar se
        // quedaba filtrando por algo que ahí no existe: la pantalla salía vacía
        // y parecía que no tenías trabajo, no que había un filtro puesto. Y el
        // rótulo del filtro decía el nombre de una lista de la organización
        // anterior, que es peor todavía.
        //
        // Sólo cuando **cambia**, y no en cada carga: `load` corre también al
        // cambiar de lente o al pedir los estados cerrados, y ahí tirar el
        // filtro sería quitarle a alguien algo que acaba de poner.
        if (orgId !== get().loadedOrgId) {
          set({ scope: null, loadedOrgId: orgId });
        }
        set({ loading: true, error: null });
        try {
          const partes = [
            orgId ? `orgId=${orgId}` : "",
            LENS_QUERY[get().lens],
            get().includeClosed ? "status=all" : "",
            "limit=200",
          ].filter(Boolean);
          const res = await api.get<APIResponse<OpenTask[]>>(
            `/api/v1/tasks/?${partes.join("&")}`,
            true,
          );
          set({ tasks: res.data ?? [], loading: false });
        } catch (e) {
          set({ error: String(e), loading: false, tasks: [] });
        }
      },

      olvidar: (taskId) =>
        set((s) => ({ tasks: s.tasks.filter((t) => t.id !== taskId) })),

      setWatching: async (taskId, on) => {
        const path = `/api/v1/tasks/${taskId}/watch`;
        if (on) await api.post<APIResponse<unknown>>(path, {}, true);
        else await api.delete<APIResponse<unknown>>(path, true);
        // Unfollowing from the "watching" lens should take the row away: it no
        // longer answers the question the screen is asking.
        if (!on && get().lens === "watching") {
          set((s) => ({ tasks: s.tasks.filter((t) => t.id !== taskId) }));
        }
      },
    }),
    {
      name: "cac-mywork",
      // Only the lens and the toggle: the work itself is asked for fresh, since
      // a stale list of what is pending is worse than a moment with none.
      // The scope is not kept: it is where you clicked a moment ago, and
      // reopening the app pointed at a list you no longer remember choosing is
      // a filter that looks like missing data.
      partialize: (s) => ({ lens: s.lens, includeClosed: s.includeClosed }),
    },
  ),
);
