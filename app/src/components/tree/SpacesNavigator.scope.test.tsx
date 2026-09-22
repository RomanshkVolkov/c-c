import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";

/**
 * Pulsar una lista en el árbol acota «My work». No abre su tablero.
 *
 * Eso son dos cosas que hay que sostener a la vez, y cada una tuvo su fallo:
 *
 * - El **ámbito** queda puesto, con la organización de la que es. Sin el sello,
 *   la primera carga de «My work» lo tiraba y hacían falta **dos clics** para
 *   filtrar.
 * - Y el **tablero no se pide**: este clic lleva a `/my-work`, así que esa
 *   petición no la llega a ver nadie. Lo que sí queda es la lista marcada como
 *   activa, que es lo que resalta la fila en el árbol.
 */

vi.mock("@/lib/api", () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn(), postForm: vi.fn() },
  apiUrl: (p: string) => `http://localhost${p}`,
}));

const { MemoryRouter } = await import("react-router-dom");
const { default: SpacesNavigator } = await import("@/components/tree/SpacesNavigator");
const { PromptProvider } = await import("@/components/PromptDialog");
const { ConfirmProvider } = await import("@/components/ConfirmDialog");
const { useTasksStore } = await import("@/store/tasks.store");
const { useMyWorkStore } = await import("@/store/mywork.store");
const { useOrgsStore } = await import("@/store/orgs.store");
const { api } = await import("@/lib/api");

const espacio = {
  id: "sp-1",
  orgId: "org-1",
  name: "Ingeniería",
  color: "#888888",
  folders: [],
  lists: [{ id: "li-1", name: "Pendientes", taskCount: 0 }],
};

const montar = () =>
  render(
    <MemoryRouter>
      <ConfirmProvider>
        <PromptProvider>
          <SpacesNavigator />
        </PromptProvider>
      </ConfirmProvider>
    </MemoryRouter>,
  );

afterEach(cleanup);
beforeEach(() => {
  vi.mocked(api.get).mockClear();
  useTasksStore.setState({
    tree: [espacio],
    loadingTree: false,
    error: null,
    activeListId: null,
  } as never);
  useMyWorkStore.setState({ scope: null, orgId: null });
  useOrgsStore.setState({ currentOrgId: "org-1" });
});

describe("pulsar una lista en el árbol", () => {
  it("acota «My work» a esa lista", () => {
    montar();
    fireEvent.click(screen.getByText("Pendientes"));
    expect(useMyWorkStore.getState().scope).toMatchObject({
      kind: "list",
      id: "li-1",
      name: "Pendientes",
    });
  });

  /**
   * Y el ámbito sale sellado con la organización activa.
   *
   * Es lo que le deja sobrevivir a la carga que viene justo detrás, al montarse
   * la pantalla. El mutante que mata: `setScope` guardando lo que le dan tal
   * cual.
   */
  it("con la organización de la que es", () => {
    montar();
    fireEvent.click(screen.getByText("Pendientes"));
    expect(useMyWorkStore.getState().scope?.orgId).toBe("org-1");
  });

  it("deja la lista marcada como activa", () => {
    montar();
    fireEvent.click(screen.getByText("Pendientes"));
    expect(useTasksStore.getState().activeListId).toBe("li-1");
  });

  /**
   * Y no pide el tablero.
   *
   * El mutante que mata: volver a `selectList`, que sí lo pide. Una petición
   * de más por cada clic en el árbol, de algo que ese clic no enseña.
   */
  it("y no pide el tablero, que no se va a enseñar", () => {
    montar();
    fireEvent.click(screen.getByText("Pendientes"));
    const rutas = vi.mocked(api.get).mock.calls.map((c) => String(c[0]));
    expect(rutas.filter((r) => r.includes("/board"))).toEqual([]);
  });
});
