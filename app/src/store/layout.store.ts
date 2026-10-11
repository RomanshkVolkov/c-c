import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * Qué columnas laterales lleva plegadas quien mira, por pantalla.
 *
 * Es su preferencia, no un estado de la sesión: se recuerda entre arranques. La
 * lista de canales y la de directos se comen 240px que en una tablet son la
 * conversación (9-oct-2026); plegadas quedan en un riel con las iniciales de
 * cada una.
 */
export type CollapsibleColumn = "channels" | "dms";

/** Las dos mitades de «Comunicación» en el móvil. */
export type CommsPath = "/chat" | "/dm";

interface LayoutState {
  collapsed: Partial<Record<CollapsibleColumn, boolean>>;
  setCollapsed: (column: CollapsibleColumn, v: boolean) => void;
  /**
   * En cuál de las dos estuviste la última vez: el botón «Comunicación» del
   * menú inferior vuelve ahí, que es lo que se espera de una pestaña.
   */
  comms: CommsPath;
  setComms: (path: CommsPath) => void;
}

export const useLayoutStore = create<LayoutState>()(
  persist(
    (set) => ({
      collapsed: {},
      setCollapsed: (column, v) => set((s) => ({ collapsed: { ...s.collapsed, [column]: v } })),
      comms: "/chat",
      setComms: (comms) => set({ comms }),
    }),
    { name: "cac-layout" },
  ),
);
