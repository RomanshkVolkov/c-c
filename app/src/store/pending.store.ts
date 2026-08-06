import { create } from "zustand";
import { api } from "@/lib/api";
import type { APIResponse } from "@/types/auth";
import type { OpenTask } from "@/types/task";
import { normalizeStatus, type ReportListItem } from "@/types/report";

/**
 * What's still pending, for the dashboard.
 *
 * A store rather than state inside the card, for two reasons. The live event
 * stream can refresh it without the card having to be mounted or reachable
 * from the hook. And it fetches reports itself instead of reading the reports
 * store, which carries the filters set on the Reports page — a dashboard that
 * quietly inherited "only urgent, only project X" would be lying about what's
 * left to do.
 */

/** Worst first, so the top of the list is the part that matters. */
const REPORT_PRIORITY_RANK: Record<string, number> = {
  urgent: 0, high: 1, medium: 2, low: 3,
};

/** Bursts are the norm — moving a card fires several events. Coalesce them. */
const COALESCE_MS = 1_500;

interface PendingState {
  tasks: OpenTask[] | null;
  reports: ReportListItem[] | null;
  failed: boolean;
  /** The org the current data belongs to; also what a live refresh re-asks for. */
  orgId: string | null;
  /** Whether anyone has ever asked for this. Live events are ignored until then,
   *  so a user who never opens the dashboard pays nothing for it. */
  loaded: boolean;

  load: (orgId: string | null) => Promise<void>;
  /** Re-read after a live event. Debounced, and a no-op before the first load. */
  markStale: () => void;
}

let timer: ReturnType<typeof setTimeout> | null = null;

export const usePendingStore = create<PendingState>()((set, get) => ({
  tasks: null,
  reports: null,
  failed: false,
  orgId: null,
  loaded: false,

  load: async (orgId) => {
    const changedOrg = get().orgId !== orgId;
    // Blank only when the org changed: on a live refresh the old numbers are
    // better company than a spinner.
    set(changedOrg ? { orgId, tasks: null, reports: null, failed: false } : { failed: false });

    const qs = orgId ? `?orgId=${encodeURIComponent(orgId)}&limit=8` : "?limit=8";
    try {
      const [t, r] = await Promise.all([
        api.get<APIResponse<OpenTask[]>>(`/api/v1/tasks/${qs}`, true),
        api.get<APIResponse<{ items: ReportListItem[] }>>("/api/v1/reports/?limit=100", true),
      ]);
      // A late response for an org the user already switched away from.
      if (get().orgId !== orgId) return;

      const reports = (r.success && r.data ? r.data.items : [])
        .map((x) => ({ ...x, status: normalizeStatus(x.status) }))
        .filter((x) => x.status === "open" || x.status === "in_progress")
        .sort(
          (a, b) =>
            (REPORT_PRIORITY_RANK[a.priority] ?? 9) - (REPORT_PRIORITY_RANK[b.priority] ?? 9) ||
            +new Date(b.createdAt) - +new Date(a.createdAt),
        );
      set({ tasks: t.success && t.data ? t.data : [], reports, loaded: true, failed: false });
    } catch {
      if (get().orgId !== orgId) return;
      // Saying so beats an empty card that reads as "nothing pending" — the one
      // wrong answer this card must never give.
      set({ failed: true, loaded: true });
    }
  },

  markStale: () => {
    if (!get().loaded) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void get().load(get().orgId);
    }, COALESCE_MS);
  },
}));
