import { create } from "zustand";

/**
 * Una navegación pedida desde donde no hay router: `openInternalRef` (un enlace
 * a un documento en el chat), una store. La sigue `RepoDocNavigator`, montado
 * dentro del router en el layout.
 *
 * Hacía falta para los documentos: un enlace del chat a uno de ellos lo abría
 * en la store, pero la pantalla seguía en el chat y no se veía nada (jose,
 * 16-oct-2026: «se creó una referencia a documentación pero no te lleva a
 * ella»).
 */
interface RouteRequestState {
  pending: string | null;
  request: (route: string) => void;
  take: () => string | null;
}

export const useRouteRequest = create<RouteRequestState>((set, get) => ({
  pending: null,
  request: (route) => set({ pending: route }),
  take: () => {
    const r = get().pending;
    if (r) set({ pending: null });
    return r;
  },
}));
