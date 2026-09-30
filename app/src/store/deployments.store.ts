import { create } from "zustand";
import { api } from "@/lib/api";
import type { APIResponse } from "@/types/auth";
import type { CIKey, CINotifyMode, CreateDeployablePayload, Deployable, Deployment, ImageBuild } from "@/types/deploy";

/**
 * Los despliegues desde cac: qué servicios de cada servidor se despliegan desde
 * aquí, su historial, y el log en vivo de cada deploy.
 *
 * El deploy lo hace el agente del servidor; lo que llega aquí es lo que va
 * contando, por el stream de eventos (`deploy:status`, `deploy:log`). Por eso
 * el historial se **funde** con lo que llega y no se vuelve a pedir: un deploy
 * que avanza no puede depender de que alguien refresque.
 */
/** Unas líneas más del log de un deploy, tal como las manda el backend. */
export interface DeployLogEvent {
  deploymentId: string;
  deployableId: string;
  lines: string[];
}

interface DeploymentsState {
  deployables: Record<string, Deployable[]>;
  history: Record<string, Deployment[]>;
  logs: Record<string, string>;
  builds: Record<string, ImageBuild[]>;

  loadDeployables: (serverId: string) => Promise<void>;
  createDeployable: (serverId: string, p: CreateDeployablePayload) => Promise<Deployable>;
  deploy: (serverId: string, deployableId: string, sha: string) => Promise<Deployment>;
  rollback: (serverId: string, deployableId: string, deploymentId: string) => Promise<Deployment>;
  loadHistory: (serverId: string, deployableId: string) => Promise<void>;
  loadLog: (serverId: string, deployableId: string, deploymentId: string) => Promise<void>;
  loadBuilds: (serverId: string, deployableId: string) => Promise<void>;
  /** Acuña la llave del CI; la anterior deja de valer. */
  mintCIKey: (serverId: string, deployableId: string) => Promise<CIKey>;
  setCINotify: (serverId: string, d: Deployable, mode: CINotifyMode) => Promise<void>;

  /** Lo que llega por el stream. Públicos para probarlos sin él. */
  onStatus: (d: Deployment) => void;
  onLog: (e: DeployLogEvent) => void;
}

const base = (serverId: string) => `/api/v1/servers/${serverId}/deployables`;

function must<T>(res: APIResponse<T>): T {
  if (!res.success || res.data === undefined) throw new Error(res.error ?? "deploy");
  return res.data;
}

function replace(
  set: (fn: (s: DeploymentsState) => Partial<DeploymentsState>) => void,
  serverId: string,
  deployableId: string,
  patch: Partial<Deployable>,
) {
  set((s) => ({
    deployables: {
      ...s.deployables,
      [serverId]: (s.deployables[serverId] ?? []).map((x) => (x.id === deployableId ? { ...x, ...patch } : x)),
    },
  }));
}

export const useDeploymentsStore = create<DeploymentsState>((set, get) => ({
  deployables: {},
  history: {},
  logs: {},
  builds: {},

  loadDeployables: async (serverId) => {
    const data = must(await api.get<APIResponse<Deployable[]>>(`${base(serverId)}`, true));
    set((s) => ({ deployables: { ...s.deployables, [serverId]: data } }));
  },

  createDeployable: async (serverId, p) => {
    const d = must(await api.post<APIResponse<Deployable>>(base(serverId), p, true));
    set((s) => ({ deployables: { ...s.deployables, [serverId]: [...(s.deployables[serverId] ?? []), d] } }));
    return d;
  },

  deploy: async (serverId, deployableId, sha) => {
    const d = must(await api.post<APIResponse<Deployment>>(`${base(serverId)}/${deployableId}/deploy`, { sha }, true));
    get().onStatus(d);
    return d;
  },

  rollback: async (serverId, deployableId, deploymentId) => {
    const d = must(
      await api.post<APIResponse<Deployment>>(
        `${base(serverId)}/${deployableId}/deployments/${deploymentId}/rollback`,
        {},
        true,
      ),
    );
    get().onStatus(d);
    return d;
  },

  loadHistory: async (serverId, deployableId) => {
    const data = must(await api.get<APIResponse<Deployment[]>>(`${base(serverId)}/${deployableId}/deployments`, true));
    set((s) => ({ history: { ...s.history, [deployableId]: data } }));
  },

  loadLog: async (serverId, deployableId, deploymentId) => {
    const d = must(
      await api.get<APIResponse<Deployment>>(`${base(serverId)}/${deployableId}/deployments/${deploymentId}`, true),
    );
    set((s) => ({ logs: { ...s.logs, [deploymentId]: d.log ?? "" } }));
  },

  loadBuilds: async (serverId, deployableId) => {
    const data = must(await api.get<APIResponse<ImageBuild[]>>(`${base(serverId)}/${deployableId}/builds`, true));
    set((s) => ({ builds: { ...s.builds, [deployableId]: data } }));
  },

  mintCIKey: async (serverId, deployableId) => {
    const k = must(await api.post<APIResponse<CIKey>>(`${base(serverId)}/${deployableId}/ci-key`, {}, true));
    replace(set, serverId, deployableId, { ciKeyPreview: k.preview });
    return k;
  },

  setCINotify: async (serverId, d, mode) => {
    // El PATCH pide la fila entera: lo demás va como está.
    const next = must(
      await api.patch<APIResponse<Deployable>>(
        `${base(serverId)}/${d.id}`,
        { name: d.name, environment: d.environment, repoFullName: d.repoFullName, onCINotify: mode },
        true,
      ),
    );
    replace(set, serverId, d.id, next);
  },

  onStatus: (d) =>
    set((s) => {
      // Un evento que no se pudo leer llega vacío: no hay fila que tocar.
      if (!d?.id || !d.deployableId) return s;
      const list = s.history[d.deployableId] ?? [];
      const i = list.findIndex((x) => x.id === d.id);
      // Se funde con lo que ya había, no se sustituye: el evento es un
      // `Deployment` del backend, que no lleva el nombre de quien lo pidió, y
      // sustituir la fila le quitaría el autor al avanzar.
      const next = i >= 0 ? list.map((x, j) => (j === i ? { ...x, ...d } : x)) : [d, ...list];
      return { history: { ...s.history, [d.deployableId]: next } };
    }),

  onLog: ({ deploymentId, lines }) =>
    set((s) =>
      !deploymentId || !Array.isArray(lines)
        ? s
        : { logs: { ...s.logs, [deploymentId]: (s.logs[deploymentId] ?? "") + lines.join("\n") + "\n" } },
    ),
}));
