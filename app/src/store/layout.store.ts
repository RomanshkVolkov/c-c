import { create } from "zustand";
import { persist } from "zustand/middleware";

import type { ModuleKey } from "@/lib/nav";

/**
 * Cómo tiene quien mira la barra lateral: qué módulo manda, si el panel está
 * abierto, qué ramas de cada árbol ha plegado o desplegado, y qué columnas
 * laterales lleva plegadas.
 *
 * Es su preferencia, no un estado de la sesión: se recuerda entre arranques.
 *
 * Desde el 12-oct-2026 el sidebar es un riel de módulos y un panel (ver
 * `lib/nav.ts`, `MODULES`). Lo abierto/plegado del panel vivía en una cookie
 * de shadcn que se escribía y nunca se leía: el sidebar arrancaba siempre
 * abierto. Ahora el `SidebarProvider` va controlado desde `panelOpen`.
 *
 * Ojo: `useEncogerEnLlamada` pliega el panel al entrar en una llamada y lo
 * restaura al salir, y como el provider está controlado eso **se persiste**
 * mientras dura la llamada. Cerrar la app en mitad de una deja el panel
 * plegado al arrancar; un ⌘B lo arregla. Se acepta: la alternativa era un
 * estado «plegado por la llamada» aparte que había que sincronizar.
 */
export type CollapsibleColumn = "channels" | "dms";

/** Las dos mitades de «Comunicación» en el móvil. */
export type CommsPath = "/chat" | "/dm";

/** Bajo qué clave se guarda lo desplegado de un árbol: por org **y** módulo. */
export function expansionKey(orgId: string | null | undefined, module: ModuleKey): string {
  return `${orgId ?? ""}/${module}`;
}

interface LayoutState {
  /**
   * La lista de canales y la de directos se comen 240px que en una tablet son
   * la conversación (9-oct-2026); plegadas quedan en un riel con las iniciales.
   * Desaparece con la rebanada S1 del sidebar nuevo.
   */
  collapsed: Partial<Record<CollapsibleColumn, boolean>>;
  setCollapsed: (column: CollapsibleColumn, v: boolean) => void;
  /**
   * En cuál de las dos estuviste la última vez: el botón «Comunicación» del
   * menú inferior vuelve ahí, que es lo que se espera de una pestaña.
   */
  comms: CommsPath;
  setComms: (path: CommsPath) => void;

  /** El panel del sidebar, abierto o plegado al riel (⌘B). */
  panelOpen: boolean;
  setPanelOpen: (v: boolean) => void;
  /** El módulo que manda en el panel. Se queda cuando la ruta no es de ninguno. */
  activeModule: ModuleKey;
  setActiveModule: (m: ModuleKey) => void;
  /** Dónde estabas en cada módulo, para que su icono te devuelva ahí. */
  lastRoute: Partial<Record<ModuleKey, string>>;
  rememberRoute: (m: ModuleKey, route: string) => void;
  /**
   * Lo plegado o desplegado **a mano** en cada árbol: `expansionKey` → id →
   * abierto. Ausente = sin decidir, y entonces manda la regla por defecto del
   * árbol (la rama activa abierta, el resto cerrado). Guarda `true` **y**
   * `false` porque una lista de ids abiertos no puede decir «abierto por
   * defecto salvo que lo cerraras».
   */
  expanded: Record<string, Record<string, boolean>>;
  setExpanded: (orgId: string | null | undefined, module: ModuleKey, id: string, open: boolean) => void;
  /**
   * Olvida lo decidido sobre estos ids, para que vuelva a mandar la regla por
   * defecto. Lo llama un árbol cuando cambia su nodo activo: una lista abierta
   * desde la paleta no puede quedar escondida bajo un espacio que plegaste.
   */
  reveal: (orgId: string | null | undefined, module: ModuleKey, ids: string[]) => void;
}

export const useLayoutStore = create<LayoutState>()(
  persist(
    (set) => ({
      collapsed: {},
      setCollapsed: (column, v) => set((s) => ({ collapsed: { ...s.collapsed, [column]: v } })),
      comms: "/chat",
      setComms: (comms) => set({ comms }),

      panelOpen: true,
      setPanelOpen: (panelOpen) => set({ panelOpen }),
      activeModule: "work",
      setActiveModule: (activeModule) => set({ activeModule }),
      lastRoute: {},
      rememberRoute: (m, route) => set((s) => ({ lastRoute: { ...s.lastRoute, [m]: route } })),
      expanded: {},
      setExpanded: (orgId, module, id, open) =>
        set((s) => {
          const key = expansionKey(orgId, module);
          return { expanded: { ...s.expanded, [key]: { ...s.expanded[key], [id]: open } } };
        }),
      reveal: (orgId, module, ids) =>
        set((s) => {
          const key = expansionKey(orgId, module);
          const decided = s.expanded[key];
          if (!decided || !ids.some((id) => id in decided)) return s;
          const rest = { ...decided };
          for (const id of ids) delete rest[id];
          return { expanded: { ...s.expanded, [key]: rest } };
        }),
    }),
    { name: "cac-layout" },
  ),
);
