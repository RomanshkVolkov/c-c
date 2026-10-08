import { create } from "zustand";

import { api } from "@/lib/api";
import type { APIResponse } from "@/types/auth";
import type { DocOwnerKind, DocPage, DocPageTreeItem, DocPageView } from "@/types/task";

/**
 * Las páginas del documento abierto: el árbol que cuelga de la portada.
 *
 * Aparte de `tasks.store` a propósito, que ya pasa de mil líneas; lo único que
 * comparten es qué nodo está abierto, y eso se pasa en cada llamada.
 *
 * Mover es **una página a la vez** (`move` con madre y vecina) y no el árbol
 * entero: un agente por MCP puede estar moviendo a la vez, y mandar el árbol
 * desde una copia vieja desharía lo suyo. El servidor contesta con el árbol ya
 * movido y con eso se resincroniza.
 */

interface Owner {
  kind: DocOwnerKind;
  id: string;
}

const base = (o: Owner) => `/api/v1/docs/${o.kind}/${o.id}/pages`;

interface DocPagesState {
  owner: Owner | null;
  tree: DocPageTreeItem[];
  /** La página abierta, o null cuando se mira la portada. */
  activePageId: string | null;
  view: DocPageView | null;
  loadingPage: boolean;

  fetchTree: (o: Owner) => Promise<void>;
  /**
   * Se abre el documento de un nodo. Si es otro nodo, fuera la página abierta;
   * si es el mismo, se queda. Lo segundo es lo que deja funcionar un enlace con
   * `&page=`: `openPage` fija el nodo antes de que el documento se pinte, y
   * vaciarlo al pintarse cerraría la página que se acaba de pedir.
   */
  enter: (o: Owner) => Promise<void>;
  openPage: (o: Owner, pageId: string) => Promise<void>;
  closePage: () => void;
  /** Crea una página (hija de `parentId`, o de la portada) y la abre. */
  createPage: (o: Owner, parentId: string | null, title: string) => Promise<DocPage | null>;
  /** Guarda título y/o cuerpo. Devuelve el hash nuevo; lanza `doc-page-conflict`. */
  savePage: (o: Owner, pageId: string, fields: { title?: string; body?: string }, baseHash?: string) => Promise<string | undefined>;
  movePage: (o: Owner, pageId: string, to: { parentId: string | null; afterId?: string; beforeId?: string }) => Promise<void>;
  trashPage: (o: Owner, pageId: string) => Promise<number>;
  reset: () => void;
}

export const useDocPages = create<DocPagesState>((set, get) => ({
  owner: null,
  tree: [],
  activePageId: null,
  view: null,
  loadingPage: false,

  fetchTree: async (o) => {
    const res = await api.get<APIResponse<DocPageTreeItem[]>>(base(o));
    // Si mientras tanto se abrió otro nodo, este árbol ya no es de nadie.
    const now = get().owner;
    if (now && (now.kind !== o.kind || now.id !== o.id)) return;
    // Sólo un array: un servidor anterior a las páginas contesta otra cosa, y
    // el árbol se pinta con `filter`.
    set({ owner: o, tree: Array.isArray(res.data) ? res.data : [] });
  },

  enter: async (o) => {
    const now = get().owner;
    if (!now || now.kind !== o.kind || now.id !== o.id) {
      get().reset();
      // El nodo se fija ya, no al llegar el árbol: así la respuesta de un nodo
      // que se dejó atrás no se pinta encima del de ahora (ver `fetchTree`).
      set({ owner: o });
    }
    await get().fetchTree(o);
  },

  openPage: async (o, pageId) => {
    set({ owner: o, activePageId: pageId, view: null, loadingPage: true });
    try {
      const res = await api.get<APIResponse<DocPageView>>(`${base(o)}/${pageId}`);
      if (get().activePageId !== pageId) return; // se cambió de página a medio camino
      set({ view: res.data ?? null });
    } finally {
      if (get().activePageId === pageId) set({ loadingPage: false });
    }
  },

  closePage: () => set({ activePageId: null, view: null }),

  createPage: async (o, parentId, title) => {
    const res = await api.post<APIResponse<DocPage>>(base(o), { title, ...(parentId ? { parentId } : {}) }, true);
    const page = res.data ?? null;
    await get().fetchTree(o);
    if (page) await get().openPage(o, page.id);
    return page;
  },

  savePage: async (o, pageId, fields, baseHash) => {
    const body = { ...fields, ...(fields.body !== undefined && baseHash ? { baseHash } : {}) };
    const res = await api.put<APIResponse<DocPage>>(`${base(o)}/${pageId}`, body);
    const page = res.data;
    if (page && get().activePageId === pageId) {
      // Se funde y no se recarga: recargar mientras alguien escribe reiniciaría
      // la pantalla en mitad de una frase.
      set((s) => (s.view ? { view: { ...s.view, page } } : s));
    }
    if (fields.title !== undefined) {
      set((s) => ({ tree: s.tree.map((x) => (x.id === pageId ? { ...x, title: page?.title ?? x.title } : x)) }));
    }
    return page?.bodyHash;
  },

  movePage: async (o, pageId, to) => {
    const res = await api.post<APIResponse<DocPageTreeItem[]>>(`${base(o)}/${pageId}/move`, to, true);
    set({ tree: res.data ?? get().tree });
  },

  trashPage: async (o, pageId) => {
    const res = await api.delete<APIResponse<{ pages: number }>>(`${base(o)}/${pageId}`);
    const gone = new Set<string>([pageId]);
    // Lo que colgaba de ella se fue con ella.
    let added = true;
    while (added) {
      added = false;
      for (const x of get().tree) {
        if (x.parentId && gone.has(x.parentId) && !gone.has(x.id)) {
          gone.add(x.id);
          added = true;
        }
      }
    }
    set((s) => ({
      tree: s.tree.filter((x) => !gone.has(x.id)),
      ...(s.activePageId && gone.has(s.activePageId) ? { activePageId: null, view: null } : {}),
    }));
    return res.data?.pages ?? gone.size;
  },

  reset: () => set({ owner: null, tree: [], activePageId: null, view: null, loadingPage: false }),
}));

/** Las hijas de una página (o de la portada, con null), en el orden del árbol. */
export function childrenOf(tree: DocPageTreeItem[], parentId: string | null): DocPageTreeItem[] {
  return tree.filter((x) => (x.parentId ?? null) === parentId);
}
