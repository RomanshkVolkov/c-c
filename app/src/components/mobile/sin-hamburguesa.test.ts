import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * El móvil va con el menú de abajo y sin hamburguesa (11-oct-2026). Se lee el
 * fuente de `AppLayout` porque lo que importa es qué se monta y dónde:
 * - no vuelve el botón del cajón lateral;
 * - el menú va **dentro** de la columna (`SidebarInset`), detrás del contenido,
 *   para que empuje al redactor y no lo tape;
 * - los avisos, arriba en el teléfono, que abajo está el menú;
 * - y `index.html` pide la zona segura, sin la cual el relleno de abajo del
 *   iPhone vale cero.
 * Mutantes: cada una de las cuatro.
 */
const leer = (f: string) => readFileSync(join(process.cwd(), f), "utf-8");

describe("el armazón en el teléfono", () => {
  it("no tiene hamburguesa", () => {
    expect(leer("src/components/AppLayout.tsx")).not.toContain("SidebarTrigger");
  });

  it("monta el menú de abajo dentro de la columna, tras el contenido", () => {
    const s = leer("src/components/AppLayout.tsx");
    const columna = s.slice(s.indexOf("<SidebarInset"), s.indexOf("</SidebarInset>"));
    expect(columna.indexOf("<Outlet />")).toBeGreaterThan(-1);
    expect(columna.indexOf("<MobileTabBar />")).toBeGreaterThan(columna.indexOf("<Outlet />"));
  });

  it("pone los avisos arriba en el teléfono", () => {
    expect(leer("src/components/AppLayout.tsx")).toContain('position={movil ? "top-center" : "bottom-right"}');
  });

  it("pide la zona segura del iPhone", () => {
    expect(leer("index.html")).toContain("viewport-fit=cover");
  });
});
