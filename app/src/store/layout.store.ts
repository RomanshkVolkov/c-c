import { create } from "zustand";
import { persist } from "zustand/middleware";

import type { ModuleKey } from "@/lib/nav";

/**
 * Cómo tiene quien mira la barra lateral: qué módulo manda, si el panel está
 * abierto y qué ramas de cada árbol ha plegado o desplegado.
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
/** Las dos mitades de «Comunicación» en el móvil. */
export type CommsPath = "/chat" | "/dm";

/** Bajo qué clave se guarda lo desplegado de un árbol: por org **y** módulo. */
export function expansionKey(orgId: string | null | undefined, module: ModuleKey): string {
  return `${orgId ?? ""}/${module}`;
}

interface LayoutState {
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
    {
      name: "cac-layout",
      // v2 (12-oct-2026): fuera `collapsed`, el plegado de las columnas de
      // canales y directos, que ya no existen —su lista vive en el panel—.
      // Se tira en vez de traducirlo: plegar una columna de 240px no dice
      // nada de si quieres el panel entero abierto.
      version: 2,
      migrate: (persisted, version) => {
        const state = { ...(persisted as Record<string, unknown>) };
        if (version < 2) delete state.collapsed;
        return state as unknown as LayoutState;
      },
    },
  ),
);
