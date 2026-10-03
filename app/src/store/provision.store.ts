import { create } from "zustand";
import { persist } from "zustand/middleware";
import { invoke } from "@tauri-apps/api/core";
import { api } from "@/lib/api";
import { appendBounded } from "@/lib/ansible";
import type { APIResponse } from "@/types/auth";
import type { ProvisioningRun } from "@/types/ansible";

/** Lo que se recuerda por servidor, en esta máquina: de dónde y contra qué. */
export interface ProvisionPrefs {
  projectDir: string;
  limit: string;
  playbookId: string;
}

/** Una ejecución en marcha. Persistida para saber, tras reabrir, que se cortó. */
export interface InFlight {
  serverId: string;
  /** El de Rust, para cancelar. */
  runId: string;
  /** El de cac, para cerrarla. */
  backendRunId: string;
}

interface ProvisionState {
  prefs: Record<string, ProvisionPrefs>;
  inFlight: InFlight | null;
  /** La salida de la ejecución en marcha (o de la última), acotada. */
  lines: string[];
  history: Record<string, ProvisioningRun[]>;

  setPrefs: (serverId: string, p: Partial<ProvisionPrefs>) => void;
  start: (f: InFlight) => void;
  push: (lines: string[]) => void;
  clearLines: () => void;
  finished: () => void;
  loadHistory: (serverId: string) => Promise<void>;
  /**
   * Una ejecución que quedó «en curso» de una sesión anterior. Si la app se
   * cerró, el proceso murió con ella; si sólo se recargó la ventana, sigue
   * corriendo en Rust sin nadie que vea su salida, y se para —como los
   * terminales huérfanos—. En los dos casos, en cac se cierra como
   * interrumpida para que no quede viva para siempre.
   */
  closeOrphan: () => Promise<void>;
}

const EMPTY: ProvisionPrefs = { projectDir: "", limit: "", playbookId: "" };

export const prefsOf = (s: ProvisionState, serverId: string): ProvisionPrefs => s.prefs[serverId] ?? EMPTY;

export const useProvisionStore = create<ProvisionState>()(
  persist(
    (set, get) => ({
      prefs: {},
      inFlight: null,
      lines: [],
      history: {},

      setPrefs: (serverId, p) =>
        set((s) => ({ prefs: { ...s.prefs, [serverId]: { ...(s.prefs[serverId] ?? EMPTY), ...p } } })),

      start: (f) => set({ inFlight: f, lines: [] }),

      push: (more) => set((s) => ({ lines: appendBounded(s.lines, more) })),

      clearLines: () => set({ lines: [] }),

      finished: () => set({ inFlight: null }),

      loadHistory: async (serverId) => {
        const res = await api.get<APIResponse<ProvisioningRun[]>>(`/api/v1/servers/${serverId}/provisioning-runs`, true);
        if (res?.success && Array.isArray(res.data)) set((s) => ({ history: { ...s.history, [serverId]: res.data! } }));
      },

      closeOrphan: async () => {
        const f = get().inFlight;
        if (!f) return;
        set({ inFlight: null });
        await invoke("ansible_cancel", { runId: f.runId }).catch(() => {});
        await api
          .patch(`/api/v1/servers/${f.serverId}/provisioning-runs/${f.backendRunId}`, { status: "interrupted", summary: "", logTail: "" }, true)
          .catch(() => {});
      },
    }),
    // Sólo lo que sirve tras reabrir: las preferencias y si había algo en marcha.
    { name: "cac-provision", partialize: (s) => ({ prefs: s.prefs, inFlight: s.inFlight }) },
  ),
);
