import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import i18next from "i18next";

import { fecha, fechaYHora, horaCorta } from "@/lib/fechas";

/**
 * Las fechas siguen al idioma elegido, no al del ordenador.
 *
 * Este fallo no se ve mirando: la interfaz sale en castellano y las fechas en
 * `10/1/2025, 8:11:38 AM`, que parece un detalle hasta que te fijas en el AM.
 * `toLocale*String()` sin argumento significa «el del sistema operativo», y el
 * del sistema no tiene por qué ser el que la persona eligió en la aplicación.
 */
describe("las fechas", () => {
  const CUANDO = new Date("2026-09-01T20:11:38Z");

  it("cambian con el idioma", () => {
    i18next.changeLanguage("en");
    const en = fechaYHora(CUANDO);
    i18next.changeLanguage("es");
    const es = fechaYHora(CUANDO);
    i18next.changeLanguage("en");
    expect(en).not.toBe(es);
  });

  // El inglés de Estados Unidos pone el mes primero y usa AM/PM; el castellano
  // no hace ni lo uno ni lo otro. Es lo que se veía en la captura del reporte.
  it("en castellano no salen en formato americano", () => {
    i18next.changeLanguage("es");
    const dicho = fechaYHora(CUANDO);
    i18next.changeLanguage("en");
    expect(dicho).not.toMatch(/\bAM\b|\bPM\b/i);
  });

  /**
   * Una fecha que no vale no puede tirar la pantalla.
   *
   * `Intl.DateTimeFormat.format()` **lanza** con una fecha inválida, y el
   * `toLocaleString()` al que sustituye devolvía «Invalid Date». Al convertir el
   * último sitio, dos pruebas del cajón de tareas se cayeron con «Invalid time
   * value» — o sea que el cambio convertía un campo nulo en un pantallazo.
   */
  it("una fecha inválida se rinde en vez de lanzar", () => {
    for (const malo of [undefined, null, "", "no soy una fecha", NaN]) {
      expect(() => fechaYHora(malo as never)).not.toThrow();
      expect(fechaYHora(malo as never)).toBe("—");
    }
  });

  it("y las tres formas dicen lo suyo y no más", () => {
    i18next.changeLanguage("en");
    expect(fecha(CUANDO)).not.toMatch(/:/); // sin hora
    expect(horaCorta(CUANDO)).not.toMatch(/\//); // sin fecha
    expect(fechaYHora(CUANDO)).toMatch(/:/);
  });
});

/**
 * Y que no vuelva a colarse el vigésimo sitio.
 *
 * Había **tres deletreos** del mismo fallo y el barrido inicial sólo cazó uno:
 * `toLocaleDateString()` a secas, `toLocaleDateString(undefined, …)` y
 * `toLocaleTimeString([], …)`. Los tres significan lo mismo. Por eso el patrón
 * de aquí abajo mira el nombre del método y no la forma del argumento.
 */
describe("y que no vuelvan a seguir al sistema", () => {
  const RAIZ = join(process.cwd(), "src");

  // Los instrumentos van aparte; ver `docs/idiomas.md`.
  const FUERA = /\/(devtools|CryptoTools|RequestClient|VoiceLab|ImageTool)|lib\/fechas\.ts/;

  function fuentes(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const ruta = join(dir, e.name);
      if (e.isDirectory()) return fuentes(ruta);
      if (!/\.tsx?$/.test(e.name) || e.name.includes(".test.")) return [];
      return [ruta];
    });
  }

  it("ningún `toLocale*String` fuera de `lib/fechas.ts`", () => {
    const fugas: string[] = [];
    for (const fichero of fuentes(RAIZ)) {
      if (FUERA.test(fichero)) continue;
      readFileSync(fichero, "utf-8")
        .split("\n")
        .forEach((linea, i) => {
          if (/\.toLocale(Date|Time)?String\(/.test(linea)) {
            fugas.push(`${fichero.replace(RAIZ, "src")}:${i + 1}: ${linea.trim()}`);
          }
        });
    }
    expect(fugas).toEqual([]);
  });
});
