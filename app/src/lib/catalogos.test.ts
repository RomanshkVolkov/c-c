import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { NAMESPACES } from "@/lib/i18n";

/**
 * Los dos catálogos dicen las mismas cosas.
 *
 * El modo de fallo es silencioso en las dos direcciones. Una clave que está en
 * inglés y no en castellano **sale en inglés** sin avisar —i18next cae al
 * idioma base y no se queja—, que es como se queda una pantalla medio
 * traducida. Y una que sólo está en castellano es peso muerto que nadie borra
 * porque nadie sabe que sobra.
 *
 * Existe porque los tipos sólo cubren una mitad: `i18next.d.ts` se declara
 * sobre el catálogo **inglés**, así que el compilador sabe qué claves existen
 * pero no si alguien las tradujo.
 */

type Catalogo = Record<string, unknown>;

function leer(locale: string, ns: string): Catalogo {
  return JSON.parse(
    readFileSync(join(process.cwd(), "src/locales", locale, `${ns}.json`), "utf-8"),
  ) as Catalogo;
}

/** Las claves de un catálogo, aplanadas: `menu.archivo.abrir`. */
function claves(o: Catalogo, prefijo = ""): string[] {
  return Object.entries(o).flatMap(([k, v]) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? claves(v as Catalogo, `${prefijo}${k}.`)
      : [`${prefijo}${k}`],
  );
}

describe("los catálogos", () => {
  it.each(NAMESPACES)("«%s» dice lo mismo en los dos idiomas", (ns) => {
    const en = claves(leer("en", ns)).sort();
    const es = claves(leer("es", ns)).sort();
    // Se separan las dos direcciones: «falta en castellano» y «sobra en
    // castellano» son fallos distintos y el mensaje tiene que decir cuál es.
    expect(en.filter((k) => !es.includes(k))).toEqual([]);
    expect(es.filter((k) => !en.includes(k))).toEqual([]);
  });

  it.each(NAMESPACES)("«%s» no tiene ninguna frase en blanco", (ns) => {
    for (const locale of ["en", "es"]) {
      const catalogo = leer(locale, ns);
      const vacias = claves(catalogo).filter((k) => {
        const v = k.split(".").reduce<unknown>((o, p) => (o as Catalogo)?.[p], catalogo);
        return typeof v === "string" && v.trim() === "";
      });
      expect(vacias, `${locale}/${ns}`).toEqual([]);
    }
  });

  /**
   * Y ningún catálogo se queda fuera de la lista.
   *
   * `NAMESPACES` se repite en tres sitios —el arranque, el hook y los tipos— y
   * el propio `i18n.ts` lo avisa. Un fichero de catálogo que exista y no esté
   * en la lista es un espacio de nombres que nadie carga: sus claves salen
   * crudas en pantalla.
   */
  it("la lista de espacios cubre todos los ficheros que hay", () => {
    const ficheros = readdirSync(join(process.cwd(), "src/locales/en"))
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/\.json$/, ""))
      .sort();
    expect(ficheros).toEqual([...NAMESPACES].sort());
  });
});
