import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

/**
 * Qué módulo manda en el panel, según dónde estés.
 *
 * Lo decide la ruta, con una excepción: leer un documento en `/tasks` (el
 * conmutador «Docs» de una lista) es Documentación. Las páginas de ese
 * documento viven en el panel de Documentación; con el de Trabajo, en el
 * escritorio no habría forma de llegar a ellas. Y ese `/tasks` no se apunta
 * como el sitio de Documentación: volver a él con el documento cerrado sería
 * volver a un tablero. Mutantes: decidir sólo por la ruta; apuntar la ruta
 * igualmente; contar un documento de otra org.
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

  it("leer un documento en el tablero es Documentación, y no se apunta", () => {
    useTasksStore.setState({ activeDoc: { kind: "list", id: "li-1", name: "Backlog", orgId: "org-1" } } as never);
    mount("/tasks");
    expect(heading()).toBe("Documentation");
    expect(useLayoutStore.getState().lastRoute.docs).toBeUndefined();
    expect(useLayoutStore.getState().lastRoute.work).toBeUndefined();
  });

  it("un documento de otra org no cuenta", () => {
    useTasksStore.setState({ activeDoc: { kind: "list", id: "li-9", name: "Ajeno", orgId: "org-2" } } as never);
    mount("/tasks");
    expect(heading()).toBe("Work");
  });
});
