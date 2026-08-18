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

vi.mock("@/lib/api", () => ({
  api: {
    get: vi.fn().mockResolvedValue({ success: true, data: [] }),
    post: vi.fn().mockResolvedValue({ success: true }),
    patch: vi.fn().mockResolvedValue({ success: true }),
    delete: vi.fn().mockResolvedValue({ success: true }),
    postForm: vi.fn(),
  },
  apiUrl: (p: string) => `http://localhost${p}`,
}));
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

  it("el árbol de espacios", async () => {
    const { default: SpacesNavigator } = await import("@/components/tree/SpacesNavigator");
    montar(<SpacesNavigator />);
    await waitFor(() => expect(document.body.textContent).toContain("Uno"));
  });
});
