import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

/**
 * Los contadores de la barra cuentan sólo la org en pantalla.
 *
 * Los dos llegan del servidor con todas tus orgs juntas, y se sumaban enteros:
 * un directo de otro cliente encendía el número aquí, y al entrar no había
 * nada que leer. Ver `lib/unread.ts`.
 */

const { api } = vi.hoisted(() => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn(), postForm: vi.fn() },
}));
vi.mock("@/lib/api", () => ({ api, apiUrl: (p: string) => `http://localhost${p}` }));

const { MemoryRouter } = await import("react-router-dom");
const { default: AppSidebar } = await import("@/components/AppSidebar");
const { PromptProvider } = await import("@/components/PromptDialog");
const { ConfirmProvider } = await import("@/components/ConfirmDialog");
const { SidebarProvider } = await import("@/components/ui/sidebar");
const { useAuthStore } = await import("@/store/auth.store");
const { useOrgsStore } = await import("@/store/orgs.store");
const { useDMStore } = await import("@/store/dm.store");
const { dmUnreadIn, channelUnreadIn } = await import("@/lib/unread");

const ARBOL: Record<string, unknown[]> = {
  "org-1": [{ id: "sp-1", orgId: "org-1", name: "Uno", color: "#888", folders: [], lists: [] }],
  "org-2": [{ id: "sp-2", orgId: "org-2", name: "Dos", color: "#888", folders: [], lists: [] }],
};

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

/** El texto de la fila, con su número si lo tiene. */
const fila = (nombre: string) => screen.getByText(nombre).closest("button")?.textContent ?? "";

beforeEach(() => {
  api.get.mockImplementation(async (url: string) => {
    if (url.startsWith("/api/v1/task-spaces")) {
      const org = new URLSearchParams(url.split("?")[1] ?? "").get("orgId") ?? "";
      return { success: true, data: ARBOL[org] ?? [] };
    }
    // Lo no leído de canales, de las dos orgs a la vez: así contesta el servidor.
    if (url.startsWith("/api/v1/chat/unread"))
      return { success: true, data: [{ spaceId: "sp-1", count: 2 }, { spaceId: "sp-2", count: 5 }] };
    return { success: true, data: [] };
  });
  useOrgsStore.setState({ currentOrgId: "org-1" } as never);
  useAuthStore.setState({
    session: { id: "u-1", username: "ana", superadmin: false },
    accessToken: "t",
  } as never);
  useDMStore.setState({
    conversations: [
      { conversationId: "c-1", orgId: "org-1", userId: "u-2", username: "bea", unread: 1 },
      { conversationId: "c-2", orgId: "org-2", userId: "u-3", username: "carla", unread: 4 },
    ],
  });
});
afterEach(cleanup);

describe("los contadores de la barra lateral", () => {
  it("cuentan sólo lo de la org en pantalla", async () => {
    montar();
    await waitFor(() => expect(fila("Channels")).toContain("2"));
    expect(fila("Channels")).not.toContain("7");
    expect(fila("Direct messages")).toContain("1");
    expect(fila("Direct messages")).not.toContain("5");
  });
});

describe("las cuentas", () => {
  it("los directos, sólo los de esa org", () => {
    const c = useDMStore.getState().conversations;
    expect(dmUnreadIn(c, "org-1")).toBe(1);
    expect(dmUnreadIn(c, "org-2")).toBe(4);
    expect(dmUnreadIn(c, null)).toBe(0);
  });

  it("los canales, sólo los del árbol", () => {
    expect(channelUnreadIn({ "sp-1": 2, "sp-2": 5 }, new Set(["sp-1"]))).toBe(2);
    expect(channelUnreadIn({ "sp-1": 2, "sp-2": 5 }, new Set())).toBe(0);
  });
});
