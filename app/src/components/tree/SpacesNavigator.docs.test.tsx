import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";

/**
 * Quien está leyendo documentación se queda en ella al cambiar de nodo.
 *
 * El clic en una lista lleva a «Mi trabajo» (ver `SpacesNavigator.scope`), y
 * eso sacaba de la documentación a quien iba de lista en lista leyéndola: había
 * que volver a pulsar «Documentación» cada vez (9-oct-2026). Ahora, si hay un
 * documento abierto en `/tasks` o `/docs`, el clic abre el de esa lista y se
 * queda en la misma pantalla.
 */

vi.mock("@/lib/api", () => ({
  api: { get: vi.fn(async () => ({ success: true, data: [] })), post: vi.fn(), patch: vi.fn(), delete: vi.fn(), postForm: vi.fn() },
  apiUrl: (p: string) => `http://localhost${p}`,
}));

const { MemoryRouter, useLocation } = await import("react-router-dom");
const { default: SpacesNavigator } = await import("@/components/tree/SpacesNavigator");
const { PromptProvider } = await import("@/components/PromptDialog");
const { ConfirmProvider } = await import("@/components/ConfirmDialog");
const { useTasksStore } = await import("@/store/tasks.store");
const { useMyWorkStore } = await import("@/store/mywork.store");
const { useOrgsStore } = await import("@/store/orgs.store");

const espacio = {
  id: "sp-1",
  orgId: "org-1",
  name: "Ingeniería",
  color: "#888888",
  folders: [],
  lists: [
    { id: "li-0", name: "Otra", taskCount: 0 },
    { id: "li-1", name: "Pendientes", taskCount: 0 },
  ],
};

let ruta = "";
function Ruta() {
  ruta = useLocation().pathname;
  return null;
}

const montar = (en: string) =>
  render(
    <MemoryRouter initialEntries={[en]}>
      <ConfirmProvider>
        <PromptProvider>
          <SpacesNavigator />
          <Ruta />
        </PromptProvider>
      </ConfirmProvider>
    </MemoryRouter>,
  );

afterEach(cleanup);
beforeEach(() => {
  useTasksStore.setState({
    tree: [espacio],
    loadingTree: false,
    error: null,
    activeListId: null,
    activeDoc: { kind: "list", id: "li-0", name: "Otra", orgId: "org-1" },
  } as never);
  useMyWorkStore.setState({ scope: null, orgId: null });
  useOrgsStore.setState({ currentOrgId: "org-1" });
});

describe("pulsar una lista leyendo documentación", () => {
  it("abre la documentación de esa lista y se queda en /tasks", () => {
    montar("/tasks");
    fireEvent.click(screen.getByText("Pendientes"));
    expect(useTasksStore.getState().activeDoc).toMatchObject({ kind: "list", id: "li-1" });
    expect(ruta).toBe("/tasks");
    expect(useMyWorkStore.getState().scope).toBeNull();
  });

  it("y en la pantalla de Documentación, se queda en ella", () => {
    montar("/docs");
    fireEvent.click(screen.getByText("Pendientes"));
    expect(useTasksStore.getState().activeDoc).toMatchObject({ id: "li-1" });
    expect(ruta).toBe("/docs");
  });

  it("la lista marcada es la del documento abierto", () => {
    useTasksStore.setState({ activeListId: "li-1" } as never);
    montar("/tasks");
    expect(screen.getByText("Otra").closest(".group")!.classList.contains("bg-accent")).toBe(true);
    expect(screen.getByText("Pendientes").closest(".group")!.classList.contains("bg-accent")).toBe(false);
  });

  it("fuera de la documentación, va a «Mi trabajo» como siempre", () => {
    montar("/my-work");
    fireEvent.click(screen.getByText("Pendientes"));
    expect(useMyWorkStore.getState().scope).toMatchObject({ kind: "list", id: "li-1" });
    expect(ruta).toBe("/my-work");
  });

  it("un documento de otra org no cuenta como estar leyendo", () => {
    useTasksStore.setState({ activeDoc: { kind: "list", id: "li-0", name: "Otra", orgId: "org-2" } } as never);
    montar("/tasks");
    fireEvent.click(screen.getByText("Pendientes"));
    expect(ruta).toBe("/my-work");
  });
});
