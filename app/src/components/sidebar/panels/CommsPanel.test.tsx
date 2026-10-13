import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

/**
 * El panel de Comunicación entero: las dos secciones, el filtro y lo que pide.
 *
 * Cada sección cuenta **sólo su org**: lo no leído llega del servidor con
 * todas juntas (fixture de `AppSidebar.unread.test.tsx`: 2 y no 7 en canales,
 * 1 y no 5 en directos). Pide conversaciones y gente una vez por org —y otra
 * al cambiar, que es el «había que recargar la app» de `DMSwitcher`—, y vigila
 * la voz mientras está montado. Mutantes: sumar todas las orgs; un efecto que
 * no depende de la org; no soltar la vigilancia al desmontar.
 */

const { api, watchOccupancy, stopWatching } = vi.hoisted(() => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn(), postForm: vi.fn() },
  watchOccupancy: vi.fn(),
  stopWatching: vi.fn(),
}));
vi.mock("@/lib/api", () => ({ api, apiUrl: (p: string) => p }));
vi.mock("@/store/voice-occupancy", () => ({ watchOccupancy }));

const { MemoryRouter } = await import("react-router-dom");
const { default: CommsPanel } = await import("@/components/sidebar/panels/CommsPanel");
const { useTasksStore } = await import("@/store/tasks.store");
const { useChatStore } = await import("@/store/chat.store");
const { useOrgsStore } = await import("@/store/orgs.store");
const { useAuthStore } = await import("@/store/auth.store");
const { useDMStore } = await import("@/store/dm.store");
const { usePeopleStore } = await import("@/store/people.store");
const { useLayoutStore } = await import("@/store/layout.store");

const CONVERSATIONS = [
  { conversationId: "c-1", orgId: "org-1", userId: "u-2", username: "bea", unread: 1 },
  { conversationId: "c-2", orgId: "org-2", userId: "u-3", username: "carla", unread: 4 },
];
const PEOPLE: Record<string, { id: string; username: string }[]> = {
  "org-1": [{ id: "u-2", username: "bea" }],
  "org-2": [{ id: "u-9", username: "carmen" }],
};

const mount = () =>
  render(
    <MemoryRouter initialEntries={["/chat"]}>
      <CommsPanel />
    </MemoryRouter>,
  );

const calls = (prefix: string) => api.get.mock.calls.filter(([u]) => String(u).startsWith(prefix));

beforeEach(() => {
  watchOccupancy.mockReturnValue(stopWatching);
  api.get.mockImplementation(async (url: string) => {
    if (url.startsWith("/api/v1/dm")) return { success: true, data: CONVERSATIONS };
    if (url.startsWith("/api/v1/users/search")) {
      const org = new URLSearchParams(url.split("?")[1] ?? "").get("orgId") ?? "";
      return { success: true, data: PEOPLE[org] ?? [] };
    }
    return { success: true, data: [] };
  });
  useTasksStore.setState({
    tree: [{ id: "sp-1", orgId: "org-1", name: "Uno", color: "", folders: [], lists: [], people: [] }],
  } as never);
  useChatStore.setState({ unreadBySpace: { "sp-1": 2, "sp-2": 5 } } as never);
  useOrgsStore.setState({ currentOrgId: "org-1" } as never);
  useAuthStore.setState({ session: { id: "u-1", username: "ana" }, accessToken: "t" } as never);
  useDMStore.setState({ conversations: [], conversationId: null, conversationOrgId: null });
  usePeopleStore.setState({ byOrg: {} });
  useLayoutStore.setState({ expanded: {} });
});
afterEach(cleanup);

const header = (name: RegExp) => screen.getByRole("button", { name, expanded: true });

describe("el panel de Comunicación", () => {
  it("cada sección cuenta sólo la org en pantalla", async () => {
    mount();
    await waitFor(() => expect(header(/Direct messages/).textContent).toContain("1"));
    expect(header(/Channels/).textContent).toContain("2");
    expect(header(/Channels/).textContent).not.toContain("7");
    expect(header(/Direct messages/).textContent).not.toContain("5");
  });

  it("pide conversaciones y gente una vez, y otra al cambiar de org", async () => {
    const { rerender } = mount();
    await waitFor(() => expect(calls("/api/v1/users/search")).toHaveLength(1));
    expect(calls("/api/v1/dm")).toHaveLength(1);
    expect(usePeopleStore.getState().byOrg["org-1"]).toHaveLength(1);

    useOrgsStore.setState({ currentOrgId: "org-2" } as never);
    rerender(
      <MemoryRouter initialEntries={["/chat"]}>
        <CommsPanel />
      </MemoryRouter>,
    );
    await waitFor(() => expect(usePeopleStore.getState().byOrg["org-2"]?.[0]?.username).toBe("carmen"));
    expect(calls("/api/v1/dm")).toHaveLength(2);
  });

  it("vigila la voz de su org mientras está montado, y la suelta al irse", () => {
    const { unmount } = mount();
    expect(watchOccupancy).toHaveBeenCalledTimes(1);
    expect(watchOccupancy).toHaveBeenCalledWith("org-1");
    expect(stopWatching).not.toHaveBeenCalled();
    unmount();
    expect(stopWatching).toHaveBeenCalledTimes(1);
  });

  it("el filtro recorre las dos secciones, y dice cuando no hay nada", async () => {
    mount();
    await waitFor(() => expect(screen.getByRole("button", { name: /bea/ })).toBeTruthy());
    const box = screen.getByRole("searchbox", { name: "Filter by name" });
    fireEvent.change(box, { target: { value: "bea" } });
    expect(screen.getByRole("button", { name: /bea/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Uno/ })).toBeNull();
    fireEvent.change(box, { target: { value: "zzz" } });
    expect(screen.getByText("Nothing matches")).toBeTruthy();
  });
});
