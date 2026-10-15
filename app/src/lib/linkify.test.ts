import { describe, expect, it } from "vitest";

import { linkify } from "@/lib/linkify";

/**
 * Los enlaces de un texto plano.
 * Mutantes: comerse el punto final dentro del enlace; cortar el `)` de un
 * enlace que lo abre; perder el texto de alrededor.
 */
describe("los enlaces de un texto", () => {
  it("separa el enlace del texto y deja fuera la puntuación de la frase", () => {
    expect(linkify("mira https://cac.guz-studio.dev/docs?x=1. y dime")).toEqual([
      { kind: "text", text: "mira " },
      { kind: "link", href: "https://cac.guz-studio.dev/docs?x=1" },
      { kind: "text", text: ". y dime" },
    ]);
  });

  it("un paréntesis es del enlace sólo si lo abre dentro", () => {
    expect(linkify("(ver https://es.wikipedia.org/wiki/Foo_(bar))")).toEqual([
      { kind: "text", text: "(ver " },
      { kind: "link", href: "https://es.wikipedia.org/wiki/Foo_(bar)" },
      { kind: "text", text: ")" },
    ]);
  });

  it("sin enlaces, el texto tal cual; y varios en la misma línea", () => {
    expect(linkify("hola")).toEqual([{ kind: "text", text: "hola" }]);
    expect(linkify("http://a.com y https://b.com").filter((p) => p.kind === "link")).toHaveLength(2);
  });
});
