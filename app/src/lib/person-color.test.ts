import { describe, expect, it } from "vitest";
import { hueIndex, hueVar, personTint } from "@/lib/person-color";

describe("el color de una persona o un espacio", () => {
  it("es siempre el mismo para el mismo nombre", () => {
    expect(personTint("jose")).toBe(personTint("jose"));
    expect(hueVar("sp-1")).toBe(hueVar("sp-1"));
  });

  /**
   * Y reparte: con un puñado de nombres salen todos los colores de la paleta.
   * El mutante que mata: un hash que siempre cae en el mismo, que es volver
   * al cian para todos con otro nombre.
   */
  it("reparte por toda la paleta", () => {
    const seen = new Set(Array.from({ length: 200 }, (_, i) => hueIndex(`persona-${i}`)));
    expect(seen.size).toBe(8);
  });

  /** Cada una de las ocho, tintada y con el mismo número en fondo y texto. */
  it("cada color es un fondo tintado y su texto, del mismo tono", () => {
    for (let i = 0; i < 200; i++) {
      const name = `persona-${i}`;
      const n = hueIndex(name) + 1;
      expect(personTint(name)).toBe(`bg-hue-${n}/15 text-hue-${n}`);
      expect(hueVar(name)).toBe(`var(--hue-${n})`);
    }
  });
});
