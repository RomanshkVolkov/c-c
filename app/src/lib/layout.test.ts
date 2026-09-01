import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Una caja que desborda dentro de una columna flex necesita `min-h-0`.
 *
 * Es la regla menos intuitiva de flexbox y la que más caro sale: un elemento
 * flex trae `min-height: auto`, o sea que **se niega a encogerse por debajo de
 * su contenido**. Así que un `flex-1 overflow-y-auto` sin `min-h-0` no desborda
 * nunca — crece, empuja a lo que tenga debajo fuera de la vista, y el scroll
 * acaba en otro sitio.
 *
 * Costó dos veces el mismo día:
 *
 * - En el chat de una llamada, la lista se comía el área de escribir, y el
 *   `scrollIntoView` movía un ancestro cualquiera porque la lista no desbordaba.
 * - Y en el armazón entero, donde faltaba el techo: `scrollTop = scrollHeight`
 *   era un no-op silencioso y un canal abría por los mensajes más viejos.
 *
 * Mientras la aplicación crecía con la página nada de esto se notaba. Desde que
 * `AppLayout` pone techo, cada caja tiene que desbordar en lo suyo.
 *
 * `min-h-0` sobre algo que ya se encogía no cambia nada, así que ponerlo de más
 * es gratis y ponerlo de menos cuesta una tarde de buscar.
 */
describe("las cajas que desbordan", () => {
  const RAIZ = join(process.cwd(), "src");

  // shadcn copiado: sus clases vienen de fuera y se regeneran.
  const PRESTADO = /\/components\/ui\//;

  function fuentes(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const ruta = join(dir, e.name);
      if (e.isDirectory()) return fuentes(ruta);
      if (!/\.tsx$/.test(e.name) || e.name.includes(".test.")) return [];
      return [ruta];
    });
  }

  it("declaran `min-h-0` cuando además son `flex-1`", () => {
    const fugas: string[] = [];
    for (const fichero of fuentes(RAIZ)) {
      if (PRESTADO.test(fichero)) continue;
      readFileSync(fichero, "utf-8")
        .split("\n")
        .forEach((linea, i) => {
          const m = linea.match(/className="([^"]*)"/);
          if (!m) return;
          const cls = m[1];
          const desborda = /\boverflow-(y-)?auto\b/.test(cls);
          const crece = /\bflex-1\b/.test(cls);
          if (desborda && crece && !/\bmin-h-0\b/.test(cls)) {
            fugas.push(`${fichero.replace(RAIZ, "src")}:${i + 1}: ${cls}`);
          }
        });
    }
    expect(fugas).toEqual([]);
  });
});
