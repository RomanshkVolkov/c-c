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
});
