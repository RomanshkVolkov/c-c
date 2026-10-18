import { readdirSync, readFileSync, statSync } from "node:fs";
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
    for (const p of ["scale", "translate", "background-color", "border-color"]) {
      expect(press).toContain(p);
    }
    // Y la sombra no: va en la capa de `.lift`, que sólo cambia de opacidad.
    expect(press).not.toContain("box-shadow");
  });
});

describe("el rendimiento en WebKitGTK", () => {
  const motion = css.slice(css.indexOf("Reglas de rendimiento"), css.indexOf("/* El brillo que recorre"));
  /** Las propiedades que se animan en las clases de movimiento. */
  const animated = [...motion.matchAll(/transition:\s*([^;]+);/g)].flatMap((m) =>
    m[1].split(",").map((part) => part.trim().split(/\s+/)[0]),
  );

  /**
   * Sólo lo que mueve el compositor sin repintar. El mutante que mata:
   * volver a animar el desenfoque de un diálogo o la sombra de una tarjeta.
   */
  it("sólo se animan opacidad, escala, posición y colores", () => {
    const allowed = ["opacity", "scale", "translate", "color", "background-color", "border-color"];
    expect(animated.length).toBeGreaterThan(5);
    expect(animated.filter((p) => !allowed.includes(p))).toEqual([]);
  });

  it("ni desenfoque animado, ni detrás de un diálogo o un panel", () => {
    // Declaraciones, no el comentario que explica por qué no.
    expect(motion).not.toMatch(/^\s*(backdrop-)?filter:/m);
    for (const f of ["src/components/ui/dialog.tsx", "src/components/ui/sheet.tsx"]) {
      expect(readFileSync(join(process.cwd(), f), "utf8")).not.toContain("backdrop-blur");
    }
  });

  /** En una lista larga, sólo las primeras de cada columna entran animadas. */
  it("la entrada de las tarjetas se limita a las primeras", () => {
    expect(css).toContain(".motion-enter:nth-child(-n + 12)");
    expect(css).not.toMatch(/\.motion-enter\s*\{/);
  });

  it("con la ventana oculta, las animaciones en pausa", () => {
    expect(css).toMatch(/html\.app-hidden \*[^{]*\{[^}]*animation-play-state:\s*paused/);
  });
});

describe("las barras de pestañas", () => {
  /** Todos los .tsx de la app, sin las pruebas. */
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return files(path);
      return path.endsWith(".tsx") && !path.includes(".test.") ? [path] : [];
    });

  /**
   * Ninguna se hace su propio subrayado: todas usan el indicador que se
   * desliza (`useSlidingIndicator` + `TabIndicator`). Había trece hechas a
   * mano, cada una con su raya que se apagaba en una y se encendía en otra.
   * El mutante que mata: una barra nueva copiada de las de antes.
   */
  it("ninguna lleva su propia raya de pestaña activa", () => {
    const own = files(join(process.cwd(), "src")).filter((f) => {
      const src = readFileSync(f, "utf8");
      return src.includes("border-b-2") && src.includes("border-primary") && !src.includes("use-sliding-indicator");
    });
    expect(own.map((f) => f.slice(f.indexOf("src/")))).toEqual([]);
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
    const bar = container.querySelector('[data-slot="tab-indicator"]') as HTMLElement;
    // Con `translate`, que lo mueve el compositor; no con `left`.
    expect(bar.style.translate).toBe("72px 0");
    expect(bar.style.left).toBe("");
    expect(bar.style.width).toBe("40px");
    expect(screen.getByRole("button", { name: "List" }).className).toContain("border-transparent");
    vi.restoreAllMocks();
  });
});
