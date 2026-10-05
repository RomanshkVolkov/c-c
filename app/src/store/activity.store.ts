import { create } from "zustand";
import { api } from "@/lib/api";
import type { APIResponse } from "@/types/auth";
import type { Deployment } from "@/types/deploy";
import type { ActivityDeployment, ActivityEntry, ActivityFilter, ActivityPage, WorkflowRun } from "@/types/activity";

/**
 * La actividad de CI de la org (R9): lo que se cargó por páginas, y lo que va
 * llegando por el stream (`ci:run` y `deploy:status`) **fundido** encima, sin
 * volver a pedir. Un run que pasa de «en curso» a «terminó» mientras alguien
 * mira la página tiene que cambiar de color solo.
 *
 * El feed lo ordena el servidor y aquí se respeta: lo que llega en vivo se
 * coloca por su `at` (el `created_at` del run, o el del deploy), que no cambia
 * entre eventos, así que una fila que avanza no salta de sitio.
 */
interface ActivityState {
  orgId: string | null;
  filter: ActivityFilter;
  entries: ActivityEntry[];
  hasMore: boolean;
  loading: boolean;
  error: string | null;

  load: (orgId: string, filter: ActivityFilter) => Promise<void>;
  loadMore: () => Promise<void>;

  /** Lo que llega por el stream. Públicos para probarlos sin él. */
  onRun: (run: WorkflowRun) => void;
  onDeployStatus: (d: Deployment) => void;
}

const PAGE = 50;

function must<T>(res: APIResponse<T>): T {
  if (!res.success || res.data === undefined) throw new Error(res.error ?? "activity");
  return res.data;
}

function query(filter: ActivityFilter, cursor?: ActivityEntry): string {
  const q = new URLSearchParams();
  if (filter.repo) q.set("repo", filter.repo);
  if (filter.deployableId) q.set("deployableId", filter.deployableId);
  q.set("limit", String(PAGE));
  if (cursor) {
    q.set("before", cursor.at);
    q.set("beforeId", idOf(cursor));
  }
  return q.toString();
}

/** El id de la fila, sea run o deploy: lo que el cursor necesita como desempate. */
export function idOf(e: ActivityEntry): string {
  return e.kind === "run" ? e.run.id : e.deployment.id;
}

/**
 * Si una entrada cae dentro del filtro de la página. Lo que llega en vivo es de
 * toda la org, y una página filtrada por repo no puede dejar colar el run de
 * otro. Por servicio no se puede decidir aquí —qué run es de qué servicio lo
 * sabe el servidor, por su workflow de build—, así que con ese filtro un run
 * nuevo no entra en vivo (su deploy, que sí lleva `deployableId`, sí).
 */
export function matchesFilter(e: ActivityEntry, filter: ActivityFilter): boolean {
  if (e.kind === "run") {
    if (filter.deployableId) return false;
    if (filter.repo && e.run.repoFullName.toLowerCase() !== filter.repo.toLowerCase()) return false;
    return true;
  }
  if (filter.deployableId && e.deployment.deployableId !== filter.deployableId) return false;
  // Un deploy en vivo no dice de qué repo es su servicio: con filtro por repo
  // sólo entra si ya estaba (se funde abajo), no como fila nueva.
  if (filter.repo) return false;
  return true;
}

/**
 * Funde un deploy con lo que ya había de él. El evento es el `Deployment` crudo
 * del backend: no trae el nombre del servicio, su entorno ni el de quien lo
 * pidió, y un evento que llega sin ellos no puede borrárselos a la fila.
 */
function mergeDeployment(prev: ActivityDeployment, next: ActivityDeployment): ActivityDeployment {
  return {
    ...prev,
    ...next,
    deployableName: next.deployableName || prev.deployableName,
    deployableEnv: next.deployableEnv || prev.deployableEnv,
    requestedByName: next.requestedByName || prev.requestedByName,
  };
}

/**
 * Funde una entrada: si ya estaba, la pisa conservando lo que el evento no
 * trae (el nombre de quien pidió un deploy, los deploys colgados de un run);
 * si no, entra en su sitio por `at`, el más nuevo primero.
 */
export function upsertEntry(entries: ActivityEntry[], e: ActivityEntry): ActivityEntry[] {
  const id = idOf(e);
  const i = entries.findIndex((x) => x.kind === e.kind && idOf(x) === id);
  if (i >= 0) {
    const prev = entries[i];
    const merged: ActivityEntry =
      e.kind === "run" && prev.kind === "run"
        ? { ...prev, run: { ...prev.run, ...e.run }, deployments: e.deployments ?? prev.deployments }
        : e.kind === "deployment" && prev.kind === "deployment"
          ? { ...prev, deployment: mergeDeployment(prev.deployment, e.deployment) }
          : e;
    return entries.map((x, j) => (j === i ? merged : x));
  }
  const at = entries.findIndex((x) => x.at < e.at || (x.at === e.at && idOf(x) < id));
  if (at < 0) return [...entries, e];
  return [...entries.slice(0, at), e, ...entries.slice(at)];
}

/** Cuelga un deploy de su run, si el run está en la página. */
function hangOnRun(entries: ActivityEntry[], dep: ActivityDeployment): ActivityEntry[] {
  if (!dep.workflowRunId) return entries;
  return entries.map((x) => {
    if (x.kind !== "run" || x.run.id !== dep.workflowRunId) return x;
    const list = x.deployments ?? [];
    const i = list.findIndex((d) => d.id === dep.id);
    const next = i >= 0 ? list.map((d, j) => (j === i ? mergeDeployment(d, dep) : d)) : [...list, dep];
    return { ...x, deployments: next };
  });
}

export const useActivityStore = create<ActivityState>((set, get) => ({
  orgId: null,
  filter: {},
  entries: [],
  hasMore: false,
  loading: false,
  error: null,

  load: async (orgId, filter) => {
    set({ orgId, filter, loading: true, error: null });
    try {
      const page = must(await api.get<APIResponse<ActivityPage>>(`/api/v1/organizations/${orgId}/activity/?${query(filter)}`, true));
      // Si entre tanto se pidió otra cosa, lo que llega ya no es de esta página.
      if (get().orgId !== orgId || get().filter !== filter) return;
      set({ entries: page.items ?? [], hasMore: page.hasMore, loading: false });
    } catch (e) {
      set({ loading: false, error: e instanceof Error ? e.message : String(e) });
    }
  },

  loadMore: async () => {
    const { orgId, filter, entries, hasMore, loading } = get();
    if (!orgId || !hasMore || loading || entries.length === 0) return;
    set({ loading: true });
    try {
      const last = entries[entries.length - 1];
      const page = must(
        await api.get<APIResponse<ActivityPage>>(`/api/v1/organizations/${orgId}/activity/?${query(filter, last)}`, true),
      );
      if (get().orgId !== orgId || get().filter !== filter) return;
      let next = get().entries;
      for (const e of page.items ?? []) next = upsertEntry(next, e);
      set({ entries: next, hasMore: page.hasMore, loading: false });
    } catch (e) {
      set({ loading: false, error: e instanceof Error ? e.message : String(e) });
    }
  },

  onRun: (run) =>
    set((s) => {
      if (!run?.id || !s.orgId || run.orgId !== s.orgId) return s;
      const e: ActivityEntry = { kind: "run", at: run.occurredAt, run };
      const exists = s.entries.some((x) => x.kind === "run" && x.run.id === run.id);
      if (!exists && !matchesFilter(e, s.filter)) return s;
      return { entries: upsertEntry(s.entries, e) };
    }),

  onDeployStatus: (d) =>
    set((s) => {
      if (!d?.id || !s.orgId) return s;
      const dep = d as ActivityDeployment;
      // El evento trae el `Deployment` crudo: sin nombre de servicio ni de
      // quien lo pidió. Al fundirse con una fila que ya estaba los conserva;
      // como fila nueva entra con lo que hay, y el servidor lo completa al
      // recargar.
      const e: ActivityEntry = { kind: "deployment", at: dep.createdAt, deployment: dep };
      const exists = s.entries.some((x) => x.kind === "deployment" && x.deployment.id === dep.id);
      let entries = hangOnRun(s.entries, dep);
      if (exists || (matchesFilter(e, s.filter) && (!dep.orgId || dep.orgId === s.orgId))) {
        entries = upsertEntry(entries, e);
      }
      return { entries };
    }),
}));
