import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";

import { highlightSnippet } from "@/lib/snippet";

/**
 * El fragmento de la búsqueda llega con `**` alrededor de lo encontrado y se
 * pinta como texto: un documento lo escribió cualquiera, y un `<b>` dentro de
 * él no puede acabar siendo marcado de verdad en la paleta.
 */
describe("el fragmento de una búsqueda", () => {
  it("resalta lo encontrado y nada más", () => {
    const { container } = render(<p>{highlightSnippet("cómo se **despliega** el **pocna**-jobs")}</p>);
    const marcas = [...container.querySelectorAll("mark")].map((m) => m.textContent);
    expect(marcas).toEqual(["despliega", "pocna"]);
    expect(container.textContent).toBe("cómo se despliega el pocna-jobs");
  });

  it("el HTML de un documento sale como texto", () => {
    const { container } = render(<p>{highlightSnippet("<b>hola</b> **x**")}</p>);
    expect(container.querySelector("b")).toBeNull();
    expect(container.textContent).toContain("<b>hola</b>");
  });

  it("sin marcas, el texto entero y ninguna marca", () => {
    const { container } = render(<p>{highlightSnippet("nada que resaltar")}</p>);
    expect(container.querySelectorAll("mark")).toHaveLength(0);
    expect(container.textContent).toBe("nada que resaltar");
  });
});
