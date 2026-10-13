import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

/**
 * Trabajo: sólo la rama de lo que miras va abierta, lo que pliegas se
 * recuerda por org, y el filtro encuentra una lista aunque esté honda.
 *
 * Mutantes: la regla por defecto devolviendo siempre abierto; la clave del
 * plegado sin org; el filtro mirando sólo el nombre del espacio.
 */

vi.mock("@/lib/api", () => ({
  api: { get: vi.fn(async () => ({ success: true, data: [] })), post: vi.fn(), patch: vi.fn(), delete: vi.fn(), postForm: vi.fn() },
  apiUrl: (p: string) => `http://localhost${p}`,
}));

const { MemoryRouter } = await import("react-router-dom");
const { default: WorkPanel } = await import("@/components/sidebar/panels/WorkPanel");
const { PromptProvider } = await import("@/components/PromptDialog");
const { ConfirmProvider } = await import("@/components/ConfirmDialog");
const { useTasksStore } = await import("@/store/tasks.store");
const { useOrgsStore } = await import("@/store/orgs.store");
const { useMyWorkStore } = await import("@/store/mywork.store");
const { useLayoutStore, expansionKey } = await import("@/store/layout.store");

const list = (id: string, name: string) => ({ id, name, taskCount: 1, openCount: 1 });
const tree = [
  {
    id: "sp-a",
    orgId: "org-1",
    name: "Proteus",
    color: "#888",
    folders: [{ id: "fo-1", name: "Cliente", folders: [], lists: [list("li-1", "Backlog")] }],
    lists: [],
  },
  { id: "sp-b", orgId: "org-1", name: "Valkey", color: "#888", folders: [], lists: [list("li-v", "Operación")] },
];

const mount = () =>
  render(
    <MemoryRouter initialEntries={["/my-work"]}>
      <ConfirmProvider>
        <PromptProvider>
          <WorkPanel />
        </PromptProvider>
      </ConfirmProvider>
    </MemoryRouter>,
  );

const expanded = (name: string) =>
  screen.getByRole("button", { name: new RegExp(`^(Collapse|Expand) ${name}$`) }).getAttribute("aria-expanded");

beforeEach(() => {
  useTasksStore.setState({ tree, loadingTree: false, error: null, activeListId: null, activeDoc: null } as never);
  useOrgsStore.setState({ currentOrgId: "org-1" } as never);
  useMyWorkStore.setState({ scope: { kind: "list", id: "li-1", name: "Backlog", orgId: "org-1" } } as never);
  useLayoutStore.setState({ expanded: {} });
});
afterEach(cleanup);

describe("el panel de Trabajo", () => {
  it("«Mi trabajo» quita el filtro de lista", () => {
    mount();
    fireEvent.click(screen.getByText("My work"));
    expect(useMyWorkStore.getState().scope).toBeNull();
  });

  it("sin nada activo, los espacios abiertos y las carpetas cerradas", () => {
    mount();
    expect(expanded("Proteus")).toBe("true");
    expect(expanded("Cliente")).toBe("false");
    expect(screen.queryByText("Backlog")).toBeNull();
  });

  it("con una lista activa, sólo su rama abierta", () => {
    useTasksStore.setState({ activeListId: "li-1" } as never);
    mount();
    expect(expanded("Proteus")).toBe("true");
    expect(expanded("Cliente")).toBe("true");
    expect(screen.getByText("Backlog")).toBeTruthy();
    expect(expanded("Valkey")).toBe("false");
  });

  it("plegar se recuerda bajo la org, y en otra org no cuenta", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Collapse Proteus" }));
    expect(useLayoutStore.getState().expanded[expansionKey("org-1", "work")]).toEqual({ "sp-a": false });
    cleanup();
    useOrgsStore.setState({ currentOrgId: "org-2" } as never);
    mount();
    expect(expanded("Proteus")).toBe("true");
  });

  it("el filtro encuentra una lista dentro de una carpeta cerrada y esconde lo demás", () => {
    mount();
    fireEvent.change(screen.getByRole("searchbox", { name: "Filter by title" }), { target: { value: "back" } });
    expect(screen.getByText("Backlog")).toBeTruthy();
    expect(screen.queryByText("Valkey")).toBeNull();
  });

  it("sin coincidencias lo dice", () => {
    mount();
    fireEvent.change(screen.getByRole("searchbox", { name: "Filter by title" }), { target: { value: "zzz" } });
    expect(screen.getByText("Nothing matches")).toBeTruthy();
  });
});
