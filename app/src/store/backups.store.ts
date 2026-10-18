import { create } from "zustand";
import { api } from "@/lib/api";
import type { APIResponse } from "@/types/auth";
import type {
  Backup,
  BackupLogEvent,
  BackupRecipient,
  BackupsStatus,
  BackupTarget,
  BackupTargetPayload,
} from "@/types/backups";

/**
 * Los backups de bases de cada servidor (#166): qué bases se respaldan, su
 * historial y el log en vivo.
 *
 * Como los deploys: el backup lo hace el agente y lo que llega aquí es lo que
 * va contando por el stream (`backup:status`, `backup:log`). El historial se
 * funde con lo que llega y no se vuelve a pedir.
 */
interface BackupsState {
  status: Record<string, BackupsStatus>;
  targets: Record<string, BackupTarget[]>;
  recipients: Record<string, BackupRecipient[]>;
  history: Record<string, Backup[]>;
  logs: Record<string, string>;

  load: (serverId: string) => Promise<void>;
  saveTarget: (serverId: string, p: BackupTargetPayload, id?: string) => Promise<BackupTarget>;
  deleteTarget: (serverId: string, id: string) => Promise<void>;
  runNow: (serverId: string, targetId: string) => Promise<Backup>;
  testNow: (serverId: string, targetId: string) => Promise<Backup>;
  loadHistory: (serverId: string, targetId: string) => Promise<void>;
  loadLog: (serverId: string, backupId: string) => Promise<void>;
  /** Una URL de cinco minutos al fichero cifrado. */
  downloadUrl: (serverId: string, backupId: string) => Promise<string>;
  addRecipient: (serverId: string, label: string, publicKey: string) => Promise<void>;
  deleteRecipient: (serverId: string, id: string) => Promise<void>;

  /** Lo que llega por el stream. Públicos para probarlos sin él. */
  onStatus: (b: Backup) => void;
  onLog: (e: BackupLogEvent) => void;
}

const base = (serverId: string) => `/api/v1/servers/${serverId}/backups`;

function must<T>(res: APIResponse<T>): T {
  if (!res.success || res.data === undefined) throw new Error(res.error ?? "backups");
  return res.data;
}

export const useBackupsStore = create<BackupsState>((set, get) => ({
  status: {},
  targets: {},
  recipients: {},
  history: {},
  logs: {},

  load: async (serverId) => {
    const [status, targets, recipients] = await Promise.all([
      api.get<APIResponse<BackupsStatus>>(`${base(serverId)}/status`, true),
      api.get<APIResponse<BackupTarget[]>>(`${base(serverId)}/targets`, true),
      api.get<APIResponse<BackupRecipient[]>>(`${base(serverId)}/recipients`, true),
    ]);
    set((s) => ({
      status: { ...s.status, [serverId]: must(status) },
      targets: { ...s.targets, [serverId]: must(targets) },
      recipients: { ...s.recipients, [serverId]: must(recipients) },
    }));
  },

  saveTarget: async (serverId, p, id) => {
    const t = id
      ? must(await api.patch<APIResponse<BackupTarget>>(`${base(serverId)}/targets/${id}`, p, true))
      : must(await api.post<APIResponse<BackupTarget>>(`${base(serverId)}/targets`, p, true));
    set((s) => {
      const list = s.targets[serverId] ?? [];
      const next = id ? list.map((x) => (x.id === id ? t : x)) : [...list, t];
      return { targets: { ...s.targets, [serverId]: next } };
    });
    return t;
  },

  deleteTarget: async (serverId, id) => {
    await api.delete(`${base(serverId)}/targets/${id}`, true);
    set((s) => ({ targets: { ...s.targets, [serverId]: (s.targets[serverId] ?? []).filter((x) => x.id !== id) } }));
  },

  runNow: async (serverId, targetId) => {
    const b = must(await api.post<APIResponse<Backup>>(`${base(serverId)}/targets/${targetId}/run`, {}, true));
    get().onStatus(b);
    return b;
  },

  testNow: async (serverId, targetId) => {
    const b = must(await api.post<APIResponse<Backup>>(`${base(serverId)}/targets/${targetId}/test`, {}, true));
    get().onStatus(b);
    return b;
  },

  loadHistory: async (serverId, targetId) => {
    const list = must(await api.get<APIResponse<Backup[]>>(`${base(serverId)}/targets/${targetId}/history`, true));
    set((s) => ({ history: { ...s.history, [targetId]: list } }));
  },

  loadLog: async (serverId, backupId) => {
    const b = must(await api.get<APIResponse<Backup>>(`${base(serverId)}/runs/${backupId}`, true));
    set((s) => ({ logs: { ...s.logs, [backupId]: b.log ?? "" } }));
  },

  downloadUrl: async (serverId, backupId) => {
    const r = must(await api.post<APIResponse<{ url: string }>>(`${base(serverId)}/runs/${backupId}/download`, {}, true));
    return r.url;
  },

  addRecipient: async (serverId, label, publicKey) => {
    const rc = must(await api.post<APIResponse<BackupRecipient>>(`${base(serverId)}/recipients`, { label, publicKey }, true));
    set((s) => ({ recipients: { ...s.recipients, [serverId]: [...(s.recipients[serverId] ?? []), rc] } }));
  },

  deleteRecipient: async (serverId, id) => {
    await api.delete(`${base(serverId)}/recipients/${id}`, true);
    set((s) => ({
      recipients: { ...s.recipients, [serverId]: (s.recipients[serverId] ?? []).filter((x) => x.id !== id) },
    }));
  },

  onStatus: (b) =>
    set((s) => {
      const list = s.history[b.targetId] ?? [];
      const i = list.findIndex((x) => x.id === b.id);
      const next = i >= 0 ? list.map((x) => (x.id === b.id ? { ...x, ...b } : x)) : [b, ...list];
      return { history: { ...s.history, [b.targetId]: next } };
    }),

  onLog: (e) =>
    set((s) => ({
      logs: { ...s.logs, [e.backupId]: (s.logs[e.backupId] ?? "") + e.lines.join("\n") + "\n" },
    })),
}));
