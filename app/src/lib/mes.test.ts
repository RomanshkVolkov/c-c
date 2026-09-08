import { describe, expect, it } from "vitest";

import { claveDeDia, comoISO, desdeISO, diaDeVencimiento, rejillaDeMes } from "@/lib/mes";

/**
 * La aritmética de un mes.
 *
 * Está llena de bordes que sólo aparecen en un día concreto del año, y por eso
 * se comprueba con una tabla en vez de arrastrando el ratón: un mes que empieza
 * en domingo, febrero, y sobre todo la ida y vuelta de `YYYY-MM-DD`, que es
 * donde los selectores de fecha guardan el día equivocado.
 */
describe("la rejilla de un mes", () => {
  it("son siempre 42 días, empiece el mes donde empiece", () => {
    for (const m of [0, 1, 5, 8, 11]) {
      expect(rejillaDeMes(new Date(2026, m, 1))).toHaveLength(42);
    }
  });

  /**
   * Siempre seis semanas, aunque el mes quepa en cinco.
   *
   * Con un número variable la rejilla cambia de alto al pasar de mes, y el botón
   * que ibas a pulsar se mueve debajo del cursor.
   */
  it("empieza en lunes", () => {
    for (const m of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]) {
      const primera = rejillaDeMes(new Date(2026, m, 1))[0];
      expect(primera.getDay()).toBe(1);
    }
  });

  // Febrero de 2026 empieza en domingo: sin el desplazamiento de lunes, la
  // rejilla saldría corrida una semana entera.
  it("un mes que empieza en domingo no se corre", () => {
    const feb = rejillaDeMes(new Date(2026, 1, 1));
    expect(feb[0].getDate()).toBe(26); // lunes 26 de enero
    expect(feb.some((d) => claveDeDia(d) === claveDeDia(new Date(2026, 1, 1)))).toBe(true);
  });

  it("contiene el mes entero", () => {
    const dias = rejillaDeMes(new Date(2026, 1, 1)).map(claveDeDia);
    for (let d = 1; d <= 28; d++) {
      expect(dias).toContain(claveDeDia(new Date(2026, 1, d)));
    }
  });
});

describe("la ida y vuelta de una fecha", () => {
  it("va y vuelve al mismo día", () => {
    const d = new Date(2026, 8, 7);
    expect(claveDeDia(desdeISO(comoISO(d))!)).toBe(claveDeDia(d));
  });

  /**
   * El fallo clásico de un selector de fecha: eliges un día y se guarda el de
   * antes.
   *
   * `new Date("2026-09-07")` lo interpreta como **UTC**, así que al oeste de
   * Greenwich cae en el día anterior. Por eso se parsea a mano.
   */
  it("un día suelto no se convierte en el anterior", () => {
    const d = desdeISO("2026-09-07")!;
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(8);
    expect(d.getDate()).toBe(7);
  });

  it("y se escribe con ceros a la izquierda", () => {
    expect(comoISO(new Date(2026, 0, 5))).toBe("2026-01-05");
  });

  it("lo que no es una fecha no se inventa", () => {
    expect(desdeISO("")).toBeNull();
    expect(desdeISO("7/9/2026")).toBeNull();
  });
});

/**
 * Un vencimiento es una fecha, no un instante.
 *
 * Se guarda como el día a medianoche **UTC**, así que leerlo con los captadores
 * locales corre el día entero en cualquier zona al oeste de Greenwich: eliges el
 * 7 y en México se ve el 6.
 *
 * Se comprueba por sus componentes locales y no comparando fechas, porque eso es
 * justo lo que tiene que ser cierto **en cualquier zona horaria** — incluida
 * aquella en la que corra esta prueba.
 */
describe("el día de vencimiento", () => {
  it("es el que se eligió, en cualquier zona", () => {
    const d = diaDeVencimiento("2026-09-07T00:00:00.000Z")!;
    expect([d.getFullYear(), d.getMonth(), d.getDate()]).toEqual([2026, 8, 7]);
  });

  it("y a medianoche local, para que restar días sea exacto", () => {
    const d = diaDeVencimiento("2026-09-07T00:00:00.000Z")!;
    expect([d.getHours(), d.getMinutes()]).toEqual([0, 0]);
  });

  it("sin fecha no inventa ninguna", () => {
    expect(diaDeVencimiento(null)).toBeNull();
    expect(diaDeVencimiento("")).toBeNull();
    expect(diaDeVencimiento("no soy una fecha")).toBeNull();
  });
});
