import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";

import { useIsMobile } from "./use-mobile";

/**
 * `useIsMobile` acierta en el **primer** render, no después de montar. Si
 * empieza en «no», el primer fotograma del teléfono es el de escritorio y un
 * efecto del mismo ciclo decide mal (así se abría solo un directo en el
 * móvil). Mutante: el estado inicial a `undefined`.
 */
describe("¿es un teléfono?", () => {
  it("se sabe desde el primer render", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    const vistos: boolean[] = [];
    function Sonda() {
      vistos.push(useIsMobile());
      return null;
    }
    render(<Sonda />);
    expect(vistos[0]).toBe(true);
  });
});
