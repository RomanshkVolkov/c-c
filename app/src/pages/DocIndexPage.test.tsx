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

const navegado: string[] = [];
let query = "";
vi.mock("react-router-dom", () => ({
  useNavigate: () => (r: string) => navegado.push(r),
  useSearchParams: () => [new URLSearchParams(query), () => {}],
}));
vi.mock("@/components/docs/RepoDocView", () => ({ default: ({ id }: { id: string }) => <p>repo-doc {id}</p> }));

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
  selectList: vi.fn(),
  focusList: vi.fn(),
  setBoardView: vi.fn(),
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
vi.mock("@/components/tasks/ViewSwitch", () => ({
  default: ({ onChange }: { onChange: (v: string) => void }) => (
    <button onClick={() => onChange("board")}>ir al tablero</button>
  ),
}));
vi.mock("@/components/CopyId", () => ({ default: () => null }));
vi.mock("@/components/markdown/MarkdownEditor", () => ({ default: () => null }));

const DocIndexPage = (await import("@/pages/DocIndexPage")).default;
const { useMyWorkStore } = await import("@/store/mywork.store");

afterEach(() => {
  cleanup();
  query = "";
});

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

  // Un .md del repo va por la URL y gana a lo que hubiera abierto: si no, el
  // fichero que se pulsó en el panel no llegaría a verse.
  // Mutante: mirar antes `activeDoc`.
  it("con ?repoDoc= enseña ese fichero del repo", () => {
    estado.activeDoc = { kind: "list", id: "l1", name: "Portento" };
    query = "repoDoc=rd-1";
    render(<DocIndexPage />);
    expect(screen.getByText("repo-doc rd-1")).toBeTruthy();
    expect(screen.queryByText("Portento")).toBeNull();
  });
});

/**
 * El conmutador dice «Tablero», así que tiene que llevar al tablero.
 *
 * Antes sólo cerraba el documento y te dejaba en el índice de documentación:
 * pulsabas «Tablero» y aparecía una tabla. Eso no se lee como un filtro, se lee
 * como que la app hizo otra cosa — y encima el estado quedaba distinto del que
 * tenías antes de entrar.
 */
describe("volver a las tareas desde un documento", () => {
  /**
   * A «Mi trabajo» acotado a esa lista y en la vista pulsada, que es a donde
   * lleva pulsarla en el árbol (18-oct-2026). Antes llevaba al tablero suelto.
   */
  it("acota Mi trabajo a la lista, fija la vista y va a esa pantalla", () => {
    navegado.length = 0;
    useMyWorkStore.setState({ scope: null, vista: "list" } as never);
    estado.activeDoc = { kind: "list", id: "l1", name: "Portento" };
    render(<DocIndexPage />);
    screen.getByText("ir al tablero").click();

    expect(estado.focusList).toHaveBeenCalledWith("l1");
    expect(estado.closeDoc).toHaveBeenCalled();
    expect(useMyWorkStore.getState().scope).toMatchObject({ kind: "list", id: "l1", name: "Portento" });
    expect(useMyWorkStore.getState().vista).toBe("board");
    expect(navegado).toEqual(["/my-work"]);
  });
});
