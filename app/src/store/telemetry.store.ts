import { create } from "zustand";
import { api } from "@/lib/api";
import type { APIResponse } from "@/types/auth";
import type {
  TelemetryDeviceDetail,
  TelemetryDeviceSummary,
  TelemetryEventView,
  TimelineFilters,
} from "@/types/telemetry";

/** Un dispositivo se elige por proyecto **y** id: el mismo teléfono puede
 *  mandar a dos proyectos, y elegir sólo por id mezclaba sus timelines. */
export interface DeviceRef {
  projectId: string;
  deviceId: string;
}

export const DEVICE_PAGE = 100;
export const TIMELINE_PAGE = 100;

export const DEFAULT_FILTERS: TimelineFilters = {
  types: [],
  minSeverity: "info",
  sessionId: "",
  sinceHours: 0,
  text: "",
};

interface TelemetryState {
  devices: TelemetryDeviceSummary[];
  /** El cursor de la siguiente página, si la hay. */
  devicesCursor: string | null;
  query: string;
  loadingDevices: boolean;
  error: string | null;

  selected: DeviceRef | null;
  detail: TelemetryDeviceDetail | null;
  detailError: string | null;

  timeline: TelemetryEventView[];
  /** `receivedAt` del último lote, si puede haber más. */
  timelineBefore: string | null;
  loadingTimeline: boolean;
  timelineError: string | null;
  filters: TimelineFilters;

  fetchDevices: (more?: boolean) => Promise<void>;
  setQuery: (q: string) => Promise<void>;
  select: (ref: DeviceRef) => Promise<void>;
  setFilters: (patch: Partial<TimelineFilters>) => Promise<void>;
  loadMoreTimeline: () => Promise<void>;
  reset: () => void;
}

const same = (a: DeviceRef | null, b: DeviceRef | null) =>
  !!a && !!b && a.projectId === b.projectId && a.deviceId === b.deviceId;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** La consulta del timeline. El texto libre se filtra aquí, no en el servidor. */
export function timelinePath(ref: DeviceRef, f: TimelineFilters, before: string | null, now = Date.now()): string {
  const q = new URLSearchParams({
    deviceId: ref.deviceId,
    projectId: ref.projectId,
    limit: String(TIMELINE_PAGE),
  });
  if (f.sessionId) q.set("sessionId", f.sessionId);
  if (f.types.length) q.set("types", f.types.join(","));
  if (f.minSeverity !== "info") q.set("minSeverity", f.minSeverity);
  if (f.sinceHours > 0) q.set("since", String(now - f.sinceHours * 3_600_000));
  if (before) q.set("before", before);
  return `/api/v1/telemetry/timeline?${q.toString()}`;
}

export const useTelemetryStore = create<TelemetryState>()((set, get) => {
  /** Pide una página del timeline del dispositivo elegido. */
  const loadTimeline = async (more: boolean) => {
    const ref = get().selected;
    if (!ref) return;
    const filters = get().filters;
    const before = more ? get().timelineBefore : null;
    set({ loadingTimeline: true, timelineError: null, ...(more ? {} : { timeline: [], timelineBefore: null }) });
    try {
      const res = await api.get<APIResponse<TelemetryEventView[]>>(timelinePath(ref, filters, before), true);
      // Sólo si nadie cambió la selección ni los filtros mientras esperábamos.
      if (!same(get().selected, ref) || get().filters !== filters) return;
      if (!res.success) throw new Error(res.error ?? "Failed to load the timeline");
      const page = res.data ?? [];
      set({
        timeline: more ? [...get().timeline, ...page] : page,
        // El servidor limita por lotes, así que una página llena puede tener
        // más detrás; con filtro, menos lotes no quiere decir que se acabó.
        timelineBefore: page.length >= TIMELINE_PAGE ? page[page.length - 1].receivedAt : null,
      });
    } catch (e) {
      if (same(get().selected, ref)) set({ timelineError: message(e) });
    } finally {
      if (same(get().selected, ref) && get().filters === filters) set({ loadingTimeline: false });
    }
  };

  return {
    devices: [],
    devicesCursor: null,
    query: "",
    loadingDevices: false,
    error: null,
    selected: null,
    detail: null,
    detailError: null,
    timeline: [],
    timelineBefore: null,
    loadingTimeline: false,
    timelineError: null,
    filters: DEFAULT_FILTERS,

    fetchDevices: async (more = false) => {
      const query = get().query;
      const cursor = more ? get().devicesCursor : null;
      if (more && !cursor) return;
      set({ loadingDevices: true, error: null });
      try {
        const q = new URLSearchParams({ limit: String(DEVICE_PAGE) });
        if (query.trim()) q.set("q", query.trim());
        if (cursor) q.set("cursor", cursor);
        const res = await api.get<APIResponse<TelemetryDeviceSummary[]>>(`/api/v1/telemetry/devices?${q}`, true);
        if (get().query !== query) return;
        if (!res.success) throw new Error(res.error ?? "Failed to load devices");
        const page = res.data ?? [];
        set({
          devices: more ? [...get().devices, ...page] : page,
          devicesCursor: page[page.length - 1]?.cursor ?? null,
        });
      } catch (e) {
        if (get().query === query) set({ error: message(e) });
      } finally {
        if (get().query === query) set({ loadingDevices: false });
      }
    },

    setQuery: async (q) => {
      set({ query: q, devicesCursor: null });
      await get().fetchDevices();
    },

    select: async (ref) => {
      set({
        selected: ref, detail: null, detailError: null,
        timeline: [], timelineBefore: null, timelineError: null,
        // La sesión es de un dispositivo: no tiene sentido llevarla a otro.
        filters: { ...get().filters, sessionId: "" },
      });
      const detail = (async () => {
        try {
          const res = await api.get<APIResponse<TelemetryDeviceDetail>>(
            `/api/v1/telemetry/devices/${encodeURIComponent(ref.projectId)}/${encodeURIComponent(ref.deviceId)}`,
            true,
          );
          if (!same(get().selected, ref)) return;
          if (!res.success || !res.data) throw new Error(res.error ?? "Failed to load the device");
          set({ detail: res.data });
        } catch (e) {
          if (same(get().selected, ref)) set({ detailError: message(e) });
        }
      })();
      await Promise.all([detail, loadTimeline(false)]);
    },

    setFilters: async (patch) => {
      const next = { ...get().filters, ...patch };
      set({ filters: next });
      // El texto se filtra en pantalla: no hace falta volver a pedir.
      const keys = Object.keys(patch);
      if (keys.length === 1 && keys[0] === "text") return;
      await loadTimeline(false);
    },

    loadMoreTimeline: () => loadTimeline(true),

    reset: () =>
      set({
        devices: [], devicesCursor: null, query: "", loadingDevices: false, error: null,
        selected: null, detail: null, detailError: null,
        timeline: [], timelineBefore: null, loadingTimeline: false, timelineError: null,
        filters: DEFAULT_FILTERS,
      }),
  };
});
