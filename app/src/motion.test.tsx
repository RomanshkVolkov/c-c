import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { BoardSkeleton, DocSkeleton, MessagesSkeleton, RowsSkeleton } from "@/components/ui/skeletons";
import { Skeleton } from "@/components/ui/skeleton";
import ViewSwitch from "@/components/tasks/ViewSwitch";

/**
 * El movimiento de la app (18-oct-2026): de dónde salen las animaciones, que
 * se respete a quien pide menos, y los huecos con forma mientras carga.
 */

afterEach(cleanup);
const css = readFileSync(join(process.cwd(), "src/index.css"), "utf8");

describe("diálogos y menús", () => {
  /**
   * Con los estados de base-ui y no con el zoom-95 de tw-animate: si vuelven
   * las dos, el diálogo se anima dos veces a la vez.
   */
  it("el diálogo entra con su curva y no con el zoom genérico", () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Hola</DialogTitle>
        </DialogContent>
      </Dialog>,
    );
    const popup = screen.getByRole("dialog");
    expect(popup.className).toContain("motion-dialog");
    expect(popup.className).not.toContain("animate-in");
  });

  it("un menú nace del botón que lo abre", () => {
    render(
      <DropdownMenu open>
        <DropdownMenuTrigger>abrir</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>uno</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    const menu = screen.getByRole("menu");
    expect(menu.className).toContain("motion-pop");
    expect(menu.className).not.toContain("zoom-in-95");
  });

  it("las clases que usan existen en index.css, con su estado de entrada y de salida", () => {
    for (const c of ["motion-dialog", "motion-pop", "motion-backdrop"]) {
      expect(css).toContain(`.${c}[data-starting-style]`);
      expect(css).toContain(`.${c}[data-ending-style]`);
    }
  });
});

describe("el muelle", () => {
  /**
   * Una curva que el WebKit no entiende anula la transición entera, en
   * silencio: la Bézier de reserva va primero y `linear()` sólo donde se
   * entiende. El mutante que mata: quitar la reserva.
   */
  it("hay curva de reserva para un WebKit sin linear()", () => {
    const root = css.slice(css.indexOf("--ease-out-expo"), css.indexOf("@supports (transition-timing-function: linear(0, 1))"));
    expect(root).toMatch(/--ease-spring:\s*cubic-bezier\(/);
    const supported = css.slice(css.indexOf("@supports (transition-timing-function: linear(0, 1))"));
    expect(supported).toMatch(/--ease-spring:\s*linear\(0,/);
  });

  /**
   * Las clases de movimiento están fuera de las capas de Tailwind, así que su
   * `transition` pisa la de las utilidades: lo que pulsa tiene que llevar en
   * su lista también los colores, o un botón dejaría de animar su hover.
   */
  it("lo que se pulsa sigue animando sus colores", () => {
    const press = css.slice(css.indexOf(".motion-press {"), css.indexOf(".motion-press:active"));
    for (const p of ["scale", "translate", "background-color", "border-color", "box-shadow"]) {
      expect(press).toContain(p);
    }
  });
});

describe("menos movimiento", () => {
  /**
   * Quien lo pide en el sistema no recibe animaciones en ningún sitio, no
   * sólo en la barra lateral. Mata el mutante de quitar la regla global.
   */
  it("una sola regla lo apaga todo", () => {
    const block = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(block).toMatch(/\*,\s*::before,\s*::after\s*\{[^}]*transition-duration:\s*0\.01ms !important/);
    expect(block).toMatch(/\.skeleton-shimmer\s*\{[^}]*animation:\s*none !important/);
  });
});

describe("mientras carga", () => {
  it("el hueco brilla en vez de parpadear", () => {
    const { container } = render(<Skeleton />);
    expect((container.firstChild as HTMLElement).className).toContain("skeleton-shimmer");
    expect((container.firstChild as HTMLElement).className).not.toContain("animate-pulse");
  });

  /** La forma se ve; el texto lo oye un lector de pantalla. */
  it.each([
    ["tablero", BoardSkeleton],
    ["documento", DocSkeleton],
    ["mensajes", MessagesSkeleton],
    ["filas", RowsSkeleton],
  ])("el de %s dice que carga sin pintarlo", (_n, Shape) => {
    render(<Shape label="Cargando…" />);
    const status = screen.getByRole("status");
    expect(status.textContent).toBe("Cargando…");
    expect(screen.getByText("Cargando…").className).toContain("sr-only");
  });
});

describe("las pestañas de una lista", () => {
  it("sin poder medir, la activa se subraya sola", () => {
    render(<ViewSwitch value="list" onChange={() => {}} />);
    expect(screen.getByRole("button", { name: "List" }).className).toContain("border-primary");
  });

  /** Con layout, un solo subrayado que se desliza hasta la activa. */
  it("midiendo, un subrayado que va a la activa", () => {
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(40);
    vi.spyOn(HTMLElement.prototype, "offsetLeft", "get").mockReturnValue(72);
    const { container } = render(<ViewSwitch value="list" onChange={() => {}} />);
    const bar = container.querySelector("span.bg-primary") as HTMLElement;
    expect(bar.style.left).toBe("72px");
    expect(bar.style.width).toBe("40px");
    expect(screen.getByRole("button", { name: "List" }).className).toContain("border-transparent");
    vi.restoreAllMocks();
  });
});
