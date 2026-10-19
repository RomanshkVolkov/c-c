import { describe, expect, it } from "vitest";
import { findScope, scopeGroups, scopeValue } from "@/lib/scope-options";
import type { SpaceTree } from "@/types/task";

const list = (id: string, name: string) => ({ id, name, taskCount: 0, openCount: 0 });
const tree = [
  { id: "g", orgId: "o", name: "General", color: "", kind: "general", folders: [], lists: [], people: [] },
  {
    id: "sp",
    orgId: "o",
    name: "Boaty",
    color: "",
    folders: [{ id: "f", name: "web", folders: [{ id: "f2", name: "app", folders: [], lists: [list("l3", "Bugs")] }], lists: [list("l2", "Tasks")] }],
    lists: [list("l1", "Ops")],
    people: [],
  },
] as SpaceTree[];

describe("a dónde se puede acotar Mi trabajo", () => {
  const groups = scopeGroups(tree, "Whole space");

  it("cada espacio, entero y por listas, también las de carpetas", () => {
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe("Boaty");
    expect(groups[0].options.map((o) => [o.value, o.label])).toEqual([
      ["space:sp", "Whole space"],
      ["list:l1", "Ops"],
      ["list:l2", "web / Tasks"],
      ["list:l3", "web / app / Bugs"],
    ]);
  });

  it("la sala general no sale: no tiene tareas", () => {
    expect(groups.find((g) => g.label === "General")).toBeUndefined();
  });

  it("del ámbito al valor y de vuelta, con el nombre como lo dice el árbol", () => {
    expect(scopeValue(null)).toBe("");
    expect(scopeValue({ kind: "list", id: "l2" })).toBe("list:l2");
    expect(findScope(groups, "list:l2")).toMatchObject({ kind: "list", id: "l2", name: "Tasks" });
    expect(findScope(groups, "nada")).toBeNull();
  });
});
