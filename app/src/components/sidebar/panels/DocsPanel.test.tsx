import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { SpaceTree } from "@/types/task";

/**
 * El panel de Documentación: «Todos los docs», el filtro, y el árbol de
 * espacios con las páginas de cada documento.
 *
 * Lo que se fija: sólo la rama del documento abierto va desplegada; pulsar un
 * nodo se queda en la pantalla de documentación en la que estés; lo
 * desplegado se recuerda por org; y las páginas de un documento que no es el
 * abierto se piden al desplegarlo, no antes. Mutantes: «Todos los docs» sin
 * `closeDoc`; todo abierto; ir siempre a `/docs`; el filtro sin antepasados;
 * la clave sin org; pedir las páginas al montar.
 */

const { get } = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@/lib/api", () => ({
  api: { get, post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  apiUrl: (p: string) => p,
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const { MemoryRouter, Route, Routes, useLocation } = await import("react-router-dom");
const { default: DocsPanel } = await import("@/components/sidebar/panels/DocsPanel");
const { useTasksStore } = await import("@/store/tasks.store");
const { useOrgsStore } = await import("@/store/orgs.store");
const { useDocPages } = await import("@/store/doc-pages.store");
const { useLayoutStore } = await import("@/store/layout.store");
const { useRepoDocs } = await import("@/store/repo-docs.store");
const { ConfirmProvider } = await import("@/components/ConfirmDialog");
const { PromptProvider } = await import("@/components/PromptDialog");

const list = (id: string, name: string) => ({ id, name, taskCount: 0, openCount: 0 });
const TREE: SpaceTree[] = [
  {
    id: "sp-a",
    orgId: "org-1",
    name: "Proteus",
    color: "",
    people: [],
    folders: [
      {
        id: "fo-1",
        name: "Cliente",
        folders: [{ id: "fo-2", name: "Accesos", folders: [], lists: [list("li-deep", "Inventario")] }],
        lists: [list("li-1", "Backlog")],
      },
    ],
    lists: [],
  },
  { id: "sp-b", orgId: "org-1", name: "Valkey", color: "", people: [], folders: [], lists: [list("li-v", "Operación")] },
];

// Un repo atado a Valkey, con sus .md (docs as code).
const WEB = {
  repoId: 200,
  fullName: "dwit/web",
  branch: "main",
  state: "ok",
  syncedAt: null,
  files: [
    { id: "rd-readme", path: "README.md", title: "Web" },
    { id: "rd-k8s", path: "docs/guias/k8s.md", title: "Desplegar en k8s" },
  ],
};

const row = (id: string, title: string) => ({ id, title, rank: "0.5", hasBody: false, updatedAt: "" });

let where = "";
let whereSearch = "";
function Where() {
  const l = useLocation();
  where = l.pathname;
  whereSearch = l.search;
  return null;
}

const mount = (url = "/docs", filter?: string) => {
  const r = render(
    <MemoryRouter initialEntries={[url]}>
      <ConfirmProvider>
        <PromptProvider>
          <Routes>
            <Route
              path="*"
              element={
                <>
                  <DocsPanel />
                  <Where />
                </>
              }
            />
          </Routes>
        </PromptProvider>
      </ConfirmProvider>
    </MemoryRouter>,
  );
  if (filter) fireEvent.change(screen.getByRole("searchbox"), { target: { value: filter } });
  return r;
};

const pagesCalls = (owner: string) => get.mock.calls.filter(([u]) => u === `/api/v1/docs/${owner}/pages`);
const shows = (name: string) => screen.queryByRole("button", { name: new RegExp(`^${name}`) }) !== null;

beforeEach(() => {
  get.mockImplementation(async (url: string) =>
    url === "/api/v1/docs/list/li-v/pages"
      ? { data: [row("pv", "Rotación")] }
      : url === "/api/v1/repo-docs?spaceId=sp-b"
        ? { success: true, data: [WEB] }
        : url.startsWith("/api/v1/repo-docs?")
          ? { success: true, data: [] }
          : { success: true, data: null },
  );
  useRepoDocs.setState({ bySpace: {}, open: null });
  useOrgsStore.setState({ currentOrgId: "org-1" } as never);
  useTasksStore.setState({
    tree: TREE,
    activeDoc: { kind: "list", id: "li-1", name: "Backlog", orgId: "org-1" },
    docIndex: {},
  } as never);
  useDocPages.setState({ owner: { kind: "list", id: "li-1" }, tree: [], pagesByOwner: {}, activePageId: null, view: null });
  useLayoutStore.setState({ expanded: {} });
});
afterEach(cleanup);

describe("el panel de Documentación", () => {
  it("«Todos los docs» cierra el documento y va a la tabla", () => {
    mount("/tasks");
    fireEvent.click(screen.getByRole("button", { name: /All docs/ }));
    expect(useTasksStore.getState().activeDoc).toBeNull();
    expect(where).toBe("/docs");
  });

  it("sólo va abierta la rama del documento que lees", () => {
    mount();
    // El camino hasta Backlog, y Backlog con su portada.
    expect(shows("Cliente")).toBe(true);
    expect(shows("Backlog")).toBe(true);
    expect(screen.getByText("Home")).toBeTruthy();
    // La hermana de Backlog se ve, pero cerrada; el otro espacio, cerrado.
    expect(shows("Accesos")).toBe(true);
    expect(shows("Inventario")).toBe(false);
    expect(shows("Operación")).toBe(false);
    // Lo que lees es la portada; Backlog sólo es el camino hasta ella.
    expect(screen.getByText("Home").closest("button")?.getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("button", { name: /^Backlog/ }).getAttribute("aria-current")).toBe("location");
  });

  // Dos filas con fondo una encima de otra se leían como dos cosas abiertas
  // (13-oct-2026). Plegado, el documento vuelve a llevar la marca: si no, no
  // quedaría ninguna a la vista. Mutantes: siempre «path»; siempre `true`.
  it("plegar el documento que lees le devuelve la marca", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Collapse Backlog" }));
    expect(screen.queryByText("Home")).toBeNull();
    expect(screen.getByRole("button", { name: /^Backlog/ }).getAttribute("aria-current")).toBe("page");
  });

  it("desplegar se recuerda bajo la org", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Expand Valkey" }));
    expect(shows("Operación")).toBe(true);
    expect(useLayoutStore.getState().expanded["org-1/docs"]).toEqual({ "space:sp-b": true });
  });
});

describe("abrir desde el árbol", () => {
  it("leyendo en el tablero, te quedas en el tablero", () => {
    mount("/tasks");
    fireEvent.click(screen.getByRole("button", { name: "Expand Valkey" }));
    fireEvent.click(screen.getByRole("button", { name: /^Operación/ }));
    expect(useTasksStore.getState().activeDoc?.id).toBe("li-v");
    expect(where).toBe("/tasks");
  });

  it("desde otra pantalla, a Documentación", () => {
    mount("/my-work");
    fireEvent.click(screen.getByRole("button", { name: /^Accesos/ }));
    expect(useTasksStore.getState().activeDoc?.id).toBe("fo-2");
    expect(where).toBe("/docs");
  });

  it("pulsar el documento abierto vuelve a su portada", () => {
    useDocPages.setState({ activePageId: "p1" });
    mount();
    fireEvent.click(screen.getByRole("button", { name: /^Backlog/ }));
    expect(useDocPages.getState().activePageId).toBeNull();
    expect(useTasksStore.getState().activeDoc?.id).toBe("li-1");
  });
});

describe("las páginas de otro documento", () => {
  beforeEach(() => {
    useTasksStore.setState({ docIndex: { "list:li-v": { written: true, pages: 1 } } } as never);
  });

  it("se piden al desplegarlo, no antes", async () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Expand Valkey" }));
    expect(pagesCalls("list/li-v")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Expand Operación" }));
    expect(await screen.findByText("Rotación")).toBeTruthy();
    expect(pagesCalls("list/li-v")).toHaveLength(1);
  });

  // La página primero: fija el dueño, y así abrir el documento no la cierra.
  it("pulsar una abre ese documento en esa página", async () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Expand Valkey" }));
    fireEvent.click(screen.getByRole("button", { name: "Expand Operación" }));
    fireEvent.click(await screen.findByText("Rotación"));
    expect(useDocPages.getState().activePageId).toBe("pv");
    expect(useDocPages.getState().owner).toEqual({ kind: "list", id: "li-v" });
    expect(useTasksStore.getState().activeDoc?.id).toBe("li-v");
    expect(where).toBe("/docs");
  });
});

describe("el filtro", () => {
  it("deja lo que casa y de dónde cuelga, abierto", () => {
    mount("/docs", "inventario");
    expect(shows("Proteus")).toBe(true);
    expect(shows("Cliente")).toBe(true);
    expect(shows("Accesos")).toBe(true);
    expect(shows("Inventario")).toBe(true);
    expect(shows("Backlog")).toBe(false);
    expect(shows("Valkey")).toBe(false);
  });

  it("encuentra páginas ya cargadas, aunque su documento esté plegado", () => {
    useDocPages.setState({ pagesByOwner: { "list:li-v": [row("pv", "Rotación")] } });
    mount("/docs", "rota");
    expect(screen.getByText("Rotación")).toBeTruthy();
    expect(shows("Proteus")).toBe(false);
    // Y filtrar no pide nada.
    expect(pagesCalls("list/li-v")).toHaveLength(0);
  });

  it("sin nada que case, lo dice", () => {
    mount("/docs", "zzz");
    expect(screen.getByText("Nothing matches")).toBeTruthy();
  });
});

describe("al cambiar el documento que lees", () => {
  it("su camino se abre aunque lo hubieras plegado", async () => {
    useLayoutStore.setState({ expanded: { "org-1/docs": { "space:sp-b": false } } });
    mount();
    useTasksStore.setState({ activeDoc: { kind: "list", id: "li-v", name: "Operación", orgId: "org-1" } } as never);
    await waitFor(() => expect(shows("Operación")).toBe(true));
  });
});

/**
 * Los .md del repo atado a un espacio, colgando de él.
 * Mutantes: montar la rama del repo con el espacio plegado (se piden al
 * abrir el panel); el filtro sin los ficheros del repo; abrir un fichero sin
 * cerrar el documento (la pantalla seguiría enseñando el de antes).
 */
describe("los .md del repo", () => {
  const repoCalls = (space: string) => get.mock.calls.filter(([u]) => u === `/api/v1/repo-docs?spaceId=${space}`);

  it("se piden al desplegar el espacio, no antes, y van por carpetas", async () => {
    mount();
    expect(repoCalls("sp-b")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Expand Valkey" }));
    await waitFor(() => expect(shows("dwit/web")).toBe(true));
    expect(repoCalls("sp-b")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Expand dwit/web" }));
    expect(shows("docs/guias")).toBe(true);
    expect(shows("Web")).toBe(true);
    // La carpeta, plegada: lo de dentro no se ve hasta abrirla.
    expect(shows("Desplegar en k8s")).toBe(false);
  });

  it("el filtro encuentra un fichero del repo y abre su camino", () => {
    useRepoDocs.setState({ bySpace: { "sp-b": [WEB] } } as never);
    mount("/docs", "k8s");
    expect(shows("Valkey")).toBe(true);
    expect(shows("dwit/web")).toBe(true);
    expect(shows("Desplegar en k8s")).toBe(true);
    expect(shows("Operación")).toBe(false);
  });

  it("abrir un fichero cierra el documento y lo enseña en /docs", async () => {
    useRepoDocs.setState({ bySpace: { "sp-b": [WEB] } } as never);
    mount("/tasks", "Web");
    fireEvent.click(screen.getByRole("button", { name: /^Web/ }));
    expect(useTasksStore.getState().activeDoc).toBeNull();
    expect(where).toBe("/docs");
    expect(whereSearch).toBe("?repoDoc=rd-readme");
  });
});
