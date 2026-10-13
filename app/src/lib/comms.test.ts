import { describe, expect, it } from "vitest";

import { orderedChannels, resolveSpace } from "@/lib/comms";
import type { SpaceTree } from "@/types/task";

const space = (id: string, kind?: string) =>
  ({ id, orgId: "o", name: id, color: "", kind, folders: [], lists: [], people: [] }) as unknown as SpaceTree;

const tree = [space("sp-1"), space("sp-2"), space("sp-g", "general")];

/**
 * Qué canal está en pantalla. La contestan la página y el panel, y tienen que
 * contestar lo mismo. Mutantes: invertir pedido y recordado; olvidar la
 * general; no caer al siguiente con un id que ya no está.
 */
describe("resolveSpace", () => {
  it("lo pedido gana a lo recordado", () => {
    expect(resolveSpace(tree, "sp-1", "sp-2")?.id).toBe("sp-1");
  });

  it("sin pedido, lo recordado", () => {
    expect(resolveSpace(tree, null, "sp-2")?.id).toBe("sp-2");
  });

  it("sin nada, la general antes que el primero", () => {
    expect(resolveSpace(tree, null, null)?.id).toBe("sp-g");
  });

  it("sin general, el primero", () => {
    expect(resolveSpace([space("sp-1"), space("sp-2")], null, undefined)?.id).toBe("sp-1");
  });

  it("un id que ya no está cae al siguiente", () => {
    expect(resolveSpace(tree, "borrado", "sp-2")?.id).toBe("sp-2");
    expect(resolveSpace(tree, "borrado", "tambien")?.id).toBe("sp-g");
  });

  it("sin canales, nada", () => {
    expect(resolveSpace([], "sp-1", "sp-2")).toBeUndefined();
  });
});

describe("orderedChannels", () => {
  it("separa la general del resto, sin perder el orden", () => {
    const { general, rest } = orderedChannels(tree);
    expect(general?.id).toBe("sp-g");
    expect(rest.map((s) => s.id)).toEqual(["sp-1", "sp-2"]);
  });
});
