import { create } from "zustand";
import { api } from "@/lib/api";
import type { APIResponse } from "@/types/auth";
import type {
  ReportProject,
  ReportListItem,
  ReportListResult,
  ReportStatus,
  TransitionsMap,
} from "@/types/report";
import { useOrgsStore } from "@/store/orgs.store";

interface ReportsState {
  projects: ReportProject[];
  reports: ReportListItem[];
  transitions: TransitionsMap | null;
  loading: boolean;
  projectFilter: string; // "" = all projects in current org
  statusFilter: ReportStatus | "";

  fetchProjects: () => Promise<void>;
  fetchReports: () => Promise<void>;
  fetchTransitions: () => Promise<void>;
  setProjectFilter: (id: string) => void;
  setStatusFilter: (s: ReportStatus | "") => void;
  updateStatus: (id: string, status: ReportStatus) => Promise<void>;
  /** merge a single report (from SSE / after mutation) into the list */
  upsertReportFromServer: (id: string) => Promise<void>;
}

/** project ids belonging to the active org (reports carry projectId, not orgId). */
function orgProjectIds(projects: ReportProject[]): Set<string> {
  const orgId = useOrgsStore.getState().currentOrgId;
  return new Set(projects.filter((p) => p.orgId === orgId).map((p) => p.id));
}

export const useReportsStore = create<ReportsState>((set, get) => ({
  projects: [],
  reports: [],
  transitions: null,
  loading: false,
  projectFilter: "",
  statusFilter: "",

  fetchProjects: async () => {
    const res = await api.get<APIResponse<ReportProject[]>>("/api/v1/report-projects/", true);
    const orgId = useOrgsStore.getState().currentOrgId;
    const all = res.success && res.data ? res.data : [];
    set({ projects: all.filter((p) => p.orgId === orgId) });
  },

  fetchReports: async () => {
    set({ loading: true });
    try {
      const { projectFilter, statusFilter, projects } = get();
      const qs = new URLSearchParams({ limit: "200" });
      if (projectFilter) qs.set("projectId", projectFilter);
      if (statusFilter) qs.set("status", statusFilter);
      const res = await api.get<APIResponse<ReportListResult>>(
        `/api/v1/reports/?${qs.toString()}`,
        true
      );
      let items = res.success && res.data ? res.data.items : [];
      // When not filtered to a single project, keep only the active org's.
      if (!projectFilter) {
        const ids = orgProjectIds(projects);
        items = items.filter((r) => ids.has(r.projectId));
      }
      set({ reports: items });
    } finally {
      set({ loading: false });
    }
  },

  fetchTransitions: async () => {
    if (get().transitions) return;
    const res = await api.get<APIResponse<TransitionsMap>>("/api/v1/reports/transitions", true);
    if (res.success && res.data) set({ transitions: res.data });
  },

  setProjectFilter: (id) => {
    set({ projectFilter: id });
    get().fetchReports();
  },

  setStatusFilter: (s) => {
    set({ statusFilter: s });
    get().fetchReports();
  },

  updateStatus: async (id, status) => {
    // optimistic
    const prev = get().reports;
    set({ reports: prev.map((r) => (r.id === id ? { ...r, status } : r)) });
    try {
      await api.patch<APIResponse<unknown>>(`/api/v1/reports/${id}`, { status }, true);
    } catch (e) {
      set({ reports: prev }); // revert
      throw e;
    }
  },

  upsertReportFromServer: async () => {
    // Simplest correct behavior for now: refetch the list.
    await get().fetchReports();
  },
}));
