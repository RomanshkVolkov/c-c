import { describe, expect, it } from "vitest";

import { syncPageTitles } from "./page-titles";

/**
 * Un bloque de página dice el título de hoy, no el que tenía al enlazarse
 * (27-oct-2026: `/page` deja la subpágina «Sin título» y se renombra después).
 */
const titles: Record<string, string> = {
  a1: "Arquitectura",
  b2: "Notas *de* campo",
  c3: "Igual",
  d4: "v1.2 - final",
  e5: "v1.2 *beta*",
};
const titleOf = (id: string) => titles[id];

describe("el título de un bloque de página", () => {
  it("se pone al día con el de la página", () => {
    expect(syncPageTitles("Intro\n\n[Sin título](/notes/a1)\n\nFin", titleOf)).toBe(
      "Intro\n\n[Arquitectura](/notes/a1)\n\nFin",
    );
  });

  it("escapa lo que en markdown sería formato", () => {
    expect(syncPageTitles("[x](/notes/b2)", titleOf)).toBe("[Notas \\*de\\* campo](/notes/b2)");
  });

  it("si ya coincide, devuelve el mismo texto, aunque esté escapado", () => {
    const md = "[Notas \\*de\\* campo](/notes/b2)\n\n[Igual](/notes/c3)";
    expect(syncPageTitles(md, titleOf)).toBe(md);
  });

  it("si coincide pero el editor lo escapó de otra forma, tampoco se reescribe", () => {
    // El editor no escapa un punto ni un guion en mitad del texto; reescribirlo
    // con los nuestros guardaría la nota cada vez que se abre.
    for (const md of ["[v1.2 - final](/notes/d4)", "[v1.2 \\*beta\\*](/notes/e5)"]) {
      expect(syncPageTitles(md, titleOf)).toBe(md);
    }
  });

  it("un enlace en mitad de una frase conserva su texto", () => {
    for (const md of ["Ver [esto](/notes/a1) antes de seguir", "Ver [esto](/notes/a1)", "[esto](/notes/a1) y más"]) {
      expect(syncPageTitles(md, titleOf)).toBe(md);
    }
  });

  it("ni una página que no está en el árbol, ni otra clase de enlace", () => {
    const md = "[Viejo](/notes/zz)\n\n[Fuera](https://ejemplo.com/notes/a1)";
    expect(syncPageTitles(md, titleOf)).toBe(md);
  });

  it("dentro de un bloque de código no se toca", () => {
    const md = "```\n[Sin título](/notes/a1)\n```";
    expect(syncPageTitles(md, titleOf)).toBe(md);
  });
});
