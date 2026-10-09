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

interface LayoutState {
  collapsed: Partial<Record<CollapsibleColumn, boolean>>;
  setCollapsed: (column: CollapsibleColumn, v: boolean) => void;
}

export const useLayoutStore = create<LayoutState>()(
  persist(
    (set) => ({
      collapsed: {},
      setCollapsed: (column, v) => set((s) => ({ collapsed: { ...s.collapsed, [column]: v } })),
    }),
    { name: "cac-layout" },
  ),
);
