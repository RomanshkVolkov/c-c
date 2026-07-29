import { create } from "zustand";

/**
 * Health of the link to the backend, recorded from `lib/api` — the single choke
 * point every request passes through.
 *
 * Why this exists: when a call failed the app showed an empty screen and said
 * nothing, which is indistinguishable from "the app is frozen" and led to
 * restarting it. With this, a failure is visible and recoverable.
 */
interface ConnectionState {
  lastOkAt: number | null;
  lastFailAt: number | null;
  lastError: string | null;
  /** Consecutive failures; a single blip shouldn't raise an alarm. */
  failures: number;
  /**
   * Live SSE stream state, reported by the events hook. "idle" means we aren't
   * subscribed at all (guest / signed out) — not a problem to report.
   */
  stream: "idle" | "connecting" | "open" | "down";

  markOk: () => void;
  markFail: (error: string) => void;
  setStream: (s: ConnectionState["stream"]) => void;
}

export const useConnectionStore = create<ConnectionState>()((set) => ({
  lastOkAt: null,
  lastFailAt: null,
  lastError: null,
  failures: 0,
  stream: "idle",

  markOk: () => set({ lastOkAt: Date.now(), failures: 0, lastError: null }),

  markFail: (error) =>
    set((s) => ({ failures: s.failures + 1, lastFailAt: Date.now(), lastError: error })),

  setStream: (stream) => set({ stream }),
}));

/**
 * Degraded = repeated failures, not a one-off (those already retry silently).
 * Selected as a primitive so the banner doesn't re-render on every OK request.
 */
export const selectDegraded = (s: ConnectionState) => s.failures >= 2;
