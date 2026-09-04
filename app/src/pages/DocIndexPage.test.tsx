import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

/**
 * Un índice del que no se puede entrar no es un índice.
 *
 * Abrir un documento sólo cambia el estado; quien lo pinta es la pantalla. Esta
 * tabla llamaba a `openDoc` y se quedaba enseñando la misma tabla — cada fila
 * era un botón que no hacía nada, y desde fuera eso se lee como «la
 * documentación no funciona».
 */

const estado: Record<string, unknown> = {
  activeDoc: null,
  doc: null,
  tree: [],
  docIndex: {},
  loadingDoc: false,
  openDoc: vi.fn(),
  closeDoc: vi.fn(),
  saveDoc: vi.fn(),
  uploadDocAttachment: vi.fn(),
  board: null,
  docVersions: vi.fn(async () => []),
  restoreDoc: vi.fn(),
  addDecision: vi.fn(),
};

vi.mock("@/store/tasks.store", () => ({
  useTasksStore: Object.assign(
    (sel: (s: Record<string, unknown>) => unknown) => sel(estado),
    { getState: () => estado },
  ),
}));
vi.mock("@/components/docs/DocHeader", () => ({ default: () => null }));
vi.mock("@/components/docs/DocHistory", () => ({ default: () => null }));
vi.mock("@/components/docs/ShareDoc", () => ({ default: () => null }));
vi.mock("@/components/docs/DocToc", () => ({ default: () => null }));
vi.mock("@/components/CopyId", () => ({ default: () => null }));
vi.mock("@/components/markdown/MarkdownEditor", () => ({ default: () => null }));

const DocIndexPage = (await import("@/pages/DocIndexPage")).default;

afterEach(cleanup);

describe("la pantalla de documentación", () => {
  it("sin nada abierto enseña la tabla", () => {
    estado.activeDoc = null;
    render(<DocIndexPage />);
    expect(screen.getByText("All docs")).toBeTruthy();
  });

  it("con un documento abierto lo enseña, y no la tabla otra vez", () => {
    estado.activeDoc = { kind: "list", id: "l1", name: "Portento" };
    render(<DocIndexPage />);
    expect(screen.getByText("Portento")).toBeTruthy();
    expect(screen.queryByText("All docs")).toBeNull();
  });
});
