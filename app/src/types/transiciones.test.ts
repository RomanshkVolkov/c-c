import { describe, expect, it } from "vitest";

import { puedeIr, type TransitionsMap } from "./report";

/**
 * Qué movimientos ofrece el tablero.
 *
 * La regla es del servidor: `open` y `done` no son adyacentes, se pasa por
 * `in_progress`. Antes el tablero ofrecía las cuatro columnas y el servidor
 * rechazaba después — con un **500**, además, que se leía como una avería.
 *
 * Lo que se prueba aquí es la consulta, y sobre todo los dos casos que deciden
 * si esto es útil o un estorbo: qué pasa sin mapa, y qué pasa al reordenar
 * dentro de la misma columna.
 */

/** Como llega de `fetchTransitions`, ya plegado al vocabulario de la app. */
const MAPA: TransitionsMap = {
  open: ["in_progress", "closed"],
  in_progress: ["open", "done", "closed"],
  done: ["in_progress", "closed"],
  closed: [],
};

describe("qué movimientos se ofrecen", () => {
  it("de Open a In progress sí", () => {
    expect(puedeIr(MAPA, "open", "in_progress")).toBe(true);
  });

  // El caso que abrió todo esto: se cerraron dos tarjetas desde el MCP y hubo
  // que pasarlas por In progress a mano.
  it("de Open a Done no: no son adyacentes", () => {
    expect(puedeIr(MAPA, "open", "done")).toBe(false);
  });

  it("de Closed no se sale a ningún sitio", () => {
    expect(puedeIr(MAPA, "closed", "open")).toBe(false);
    expect(puedeIr(MAPA, "closed", "in_progress")).toBe(false);
    expect(puedeIr(MAPA, "closed", "done")).toBe(false);
  });

  it("a Closed se llega desde cualquiera", () => {
    expect(puedeIr(MAPA, "open", "closed")).toBe(true);
    expect(puedeIr(MAPA, "in_progress", "closed")).toBe(true);
    expect(puedeIr(MAPA, "done", "closed")).toBe(true);
  });

  // Reordenar dentro de una columna no es una transición, y la tabla del
  // servidor no se lista a sí misma como destino. Sin este caso, subir una
  // tarjeta dos posiciones quedaría prohibida — y nadie relacionaría las dos
  // cosas.
  it("quedarse donde estás siempre vale, aunque la tabla no se liste a sí misma", () => {
    expect(puedeIr(MAPA, "open", "open")).toBe(true);
    expect(puedeIr(MAPA, "closed", "closed")).toBe(true);
  });

  // Si la petición aún no volvió o falló, se deja pasar y que conteste el
  // servidor con su 409. Bloquear por no saber convertiría un fallo de red en
  // un tablero congelado, que es peor que un movimiento rechazado.
  it("sin mapa todo vale, en vez de congelar el tablero", () => {
    expect(puedeIr(null, "open", "done")).toBe(true);
    expect(puedeIr(null, "closed", "open")).toBe(true);
  });

  // Un estado que el mapa no menciona no puede tumbar el arrastre.
  it("un estado desconocido no revienta", () => {
    const cojo = { open: ["in_progress"] } as unknown as TransitionsMap;
    expect(puedeIr(cojo, "done", "open")).toBe(false);
    expect(puedeIr(cojo, "open", "in_progress")).toBe(true);
  });
});
