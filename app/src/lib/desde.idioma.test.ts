import { afterEach, describe, expect, it, vi } from "vitest";
import i18next from "i18next";

import { desde, faltan } from "@/lib/desde";

/**
 * El tiempo relativo, en los dos idiomas.
 *
 * Antes eran siete cadenas inglesas cosidas a mano —«3 d ago», «yesterday»— con
 * su plural escrito con un condicional. Ahora lo dice `Intl`, que sabe las
 * formas de cada idioma sin que nadie las escriba.
 *
 * Lo que se prueba aquí no es el texto exacto —eso es cosa de la plataforma y
 * cambia entre versiones— sino que **cambia con el idioma** y que **la unidad y
 * el signo son los correctos**, que es lo que sí decidimos nosotros.
 */

const haceMin = (n: number) => new Date(Date.now() - n * 60_000).toISOString();
// El reloj congelado, y no `Date.now()` dos veces.
//
// `faltan` vuelve a leer la hora para restar, así que entre construir la fecha y
// medirla pasa una fracción de milisegundo: cinco horas se redondean hacia abajo
// a cuatro cuando las dos lecturas caen a los lados de un milisegundo. El fallo
// era del test, no del cálculo, y aparecía una vez de cada tantas.
const AHORA = new Date("2026-09-02T12:00:00.000Z");
const enHoras = (n: number) => new Date(AHORA.getTime() + n * 3_600_000).toISOString();

afterEach(() => void i18next.changeLanguage("en"));

describe("cuánto hace", () => {
  it("sin marca no inventa una fecha", async () => {
    expect(desde(null)).toBe("never");
    await i18next.changeLanguage("es");
    expect(desde(null)).toBe("nunca");
  });

  // Por debajo de dos minutos la cifra no aporta y la frase se lee peor.
  it("lo recién pasado es «ahora», sin número", async () => {
    expect(desde(haceMin(1))).toBe("now");
    await i18next.changeLanguage("es");
    expect(desde(haceMin(1))).toBe("ahora");
  });

  it("habla en el idioma que esté puesto", async () => {
    const enIngles = desde(haceMin(30));
    await i18next.changeLanguage("es");
    const enCastellano = desde(haceMin(30));
    expect(enCastellano).not.toBe(enIngles);
    expect(enCastellano.toLowerCase()).toContain("min");
  });

  // Lo que decidimos nosotros es la unidad: minutos por debajo de una hora,
  // horas por debajo de un día, días por encima.
  it("elige la unidad según cuánto hace", () => {
    expect(desde(haceMin(30)).toLowerCase()).toContain("min");
    expect(desde(haceMin(60 * 5))).toMatch(/h/i);
    expect(desde(haceMin(60 * 24 * 3))).toMatch(/d/i);
  });

  // «hace 1 día» se dice «ayer», y en inglés «yesterday». Era una rama escrita a
  // mano; ahora la pone quien sabe hacerlo en los dos idiomas.
  it("un día es «ayer», no «hace 1 día»", async () => {
    expect(desde(haceMin(60 * 24 + 5))).toBe("yesterday");
    await i18next.changeLanguage("es");
    expect(desde(haceMin(60 * 24 + 5))).toBe("ayer");
  });

  // El plural es el que más se nota y el que peor se cose a mano.
  it("el plural lo pone el idioma", async () => {
    await i18next.changeLanguage("es");
    expect(desde(haceMin(60 * 24 * 2))).not.toBe(desde(haceMin(60 * 24 * 5)));
  });
});

describe("cuánto falta", () => {
  it("mira al futuro, no al pasado", () => {
    vi.useFakeTimers();
    vi.setSystemTime(AHORA);
    const queda = faltan(enHoras(5));
    // Un plazo que vence **en** cinco horas, no que venció hace cinco.
    expect(queda).not.toContain("ago");
    expect(queda).toMatch(/5/);
    vi.useRealTimers();
  });

  it("lo ya vencido no dice nada", () => {
    expect(faltan(new Date(Date.now() - 1000).toISOString())).toBe("");
    expect(faltan(null)).toBe("");
  });

  // «en 0 horas» para algo que vence en cuarenta minutos suena a que ya venció.
  it("nunca dice cero", () => {
    expect(faltan(new Date(Date.now() + 40 * 60_000).toISOString())).toMatch(/1/);
  });
});
