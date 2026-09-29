import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Un cambio de organización se atiende en un solo sitio.
 *
 * El directo de otra org se quedaba abierto porque el único que lo cerraba era
 * `DMSwitcher`, y lo hacía comparando la org con la anterior guardada en un
 * `useRef`: eso sólo ve los cambios que ocurren con ese componente montado.
 * Cualquier pantalla que vuelva a hacerlo así hereda el mismo agujero.
 *
 * Así que aquí se exige:
 * - que nadie más que `store/org-switch.ts` se suscriba a `useOrgsStore`;
 * - que ningún `useRef` guarde la org de antes para compararla.
 */

const src = join(process.cwd(), "src");
const ficheros: string[] = [];
const recorrer = (dir: string) => {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) recorrer(p);
    else if (/\.tsx?$/.test(n) && !/\.test\.tsx?$/.test(n)) ficheros.push(p);
  }
};
recorrer(src);

describe("el cambio de org", () => {
  it("se recorrió de verdad", () => {
    // Sin esto, un recorrido que no encontrara nada pasaría sin mirar.
    expect(ficheros.length).toBeGreaterThan(50);
  });

  it("sólo lo escucha org-switch.ts", () => {
    const fuera = ficheros
      .filter((f) => !f.endsWith(join("store", "org-switch.ts")))
      .filter((f) => /useOrgsStore\.subscribe\(/.test(readFileSync(f, "utf8")))
      .map((f) => relative(src, f));
    expect(fuera).toEqual([]);
  });

  it("nadie guarda la org anterior en un useRef para compararla", () => {
    const culpables = ficheros
      .filter((f) => {
        const s = readFileSync(f, "utf8");
        // Un ref al que se le asigna la org actual: `algo.current = orgId`.
        return /useRef/.test(s) && /\.current\s*=\s*(orgId|currentOrgId)\b/.test(s);
      })
      .map((f) => relative(src, f));
    expect(culpables).toEqual([]);
  });
});
