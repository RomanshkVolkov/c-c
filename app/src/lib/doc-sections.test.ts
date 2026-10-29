import { describe, expect, it } from "vitest";

import { headingKey, scrollToSection, sectionHref, sectionsByLine } from "@/lib/doc-sections";
import type { DocSection } from "@/types/task";

/**
 * Los títulos que pinta el markdown se casan con las secciones del servidor
 * por su línea (command-and-control-91). Con el slug del texto dos «Notas»
 * daban la misma, y un título con marcas no casaba con nada.
 */

const sec = (id: string, heading: string, level: number, index: number): DocSection => ({ id, heading, level, index });

describe("headingKey", () => {
  it("compara sin mayúsculas, acentos ni marcas, como el backend", () => {
    expect(headingKey("**Volver Atrás**")).toBe(headingKey("volver atras"));
    expect(headingKey("Desplegar")).not.toBe(headingKey("Desplegar todo"));
  });
});

describe("sectionsByLine", () => {
  const body = "# Arriba\n\n## Notas\n\na\n\n```bash\n# no es un título\n```\n\n## Notas\n\n### Notas\n\n## **Correo** saliente\n";
  const secs = [sec("a", "Arriba", 1, 0), sec("n1", "Notas", 2, 1), sec("n2", "Notas", 2, 2), sec("h3", "Notas", 3, 3), sec("c", "Correo saliente", 2, 4)];

  it("cada título, por su línea, con su sección; también los repetidos y los que llevan marcas", () => {
    const m = sectionsByLine(body, secs);
    expect([...m.entries()].map(([l, s]) => `${l}:${s.id}`)).toEqual(["1:a", "3:n1", "11:n2", "13:h3", "15:c"]);
  });

  it("una sección atrasada (otro título en su puesto) no se lleva el título", () => {
    const m = sectionsByLine("## Uno\n## Dos\n", [sec("x", "Uno", 2, 0), sec("y", "Otro", 2, 1)]);
    expect(m.get(1)?.id).toBe("x");
    expect(m.get(2)).toBeUndefined();
  });

  it("ni con otro nivel", () => {
    expect(sectionsByLine("### Uno\n", [sec("x", "Uno", 2, 0)]).size).toBe(0);
  });

  it("sin secciones no casa nada", () => {
    expect(sectionsByLine("## x\n", undefined).size).toBe(0);
  });
});

describe("sectionHref", () => {
  const base = { id: "l", kind: "section" as const, addedAt: "", ownerKind: "list" as const, ownerId: "L1" };
  it("lleva a la pestaña y a la sección", () => {
    expect(sectionHref({ ...base, tab: "runbook", sectionId: "s1" })).toBe("/tasks?doc=list:L1&tab=runbook&section=s1");
  });
  it("una de una página lleva a la página, no a la pestaña", () => {
    expect(sectionHref({ ...base, pageId: "p1", sectionId: "s1" })).toBe("/tasks?doc=list:L1&page=p1&section=s1");
  });
  it("una que ya no está lleva al documento, no a un ancla que no existe", () => {
    expect(sectionHref({ ...base, tab: "runbook", sectionId: "s1", sectionRemoved: true })).toBe("/tasks?doc=list:L1&tab=runbook");
  });
  it("sin dónde vive no hay enlace", () => {
    expect(sectionHref({ id: "l", kind: "section", addedAt: "" })).toBeNull();
  });
});

describe("scrollToSection", () => {
  it("salta a la sección pintada y dice si la encontró", () => {
    document.body.innerHTML = '<h2 data-section-id="s1">A</h2><h2 data-section-id="s2">B</h2>';
    const el = document.querySelector('[data-section-id="s2"]') as HTMLElement;
    let scrolled = false;
    el.scrollIntoView = () => {
      scrolled = true;
    };
    expect(scrollToSection(document, "s2")).toBe(true);
    expect(scrolled).toBe(true);
    // Si aún no está pintada, la petición sigue esperando.
    expect(scrollToSection(document, "s3")).toBe(false);
    expect(scrollToSection(document, null)).toBe(false);
  });
});
