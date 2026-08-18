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
    rateLimitPerReporterPerHour?: number;
    /** "web" polices the Origin header; "app" is for server-to-server callers,
     *  which send none. Set at creation — it decides how the project is
     *  authenticated, not a display preference. */
    platform?: "web" | "app";
    webhookUrl?: string;
    webhookSecret?: string;
  }) => Promise<string>; // returns ingest key (once)
  rotateProjectKey: (id: string) => Promise<string>;
  updateProject: (
    id: string,
    patch: {
      name: string;
      allowedOrigins: string[];
      rateLimitPerHour: number;
      rateLimitPerReporterPerHour?: number;
      isActive?: boolean;
      webhookUrl?: string;
      /** Omit to keep the current secret; "" alongside an empty url clears it. */
      webhookSecret?: string;
      /** "" lo quita; un uuid lo pone. */
      defaultAssigneeUserId?: string;
    }
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
  editComment: (
    commentId: string,
    edit: { body?: string; add?: File[]; removeImageIds?: string[] }
  ) => Promise<void>;
  deleteComment: (commentId: string) => Promise<void>;
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

  createProject: async ({ name, allowedOrigins, rateLimitPerHour, rateLimitPerReporterPerHour, platform, webhookUrl, webhookSecret }) => {
    const orgId = useOrgsStore.getState().currentOrgId;
    const res = await api.post<APIResponse<CreateReportProjectResult>>(
      "/api/v1/report-projects/",
      { orgId, name, allowedOrigins, rateLimitPerHour, rateLimitPerReporterPerHour, platform, webhookUrl, webhookSecret },
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

  // Pausar y reanudar mandan el proyecto **entero**, no sólo la bandera.
  //
  // El PATCH del servidor reemplaza, no fusiona: lo que no viaja se guarda
  // vacío. Mandando sólo nombre, orígenes y límites, pausar una integración le
  // borraba el webhook, su secreto y el responsable por defecto —y reanudarla
  // no los devolvía, porque ya no existían.
  setProjectActive: async (id, isActive) => {
    const p = get().projects.find((x) => x.id === id);
    if (!p) return;
    await get().updateProject(id, {
      name: p.name,
      allowedOrigins: p.allowedOrigins,
      rateLimitPerHour: p.rateLimitPerHour,
      rateLimitPerReporterPerHour: p.rateLimitPerReporterPerHour,
      isActive,
      webhookUrl: p.webhookUrl,
      // El secreto no se manda: el servidor sólo lo cambia si llega uno nuevo,
      // y aquí no hay ninguno que mandar. Va con la url para que no lo retire.
      defaultAssigneeUserId: p.defaultAssigneeUserId ?? "",
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
      // Scope at the source. The narrowing below still runs, because the app
      // ships separately from the server and may be talking to one that
      // doesn't know this parameter yet — but on a current server another
      // tenant's reports no longer cross the wire at all.
      const orgId = useOrgsStore.getState().currentOrgId;
      if (orgId) qs.set("orgId", orgId);
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
    if (!id) return;
    // Deliberately NOT openReport: that blanks `detail` before fetching, and the
    // drawer renders its comment box inside `{detail && …}`. Blanking unmounts
    // the box, so a live event arriving while you type throws away the text and
    // any screenshot you had pasted. Refetch and swap in place instead — no
    // flash, no lost draft.
    try {
      const res = await api.get<APIResponse<ReportDetail>>(`/api/v1/reports/${id}`, true);
      if (res.success && res.data && get().selectedId === id) {
        set({ detail: { ...res.data, status: normalizeStatus(res.data.status) } });
      }
    } catch {
      // A failed background refresh keeps whatever is on screen; the connection
      // banner already tells the user the stream is unhappy.
    }
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

  editComment: async (commentId, edit) => {
    const id = get().selectedId;
    if (!id) return;
    // multipart, because one edit carries text and files together — sending
    // them as separate requests is how half of an edit lands.
    const form = new FormData();
    if (edit.body !== undefined) form.set("body", edit.body);
    for (const f of edit.add ?? []) form.append("images", f);
    for (const rid of edit.removeImageIds ?? []) form.append("removeImageIds", rid);
    const res = await api.patchForm<APIResponse<ReportDetail>>(
      `/api/v1/reports/${id}/comments/${commentId}`,
      form
    );
    if (res.success && res.data) set({ detail: res.data });
  },

  deleteComment: async (commentId) => {
    const id = get().selectedId;
    if (!id) return;
    await api.delete<APIResponse<unknown>>(`/api/v1/reports/${id}/comments/${commentId}`);
    // Delete still answers with a message, and the list's comment count moves.
    await get().refreshDetail();
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
