import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

/**
 * Un servidor se abre con su URL y nada más.
 *
 * Lo que se fija:
 * 1. El layout pide el servidor por su id: llegar por un enlace o recargar
 *    funciona igual que llegar desde el panel.
 * 2. En Secrets, el servicio sale de `?service=` y de él se deduce el repo,
 *    aunque los servicios lleguen después de pintar.
 * 3. El resumen de un servidor sin nada de cac —ni deployables ni
 *    provisioning, con esos endpoints contestando 404— enseña cómo empezar,
 *    no un error.
 * 4. Un servidor que no es de tu org (404) devuelve al panel.
 * 5. Un kubernetes sigue yendo a su consola.
 */

const { api } = vi.hoisted(() => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));
vi.mock("@/lib/api", () => ({ api, apiUrl: (p: string) => `http://cac.test${p}` }));
const { agentJson } = vi.hoisted(() => ({ agentJson: vi.fn() }));
vi.mock("@/lib/agent", () => ({
  agentBase: (h: string, p: number) => `http://${h}:${p}`,
  agentJson,
  agentFetch: vi.fn(),
  agentStreamUrl: vi.fn(async (u: string) => u),
  registerAgent: vi.fn(),
}));
vi.mock("@/components/terminal/TerminalPanel", () => ({ default: () => null }));
vi.mock("@/pages/K8sHub", () => ({ default: () => <p>consola de kubernetes</p> }));

const { MemoryRouter, Route, Routes } = await import("react-router-dom");
const { ConfirmProvider } = await import("@/components/ConfirmDialog");
const { default: ServerLayout } = await import("./ServerLayout");
const { default: ServerOverview } = await import("./ServerOverview");
const { default: ServerServices } = await import("./ServerServices");
const { default: StackSecrets } = await import("@/pages/StackSecrets");
const { useDeploymentsStore } = await import("@/store/deployments.store");

const servidor = (over: Record<string, unknown> = {}) => ({
  id: "srv-1", orgId: "org-1", name: "tds", host: "10.0.0.1", sshPort: 22, sshUser: "root",
  type: "docker-swarm", agentPort: 9090, status: "online", hasAgentToken: true, agentVersion: 3, ...over,
});

const noEncontrado = () => Promise.reject(new Error("404 Not Found"));

function backend(server: unknown) {
  api.get.mockImplementation((url: string) => {
    if (url === "/api/v1/servers/srv-1") return server ? Promise.resolve({ success: true, data: server }) : noEncontrado();
    // Lo opcional, contestando 404: el resumen no puede caerse por ello.
    return noEncontrado();
  });
}

function agente() {
  agentJson.mockImplementation(async (url: string) =>
    url.endsWith("/services")
      ? {
          success: true,
          data: [
            {
              id: "s1", name: "beta_app", image: "ghcr.io/dwit-mexico/beta-api:abc1234", stack: "beta",
              replicas: { running: 1, desired: 1 }, updatedAt: "2026-09-30T10:00:00Z",
            },
          ],
        }
      : { success: true, data: [] },
  );
}

const montar = (url: string) =>
  render(
    <MemoryRouter initialEntries={[url]}>
      <ConfirmProvider>
        <Routes>
          <Route path="/dashboard" element={<p>panel de servidores</p>} />
          <Route path="/servers/:id" element={<ServerLayout />}>
            <Route index element={<ServerOverview />} />
            <Route path="services" element={<ServerServices />} />
            <Route path="secrets" element={<StackSecrets />} />
          </Route>
        </Routes>
      </ConfirmProvider>
    </MemoryRouter>,
  );

beforeEach(() => {
  useDeploymentsStore.setState({ deployables: {}, history: {}, logs: {}, builds: {} });
  api.post.mockResolvedValue({ success: true, data: {} });
  agente();
});
afterEach(cleanup);

describe("un servidor se abre con su URL", () => {
  it("el resumen sin nada de cac invita a empezar, con lo opcional en 404", async () => {
    backend(servidor());
    montar("/servers/srv-1");
    await waitFor(() => expect(screen.getByText("tds")).toBeTruthy());
    expect(api.get).toHaveBeenCalledWith("/api/v1/servers/srv-1", true);
    await waitFor(() =>
      expect(screen.getByText(/(ningún servicio se despliega todavía|no service deploys from cac yet)/i)).toBeTruthy(),
    );
    expect(screen.getByText(/(ningún playbook|no playbook)/i)).toBeTruthy();
    expect(screen.getByRole("link", { name: /(ir a servicios|go to services)/i }).getAttribute("href")).toBe(
      "/servers/srv-1/services",
    );
  });

  it("en Secrets, el servicio sale de la URL y de él el repo, aunque llegue tarde", async () => {
    backend(servidor());
    montar("/servers/srv-1/secrets?service=beta_app");
    await waitFor(() => expect(screen.getByLabelText(/^(servicio|service)$/i).textContent).toContain("beta_app"));
    await waitFor(() => expect(screen.getByDisplayValue("dwit-mexico")).toBeTruthy());
    expect(screen.getByDisplayValue("beta-api")).toBeTruthy();
  });

  it("los Secrets de un servicio se abren desde su fila, con el servicio en la URL", async () => {
    backend(servidor());
    montar("/servers/srv-1/services");
    fireEvent.click(await screen.findByRole("button", { name: /^secrets$/i }));
    await waitFor(() => expect(screen.getByLabelText(/^(servicio|service)$/i).textContent).toContain("beta_app"));
  });

  it("uno que no es de tu org devuelve al panel", async () => {
    backend(null);
    montar("/servers/srv-1/services");
    await waitFor(() => expect(screen.getByText("panel de servidores")).toBeTruthy());
  });

  it("un agente sin identidad lo dice en el resumen", async () => {
    backend(servidor({ hasAgentToken: false, agentVersion: 0 }));
    montar("/servers/srv-1");
    await waitFor(() => expect(screen.getByText(/(no tiene identidad|has no identity)/i)).toBeTruthy());
  });

  it("un kubernetes va a su consola", async () => {
    backend(servidor({ type: "kubernetes" }));
    montar("/servers/srv-1");
    await waitFor(() => expect(screen.getByText("consola de kubernetes")).toBeTruthy());
  });
});
