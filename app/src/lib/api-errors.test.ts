import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
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

describe("las etiquetas de error", () => {
  /**
   * Todos los códigos que el servidor sabe emitir están en el catálogo.
   *
   * Se leen del **fuente de Go**, no de una lista escrita a mano: una lista a
   * mano se queda vieja el día que alguien añade un `SendErrorResponse`, que es
   * justo el día en que esto importaría.
   */
  it("cubren lo que el servidor sabe emitir", () => {
    const raiz = join(process.cwd(), "..", "backend", "internal");
    let salida = "";
    try {
      salida = execSync(
        `grep -rhoE 'SendErrorResponse\\([^)]*"[a-z][a-z0-9-]+"\\)' --include=*.go ${raiz}`,
        { encoding: "utf-8" },
      );
    } catch {
      return; // sin el backend a mano, esta prueba no aplica
    }
    const codigos = [
      ...new Set(
        salida
          .split("\n")
          .map((l) => l.match(/"([a-z][a-z0-9-]+)"\)$/)?.[1])
          .filter((c): c is string => Boolean(c)),
      ),
    ];
    expect(codigos.length).toBeGreaterThan(20);
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
