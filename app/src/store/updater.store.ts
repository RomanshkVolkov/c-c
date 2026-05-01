import { create } from "zustand";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export interface UpdateInfo {
  version: string;
  body: string;
}

interface UpdaterState {
  available: UpdateInfo | null;
  checking: boolean;
  downloading: boolean;
  progress: string | null;
  lastCheckedAt: number | null;
  lastError: string | null;
  dismissedVersion: string | null;

  checkForUpdate: (opts?: { silent?: boolean }) => Promise<UpdateInfo | null>;
  installUpdate: () => Promise<void>;
  dismiss: () => void;
}

export const useUpdaterStore = create<UpdaterState>((set, get) => ({
  available: null,
  checking: false,
  downloading: false,
  progress: null,
  lastCheckedAt: null,
  lastError: null,
  dismissedVersion: null,

  checkForUpdate: async (opts) => {
    const silent = opts?.silent ?? false;
    if (get().checking || get().downloading) return get().available;
    set({ checking: true, lastError: null });
    try {
      const update = await check();
      const info: UpdateInfo | null = update
        ? { version: update.version, body: update.body ?? "" }
        : null;
      set({
        available: info,
        lastCheckedAt: Date.now(),
        ...(info ? { dismissedVersion: null } : {}),
      });
      return info;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      set({ lastError: message });
      if (silent) return null;
      throw e;
    } finally {
      set({ checking: false });
    }
  },

  installUpdate: async () => {
    if (!get().available) return;
    set({ downloading: true, progress: "Preparing..." });
    try {
      const update = await check();
      if (!update) {
        set({
          available: null,
          downloading: false,
          progress: null,
          lastCheckedAt: Date.now(),
        });
        return;
      }
      await update.downloadAndInstall((event) => {
        if (event.event === "Started" && event.data.contentLength) {
          set({
            progress: `0 / ${(event.data.contentLength / 1024 / 1024).toFixed(1)} MB`,
          });
        } else if (event.event === "Progress") {
          set({
            progress: `Downloading... ${(event.data.chunkLength / 1024).toFixed(0)} KB`,
          });
        } else if (event.event === "Finished") {
          set({ progress: "Restarting..." });
        }
      });
      await relaunch();
    } catch (e) {
      set({
        downloading: false,
        progress: null,
        lastError: e instanceof Error ? e.message : String(e),
      });
    }
  },

  dismiss: () => {
    const a = get().available;
    if (a) set({ dismissedVersion: a.version });
  },
}));
