import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

/**
 * Qué módulo manda en el panel, según dónde estés.
 *
 * Lo decide la ruta, y nada más. Leer la documentación de una lista en
 * `/tasks` (su pestaña «Documentación») sigue siendo Trabajo: hasta el
 * 13-oct-2026 cambiaba a Documentación, y pasar entre las pestañas de una
 * lista hacía saltar el panel de un módulo a otro. Mutante: volver a mirar el
 * documento abierto.
 */

const { api } = vi.hoisted(() => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn(), postForm: vi.fn() },
}));
vi.mock("@/lib/api", () => ({ api, apiUrl: (p: string) => `http://localhost${p}` }));

const { MemoryRouter } = await import("react-router-dom");
const { default: AppSidebar } = await import("@/components/AppSidebar");
const { PromptProvider } = await import("@/components/PromptDialog");
const { ConfirmProvider } = await import("@/components/ConfirmDialog");
const { SidebarProvider } = await import("@/components/ui/sidebar");
const { useAuthStore } = await import("@/store/auth.store");
const { useOrgsStore } = await import("@/store/orgs.store");
const { useTasksStore } = await import("@/store/tasks.store");
const { useLayoutStore } = await import("@/store/layout.store");

const mount = (url: string) =>
  render(
    <MemoryRouter initialEntries={[url]}>
      <ConfirmProvider>
        <PromptProvider>
          <SidebarProvider>
            <AppSidebar />
          </SidebarProvider>
        </PromptProvider>
      </ConfirmProvider>
    </MemoryRouter>,
  );

const heading = () => screen.getByRole("heading", { level: 2 }).textContent;

beforeEach(() => {
  api.get.mockResolvedValue({ success: true, data: [] });
  useOrgsStore.setState({ currentOrgId: "org-1" } as never);
  useAuthStore.setState({ session: { id: "u-1", username: "ana", superadmin: false }, accessToken: "t" } as never);
  useTasksStore.setState({ activeDoc: null } as never);
  useLayoutStore.setState({ activeModule: "work", lastRoute: {}, panelOpen: true, expanded: {} });
});
afterEach(cleanup);

describe("el módulo del panel", () => {
  it("el tablero es Trabajo", () => {
    mount("/tasks");
    expect(heading()).toBe("Work");
    expect(useLayoutStore.getState().lastRoute.work).toBe("/tasks");
  });

  it("leer la documentación de una lista en el tablero sigue siendo Trabajo", () => {
    useTasksStore.setState({ activeDoc: { kind: "list", id: "li-1", name: "Backlog", orgId: "org-1" } } as never);
    mount("/tasks");
    expect(heading()).toBe("Work");
    expect(useLayoutStore.getState().lastRoute.work).toBe("/tasks");
    expect(useLayoutStore.getState().lastRoute.docs).toBeUndefined();
  });

  it("en /docs es Documentación", () => {
    mount("/docs");
    expect(heading()).toBe("Documentation");
  });
});
