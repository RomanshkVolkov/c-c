import { create } from "zustand";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export interface UpdateInfo {
  version: string;
  body: string;
}

/**
 * How long without a single chunk before the panel says so.
 *
 * The download is one 86 MB file over whatever connection the person has — on a
 * slow one, twenty seconds between chunks is unremarkable. This is not a
 * timeout and nothing is cancelled: it only replaces a number that has stopped
 * moving with a sentence saying it has stopped moving.
 */
const STALL_SECONDS = 20;

const MB = 1024 * 1024;

/**
 * What to show for a download in flight.
 *
 * Without a total there is no percentage — the API marks `contentLength`
 * optional, and a made-up denominator is worse than an honest byte count.
 */
export function describeProgress(downloaded: number, total: number | null): string {
  const got = (downloaded / MB).toFixed(1);
  if (!total) return `${got} MB downloaded`;
  const all = (total / MB).toFixed(1);
  const pct = Math.min(100, Math.round((downloaded / total) * 100));
  return `${got} / ${all} MB (${pct}%)`;
}

interface UpdaterState {
  available: UpdateInfo | null;
  checking: boolean;
  downloading: boolean;
  progress: string | null;
  /** Bytes in, accumulated across every chunk. */
  downloaded: number;
  /** Total bytes, when the server declared one. */
  total: number | null;
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
  downloaded: 0,
  total: null,
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
    // Every counter starts from zero, and last attempt's error goes with it —
    // otherwise a retry shows the previous failure while it is busy succeeding.
    set({
      downloading: true,
      progress: "Preparing…",
      downloaded: 0,
      total: null,
      lastError: null,
    });

    let lastChunkAt = Date.now();
    const stall = setInterval(() => {
      const s = get();
      if (!s.downloading) return;
      const idle = Math.round((Date.now() - lastChunkAt) / 1000);
      if (idle < STALL_SECONDS) return;
      // A stalled download used to be indistinguishable from a slow one, which
      // is how "it just sat there" became the whole bug report.
      set({
        progress: `${describeProgress(s.downloaded, s.total)} — no progress for ${idle}s`,
      });
    }, 5000);

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
        if (event.event === "Started") {
          lastChunkAt = Date.now();
          const total = event.data.contentLength ?? null;
          set({ total, downloaded: 0, progress: describeProgress(0, total) });
        } else if (event.event === "Progress") {
          lastChunkAt = Date.now();
          // `chunkLength` is the size of *this chunk*, not the running total —
          // see the plugin's DownloadEvent. Reporting it directly is what made
          // an 86 MB download read "16 KB" forever, because that is simply how
          // big each chunk happens to be.
          set((s) => {
            const downloaded = s.downloaded + event.data.chunkLength;
            return { downloaded, progress: describeProgress(downloaded, s.total) };
          });
        } else if (event.event === "Finished") {
          // Swapping the binary takes a moment and reports nothing while it
          // does; saying "Restarting" before it happened was a small lie.
          set({ progress: "Installing…" });
        }
      });
      await relaunch();
    } catch (e) {
      set({
        downloading: false,
        progress: null,
        downloaded: 0,
        total: null,
        lastError: e instanceof Error ? e.message : String(e),
      });
    } finally {
      clearInterval(stall);
    }
  },

  dismiss: () => {
    const a = get().available;
    if (a) set({ dismissedVersion: a.version });
  },
}));
