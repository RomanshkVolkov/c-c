import { createContext, useContext } from "react";

import { useTreeExpansion } from "@/components/sidebar/useTreeExpansion";

/**
 * Lo que el árbol de Documentación sabe de sí mismo y le cuenta a cada fila:
 * qué va abierto por defecto (`defaultExpanded`) y, con el filtro puesto, qué
 * se ve (`filterDocsTree`). En un contexto para no pasarlo a mano por cada
 * nivel de páginas, que no tiene fondo.
 *
 * Fuera del panel —la hoja «Páginas» del teléfono— no hay árbol alrededor, y
 * el valor por defecto deja todo plegado y sin filtrar.
 */
export const DocsTreeView = createContext<{ defaults: Set<string>; visible: Set<string> | null }>({
  defaults: new Set(),
  visible: null,
});

/**
 * Si una rama (un nodo o una página, por su clave) va desplegada, y cómo
 * cambiarlo. Con el filtro puesto todo lo que se ve va abierto: lo que se
 * busca no puede quedar tras un chevrón.
 */
export function useBranch(key: string) {
  const { defaults, visible } = useContext(DocsTreeView);
  const expansion = useTreeExpansion("docs");
  const fallback = defaults.has(key);
  return {
    open: visible ? true : expansion.isOpen(key, fallback),
    toggle: () => expansion.toggle(key, fallback),
    /** Con filtro, si esta clave se pinta. Sin filtro, todo. */
    shows: (k: string) => !visible || visible.has(k),
    filtering: !!visible,
  };
}

/** Sólo el filtro: qué claves se pintan, y si se está filtrando. */
export function useDocsFilter() {
  const { visible } = useContext(DocsTreeView);
  return { shows: (k: string) => !visible || visible.has(k), filtering: !!visible };
}
