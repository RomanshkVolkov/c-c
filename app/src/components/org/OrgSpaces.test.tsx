import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { SpaceTree } from "@/types/task";

/**
 * La ficha de un espacio dice tres cosas que no se ven en el árbol: a qué canal
 * responde, cuánto queda por hacer, y quién lo está sosteniendo.
 */

const { tree } = vi.hoisted(() => ({ tree: { current: [] as SpaceTree[] } }));

vi.mock("@/store/tasks.store", () => ({
  useTasksStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({ tree: tree.current, fetchTree: vi.fn().mockResolvedValue(undefined), createSpace: vi.fn() }),
}));
vi.mock("@/store/reports.store", () => ({
  useReportsStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({ projects: [{ id: "proy-1", name: "Portento" }], fetchProjects: vi.fn().mockResolvedValue(undefined) }),
}));
vi.mock("@/store/orgs.store", () => ({
  useOrgsStore: (sel: (s: Record<string, unknown>) => unknown) => sel({ currentOrgId: "org-1" }),
}));
vi.mock("@/components/PromptDialog", () => ({ usePrompt: () => vi.fn() }));
vi.mock("react-router-dom", () => ({ useNavigate: () => vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

const { default: OrgSpaces } = await import("@/components/org/OrgSpaces");

afterEach(cleanup);

const lista = (id: string, todas: number, abiertas: number, projectId?: string) => ({
  id, name: id, taskCount: todas, openCount: abiertas, projectId,
});

const ESPACIOS = [
  {
    id: "esp-a", orgId: "org-1", name: "link-transfer", color: "#0ff",
    folders: [], lists: [lista("l1", 40, 7), lista("l2", 8, 2)],
    people: [{ userId: "u1", username: "jose.marin" }, { userId: "u2", username: "ana" }],
  },
  {
    id: "esp-b", orgId: "org-1", name: "cliente", color: "#f0f", projectId: "proy-1",
    folders: [], lists: [lista("l3", 3, 1)], people: [],
  },
] as unknown as SpaceTree[];

describe("fichas de espacios", () => {
  it("cuenta todas y las que quedan, sumando las listas anidadas", () => {
    tree.current = ESPACIOS;
    render(<OrgSpaces />);
    expect(screen.getByText("48 · 9 open")).toBeTruthy();
  });

  it("nombra al cliente cuando el espacio le pertenece, y a la organización cuando no", () => {
    tree.current = ESPACIOS;
    render(<OrgSpaces />);
    expect(screen.getByText("the whole organization")).toBeTruthy();
    expect(screen.getByText("Portento")).toBeTruthy();
  });

  it("dibuja a quien carga trabajo, con sus iniciales", () => {
    tree.current = ESPACIOS;
    render(<OrgSpaces />);
    expect(screen.getByTitle("@jose.marin").textContent).toBe("JM");
  });

  it("y dice que no hay nadie en vez de dejar el hueco mudo", () => {
    tree.current = ESPACIOS;
    render(<OrgSpaces />);
    expect(screen.getByText("nobody is on it")).toBeTruthy();
  });
});
