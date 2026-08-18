import { create } from "zustand";

/**
 * Qué hay abierto de notificaciones: el panel y el diálogo de preferencias.
 *
 * Vive fuera de los dos componentes porque los abren desde sitios que no se
 * hablan: la campana está en la barra de arriba y el menú de cuenta en el pie
 * del sidebar, y ambos tienen que poder abrir las preferencias. Pasarlo por
 * props obligaría a que uno fuera hijo del otro, que es justo lo que no son.
 */
interface NotifUI {
  panelOpen: boolean;
  prefsOpen: boolean;
  setPanelOpen: (v: boolean) => void;
  setPrefsOpen: (v: boolean) => void;
}

export const useNotifUI = create<NotifUI>((set) => ({
  panelOpen: false,
  prefsOpen: false,
  setPanelOpen: (v) => set({ panelOpen: v }),
  setPrefsOpen: (v) => set({ prefsOpen: v }),
}));
