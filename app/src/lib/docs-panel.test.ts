import { describe, expect, it } from "vitest";

import { defaultExpanded, docNodes, filterDocsTree, pageKey } from "@/lib/docs-panel";
import type { DocPageTreeItem, SpaceTree } from "@/types/task";

const list = (id: string, name: string) => ({ id, name, taskCount: 0, openCount: 0 });

const tree: SpaceTree[] = [
  { id: "sp-g", orgId: "o", name: "General", color: "", kind: "general", people: [], folders: [], lists: [] },
  {
    id: "sp-a",
    orgId: "o",
    name: "Proteus",
    color: "#e5484d",
    people: [],
    folders: [
      {
        id: "fo-1",
        name: "Cliente",
        folders: [{ id: "fo-2", name: "Accesos", folders: [], lists: [list("li-deep", "Inventario")] }],
        lists: [list("li-1", "Backlog")],
      },
    ],
    lists: [list("li-top", "Juntas")],
  },
  { id: "sp-b", orgId: "o", name: "Valkey", color: "", people: [], folders: [], lists: [list("li-v", "Operación")] },
];

const page = (id: string, title: string, parentId?: string): DocPageTreeItem => ({
  id,
  title,
  parentId,
  rank: "0.5",
  hasBody: false,
  updatedAt: "",
});

describe("docNodes", () => {
  it("la sala general no es un trabajo con documentación", () => {
    expect(docNodes(tree).map((n) => n.id)).toEqual(["sp-a", "sp-b"]);
  });

  it("carpetas antes que listas, como en el árbol de Trabajo", () => {
    expect(docNodes(tree)[0].children.map((n) => n.id)).toEqual(["fo-1", "li-top"]);
  });
});

/**
 * Lo abierto sin que nadie lo pida: el camino hasta lo que lees y nada más.
 * Mutantes: incluir a las hermanas; olvidar el propio nodo; olvidar el
 * camino de páginas.
 */
describe("defaultExpanded", () => {
  it("el camino hasta el documento abierto, el documento incluido", () => {
    const open = defaultExpanded(tree, { kind: "list", id: "li-deep" });
    expect([...open].sort()).toEqual(["folder:fo-1", "folder:fo-2", "list:li-deep", "space:sp-a"]);
  });

  it("y las páginas por encima de la abierta", () => {
    const open = defaultExpanded(tree, { kind: "space", id: "sp-b" }, [{ id: "p1" }, { id: "p2" }]);
    expect([...open].sort()).toEqual(["page:p1", "page:p2", "space:sp-b"]);
  });

  it("sin documento abierto, nada", () => {
    expect(defaultExpanded(tree, null).size).toBe(0);
  });
});

/**
 * El filtro: lo que casa y de dónde cuelga. Mutantes: sin antepasados (una
 * página honda no tendría dónde pintarse); parar en la lista y no subir al
 * espacio; distinguir mayúsculas; no mirar las páginas.
 */
describe("filterDocsTree", () => {
  const pages = { "list:li-deep": [page("p1", "Credenciales"), page("p2", "Rotación de llaves", "p1")] };

  it("sin texto no filtra", () => {
    expect(filterDocsTree(tree, " ", pages)).toBeNull();
  });

  it("una página honda arrastra a su madre, su lista, sus carpetas y su espacio", () => {
    const keep = filterDocsTree(tree, "ROTACIÓN", pages)!;
    expect([...keep].sort()).toEqual(
      ["folder:fo-1", "folder:fo-2", "list:li-deep", pageKey("p1"), pageKey("p2"), "space:sp-a"].sort(),
    );
  });

  it("un nodo que casa por su nombre, con su camino y sin sus hermanos", () => {
    const keep = filterDocsTree(tree, "backlog", {})!;
    expect([...keep].sort()).toEqual(["folder:fo-1", "list:li-1", "space:sp-a"]);
  });

  it("nada que case, nada que enseñar", () => {
    expect(filterDocsTree(tree, "zzz", pages)!.size).toBe(0);
  });
});
