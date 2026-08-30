import { describe, expect, it } from "vitest";
import i18next from "i18next";

import { joinNames } from "@/lib/people-list";

/**
 * Unir nombres, y la frase que los envuelve.
 *
 * Antes esto devolvía **media oración** —«Marta está»— para que la vista le
 * pegara el verbo. Funcionaba en los dos idiomas por casualidad; una frase
 * partida por la mitad no se puede arreglar desde el catálogo en cuanto un
 * idioma ordene las palabras de otra forma.
 *
 * Ahora son dos cosas separadas: la lista la une `Intl`, y la frase entera —con
 * su verbo concordado— vive en el catálogo. Esto prueba las dos.
 */

describe("unir nombres", () => {
  it("uno solo se queda como está", () => {
    expect(joinNames(["Marta"], "en")).toBe("Marta");
    expect(joinNames(["Marta"], "es")).toBe("Marta");
  });

  it("ninguno no inventa nada", () => {
    expect(joinNames([], "en")).toBe("");
  });

  // Cada idioma pone su conjunción, y el inglés además su coma antes del «and».
  it("cada idioma une a su manera", () => {
    const en = joinNames(["Marta", "Luis", "Elena"], "en");
    const es = joinNames(["Marta", "Luis", "Elena"], "es");
    expect(en).toContain("and");
    expect(es).toContain(" y ");
    expect(en).not.toBe(es);
  });

  it("y todos los nombres están", () => {
    const unidos = joinNames(["Marta", "Luis", "Elena"], "es");
    for (const n of ["Marta", "Luis", "Elena"]) expect(unidos).toContain(n);
  });
});

describe("la frase que los envuelve", () => {
  // El fallo que esto evita es el clásico «1 people are talking».
  it("el verbo concuerda con cuántos son", () => {
    const uno = i18next.t("common:voice.inChannel", { people: "Marta", count: 1, lng: "en" });
    const varios = i18next.t("common:voice.inChannel", {
      people: "Marta and Luis", count: 2, lng: "en",
    });
    expect(uno).toContain(" is ");
    expect(varios).toContain(" are ");
  });

  it("y también en castellano", () => {
    const uno = i18next.t("common:voice.inChannel", { people: "Marta", count: 1, lng: "es" });
    const varios = i18next.t("common:voice.inChannel", {
      people: "Marta y Luis", count: 2, lng: "es",
    });
    expect(uno).toContain("está ");
    expect(varios).toContain("están ");
  });

  it("la frase lleva los nombres dentro, no al lado", () => {
    const frase = i18next.t("common:voice.inChannel", { people: "Marta", count: 1, lng: "es" });
    expect(frase.startsWith("Marta")).toBe(true);
    expect(frase.trim().endsWith(".")).toBe(true);
  });
});
