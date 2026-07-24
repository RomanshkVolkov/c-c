import { create } from "zustand";
import { api } from "@/lib/api";
import type { APIResponse } from "@/types/auth";
import type { TelemetryDeviceSummary, TelemetryEventView } from "@/types/telemetry";

interface TelemetryState {
  devices: TelemetryDeviceSummary[];
  loadingDevices: boolean;
  error: string | null;

  selectedDeviceId: string | null;
  timeline: TelemetryEventView[];
  loadingTimeline: boolean;

  fetchDevices: () => Promise<void>;
  selectDevice: (deviceId: string) => Promise<void>;
  reset: () => void;
}

export const useTelemetryStore = create<TelemetryState>()((set, get) => ({
  devices: [],
  loadingDevices: false,
  error: null,
  selectedDeviceId: null,
  timeline: [],
  loadingTimeline: false,

  fetchDevices: async () => {
    set({ loadingDevices: true, error: null });
    try {
      const res = await api.get<APIResponse<TelemetryDeviceSummary[]>>(
        "/api/v1/telemetry/devices",
        true,
      );
      if (!res.success) throw new Error(res.error ?? "Failed to load devices");
      set({ devices: res.data ?? [] });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      set({ loadingDevices: false });
    }
  },

  selectDevice: async (deviceId) => {
    set({ selectedDeviceId: deviceId, loadingTimeline: true, timeline: [] });
    try {
      const res = await api.get<APIResponse<TelemetryEventView[]>>(
        `/api/v1/telemetry/timeline?deviceId=${encodeURIComponent(deviceId)}`,
        true,
      );
      // Only apply if the selection hasn't changed while we awaited.
      if (get().selectedDeviceId !== deviceId) return;
      set({ timeline: res.success && res.data ? res.data : [] });
    } catch {
      if (get().selectedDeviceId === deviceId) set({ timeline: [] });
    } finally {
      if (get().selectedDeviceId === deviceId) set({ loadingTimeline: false });
    }
  },

  reset: () =>
    set({
      devices: [],
      loadingDevices: false,
      error: null,
      selectedDeviceId: null,
      timeline: [],
      loadingTimeline: false,
    }),
}));
