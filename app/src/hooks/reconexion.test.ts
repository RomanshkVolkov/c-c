import { describe, expect, it } from "vitest";

import { tocaLaCampana, vigilanteDeReconexion } from "./use-report-events";

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

/**
 * Qué eventos dejan fila en la campana.
 *
 * El backend guarda la notificación en su tabla, pero la campana no se entera
 * sola: hay que volver a pedir la bandeja. Sólo lo hacían tres ramas del
 * conmutador, así que un mensaje de canal o un directo se guardaban y no
 * aparecían hasta que algo la recargaba por otro motivo —arrancar la app o
 * cambiar de organización—. Desde fuera parecía que llegaban al entrar en la
 * sección.
 */
describe("qué toca la campana", () => {
  // Los tres del fallo reportado, y los que ya iban.
  it.each([
    "dm:message",
    "chat:message",
    "chat:mention",
    "task:assigned",
    "task:status",
    "report:new",
    "report:comment",
    "task:comment",
  ])("%s deja fila", (evento) => {
    expect(tocaLaCampana(evento)).toBe(true);
  });

  // Y lo que no debe tocarla. Mover una tarjeta o recibir vídeo pasa
  // constantemente; releer la bandeja en cada uno sería un sondeo disfrazado.
  it.each(["task:move", "task:new", "task:delete", "report:attachment", "voice.ring", "ping"])(
    "%s no la toca",
    (evento) => {
      expect(tocaLaCampana(evento)).toBe(false);
    },
  );
});
