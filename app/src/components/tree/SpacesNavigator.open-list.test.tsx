import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";

/**
 * Pulsar una lista en el árbol abre esa lista: su tablero, en `/tasks`.
 *
 * Hasta el 18-oct-2026 acotaba «Mi trabajo» y llevaba a `/my-work`: otra
 * pantalla, con otra cabecera y la lista hecha un chip, y jose no sabía de
 * dónde salía. El tablero sólo se abría desde el menú «…» de la fila.
 */

vi.mock("@/lib/api", () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn(), postForm: vi.fn() },
  apiUrl: (p: string) => `http://localhost${p}`,
}));

const { MemoryRouter, useLocation } = await import("react-router-dom");
const { default: SpacesNavigator } = await import("@/components/tree/SpacesNavigator");
const { PromptProvider } = await import("@/components/PromptDialog");
const { ConfirmProvider } = await import("@/components/ConfirmDialog");
const { useTasksStore } = await import("@/store/tasks.store");
const { useMyWorkStore } = await import("@/store/mywork.store");
const { useOrgsStore } = await import("@/store/orgs.store");
const { api } = await import("@/lib/api");

const space = {
  id: "sp-1",
  orgId: "org-1",
  name: "Ingeniería",
  color: "#888888",
  folders: [],
  lists: [{ id: "li-1", name: "Pendientes", taskCount: 0 }],
};

function Where() {
  return <output data-testid="where">{useLocation().pathname}</output>;
}

const mount = (at = "/my-work") =>
  render(
    <MemoryRouter initialEntries={[at]}>
      <ConfirmProvider>
        <PromptProvider>
          <SpacesNavigator />
          <Where />
        </PromptProvider>
      </ConfirmProvider>
    </MemoryRouter>,
  );

afterEach(cleanup);
beforeEach(() => {
  vi.mocked(api.get).mockReset();
  vi.mocked(api.get).mockResolvedValue({ success: true, data: null });
  useTasksStore.setState({
    tree: [space],
    loadingTree: false,
    error: null,
    activeListId: null,
    activeDoc: null,
  } as never);
  useMyWorkStore.setState({ scope: null, orgId: null });
  useOrgsStore.setState({ currentOrgId: "org-1" });
});

describe("pulsar una lista en el árbol", () => {
  it("lleva a su tablero, no a «Mi trabajo»", () => {
    mount();
    fireEvent.click(screen.getByText("Pendientes"));
    expect(screen.getByTestId("where").textContent).toBe("/tasks");
  });

  it("la deja como la lista activa", () => {
    mount();
    fireEvent.click(screen.getByText("Pendientes"));
    expect(useTasksStore.getState().activeListId).toBe("li-1");
  });

  /**
   * Y pide el tablero. Si `Tasks` ya está montado (se pulsa otra lista desde
   * el tablero), su efecto de montaje no vuelve a correr: sin esta petición
   * se quedaría en «Cargando…». El mutante que mata: marcarla con
   * `focusList` sin pedir nada.
   */
  it("y pide su tablero", () => {
    mount("/tasks");
    fireEvent.click(screen.getByText("Pendientes"));
    const paths = vi.mocked(api.get).mock.calls.map((c) => String(c[0]));
    expect(paths).toContain("/api/v1/task-lists/li-1/board");
  });

  it("y no acota «Mi trabajo»", () => {
    mount();
    fireEvent.click(screen.getByText("Pendientes"));
    expect(useMyWorkStore.getState().scope).toBeNull();
  });
});
