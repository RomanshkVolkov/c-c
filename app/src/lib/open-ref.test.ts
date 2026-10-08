import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Un enlace de dentro se abre dentro.
 *
 * Lo que se prueba que antes no existía: un enlace a una **página** abre esa
 * página, y no la portada; y el orden importa —la página antes que el
 * documento— porque es lo que impide que pintar el documento la cierre.
 */

const orden: string[] = [];
const openTask = vi.fn(async (id: string) => void orden.push(`task:${id}`));
const openDoc = vi.fn(async (kind: string, id: string) => void orden.push(`doc:${kind}:${id}`));
let activeDoc: { kind: string; id: string } | null = null;
vi.mock("@/store/tasks.store", () => ({
  useTasksStore: { getState: () => ({ openTask, openDoc, activeDoc }) },
}));
const openPage = vi.fn(async (o: { id: string }, p: string) => void orden.push(`page:${o.id}:${p}`));
const closePage = vi.fn(() => void orden.push("portada"));
vi.mock("@/store/doc-pages.store", () => ({
  useDocPages: { getState: () => ({ openPage, closePage }) },
}));

const { openInternalRef } = await import("@/lib/open-ref");

beforeEach(() => {
  orden.length = 0;
  activeDoc = null;
  vi.clearAllMocks();
});

describe("un enlace de dentro", () => {
  it("a una página abre la página, antes que el documento", () => {
    expect(openInternalRef("/tasks?doc=list:l1&page=p9")).toBe(true);
    expect(orden).toEqual(["page:l1:p9", "doc:list:l1"]);
  });

  it("a un documento sin página vuelve a su portada", () => {
    expect(openInternalRef("/tasks?doc=space:s1")).toBe(true);
    expect(orden).toEqual(["portada", "doc:space:s1"]);
  });

  // Saltar entre páginas del mismo documento no lo vuelve a pedir: recargarlo
  // cerraría el editor de la portada y parpadearía.
  it("otra página del documento abierto no recarga el documento", () => {
    activeDoc = { kind: "list", id: "l1" };
    openInternalRef("/tasks?doc=list:l1&page=p2");
    expect(orden).toEqual(["page:l1:p2"]);
  });

  it("una tarjeta abre la tarjeta", () => {
    expect(openInternalRef("/tasks?task=t1")).toBe(true);
    expect(orden).toEqual(["task:t1"]);
  });

  it("una grabación se reclama aunque nadie sepa abrirla", () => {
    const abrir = vi.fn();
    const href = "cac:recording/0f8fad5b-d9cb-469f-a165-70867728950e";
    expect(openInternalRef(href, { onOpenRecordings: abrir })).toBe(true);
    expect(abrir).toHaveBeenCalled();
    expect(openInternalRef(href)).toBe(true);
  });

  it("un enlace de fuera sigue siendo de fuera", () => {
    expect(openInternalRef("https://ejemplo.com/tasks?doc=list:l1")).toBe(false);
    expect(orden).toEqual([]);
  });

  it("un tipo de nodo que no existe no se abre", () => {
    expect(openInternalRef("/tasks?doc=board:x1")).toBe(false);
  });
});
