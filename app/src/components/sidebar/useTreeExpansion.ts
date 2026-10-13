import { useMemo } from "react";

import type { ModuleKey } from "@/lib/nav";
import { expansionKey, useLayoutStore } from "@/store/layout.store";
import { useOrgsStore } from "@/store/orgs.store";

/**
 * Qué ramas de un árbol del panel están abiertas, y cómo recordarlo.
 *
 * Cada árbol trae su **regla por defecto** —en Trabajo, la rama del nodo
 * activo; sin nada activo, los espacios abiertos y las carpetas cerradas— y
 * esto sólo contesta cuando quien mira decidió otra cosa a mano. Lo decidido
 * se guarda por organización y módulo (`layout.store.expanded`), así que
 * plegar un espacio en un cliente no pliega el del mismo nombre en otro.
 */
export function useTreeExpansion(module: ModuleKey) {
  const orgId = useOrgsStore((s) => s.currentOrgId);
  const key = expansionKey(orgId, module);
  const decided = useLayoutStore((s) => s.expanded[key]);
  const setExpanded = useLayoutStore((s) => s.setExpanded);
  const reveal = useLayoutStore((s) => s.reveal);

  return useMemo(
    () => ({
      /** Abierto, según lo decidido a mano o, si no hay nada, según `fallback`. */
      isOpen: (id: string, fallback: boolean): boolean => decided?.[id] ?? fallback,
      /** Lo contrario de lo que se ve ahora, y se recuerda. */
      toggle: (id: string, fallback: boolean) =>
        setExpanded(orgId, module, id, !(decided?.[id] ?? fallback)),
      set: (id: string, open: boolean) => setExpanded(orgId, module, id, open),
      /** Olvida lo decidido sobre estos ids: vuelve a mandar la regla por defecto. */
      reveal: (ids: string[]) => reveal(orgId, module, ids),
    }),
    [decided, orgId, module, setExpanded, reveal],
  );
}
