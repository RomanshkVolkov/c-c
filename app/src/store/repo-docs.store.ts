import { create } from "zustand";

import { api } from "@/lib/api";
import { useAuthStore } from "@/store/auth.store";
import type { APIResponse } from "@/types/auth";
import type { RepoDoc, RepoDocsGroup } from "@/types/github";

/**
 * Los .md de los repos atados a cada espacio (docs as code), de sólo lectura.
 *
 * Por espacio y bajo demanda: el panel los pide al desplegar un espacio, no
 * al montar, igual que las páginas de un documento que no es el abierto
 * (`peekPages`). Un espacio sin repo contesta una lista vacía y no se vuelve
 * a pedir. Sin persistir: lo que importa es lo que hay en el repo ahora.
 *
 * `open` es el fichero que se lee en `/docs?repoDoc=`, con su cuerpo; el panel
 * lo mira para marcar su fila y abrir el camino hasta ella.
 */
interface RepoDocsState {
  bySpace: Record<string, RepoDocsGroup[]>;
  open: RepoDoc | null;
  /** Una vez por espacio; `force` para después de sincronizar. */
  fetchSpace: (spaceId: string, force?: boolean) => Promise<void>;
  openDoc: (id: string) => Promise<RepoDoc>;
  closeDoc: () => void;
}

const inFlight = new Map<string, Promise<void>>();

export const useRepoDocs = create<RepoDocsState>()((set, get) => ({
  bySpace: {},
  open: null,

  fetchSpace: (spaceId, force = false) => {
    if (!force && get().bySpace[spaceId]) return Promise.resolve();
    const running = inFlight.get(spaceId);
    if (running) return running;
    const p = api
      .get<APIResponse<RepoDocsGroup[]>>(`/api/v1/repo-docs?spaceId=${encodeURIComponent(spaceId)}`)
      .then((res) => {
        const groups = Array.isArray(res.data) ? res.data : [];
        set((s) => ({ bySpace: { ...s.bySpace, [spaceId]: groups } }));
      })
      .finally(() => inFlight.delete(spaceId));
    inFlight.set(spaceId, p);
    return p;
  },

  openDoc: async (id) => {
    const res = await api.get<APIResponse<RepoDoc>>(`/api/v1/repo-docs/${encodeURIComponent(id)}`);
    if (!res.data) throw new Error(res.error ?? "not-found");
    set({ open: res.data });
    return res.data;
  },

  closeDoc: () => set({ open: null }),
}));

useAuthStore.subscribe((state, prev) => {
  if (prev.accessToken && !state.accessToken) useRepoDocs.setState({ bySpace: {}, open: null });
});
