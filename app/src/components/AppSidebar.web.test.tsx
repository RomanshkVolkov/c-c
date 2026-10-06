import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

/**
 * El menú de la versión web (W1).
 *
 * La web no gestiona servidores ni trae las herramientas de desarrollo: sus
 * páginas ni existen en ese build (ver App.tsx). Una fila del menú que lleva a
 * una ruta inexistente acaba en la redirección de inicio, que se lee como un
 * botón roto. Lo que sí tiene que seguir: el trabajo, los canales y los docs.
 * Mutantes: no filtrar «Servers»; dejar las herramientas o el MCP en web.
 */

vi.stubEnv("VITE_TARGET", "web");

const { api } = vi.hoisted(() => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn(), postForm: vi.fn() },
}));
vi.mock("@/lib/api", () => ({ api, apiUrl: (p: string) => `http://localhost${p}`, revokeSession: vi.fn() }));

const { MemoryRouter } = await import("react-router-dom");
const { default: AppSidebar } = await import("@/components/AppSidebar");
const { PromptProvider } = await import("@/components/PromptDialog");
const { ConfirmProvider } = await import("@/components/ConfirmDialog");
const { SidebarProvider } = await import("@/components/ui/sidebar");
const { useAuthStore } = await import("@/store/auth.store");
const { useOrgsStore } = await import("@/store/orgs.store");

const montar = () =>
  render(
    <MemoryRouter>
      <ConfirmProvider>
        <PromptProvider>
          <SidebarProvider>
            <AppSidebar />
          </SidebarProvider>
        </PromptProvider>
      </ConfirmProvider>
    </MemoryRouter>,
  );

beforeEach(() => {
  api.get.mockResolvedValue({ success: true, data: [] });
  useOrgsStore.setState({ currentOrgId: "org-1" } as never);
  useAuthStore.setState({
    session: { id: "u-1", username: "ana", superadmin: false },
    accessToken: "t",
  } as never);
});
afterEach(cleanup);

describe("el menú de la versión web", () => {
  it("no ofrece servidores ni herramientas de desarrollo", () => {
    montar();
    expect(screen.queryByText(/^(servers|servidores)$/i)).toBeNull();
    expect(screen.queryByText(/^(dev ?tools|herramientas)$/i)).toBeNull();
  });

  it("y sí el trabajo, los canales y los docs", () => {
    montar();
    expect(screen.getByText("My work")).toBeTruthy();
    expect(screen.getByText("All docs")).toBeTruthy();
    expect(screen.getByText("Channels")).toBeTruthy();
  });
});
