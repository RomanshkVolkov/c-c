import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Ningún `<select>` nativo en la app. En Linux (WebKitGTK) abre un menú del
 * sistema blanco, sin el tema, que se sale de la ventana con opciones largas
 * (jose, 7-oct-2026, «Los reportes caen en»). Se usa `Picker`
 * (`components/ui/picker.tsx`), que tiene la misma forma. Mutante: volver a
 * poner un `<select>` en cualquier pantalla.
 */
function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return tsxFiles(p);
    return p.endsWith(".tsx") && !p.endsWith(".test.tsx") ? [p] : [];
  });
}

describe("los desplegables de la app", () => {
  it("ninguno es un <select> nativo", () => {
    // picker.tsx lo nombra en sus comentarios: es justo el que lo sustituye.
    const con = tsxFiles(join(process.cwd(), "src"))
      .filter((f) => !f.endsWith(join("ui", "picker.tsx")))
      .filter((f) => /<select[\s>]/.test(readFileSync(f, "utf8")));
    expect(con, "usa Picker (components/ui/picker.tsx) en vez de <select>").toEqual([]);
  });
});
