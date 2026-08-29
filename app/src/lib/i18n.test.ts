import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { LOCALES } from "@/store/locale.store";

/**
 * Los dos catálogos dicen lo mismo.
 *
 * Éste es **el** modo de fallo de traducir una aplicación, y no se parece a un
 * fallo: una clave que falta en castellano sale en inglés, sin error, sin traza
 * y sin romper nada. La interfaz queda medio traducida y sólo se entera quien la
 * mire — normalmente un cliente.
 *
 * Se comparan los ficheros, no lo que i18next haya cargado en memoria: lo que se
 * quiere vigilar es que nadie añada una frase a un idioma y se olvide del otro,
 * y eso pasa en el fichero.
 */

const RAIZ = join(process.cwd(), "src/locales");

/** Todas las claves de un objeto anidado, aplanadas: `action.save`. */
function claves(obj: unknown, prefijo = ""): string[] {
  if (typeof obj !== "object" || obj === null) return [prefijo];
  return Object.entries(obj).flatMap(([k, v]) =>
    claves(v, prefijo ? `${prefijo}.${k}` : k),
  );
}

function catalogo(locale: string, ns: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(RAIZ, locale, `${ns}.json`), "utf-8"));
}

const espacios = readdirSync(join(RAIZ, "en"))
  .filter((f) => f.endsWith(".json"))
  .map((f) => f.replace(/\.json$/, ""));

describe("los catálogos", () => {
  it("tienen los mismos ficheros en los dos idiomas", () => {
    for (const locale of LOCALES) {
      const suyos = readdirSync(join(RAIZ, locale)).filter((f) => f.endsWith(".json")).sort();
      expect(suyos).toEqual(espacios.map((n) => `${n}.json`).sort());
    }
  });

  // La prueba que importa: una clave añadida en inglés y olvidada en castellano
  // no se ve en ninguna pantalla hasta que alguien lee esa frase en español.
  it.each(espacios)("«%s» tiene las mismas claves en los dos", (ns) => {
    const enClaves = claves(catalogo("en", ns)).sort();
    for (const locale of LOCALES) {
      if (locale === "en") continue;
      const otras = claves(catalogo(locale, ns)).sort();
      const faltan = enClaves.filter((k) => !otras.includes(k));
      const sobran = otras.filter((k) => !enClaves.includes(k));
      expect({ faltan, sobran }).toEqual({ faltan: [], sobran: [] });
    }
  });

  // Una cadena vacía pasa el control de claves y deja un hueco en pantalla, que
  // es peor que la frase en inglés.
  it.each(espacios)("«%s» no tiene traducciones vacías", (ns) => {
    for (const locale of LOCALES) {
      const plano = catalogo(locale, ns);
      const vacias = claves(plano).filter((k) => {
        const valor = k.split(".").reduce<unknown>((o, p) => (o as never)?.[p], plano);
        return typeof valor === "string" && valor.trim() === "";
      });
      expect(vacias).toEqual([]);
    }
  });

  // Sin esto, una frase en inglés dentro del catálogo español pasaría por
  // traducida. No se puede comprobar el idioma, pero sí que alguien lo tocó.
  it("el castellano no es una copia literal del inglés", () => {
    const en = JSON.stringify(catalogo("en", "common"));
    const es = JSON.stringify(catalogo("es", "common"));
    expect(es).not.toBe(en);
  });
});
