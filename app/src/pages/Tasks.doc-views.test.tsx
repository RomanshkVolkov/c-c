import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

/**
 * Desde la documentación de una lista, Tablero, Lista o Calendario llevan a
 * «Mi trabajo» acotado a esa lista y en esa vista: la misma pantalla a la que
 * lleva pulsar la lista en el árbol, y sin pedir su tablero, que no se va a ver.
 */

const { api, onView } = vi.hoisted(() => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn(), postForm: vi.fn() },
  onView: { fn: null as null | ((v: "board" | "list" | "calendar") => void) },
}));
vi.mock("@/lib/api", () => ({ api, apiUrl: (p: string) => `http://localhost${p}` }));
vi.mock("@/components/docs/DocTabs", () => ({
  default: (props: { onView: (v: "board" | "list" | "calendar") => void }) => {
    onView.fn = props.onView;
    return <p>el documento</p>;
  },
}));

const { default: Tasks } = await import("./Tasks");
const { useTasksStore } = await import("@/store/tasks.store");
const { useMyWorkStore } = await import("@/store/mywork.store");
const { useOrgsStore } = await import("@/store/orgs.store");
const { PromptProvider } = await import("@/components/PromptDialog");
const { ConfirmProvider } = await import("@/components/ConfirmDialog");

beforeEach(() => {
  api.get.mockReset();
  api.get.mockResolvedValue({ success: true, data: [] });
  useOrgsStore.setState({ currentOrgId: "org-1" });
  useTasksStore.setState({
    activeListId: null,
    activeDoc: { kind: "list", id: "l-1", name: "Tasks", orgId: "org-1" },
  } as never);
  useMyWorkStore.setState({ scope: null, vista: "list" } as never);
});
afterEach(cleanup);

describe("de la documentación a las tareas", () => {
  it("lleva a Mi trabajo acotado a la lista, en la vista pulsada", () => {
    render(
      <ConfirmProvider>
        <PromptProvider>
          <MemoryRouter initialEntries={["/tasks"]}>
            <Routes>
              <Route path="/tasks" element={<Tasks />} />
              <Route path="/my-work" element={<p>mi trabajo</p>} />
            </Routes>
          </MemoryRouter>
        </PromptProvider>
      </ConfirmProvider>,
    );
    api.get.mockClear();
    act(() => onView.fn!("board"));

    expect(screen.getByText("mi trabajo")).toBeTruthy();
    expect(useMyWorkStore.getState().scope).toMatchObject({ kind: "list", id: "l-1", name: "Tasks" });
    expect(useMyWorkStore.getState().vista).toBe("board");
    expect(useTasksStore.getState().activeDoc).toBeNull();
    expect(useTasksStore.getState().activeListId).toBe("l-1");
    // Y el tablero de la lista no se pide: no lo va a ver nadie.
    expect(api.get.mock.calls.map((c) => String(c[0])).filter((p) => p.includes("/board"))).toEqual([]);
  });
});
