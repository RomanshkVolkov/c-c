import { describe, expect, it } from "vitest";

import { headingsOf, slugify } from "@/lib/headings";

/**
 * El índice de un documento y las anclas del texto salen de aquí.
 *
 * Los dos: el índice lista los encabezados y el renderizador los marca. Si
 * divergieran, el índice apuntaría a anclas que no existen — y eso no se ve
 * hasta que alguien pulsa, que es el peor momento para enterarse.
 */
describe("las anclas", () => {
  // Sin esto, «Configuración» y «Configuracion» darían anclas distintas y el
  // índice de cualquier documento en castellano se rompería a la primera.
  it("los acentos y las eñes no cambian el ancla", () => {
    expect(slugify("Configuración")).toBe("configuracion");
    expect(slugify("Año de diseño")).toBe("ano-de-diseno");
  });

  it("ni la puntuación ni las mayúsculas", () => {
    expect(slugify("¿Qué es esto?")).toBe("que-es-esto");
    expect(slugify("Variables de entorno (prod)")).toBe("variables-de-entorno-prod");
  });
});

describe("los encabezados de un markdown", () => {
  it("salen con su nivel y en orden", () => {
    const hs = headingsOf("## Uno\ntexto\n### Uno punto uno\n## Dos");
    expect(hs.map((h) => [h.level, h.text])).toEqual([
      [2, "Uno"],
      [3, "Uno punto uno"],
      [2, "Dos"],
    ]);
  });

  /**
   * Un `#` dentro de un bloque de código **no** es una sección.
   *
   * Es un comentario de shell, y en un runbook —que es medio código— los hay a
   * puñados. Sin esto, el índice de un runbook se llenaría de basura.
   */
  it("lo que hay dentro de un bloque de código no cuenta", () => {
    const hs = headingsOf("## Pasos\n```bash\n## no soy un título\n# ni yo\n```\n## Vuelta atrás");
    expect(hs.map((h) => h.text)).toEqual(["Pasos", "Vuelta atrás"]);
  });

  // El `#` de nivel 1 se deja fuera: el documento ya tiene título arriba, y un
  // segundo título dentro del cuerpo confunde más que ayuda.
  it("el nivel 1 se ignora", () => {
    expect(headingsOf("# Título\n## Sección").map((h) => h.text)).toEqual(["Sección"]);
  });

  it("el énfasis no se cuela en el texto ni en el ancla", () => {
    const [h] = headingsOf("## **Variables** de `entorno`");
    expect(h.text).toBe("Variables de entorno");
    expect(h.id).toBe("variables-de-entorno");
  });
});
