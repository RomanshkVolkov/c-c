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
const read = (f: string) => readFileSync(join(process.cwd(), f), "utf-8");

describe("el armazón en el teléfono", () => {
  it("no tiene hamburguesa", () => {
    expect(read("src/components/AppLayout.tsx")).not.toContain("SidebarTrigger");
  });

  it("monta el menú de abajo dentro de la columna, tras el contenido", () => {
    const s = read("src/components/AppLayout.tsx");
    const column = s.slice(s.indexOf("<SidebarInset"), s.indexOf("</SidebarInset>"));
    expect(column.indexOf("<Outlet />")).toBeGreaterThan(-1);
    expect(column.indexOf("<MobileTabBar />")).toBeGreaterThan(column.indexOf("<Outlet />"));
  });

  it("pone los avisos arriba en el teléfono", () => {
    expect(read("src/components/AppLayout.tsx")).toContain('position={mobile ? "top-center" : "bottom-right"}');
  });

  it("pide la zona segura del iPhone", () => {
    expect(read("index.html")).toContain("viewport-fit=cover");
  });
});
