import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { StrictMode } from "react";

import Markdown from "@/components/markdown/Markdown";
import type { DocSection } from "@/types/task";

/**
 * Cada título de un documento lleva el id de su sección —a donde salta un
 * enlace— y, al lado, lo que se pida pintar: la marca de sus decisiones
 * (command-and-control-91).
 */

afterEach(cleanup);

const body = "# Runbook\n\n## Notas\n\na\n\n## **Correo** saliente\n\nb\n\n## Notas\n\nc\n\n#### Hondo\n";
const sections: DocSection[] = [
  { id: "s-run", heading: "Runbook", level: 1, index: 0 },
  { id: "s-n1", heading: "Notas", level: 2, index: 1, decisions: [{ id: "d1", title: "x", decidedAt: "" }] },
  { id: "s-correo", heading: "**Correo** saliente", level: 2, index: 2 },
  { id: "s-n2", heading: "Notas", level: 2, index: 3 },
  { id: "s-hondo", heading: "Hondo", level: 4, index: 4 },
];

describe("títulos con su sección", () => {
  // En modo estricto React pinta dos veces: el primer intento casaba los
  // títulos por orden de pintado y la segunda pasada los dejaba sin sección.
  it("cada título lleva su id, también los repetidos, los que llevan marcas y los hondos", () => {
    const { container } = render(
      <StrictMode>
        <Markdown sections={sections}>{body}</Markdown>
      </StrictMode>,
    );
    const ids = [...container.querySelectorAll("[data-section-id]")].map((h) => `${h.tagName}:${h.getAttribute("data-section-id")}`);
    expect(ids).toEqual(["H1:s-run", "H2:s-n1", "H2:s-correo", "H2:s-n2", "H4:s-hondo"]);
  });

  it("pinta la marca sólo donde se pide, al lado del título", () => {
    const { container } = render(
      <Markdown sections={sections} sectionMark={(s) => (s.decisions?.length ? <i data-mark={s.id} /> : null)}>
        {body}
      </Markdown>,
    );
    const marks = [...container.querySelectorAll("[data-mark]")];
    expect(marks.map((m) => m.getAttribute("data-mark"))).toEqual(["s-n1"]);
    expect(marks[0].closest("h2")?.getAttribute("data-section-id")).toBe("s-n1");
  });

  it("los h2 y h3 siguen con el ancla del índice, y sin secciones no llevan id de sección", () => {
    const { container } = render(<Markdown>{"## Volver atrás\n"}</Markdown>);
    const h2 = container.querySelector("h2")!;
    expect(h2.id).toBe("volver-atras");
    expect(h2.hasAttribute("data-section-id")).toBe(false);
  });
});
