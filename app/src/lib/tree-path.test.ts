import { describe, expect, it } from "vitest";

import { filterTree, pathTo } from "@/lib/tree-path";
import type { SpaceTree } from "@/types/task";

const list = (id: string, name: string) => ({ id, name, taskCount: 0, openCount: 0 });

const tree: SpaceTree[] = [
  {
    id: "sp-a",
    orgId: "o",
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
    lists: [list("li-top", "Pendientes")],
  },
  { id: "sp-b", orgId: "o", name: "Valkey", color: "", people: [], folders: [], lists: [list("li-v", "Operación")] },
];

/**
 * El camino hasta un nodo es lo que el árbol abre por defecto: la rama de lo
 * que estás mirando, y nada más. Mutantes: devolver sólo el nodo (sin
 * ancestros); no bajar a carpetas anidadas.
 */
describe("pathTo", () => {
  it("una lista honda arrastra su espacio y las dos carpetas", () => {
    expect(pathTo(tree, { kind: "list", id: "li-deep" })).toEqual(["sp-a", "fo-1", "fo-2", "li-deep"]);
  });

  it("una lista suelta del espacio, sólo el espacio", () => {
    expect(pathTo(tree, { kind: "list", id: "li-top" })).toEqual(["sp-a", "li-top"]);
  });

  it("una carpeta, y un espacio", () => {
    expect(pathTo(tree, { kind: "folder", id: "fo-2" })).toEqual(["sp-a", "fo-1", "fo-2"]);
    expect(pathTo(tree, { kind: "space", id: "sp-b" })).toEqual(["sp-b"]);
  });

  it("lo que no está, vacío", () => {
    expect(pathTo(tree, { kind: "list", id: "nope" })).toEqual([]);
  });
});

/**
 * El filtro del panel: lo que casa, de dónde cuelga, y lo que lleva dentro.
 * Mutantes: sin antecesores (la lista honda no tendría dónde pintarse); casar
 * sólo los espacios; distinguir mayúsculas.
 */
describe("filterTree", () => {
  it("sin texto no filtra", () => {
    expect(filterTree(tree, "")).toBeNull();
    expect(filterTree(tree, "   ")).toBeNull();
  });

  it("una lista honda trae su camino entero, y nada de lo demás", () => {
    const v = filterTree(tree, "inven")!;
    expect([...v].sort()).toEqual(["fo-1", "fo-2", "li-deep", "sp-a"].sort());
  });

  it("sin distinguir mayúsculas", () => {
    expect(filterTree(tree, "BACKLOG")!.has("li-1")).toBe(true);
  });

  it("un espacio que casa enseña lo que tiene dentro", () => {
    const v = filterTree(tree, "valkey")!;
    expect(v.has("sp-b")).toBe(true);
    expect(v.has("li-v")).toBe(true);
    expect(v.has("sp-a")).toBe(false);
  });
});
