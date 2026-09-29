import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { DocOwnerKind } from "@/types/task";

/**
 * Dónde estabas en cada organización.
 *
 * Pedido por jose el 29-sep: volver a una org te deja donde estabas **en
 * ella** —su lista, su documento, su canal, su directo—, y no en lo que
 * tuvieras abierto en la otra ni en la pantalla vacía. Persistido, para que
 * cerrar la app tampoco lo pierda.
 *
 * Todo se apunta **bajo la org de la cosa**, no bajo la que está en pantalla:
 * un documento abierto por un enlace de otra org es de esa otra, y apuntarlo
 * aquí lo restauraría en la que no es.
 *
 * Aquí sólo vive lo apuntado, sin depender de ningún otro store: lo leen las
 * pantallas de directos y canales, que restauran lo suyo cuando no hay nada
 * abierto. Quién apunta y cuándo, y la restauración de lista y documento al
 * cambiar de org, están en `store/places.ts`.
 */

export interface Place {
  listId?: string;
  doc?: { kind: DocOwnerKind; id: string; name: string };
  spaceId?: string;
  dm?: string;
}

interface PlacesState {
  byOrg: Record<string, Place>;
  /** Apunta o borra (`undefined`) partes del sitio de una org. */
  remember: (orgId: string, part: Partial<Place>) => void;
}

export const usePlacesStore = create<PlacesState>()(
  persist(
    (set) => ({
      byOrg: {},
      remember: (orgId, part) => set((s) => ({ byOrg: { ...s.byOrg, [orgId]: { ...s.byOrg[orgId], ...part } } })),
    }),
    { name: "cac-places", partialize: (s) => ({ byOrg: s.byOrg }) },
  ),
);

/** El sitio de una org, o vacío. */
export function placeOf(orgId: string | null | undefined): Place {
  return (orgId && usePlacesStore.getState().byOrg[orgId]) || {};
}
