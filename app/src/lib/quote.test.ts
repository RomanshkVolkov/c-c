import { describe, expect, it } from "vitest";

import { quoteText } from "@/lib/quote";

/**
 * El texto de una cita: lo que dice, en una línea y sin el marcado.
 * Mutantes: dejar el `[texto](url)` crudo; perder el texto de un enlace; dejar
 * los `**`; no juntar las líneas.
 */
describe("el texto de una cita", () => {
  it("quita el marcado y deja lo que se lee", () => {
    expect(quoteText("**ojo**: mira [el PR](https://github.com/x/y/pull/1)\n\n- uno\n- dos")).toBe(
      "ojo: mira el PR uno dos",
    );
  });

  it("una imagen queda como su nombre, y un encabezado como su texto", () => {
    expect(quoteText("## Lanzamiento\n![captura.png](cacmedia://x/1)")).toBe("Lanzamiento 🖼 captura.png");
  });

  it("no se come los guiones bajos de un nombre", () => {
    expect(quoteText("revisa DB_HOST y snake_case_name")).toBe("revisa DB_HOST y snake_case_name");
  });

  // El editor guarda `<` como `&lt;`: en la lista de directos salía «&lt;3».
  // Mutante: no deshacer las entidades, o deshacer `&amp;` primero (convertiría
  // «&amp;lt;» en «<» en vez de en «&lt;»).
  it("las entidades del editor se leen como lo que son", () => {
    expect(quoteText("&lt;3 &amp; &quot;ok&quot; &#39;ya&#39;")).toBe(`<3 & "ok" 'ya'`);
    expect(quoteText("escribe &amp;lt; tal cual")).toBe("escribe &lt; tal cual");
  });
});

