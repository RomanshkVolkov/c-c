import { describe, expect, it } from "vitest";

import { faltanSubtareas } from "@/types/report";

/**
 * Dar por hecha una tarea que aún tiene subtareas abiertas.
 *
 * Se comprueba en los dos lados: el servidor lo impone y el tablero lo consulta
 * antes de dejar soltar la tarjeta. Sin lo segundo, la tarjeta se suelta, viaja,
 * la rechazan y vuelve sola a su sitio — un movimiento que se deshace solo se lee
 * como que la app va mal, no como una regla.
 */
describe("el guard de subtareas", () => {
  it("apagado no estorba", () => {
    expect(faltanSubtareas(false, "done", 3, 1)).toBe(false);
  });

  it("encendido, con subtareas abiertas impide dar por hecha", () => {
    expect(faltanSubtareas(true, "done", 3, 1)).toBe(true);
  });

  it("y con todas hechas deja", () => {
    expect(faltanSubtareas(true, "done", 3, 3)).toBe(false);
  });

  /**
   * **Cerrado no es hecho.**
   *
   * Hecho dice que se terminó todo; cerrado dice que no se va a hacer. Impedir
   * cerrar dejaría atrapada justo la tarea que se quiere abandonar, que es
   * cuando más falta hace poder cerrarla.
   */
  it("cerrar nunca se impide", () => {
    expect(faltanSubtareas(true, "closed", 3, 0)).toBe(false);
  });

  it("ni moverla a abierto o en curso", () => {
    expect(faltanSubtareas(true, "open", 3, 0)).toBe(false);
    expect(faltanSubtareas(true, "in_progress", 3, 0)).toBe(false);
  });

  /**
   * El vocabulario del servidor también cuenta.
   *
   * Aquí el estado terminado se llama `done` y en el servidor `resolved`. La
   * misma regla vive en los dos sitios, y comparar contra el nombre equivocado
   * daría una condición que no se cumple nunca: el guard no impediría nada sin
   * que nada fallara.
   */
  it("«resolved», el nombre del servidor, cuenta como hecho", () => {
    expect(faltanSubtareas(true, "resolved" as never, 3, 1)).toBe(true);
  });

  // Una tarea sin subtareas no tiene nada pendiente por definición.
  it("sin subtareas no exige nada", () => {
    expect(faltanSubtareas(true, "done")).toBe(false);
  });
});
