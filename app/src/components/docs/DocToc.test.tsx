import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import DocToc from "@/components/docs/DocToc";
import { headingsOf } from "@/lib/headings";

/**
 * «En esta página»: fijo al hacer scroll, al lado en pantallas grandes y
 * plegado a un botón por debajo.
 *
 * Se quedaba arriba al bajar por el documento —justo cuando un documento es lo
 * bastante largo para necesitarlo—, y en una tablet se comía ~250px de texto
 * (9-oct-2026).
 */

const MD = "## Qué es\n\nuno\n\n## Piezas\n\ndos\n\n### Detalle\n\ntres";

// jsdom no tiene IntersectionObserver: uno de pega que apunta con qué raíz se
// creó, que es lo que hay que comprobar.
const raices: (Element | Document | null | undefined)[] = [];
beforeEach(() => {
  raices.length = 0;
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(_cb: unknown, opts?: IntersectionObserverInit) {
        raices.push(opts?.root);
      }
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const montar = (md = MD) => {
  const r = render(
    <div data-doc-scroll>
      {headingsOf(md).map((h) => (
        <h2 key={h.id} id={h.id}>
          {h.text}
        </h2>
      ))}
      <DocToc markdown={md} />
    </div>,
  );
  return r.container.querySelector("[data-doc-scroll]")!;
};

describe("el índice de un documento", () => {
  it("al lado, fijo al hacer scroll, y sólo en pantallas grandes", () => {
    montar();
    const lado = document.querySelector('[data-toc="side"]')!;
    expect(lado.classList.contains("sticky")).toBe(true);
    expect(lado.classList.contains("top-0")).toBe(true);
    expect(lado.classList.contains("xl:block")).toBe(true);
    expect(lado.classList.contains("hidden")).toBe(true);
  });

  it("por debajo, un botón fijo que no ocupa columna", () => {
    montar();
    const boton = document.querySelector('[data-toc="button"]')!;
    expect(boton.classList.contains("sticky")).toBe(true);
    expect(boton.classList.contains("w-0")).toBe(true);
    expect(boton.classList.contains("xl:hidden")).toBe(true);
  });

  it("el botón abre la lista y elegir un título salta a él", async () => {
    montar();
    const salto = vi.fn();
    document.getElementById(headingsOf(MD)[1].id)!.scrollIntoView = salto;
    fireEvent.click(screen.getByRole("button", { name: "On this page" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Piezas" }));
    expect(salto).toHaveBeenCalled();
  });

  // Contra la ventana, un título ya escondido bajo la cabecera del documento
  // seguía contando como el que se está leyendo.
  it("el título activo se mide contra lo que hace scroll, no contra la ventana", () => {
    const scroller = montar();
    expect(raices).toEqual([scroller]);
  });

  it("con un solo título no hay índice", () => {
    montar("## Solo\n\ntexto");
    expect(document.querySelector("[data-toc]")).toBeNull();
  });
});
