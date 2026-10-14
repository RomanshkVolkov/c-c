import { create } from "zustand";

import { api } from "@/lib/api";
import { openExternal } from "@/lib/platform";
import { matchRepoBlobUrl } from "@/lib/repo-links";
import { useOrgsStore } from "@/store/orgs.store";
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

  /**
   * El .md que nombra una URL de GitHub, si es de un repo de la org actual.
   * Cacheado por URL (también los que no están, como `null`): una página con
   * diez includes no hace diez peticiones cada vez que se pinta.
   */
  byUrl: Record<string, RepoDoc | null>;
  lookup: (url: string) => Promise<RepoDoc | null>;
  /**
   * Abrir un .md del repo desde donde no hay router (`openInternalRef`, el
   * chat, un include): se apunta aquí la ruta y `RepoDocNavigator`, dentro
   * del router, navega.
   */
  pendingRoute: string | null;
  goTo: (id: string, hash?: string) => void;
  takeRoute: () => string | null;
  /** Una URL de GitHub de un .md: en cac si está copiado; si no, en GitHub. */
  openByUrl: (url: string) => void;
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

  byUrl: {},
  lookup: async (url) => {
    if (url in get().byUrl) return get().byUrl[url];
    const m = matchRepoBlobUrl(url);
    const orgId = useOrgsStore.getState().currentOrgId;
    if (!m || !orgId) return null;
    const q = new URLSearchParams({ orgId, repo: m.repo, path: m.path });
    const doc = await api
      .get<APIResponse<RepoDoc>>(`/api/v1/repo-docs/lookup?${q}`)
      .then((res) => res.data ?? null)
      .catch(() => null);
    set((s) => ({ byUrl: { ...s.byUrl, [url]: doc } }));
    return doc;
  },

  pendingRoute: null,
  goTo: (id, hash) => set({ pendingRoute: `/docs?repoDoc=${encodeURIComponent(id)}${hash ? `#${hash}` : ""}` }),
  takeRoute: () => {
    const r = get().pendingRoute;
    if (r) set({ pendingRoute: null });
    return r;
  },
  openByUrl: (url) => {
    void get()
      .lookup(url)
      .then((doc) => {
        if (doc) get().goTo(doc.id, new URL(url).hash.slice(1));
        else openExternal(url).catch(() => window.open(url, "_blank"));
      });
  },
}));

useAuthStore.subscribe((state, prev) => {
  if (prev.accessToken && !state.accessToken) useRepoDocs.setState({ bySpace: {}, open: null, byUrl: {} });
});
