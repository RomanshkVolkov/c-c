import { describe, expect, it } from "vitest";

import { vigilanteDeReconexion } from "./use-report-events";

/**
 * Recuperar lo que pasó mientras el stream estaba caído.
 *
 * El fallo que esto arregla: había que recargar la app para leer mensajes que
 * te habían escrito. La reconexión funcionaba —Rust la hace solo— pero un
 * evento emitido con la conexión muerta no se reenvía, así que volvía un stream
 * sano con un hueco detrás que nada delataba.
 *
 * Se notaba sobre todo en una llamada de voz, y no por casualidad: la única
 * recuperación que existía colgaba de `focus` y `visibilitychange`, y en media
 * hora de llamada no le quitas el foco a la ventana ni una vez.
 */
describe("volver de una caída", () => {
  it("el primer open es el arranque y no recupera nada", () => {
    const volvio = vigilanteDeReconexion();
    expect(volvio("connecting")).toBe(false);
    expect(volvio("open")).toBe(false);
  });

  it("después de una caída, volver sí recupera", () => {
    const volvio = vigilanteDeReconexion();
    volvio("open");
    expect(volvio("down")).toBe(false);
    expect(volvio("connecting")).toBe(false);
    expect(volvio("open")).toBe(true);
  });

  // Una vez recuperado, seguir vivo no vuelve a pedir nada: el estado llega
  // repetido cada vez que el transporte informa, y refrescar en cada aviso
  // sería un sondeo disfrazado de reconexión.
  it("estar arriba no recupera una y otra vez", () => {
    const volvio = vigilanteDeReconexion();
    volvio("down");
    expect(volvio("open")).toBe(true);
    expect(volvio("open")).toBe(false);
    expect(volvio("open")).toBe(false);
  });

  it("dos caídas seguidas recuperan dos veces", () => {
    const volvio = vigilanteDeReconexion();
    volvio("down");
    expect(volvio("open")).toBe(true);
    volvio("down");
    expect(volvio("open")).toBe(true);
  });

  // Cada transporte lleva el suyo: el de Rust y el de `EventSource` conviven en
  // el mismo hook y compartir estado los haría interferir.
  it("cada vigía lleva su propia cuenta", () => {
    const uno = vigilanteDeReconexion();
    const otro = vigilanteDeReconexion();
    uno("down");
    expect(otro("open")).toBe(false);
    expect(uno("open")).toBe(true);
  });
});
