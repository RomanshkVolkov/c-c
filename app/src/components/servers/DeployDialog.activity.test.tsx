import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

/**
 * El acceso directo del diálogo de deploy a la Actividad (R9).
 *
 * El diálogo no navega: le dice a quien lo montó a qué servicio y de qué org
 * ir, y se cierra. Así se prueba sin router, y la org viaja para que
 * `goInOrg` cambie de org antes de navegar si hace falta. Sin servicio
 * registrado no hay a dónde ir, y el botón no está.
 */

const { get, post, patch } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: { get, post, patch }, apiUrl: (p: string) => `https://cac.test${p}` }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@/components/ConfirmDialog", () => ({ useConfirm: () => vi.fn() }));
vi.mock("sonner", () => ({ toast: { info: vi.fn(), error: vi.fn(), success: vi.fn() } }));

const { default: DeployDialog } = await import("./DeployDialog");
const { useDeploymentsStore } = await import("@/store/deployments.store");
import type { Server } from "@/types/server";
import type { SwarmService } from "@/types/swarm";

const server = {
  id: "srv-1", orgId: "org-1", name: "tds", host: "10.0.0.1", sshPort: 22, sshUser: "root",
  type: "docker-swarm", agentPort: 9090, status: "online", hasAgentToken: true, agentVersion: 3,
} as Server;
const service: SwarmService = {
  id: "s1", name: "beta-api-prod_app", image: "ghcr.io/dwit-mexico/api:viejo", stack: "beta-api-prod",
  replicas: { running: 1, desired: 1 }, updatedAt: "2026-09-30T10:00:00Z",
};
const deployable = {
  id: "dp-1", orgId: "org-7", serverId: "srv-1", name: "app", stack: "beta-api-prod",
  serviceName: "beta-api-prod_app", imageRepo: "ghcr.io/dwit-mexico/api", environment: "prod",
  repoFullName: "", onCINotify: "record", ciKeyPreview: "", currentImage: "", previousImage: "",
};

beforeEach(() => {
  useDeploymentsStore.setState({ deployables: {}, history: {}, logs: {}, builds: {} });
  get.mockImplementation(async (url: string) => {
    if (url.endsWith("/deployables")) return { success: true, data: [deployable] };
    return { success: true, data: [] };
  });
  invoke.mockImplementation(async (cmd: string) => (cmd === "github_token_configured" ? false : []));
});
afterEach(cleanup);

describe("el acceso directo a la actividad", () => {
  it("dice el servicio y su org, y cierra el diálogo", async () => {
    const onOpenActivity = vi.fn();
    const onOpenChange = vi.fn();
    render(<DeployDialog server={server} service={service} open onOpenChange={onOpenChange} onOpenActivity={onOpenActivity} />);
    const button = await screen.findByRole("button", { name: /^(activity|actividad)$/i });
    fireEvent.click(button);
    expect(onOpenActivity).toHaveBeenCalledWith("dp-1", "org-7");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("sin quien navegue, no hay botón", async () => {
    render(<DeployDialog server={server} service={service} open onOpenChange={() => {}} />);
    await screen.findByText(/prod/);
    expect(screen.queryByRole("button", { name: /^(activity|actividad)$/i })).toBeNull();
  });
});
