import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

/**
 * The screen has to survive being rendered with a tree in the store.
 *
 * It did not. `useTasksStore((s) => s.tree.map((t) => t.id))` builds a new
 * array on every call, zustand compares selector results with Object.is, so it
 * saw a change every render and rendered again — "Maximum update depth
 * exceeded", an infinite loop rather than a slow screen.
 *
 * This is the second time this exact shape has bitten this codebase, and both
 * times it type-checked, built, and passed every other test: a selector that
 * derives is invisible to all of them and only shows up when something is
 * actually mounted with data in the store. Which is what this does.
 */

vi.mock("@/lib/api", () => ({
  api: { get: vi.fn().mockResolvedValue({ success: true, data: [] }), post: vi.fn(), delete: vi.fn() },
}));
vi.mock("@/components/tasks/NewTaskRow", () => ({ default: () => null }));
vi.mock("@/components/ItemCalendar", () => ({ default: () => null }));

const { MemoryRouter } = await import("react-router-dom");
const { default: MyWork } = await import("@/pages/MyWork");
const { useTasksStore } = await import("@/store/tasks.store");
const { useMyWorkStore } = await import("@/store/mywork.store");

const arbol = [
  { id: "sp-1", orgId: "o", name: "Uno", color: "#888", folders: [], lists: [] },
  { id: "sp-2", orgId: "o", name: "Dos", color: "#888", folders: [], lists: [] },
];

beforeEach(() => {
  useTasksStore.setState({ tree: arbol } as never);
  useMyWorkStore.setState({ tasks: [], scope: null, loading: false, error: null });
});
afterEach(cleanup);

describe("«mi trabajo» al montarse", () => {
  it("no entra en bucle de render con espacios en el árbol", async () => {
    // Un fallo aquí no es una aserción: React lanza «Maximum update depth
    // exceeded» y el test revienta, que es exactamente lo que se busca.
    render(
      <MemoryRouter>
        <MyWork />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText("My work")).toBeTruthy());
  });

  it("y tampoco con tareas dentro", async () => {
    useMyWorkStore.setState({
      tasks: [
        {
          id: "t-1", seq: 1, title: "Una", priority: "normal", statusName: "To do",
          statusKind: "open", listId: "li-1", listName: "Lista", spaceId: "sp-1",
          spaceName: "Uno", updatedAt: new Date().toISOString(),
        },
      ] as never,
    });
    render(
      <MemoryRouter>
        <MyWork />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText("Una")).toBeTruthy());
  });
});
