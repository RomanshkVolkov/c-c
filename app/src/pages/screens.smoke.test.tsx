import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

/**
 * Every new screen, mounted once with data in the stores.
 *
 * There is a class of bug here that nothing else in this project can see: a
 * zustand selector that derives — `.map()`, `.filter()`, an object literal —
 * returns a new reference every call, and the store re-renders forever. It
 * type-checks, it builds, and every unit test passes; the only thing that
 * catches it is mounting the component with something in the store.
 *
 * It has now shipped twice. This is the cheapest guard against a third.
 */

// `restoreMocks: true` en la configuración desarma estos mocks después del
// primer test, y entonces `api.get` devuelve `undefined`. Una pantalla que
// hace `await` dentro de un `try` no se entera; una que encadena `.then` casta
// con un TypeError que no habla de lo que se está comprobando. Se rearman en
// `beforeEach`, abajo.
const { api } = vi.hoisted(() => ({
  api: {
    get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn(), postForm: vi.fn(),
  },
}));
vi.mock("@/lib/api", () => ({ api, apiUrl: (p: string) => `http://localhost${p}` }));
vi.mock("@/components/chat/ChannelView", () => ({ default: () => null }));
vi.mock("@/components/DMThread", () => ({ default: () => null }));
vi.mock("@/components/ItemCalendar", () => ({ default: () => null }));

const { MemoryRouter } = await import("react-router-dom");
const { useTasksStore } = await import("@/store/tasks.store");
const { useOrgsStore } = await import("@/store/orgs.store");
const { useAuthStore } = await import("@/store/auth.store");
const { PromptProvider } = await import("@/components/PromptDialog");
const { ConfirmProvider } = await import("@/components/ConfirmDialog");

const arbol = [
  {
    id: "sp-1", orgId: "org-1", name: "Uno", color: "#888",
    folders: [{ id: "fo-1", name: "Carpeta", folders: [], lists: [] }],
    lists: [{ id: "li-1", name: "Lista", taskCount: 2 }],
  },
];

beforeEach(() => {
  api.get.mockResolvedValue({ success: true, data: [] });
  api.post.mockResolvedValue({ success: true });
  api.patch.mockResolvedValue({ success: true });
  api.delete.mockResolvedValue({ success: true });
  // jsdom no trae matchMedia y el sidebar lo consulta (tema del sistema y
  // ancho de pantalla). Sin esto el fallo es un TypeError que no dice nada de
  // lo que se está comprobando.
  if (!window.matchMedia) {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
        onchange: null,
      }),
    });
  }
  useTasksStore.setState({ tree: arbol, loadingTree: false, error: null } as never);
  useOrgsStore.setState({
    orgs: [{ id: "org-1", name: "Uno", slug: "uno", role: "admin", memberCount: 3 }],
    currentOrgId: "org-1",
  } as never);
  useAuthStore.setState({
    session: { id: "u-1", username: "ana", superadmin: false },
    accessToken: "t",
  } as never);
});
afterEach(cleanup);

const montar = (el: React.ReactNode) =>
  render(
    <MemoryRouter>
      <ConfirmProvider>
        <PromptProvider>{el}</PromptProvider>
      </ConfirmProvider>
    </MemoryRouter>,
  );

describe("las pantallas nuevas se montan sin renderizar en bucle", () => {
  it("Canales", async () => {
    const { default: Channels } = await import("@/pages/Channels");
    montar(<Channels />);
    await waitFor(() => expect(document.body.textContent).toContain("Channels"));
  });

  it("Directos", async () => {
    const { default: DirectMessages } = await import("@/pages/DirectMessages");
    montar(<DirectMessages />);
    await waitFor(() => expect(document.body.textContent).toContain("Direct messages"));
  });

  it("Organización", async () => {
    const { default: OrganizationSettings } = await import("@/pages/OrganizationSettings");
    montar(<OrganizationSettings />);
    await waitFor(() => expect(document.body.textContent).toContain("Members"));
  });

  it("Resumen", async () => {
    const { default: Overview } = await import("@/pages/Overview");
    montar(<Overview />);
    await waitFor(() => expect(document.body.textContent).toContain("Open reports"));
  });

  it("el árbol de espacios", async () => {
    const { default: SpacesNavigator } = await import("@/components/tree/SpacesNavigator");
    montar(<SpacesNavigator />);
    await waitFor(() => expect(document.body.textContent).toContain("Uno"));
  });
});

describe("el sidebar", () => {
  it("pone la organización en el pie y no en la navegación", async () => {
    const { default: AppSidebar } = await import("@/components/AppSidebar");
    const { SidebarProvider } = await import("@/components/ui/sidebar");
    const { container } = montar(
      <SidebarProvider>
        <AppSidebar />
      </SidebarProvider>,
    );
    await waitFor(() => expect(container.textContent).toContain("Organization"));
    // El rótulo dice lo que hay dentro, para no tener que abrirlo y averiguar
    // que «personas» vive ahí.
    expect(container.textContent).toContain("people · invitations");
    // Y los servidores son una entrada de plataforma, no un «dashboard».
    expect(container.textContent).toContain("Servers");
    expect(container.textContent).not.toContain("Dashboard");
    // El resumen abre la navegación, y «Tareas» ya no compite con el árbol de
    // espacios: los espacios *son* esa navegación.
    expect(container.textContent).toContain("Overview");
    expect(container.textContent).not.toContain("Tasks");
  });
});
