import { describe, expect, it } from "vitest";

import { diffStats, lineDiff } from "@/lib/line-diff";

describe("lo que cambió entre dos versiones", () => {
  it("marca lo que entra y lo que sale", () => {
    const rows = lineDiff("a\nb\nc", "a\nB\nc");
    expect(rows).toEqual([
      { kind: "same", text: "a" },
      { kind: "del", text: "b" },
      { kind: "add", text: "B" },
      { kind: "same", text: "c" },
    ]);
    expect(diffStats(rows)).toEqual({ added: 1, removed: 1 });
  });

  it("pliega lo igual que queda lejos de un cambio", () => {
    const antes = Array.from({ length: 20 }, (_, i) => `l${i}`).join("\n");
    const despues = antes.replace("l10", "diez");
    const rows = lineDiff(antes, despues, 2);
    expect(rows[0]).toEqual({ kind: "skip", count: 8 });
    expect(rows.filter((r) => r.kind === "same")).toHaveLength(4);
    expect(rows[rows.length - 1]).toEqual({ kind: "skip", count: 7 });
  });

  it("dos textos iguales: todo plegado, ningún cambio", () => {
    const rows = lineDiff("x\ny", "x\ny");
    expect(rows).toEqual([{ kind: "skip", count: 2 }]);
    expect(diffStats(rows)).toEqual({ added: 0, removed: 0 });
  });
});
