import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

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
 * 6. Un servidor sólo se enseña en su org: al llegar se entra en ella, y si
 *    luego cambias de org, sale al panel (command-and-control-225).
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
const { default: ServerLayout, useServerContext } = await import("./ServerLayout");
const { default: ServerOverview } = await import("./ServerOverview");
const { default: ServerServices } = await import("./ServerServices");
const { default: StackSecrets } = await import("@/pages/StackSecrets");
const { default: ServiceDeploy } = await import("@/pages/servers/ServiceDeploy");
const { useDeploymentsStore } = await import("@/store/deployments.store");
const { useOrgsStore } = await import("@/store/orgs.store");

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
            <Route path="deploy" element={<ServiceDeploy />} />
          </Route>
        </Routes>
      </ConfirmProvider>
    </MemoryRouter>,
  );

beforeEach(() => {
  useOrgsStore.setState({ orgs: [], currentOrgId: null });
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

  // Los secrets que gestiona cac viven en «Despliegue», con lo demás de
  // desplegar: el botón de la fila lleva ahí, con el servicio en la URL.
  // Mutante: seguir llevando a Secrets.
  it("los secrets de un servicio se abren desde su fila, en su página de despliegue", async () => {
    backend(servidor());
    montar("/servers/srv-1/services");
    fireEvent.click(await screen.findByRole("button", { name: /^secrets$/i }));
    await waitFor(() => expect(screen.getByLabelText(/^(elige un servicio|pick a service)$/i).textContent).toContain("beta_app"));
    expect(screen.getByRole("heading", { name: /^(despliegue|deploy)$/i })).toBeTruthy();
  });

  // La página trae la configuración entera, con los secrets del servicio
  // dentro. Mutante: montar el panel sin `full`.
  it("la página de despliegue tiene la configuración y los secrets", async () => {
    backend(servidor());
    useDeploymentsStore.setState({ deployables: {} });
    const backendGet = api.get.getMockImplementation()!;
    api.get.mockImplementation(async (url: string) => {
      if (url.endsWith("/deployables")) {
        return { success: true, data: [{ id: "dp-1", orgId: "org-1", serverId: "srv-1", name: "app", stack: "beta",
          serviceName: "beta_app", imageRepo: "ghcr.io/dwit-mexico/beta-api", environment: "prod", repoFullName: "",
          onCINotify: "record", ciKeyPreview: "", currentImage: "", previousImage: "" }] };
      }
      return backendGet(url);
    });
    montar("/servers/srv-1/deploy?service=beta_app");
    expect(await screen.findByText(/^(rama y build|branch and build)$/i)).toBeTruthy();
    expect(screen.getByText(/^(aviso del ci|ci notice)$/i)).toBeTruthy();
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

  describe("en su org", () => {
    const org = (id: string) => ({ id, name: id }) as never;
    const enOrg = (current: string, mine = ["org-1", "org-2"]) =>
      useOrgsStore.setState({ orgs: mine.map(org), currentOrgId: current });

    // Lo que vio jose: boaty seguía en pantalla con el panel ya en la otra org.
    // Mutante: no mirar la org al cambiar.
    it("cambiar de org con el servidor abierto vuelve al panel", async () => {
      enOrg("org-1");
      backend(servidor());
      montar("/servers/srv-1/services");
      await waitFor(() => expect(screen.getByText("tds")).toBeTruthy());
      act(() => useOrgsStore.getState().setCurrentOrg("org-2"));
      await waitFor(() => expect(screen.getByText("panel de servidores")).toBeTruthy());
      expect(screen.queryByText("tds")).toBeNull();
    });

    // Ni un pintado con el servidor de una org y la pantalla en otra, mientras
    // el efecto saca al panel. Mutante: quitar `foreign` de la puerta del render.
    it("ni un pintado del servidor en la otra org", async () => {
      enOrg("org-1");
      backend(servidor());
      const mismatched: string[] = [];
      function Spy() {
        const { server } = useServerContext();
        const current = useOrgsStore((st) => st.currentOrgId);
        if (server.orgId !== current) mismatched.push(`${server.orgId} en ${current}`);
        return <p>espía</p>;
      }
      render(
        <MemoryRouter initialEntries={["/servers/srv-1"]}>
          <ConfirmProvider>
            <Routes>
              <Route path="/dashboard" element={<p>panel de servidores</p>} />
              <Route path="/servers/:id" element={<ServerLayout />}>
                <Route index element={<Spy />} />
              </Route>
            </Routes>
          </ConfirmProvider>
        </MemoryRouter>,
      );
      await waitFor(() => expect(screen.getByText("espía")).toBeTruthy());
      act(() => useOrgsStore.getState().setCurrentOrg("org-2"));
      await waitFor(() => expect(screen.getByText("panel de servidores")).toBeTruthy());
      expect(mismatched).toEqual([]);
    });

    // Un enlace (un aviso de backup, la actividad) lleva a su org, como `?task=`.
    // Mutante: sacar al panel también al llegar.
    it("llegar desde otra org entra en la del servidor", async () => {
      enOrg("org-2");
      backend(servidor());
      montar("/servers/srv-1");
      await waitFor(() => expect(screen.getByText("tds")).toBeTruthy());
      expect(useOrgsStore.getState().currentOrgId).toBe("org-1");
    });

    // Un superadmin lo recibe del backend aunque no sea de esa org.
    // Mutante: enseñarlo sin poder entrar en su org.
    it("si no es de tus orgs, vuelve al panel aunque el backend lo dé", async () => {
      enOrg("org-2", ["org-2"]);
      backend(servidor());
      montar("/servers/srv-1");
      await waitFor(() => expect(screen.getByText("panel de servidores")).toBeTruthy());
      expect(useOrgsStore.getState().currentOrgId).toBe("org-2");
    });
  });
});
