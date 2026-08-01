import { create } from "zustand";
import { api } from "@/lib/api";
import type { APIResponse } from "@/types/auth";
import type {
  ReportProject,
  ReportListItem,
  ReportListResult,
  ReportDetail,
  ReportStatus,
  ReportCategory,
  ReportPriority,
  ReportTaxonomy,
  TransitionsMap,
  CreateReportProjectResult,
} from "@/types/report";
import { normalizeStatus } from "@/types/report";
import { useOrgsStore } from "@/store/orgs.store";

interface ReportsState {
  projects: ReportProject[];
  reports: ReportListItem[];
  transitions: TransitionsMap | null;
  loading: boolean;
  /** Last load failure, so the board can say "couldn't load" instead of "empty". */
  error: string | null;
  projectFilter: string; // "" = all projects in current org
  statusFilter: ReportStatus | "";
  categoryFilter: ReportCategory | "";
  priorityFilter: ReportPriority | "";
  /** Valid values, fetched once — the server owns the sets, not the client. */
  taxonomy: ReportTaxonomy | null;

  fetchProjects: () => Promise<void>;
  createProject: (payload: {
    name: string;
    allowedOrigins: string[];
    rateLimitPerHour?: number;
  }) => Promise<string>; // returns ingest key (once)
  rotateProjectKey: (id: string) => Promise<string>;
  updateProject: (
    id: string,
    patch: { name: string; allowedOrigins: string[]; rateLimitPerHour: number; isActive?: boolean }
  ) => Promise<void>;
  setProjectActive: (id: string, isActive: boolean) => Promise<void>;
  deleteProject: (id: string) => Promise<void>;
  fetchReports: () => Promise<void>;
  fetchTransitions: () => Promise<void>;
  setProjectFilter: (id: string) => void;
  setStatusFilter: (s: ReportStatus | "") => void;
  setCategoryFilter: (c: ReportCategory | "") => void;
  setPriorityFilter: (p: ReportPriority | "") => void;
  fetchTaxonomy: () => Promise<void>;
  updateStatus: (id: string, status: ReportStatus) => Promise<void>;
  /** merge a single report (from SSE / after mutation) into the list */
  upsertReportFromServer: (id: string) => Promise<void>;

  // ── detail drawer ──
  selectedId: string | null;
  detail: ReportDetail | null;
  detailLoading: boolean;
  openReport: (id: string) => Promise<void>;
  closeReport: () => void;
  refreshDetail: () => Promise<void>;
  changeDetailStatus: (status: ReportStatus) => Promise<void>;
  /** Triage labels. Unlike status they have no state machine, so one setter
   *  covers all three and any value in the set is reachable. */
  changeDetailTaxonomy: (patch: {
    category?: ReportCategory;
    priority?: ReportPriority;
    area?: string;
  }) => Promise<void>;
  addComment: (body: string, files: File[]) => Promise<void>;
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
  error: null,
  projectFilter: "",
  statusFilter: "",
  categoryFilter: "",
  priorityFilter: "",
  taxonomy: null,

  fetchProjects: async () => {
    try {
      const res = await api.get<APIResponse<ReportProject[]>>("/api/v1/report-projects/", true);
      const orgId = useOrgsStore.getState().currentOrgId;
      const all = res.success && res.data ? res.data : [];
      set({ projects: all.filter((p) => p.orgId === orgId), error: null });
    } catch (e) {
      // A failure here left `projects` empty, and the board then claimed the org
      // had no projects — a wrong answer instead of an error.
      set({ error: e instanceof Error ? e.message : "Failed to load projects" });
      throw e;
    }
  },

  createProject: async ({ name, allowedOrigins, rateLimitPerHour }) => {
    const orgId = useOrgsStore.getState().currentOrgId;
    const res = await api.post<APIResponse<CreateReportProjectResult>>(
      "/api/v1/report-projects/",
      { orgId, name, allowedOrigins, rateLimitPerHour },
      true
    );
    if (!res.success || !res.data) throw new Error(res.error ?? "Failed to create project");
    await get().fetchProjects();
    return res.data.ingestKey;
  },

  rotateProjectKey: async (id) => {
    const res = await api.post<APIResponse<{ ingestKey: string }>>(
      `/api/v1/report-projects/${id}/rotate-key`,
      {},
      true
    );
    if (!res.success || !res.data) throw new Error(res.error ?? "Failed to rotate key");
    return res.data.ingestKey;
  },

  updateProject: async (id, patch) => {
    await api.patch<APIResponse<unknown>>(`/api/v1/report-projects/${id}`, patch, true);
    await get().fetchProjects();
  },

  setProjectActive: async (id, isActive) => {
    const p = get().projects.find((x) => x.id === id);
    if (!p) return;
    await get().updateProject(id, {
      name: p.name,
      allowedOrigins: p.allowedOrigins,
      rateLimitPerHour: p.rateLimitPerHour,
      isActive,
    });
  },

  deleteProject: async (id) => {
    await api.delete<APIResponse<unknown>>(`/api/v1/report-projects/${id}`);
    await get().fetchProjects();
  },

  fetchReports: async () => {
    set({ loading: true });
    try {
      const { projectFilter, statusFilter, categoryFilter, priorityFilter, projects } = get();
      const qs = new URLSearchParams({ limit: "200" });
      if (projectFilter) qs.set("projectId", projectFilter);
      if (statusFilter) qs.set("status", statusFilter);
      if (categoryFilter) qs.set("category", categoryFilter);
      if (priorityFilter) qs.set("priority", priorityFilter);
      const res = await api.get<APIResponse<ReportListResult>>(
        `/api/v1/reports/?${qs.toString()}`,
        true
      );
      // Fold the pre-rename spellings on the way in — see normalizeStatus.
      // Without this a report the server still calls "pending" matches no
      // kanban column and simply disappears from the board.
      let items = (res.success && res.data ? res.data.items : []).map((r) => ({
        ...r,
        status: normalizeStatus(r.status),
      }));
      // When not filtered to a single project, keep only the active org's.
      if (!projectFilter) {
        const ids = orgProjectIds(projects);
        items = items.filter((r) => ids.has(r.projectId));
      }
      set({ reports: items, error: null });
    } catch (e) {
      // Without this the failure was invisible: the list stayed empty/stale and
      // nothing told the user (or retried), which read as a frozen app.
      set({ error: e instanceof Error ? e.message : "Failed to load reports" });
    } finally {
      set({ loading: false });
    }
  },

  fetchTransitions: async () => {
    if (get().transitions) return;
    const res = await api.get<APIResponse<TransitionsMap>>("/api/v1/reports/transitions", true);
    if (!res.success || !res.data) return;
    // Both the keys and the values need folding: the board looks up the allowed
    // moves by the status it holds, so a map still keyed "pending" would answer
    // "nothing is allowed" for every card and quietly disable drag-and-drop.
    const folded = Object.fromEntries(
      Object.entries(res.data).map(([from, to]) => [
        normalizeStatus(from),
        (to as string[]).map(normalizeStatus),
      ]),
    ) as TransitionsMap;
    set({ transitions: folded });
  },

  setCategoryFilter: (c) => {
    set({ categoryFilter: c });
    get().fetchReports();
  },

  setPriorityFilter: (p) => {
    set({ priorityFilter: p });
    get().fetchReports();
  },

  fetchTaxonomy: async () => {
    if (get().taxonomy) return;
    const res = await api.get<APIResponse<ReportTaxonomy>>("/api/v1/reports/taxonomy", true);
    if (res.success && res.data) set({ taxonomy: res.data });
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

  // ── detail drawer ──
  selectedId: null,
  detail: null,
  detailLoading: false,

  openReport: async (id) => {
    set({ selectedId: id, detail: null, detailLoading: true });
    try {
      const res = await api.get<APIResponse<ReportDetail>>(`/api/v1/reports/${id}`, true);
      if (res.success && res.data) {
        set({ detail: { ...res.data, status: normalizeStatus(res.data.status) } });
      }
    } finally {
      set({ detailLoading: false });
    }
  },

  closeReport: () => set({ selectedId: null, detail: null }),

  refreshDetail: async () => {
    const id = get().selectedId;
    if (id) await get().openReport(id);
  },

  changeDetailStatus: async (status) => {
    const id = get().selectedId;
    if (!id) return;
    const res = await api.patch<APIResponse<ReportDetail>>(
      `/api/v1/reports/${id}`,
      { status },
      true
    );
    if (res.success && res.data) set({ detail: res.data });
    await get().fetchReports();
  },

  changeDetailTaxonomy: async (patch) => {
    const id = get().selectedId;
    if (!id) return;
    const res = await api.patch<APIResponse<ReportDetail>>(`/api/v1/reports/${id}`, patch, true);
    if (res.success && res.data) {
      set({ detail: { ...res.data, status: normalizeStatus(res.data.status) } });
    }
    await get().fetchReports();
  },

  addComment: async (body, files) => {
    const id = get().selectedId;
    if (!id) return;
    const form = new FormData();
    form.set("body", body);
    for (const f of files) form.append("images", f);
    const res = await api.postForm<APIResponse<ReportDetail>>(
      `/api/v1/reports/${id}/comments`,
      form
    );
    if (res.success && res.data) set({ detail: res.data });
    await get().fetchReports();
  },
}));
