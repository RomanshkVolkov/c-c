import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

import i18next from "i18next";

import errorsEn from "@/locales/en/errors.json";
import { phraseFor } from "@/lib/server-errors";

/**
 * El error del servidor, en el idioma de quien lo lee.
 *
 * La etiqueta de código (`inbox-other-org`) es la clave del catálogo. Eso hace
 * que este circuito tenga un modo de fallo propio y silencioso: el servidor
 * inventa un código nuevo, aquí no está, y en pantalla sale la frase en inglés
 * sin que nada avise. Estas pruebas son lo que lo saca a la luz.
 */

/**
 * Los códigos que el backend puede mandarle a una persona.
 *
 * Se leen del fuente de Go, y **el fichero entero de una vez**: una llamada a
 * `SendErrorResponse` ocupa dos o tres líneas casi siempre, así que buscarlos
 * línea a línea —como se hacía— dejaba fuera a la mayoría. Cuando se arregló
 * aparecieron **veinticuatro** códigos sin traducir que llevaban meses
 * saliendo en inglés: `bad-transition`, `ring-outsider`, `subtasks-open`…
 *
 * `recording_internal.go` no cuenta. Sus códigos viajan por el puerto interno
 * —el que habla con el montador— y no hay ningún camino por el que lleguen a
 * una pantalla. Exigirles una frase sería pedir que se traduzca algo que sólo
 * lee otro proceso.
 */
const SIN_LECTOR_HUMANO = ["recording_internal.go"];

function ficherosGo(dir: string): string[] {
  const out: string[] = [];
  for (const nombre of readdirSync(dir)) {
    const ruta = join(dir, nombre);
    if (statSync(ruta).isDirectory()) {
      out.push(...ficherosGo(ruta));
    } else if (
      nombre.endsWith(".go") &&
      !nombre.endsWith("_test.go") &&
      !SIN_LECTOR_HUMANO.includes(nombre)
    ) {
      out.push(ruta);
    }
  }
  return out;
}

function codigosDelBackend(): string[] | null {
  const raiz = join(process.cwd(), "..", "backend", "internal");
  let ficheros: string[];
  try {
    ficheros = ficherosGo(raiz);
  } catch {
    return null;
  }
  const codigos = new Set<string>();
  // El último literal entre comillas de la llamada es el código. `[^()]` casa
  // también saltos de línea, que es lo que hace que una llamada partida en tres
  // se vea entera; la rama `\([^()]*\)` deja pasar los paréntesis de dentro,
  // como el `http.StatusConflict` o un `err.Error()`.
  const patron = /SendErrorResponse\((?:[^()]|\([^()]*\))*?"([a-z][a-z0-9-]+)"\s*\)/g;
  for (const f of ficheros) {
    const texto = readFileSync(f, "utf-8");
    for (const m of texto.matchAll(patron)) codigos.add(m[1]);
  }
  return [...codigos];
}

describe("las etiquetas de error", () => {
  /**
   * Todos los códigos que el servidor sabe emitir están en el catálogo.
   *
   * Se leen del **fuente de Go**, no de una lista escrita a mano: una lista a
   * mano se queda vieja el día que alguien añade un `SendErrorResponse`, que es
   * justo el día en que esto importaría.
   */
  it("cubren lo que el servidor sabe emitir", () => {
    const codigos = codigosDelBackend();
    if (codigos === null) return; // sin el backend a mano, esta prueba no aplica
    // Ochenta y pico hoy. El suelo existe para que un fallo al recogerlos
    // —una ruta mal puesta, un regex que deja de casar— no se vea como «no
    // falta ninguno».
    expect(codigos.length).toBeGreaterThan(60);
    const faltan = codigos.filter((c) => !(c in errorsEn));
    expect(faltan).toEqual([]);
  });

  // Una frase vacía pasaría el control de arriba y dejaría un toast en blanco,
  // que es peor que el código crudo.
  it("ninguna está vacía en ninguno de los dos idiomas", () => {
    for (const locale of ["en", "es"]) {
      const catalogo = JSON.parse(
        readFileSync(join(process.cwd(), "src/locales", locale, "errors.json"), "utf-8"),
      ) as Record<string, string>;
      const vacias = Object.entries(catalogo)
        .filter(([, v]) => v.trim() === "")
        .map(([k]) => k);
      expect(vacias).toEqual([]);
    }
  });

  // Y que se traduzcan de verdad, no que se queden en la clave.
  it("se dicen distinto en cada idioma", () => {
    const en = i18next.t("errors:not-found", { lng: "en" });
    const es = i18next.t("errors:not-found", { lng: "es" });
    expect(en).not.toBe(es);
    expect(es).not.toContain("not-found");
  });

  // El modo de fallo del otro lado: un servidor más nuevo con un código que
  // esta versión no conoce. Lo que se enseña es la frase que ese servidor mandó,
  // no la etiqueta cruda.
  it("un código desconocido no se enseña crudo", () => {
    expect("widget-exploded" in errorsEn).toBe(false);
  });

  // Las dos ramas de `phraseFor`, que es donde vive la decisión.
  it("un código conocido gana a la frase del servidor", () => {
    const dicho = phraseFor("not-found", "Not found");
    expect(dicho).toBe(i18next.t("errors:not-found"));
    expect(dicho).not.toBe("Not found");
  });

  it("uno desconocido conserva la frase del servidor, no la etiqueta", () => {
    expect(phraseFor("widget-exploded", "The widget exploded")).toBe("The widget exploded");
  });

  // Sin código —hay respuestas que no lo traen— tampoco puede quedarse en blanco.
  it("sin código, la frase del servidor", () => {
    expect(phraseFor("", "Request failed")).toBe("Request failed");
  });

  /**
   * Y los que emite el motor de voz, que es un tercer sitio que puede inventar
   * códigos: Go, Rust y el catálogo tienen que estar de acuerdo, y el que se
   * queda atrás no avisa — sale la etiqueta cruda en un toast.
   */
  it("cubren también lo que emite el motor de voz", () => {
    const raiz = join(process.cwd(), "src-tauri", "src");
    let salida = "";
    try {
      salida = execSync(`grep -rhoE 'Err\\("voice-[a-z-]+"' ${raiz}`, { encoding: "utf-8" });
    } catch {
      return; // sin el crate a mano, esta prueba no aplica
    }
    const codigos = [
      ...new Set(
        salida
          .split("\n")
          .map((l) => l.match(/"(voice-[a-z-]+)"/)?.[1])
          .filter((c): c is string => Boolean(c)),
      ),
    ];
    expect(codigos.length).toBeGreaterThan(5);
    const faltan = codigos.filter((c) => !(c in errorsEn));
    expect(faltan).toEqual([]);
  });
});
