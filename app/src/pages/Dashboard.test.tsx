import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

/**
 * El panel de servidores ofrece instalar el agente a todo el que no está
 * «online».
 *
 * Hasta la R4 sólo lo ofrecía a «pending» y «error», y un agente que dejó de
 * latir (offline) se quedaba sin ningún botón: ni instalar ni actualizar, justo
 * cuando reinstalarlo es lo que lo arregla.
 */

const { api } = vi.hoisted(() => ({ api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() } }));
vi.mock("@/lib/api", () => ({ api, apiUrl: (p: string) => `http://cac.test${p}` }));
vi.mock("@/lib/agent", () => ({ agentResponde: vi.fn(async () => false), registerAgent: vi.fn() }));
vi.mock("@/components/K8sStatusBadge", () => ({ default: () => null }));

const { MemoryRouter } = await import("react-router-dom");
const { ConfirmProvider } = await import("@/components/ConfirmDialog");
const { useOrgsStore } = await import("@/store/orgs.store");
const { default: Dashboard } = await import("./Dashboard");

const servidor = (id: string, status: string) => ({
  id, orgId: "org-1", name: `srv-${status}`, host: "10.0.0.1", sshPort: 22, sshUser: "root",
  type: "docker-swarm", agentPort: 9090, status, hasAgentToken: true, agentVersion: 3,
});

beforeEach(() => {
  useOrgsStore.setState({ currentOrgId: "org-1" } as never);
  api.get.mockResolvedValue({ success: true, data: [servidor("a", "offline"), servidor("b", "online")] });
});
afterEach(cleanup);

describe("el panel de servidores", () => {
  it("a un agente que dejó de latir le ofrece instalarlo; al vivo, actualizarlo", async () => {
    render(
      <MemoryRouter>
        <ConfirmProvider>
          <Dashboard />
        </ConfirmProvider>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText("srv-offline")).toBeTruthy());
    const fila = (name: string) => screen.getByText(name).closest("tr")!;
    expect(fila("srv-offline").textContent).toMatch(/(deploy agent|desplegar el agente)/i);
    expect(fila("srv-online").textContent).toMatch(/(update agent|actualizar el agente)/i);
  });
});
