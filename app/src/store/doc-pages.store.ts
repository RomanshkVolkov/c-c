import { create } from "zustand";

import { api } from "@/lib/api";
import { useAuthStore } from "@/store/auth.store";
import type { APIResponse } from "@/types/auth";
import type { DropWhere } from "@/store/tasks.store";
import {
  isDocTabKey,
  type DocOwnerKind,
  type DocPage,
  type DocPageTreeItem,
  type DocPageVersion,
  type DocPageView,
  type DocTabKey,
} from "@/types/task";

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
 *
 * **Un solo dueño, y una caché de lectura aparte.** Todas las mutaciones leen
 * y escriben `tree`, que es del documento abierto (`owner`). El panel de
 * Documentación enseña también las páginas de otros documentos, y ésas van a
 * `pagesByOwner`, que sólo se lee: se pinta, se pulsa para abrir, y nada más.
 * Si las de otro documento entraran en `tree`, un «+» de esa rama crearía la
 * página en el documento que no es.
 */

interface Owner {
  kind: DocOwnerKind;
  id: string;
}

const base = (o: Owner) => `/api/v1/docs/${o.kind}/${o.id}/pages`;

export interface MoveTo {
  /** La nueva madre; null = la portada. */
  parentId: string | null;
  afterId?: string;
  beforeId?: string;
}

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
  savePage: (
    o: Owner,
    pageId: string,
    fields: { title?: string; body?: string },
    baseHash?: string,
  ) => Promise<string | undefined>;
  movePage: (o: Owner, pageId: string, to: MoveTo) => Promise<void>;
  /**
   * Soltar una página arrastrada encima, debajo o dentro de otra. Lo que no
   * puede ser —soltarla en sí misma o en su propio subárbol— no se manda: el
   * servidor lo rechazaría, pero un rebote es peor manera de enterarse.
   */
  dropPage: (o: Owner, draggedId: string, targetId: string, where: DropWhere) => Promise<void>;
  trashPage: (o: Owner, pageId: string) => Promise<number>;

  trash: DocPageTreeItem[];
  loadingTrash: boolean;
  fetchTrash: (o: Owner) => Promise<void>;
  /** Trae de la papelera la página y lo que se fue con ella. */
  restorePage: (o: Owner, pageId: string) => Promise<void>;

  pageVersions: (o: Owner, pageId: string) => Promise<DocPageVersion[]>;
  restorePageVersion: (o: Owner, pageId: string, versionId: string) => Promise<void>;
  reset: () => void;

  /**
   * Las páginas de cada documento que se ha visto, por `docKey` (`kind:id`),
   * **sólo para pintarlas**. Las del abierto también, copiadas de `tree`, para
   * que al cambiar de documento la rama del que se deja no se quede vacía.
   */
  pagesByOwner: Record<string, DocPageTreeItem[]>;
  /** Trae las páginas de un documento a `pagesByOwner`, sin tocar `tree`. */
  peekPages: (o: Owner) => Promise<void>;

  /**
   * La pestaña de la portada que pidió un enlace (`&tab=`), hasta que la
   * portada la recoja. Aquí y no en `DocTabs` porque el enlace se lee antes de
   * que el documento exista en pantalla. Pedir una pestaña es volver a la
   * portada, así que cierra la página abierta.
   */
  requestedTab: DocTabKey | null;
  requestTab: (tab: string | undefined) => void;
  takeRequestedTab: () => DocTabKey | null;
}

export const useDocPages = create<DocPagesState>()((set, get) => ({
  owner: null,
  tree: [],
  pagesByOwner: {},
  activePageId: null,
  view: null,
  loadingPage: false,
  trash: [],
  loadingTrash: false,
  requestedTab: null,

  requestTab: (tab) => {
    if (!tab || !isDocTabKey(tab)) return;
    set({ requestedTab: tab, activePageId: null, view: null });
  },
  takeRequestedTab: () => {
    const tab = get().requestedTab;
    if (tab) set({ requestedTab: null });
    return tab;
  },

  fetchTree: async (o) => {
    const res = await api.get<APIResponse<DocPageTreeItem[]>>(base(o));
    // Si mientras tanto se abrió otro nodo, este árbol ya no es de nadie.
    const now = get().owner;
    if (now && (now.kind !== o.kind || now.id !== o.id)) return;
    // Sólo un array: un servidor anterior a las páginas contesta otra cosa, y
    // el árbol se pinta con `filter`.
    const tree = Array.isArray(res.data) ? res.data : [];
    set((s) => ({ owner: o, tree, pagesByOwner: { ...s.pagesByOwner, [ownerKey(o)]: tree } }));
  },

  peekPages: async (o) => {
    const res = await api.get<APIResponse<DocPageTreeItem[]>>(base(o));
    const pages = Array.isArray(res.data) ? res.data : [];
    set((s) => ({ pagesByOwner: { ...s.pagesByOwner, [ownerKey(o)]: pages } }));
  },

  enter: async (o) => {
    const now = get().owner;
    if (!now || now.kind !== o.kind || now.id !== o.id) {
      // El árbol que se deja se queda en la caché **antes** de vaciarlo: es
      // lo que pinta su rama en el panel mientras ya se lee otro documento.
      if (now) set((s) => ({ pagesByOwner: { ...s.pagesByOwner, [ownerKey(now)]: s.tree } }));
      get().reset();
      // El nodo se fija ya, no al llegar el árbol: así la respuesta de un nodo
      // que se dejó atrás no se pinta encima del de ahora (ver `fetchTree`).
      set({ owner: o });
    }
    await get().fetchTree(o);
  },

  openPage: async (o, pageId) => {
    // Una página de **otro** documento (desde su rama en el panel, desde un
    // enlace): el árbol que había es del anterior. Se guarda en la caché y se
    // vacía, para que la rama del documento nuevo no pinte un momento las
    // páginas del viejo ni deje que un «+» cree en él. `enter` ya no vaciará
    // nada al ver el mismo dueño, y es lo que deja abierta esta página.
    const now = get().owner;
    if (now && (now.kind !== o.kind || now.id !== o.id)) {
      set((s) => ({ pagesByOwner: { ...s.pagesByOwner, [ownerKey(now)]: s.tree }, tree: [] }));
    }
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
    const res = await api.post<APIResponse<DocPage>>(
      base(o),
      { title, ...(parentId ? { parentId } : {}) },
      true,
    );
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
      set((s) => ({
        tree: s.tree.map((x) => (x.id === pageId ? { ...x, title: page?.title ?? x.title } : x)),
      }));
    }
    return page?.bodyHash;
  },

  movePage: async (o, pageId, to) => {
    // Se mueve ya en pantalla y se corrige con lo que conteste el servidor: un
    // arrastre que tarda medio segundo en caer parece que no ha funcionado.
    const before = get().tree;
    set({ tree: placeLocally(before, pageId, to) });
    try {
      const res = await api.post<APIResponse<DocPageTreeItem[]>>(`${base(o)}/${pageId}/move`, to, true);
      set({ tree: Array.isArray(res.data) ? res.data : before });
    } catch (e) {
      set({ tree: before });
      throw e;
    }
  },

  dropPage: async (o, draggedId, targetId, where) => {
    const tree = get().tree;
    const target = tree.find((x) => x.id === targetId);
    if (!target || descendantsOf(tree, draggedId).includes(targetId)) return;
    if (where === "inside") {
      // Dentro, al final: es lo que espera quien suelta sobre una página.
      const children = childrenOf(tree, targetId).filter((x) => x.id !== draggedId);
      const last = children[children.length - 1];
      await get().movePage(o, draggedId, {
        parentId: targetId,
        ...(last ? { afterId: last.id } : {}),
      });
      return;
    }
    const parentId = target.parentId ?? null;
    await get().movePage(
      o,
      draggedId,
      where === "before" ? { parentId, beforeId: targetId } : { parentId, afterId: targetId },
    );
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

  fetchTrash: async (o) => {
    set({ loadingTrash: true });
    try {
      const res = await api.get<APIResponse<DocPageTreeItem[]>>(`${base(o)}?trashed=1`);
      set({ trash: Array.isArray(res.data) ? res.data : [] });
    } finally {
      set({ loadingTrash: false });
    }
  },

  restorePage: async (o, pageId) => {
    await api.post(`${base(o)}/${pageId}/restore`, {}, true);
    set((s) => ({ trash: s.trash.filter((x) => x.id !== pageId) }));
    await get().fetchTree(o);
  },

  pageVersions: async (o, pageId) => {
    const res = await api.get<APIResponse<DocPageVersion[]>>(`${base(o)}/${pageId}/versions`);
    return Array.isArray(res.data) ? res.data : [];
  },

  restorePageVersion: async (o, pageId, versionId) => {
    const res = await api.post<APIResponse<DocPage>>(
      `${base(o)}/${pageId}/versions/${versionId}/restore`,
      {},
      true,
    );
    const page = res.data;
    if (page && get().activePageId === pageId) {
      set((s) => (s.view ? { view: { ...s.view, page } } : s));
    }
    if (page) {
      set((s) => ({ tree: s.tree.map((x) => (x.id === pageId ? { ...x, title: page.title } : x)) }));
    }
  },

  reset: () =>
    set({ owner: null, tree: [], activePageId: null, view: null, loadingPage: false, trash: [] }),
}));

/** Bajo qué clave guarda `pagesByOwner` las páginas de un documento. */
function ownerKey(o: Owner): string {
  return `${o.kind}:${o.id}`;
}

// Los títulos de otro equipo no se quedan en memoria tras cerrar sesión.
//
// Nada de esto se persiste ya: lo único que se guardaba era si el árbol lateral
// iba plegado, y ese árbol vive ahora en el panel de Documentación.
useAuthStore.subscribe((state, prev) => {
  if (prev.accessToken && !state.accessToken) useDocPages.setState({ pagesByOwner: {} });
});

/** Las hijas de una página (o de la portada, con null), en el orden del árbol. */
export function childrenOf(tree: DocPageTreeItem[], parentId: string | null): DocPageTreeItem[] {
  return tree.filter((x) => (x.parentId ?? null) === parentId);
}

/** La página y todo lo que cuelga de ella, a cualquier profundidad. */
export function descendantsOf(tree: DocPageTreeItem[], id: string): string[] {
  const out = [id];
  for (let i = 0; i < out.length; i++) {
    for (const x of tree) if ((x.parentId ?? null) === out[i]) out.push(x.id);
  }
  return out;
}

/**
 * El árbol con una página ya puesta en su sitio nuevo, para pintarlo antes de
 * que conteste el servidor. El orden del árbol es el del array (así lo manda
 * el servidor, por rango), así que basta con sacarla y meterla junto a su
 * vecina. El rango lo pone el servidor y llega con la respuesta.
 */
export function placeLocally(tree: DocPageTreeItem[], id: string, to: MoveTo): DocPageTreeItem[] {
  const page = tree.find((x) => x.id === id);
  if (!page) return tree;
  const moved = { ...page, parentId: to.parentId };
  const rest = tree.filter((x) => x.id !== id);
  const neighbor = to.beforeId ?? to.afterId;
  let at = neighbor ? rest.findIndex((x) => x.id === neighbor) : -1;
  if (at >= 0 && to.afterId) at += 1;
  if (at < 0) {
    // Sin vecina: al final de las hijas de la madre nueva.
    const children = childrenOf(rest, to.parentId);
    const last = children[children.length - 1];
    at = last ? rest.indexOf(last) + 1 : rest.length;
  }
  return [...rest.slice(0, at), moved, ...rest.slice(at)];
}
