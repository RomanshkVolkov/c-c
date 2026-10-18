import { describe, expect, it } from "vitest";
import { EMPTY_FILTER, NOBODY, filterOptions, isFiltering, matchesFilter, type TaskFilter } from "@/lib/task-filter";
import type { TaskCard } from "@/types/task";

const card = (over: Partial<TaskCard>): TaskCard => ({
  id: "t",
  seq: 1,
  title: "Tarea",
  priority: "none",
  statusId: "s",
  hasDescription: false,
  commentCount: 0,
  attachmentCount: 0,
  subtaskCount: 0,
  subtaskDone: 0,
  tags: [],
  assignees: [],
  updatedAt: "",
  createdAt: "",
  ...over,
});
const tag = (id: string, name: string) => ({ id, orgId: "o", name, color: "#000" });
const user = (id: string, username: string) => ({ id, username });
const f = (over: Partial<TaskFilter>): TaskFilter => ({ ...EMPTY_FILTER, ...over });

describe("buscar", () => {
  it("por el título, sin mayúsculas ni acentos", () => {
    expect(matchesFilter(card({ title: "Revisión del Backup" }), f({ query: "revision" }))).toBe(true);
    expect(matchesFilter(card({ title: "Revisión del Backup" }), f({ query: "BACKUP" }))).toBe(true);
    expect(matchesFilter(card({ title: "Revisión del Backup" }), f({ query: "restaurar" }))).toBe(false);
  });

  it("por el folio, con o sin almohadilla, y entero: #1 no es #12", () => {
    expect(matchesFilter(card({ seq: 12, title: "x" }), f({ query: "#12" }))).toBe(true);
    expect(matchesFilter(card({ seq: 12, title: "x" }), f({ query: "12" }))).toBe(true);
    expect(matchesFilter(card({ seq: 12, title: "x" }), f({ query: "#1" }))).toBe(false);
  });

  it("un número también se busca en el título", () => {
    expect(matchesFilter(card({ seq: 3, title: "Migrar a v2" }), f({ query: "2" }))).toBe(true);
  });
});

describe("filtrar", () => {
  it("por responsable, y «sin asignar» son las que no tienen a nadie", () => {
    const ana = card({ assignees: [user("u1", "ana")] });
    const none = card({});
    expect(matchesFilter(ana, f({ assignee: "u1" }))).toBe(true);
    expect(matchesFilter(none, f({ assignee: "u1" }))).toBe(false);
    expect(matchesFilter(none, f({ assignee: NOBODY }))).toBe(true);
    expect(matchesFilter(ana, f({ assignee: NOBODY }))).toBe(false);
  });

  /** La guardada `medium` y la `normal` de la API son la misma (CLAUDE.md). */
  it("por prioridad, con medium y normal como la misma", () => {
    expect(matchesFilter(card({ priority: "medium" as never }), f({ priority: "normal" }))).toBe(true);
    expect(matchesFilter(card({ priority: "normal" }), f({ priority: "normal" }))).toBe(true);
    expect(matchesFilter(card({ priority: "high" }), f({ priority: "normal" }))).toBe(false);
  });

  it("por etiqueta, clase y área", () => {
    const c = card({ tags: [tag("g1", "bug")], category: "ui", area: "pagos" });
    expect(matchesFilter(c, f({ tag: "g1", category: "ui", area: "pagos" }))).toBe(true);
    expect(matchesFilter(c, f({ tag: "g2" }))).toBe(false);
    expect(matchesFilter(c, f({ category: "datos" }))).toBe(false);
    expect(matchesFilter(c, f({ area: "envíos" }))).toBe(false);
  });

  it("sin nada puesto, pasan todas; y espacios en el buscador no son un filtro", () => {
    expect(matchesFilter(card({}), EMPTY_FILTER)).toBe(true);
    expect(isFiltering(f({ query: "  " }))).toBe(false);
    expect(isFiltering(f({ tag: "g1" }))).toBe(true);
  });
});

describe("qué desplegables se ofrecen", () => {
  it("responsable sólo si separa algo; «sin nadie» cuenta", () => {
    expect(filterOptions([card({ assignees: [user("u1", "ana")] })]).assignees).toEqual([]);
    expect(filterOptions([card({ assignees: [user("u1", "ana")] }), card({})]).assignees).toEqual([{ id: "u1", name: "ana" }]);
  });

  it("prioridad con dos distintas, en el orden de la peor a la mejor", () => {
    expect(filterOptions([card({ priority: "low" }), card({ priority: "low" })]).priorities).toEqual([]);
    expect(filterOptions([card({ priority: "low" }), card({ priority: "urgent" }), card({ priority: "medium" as never })]).priorities).toEqual([
      "urgent",
      "normal",
      "low",
    ]);
  });

  it("una sola etiqueta ya separa las que la llevan", () => {
    expect(filterOptions([card({ tags: [tag("g1", "bug")] }), card({})]).tags).toEqual([{ id: "g1", name: "bug" }]);
    expect(filterOptions([card({})]).tags).toEqual([]);
  });

  /**
   * Lo elegido se sigue ofreciendo aunque ya no separe: si el desplegable
   * desapareciera con el filtro puesto, no habría cómo quitarlo.
   */
  it("lo elegido se sigue ofreciendo", () => {
    const one = [card({ priority: "low" })];
    expect(filterOptions(one, f({ priority: "low" })).priorities).toEqual(["low"]);
  });
});
