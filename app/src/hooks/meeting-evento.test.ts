import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { tocaLaCampana } from "@/hooks/use-report-events";

/**
 * Un tipo de evento nuevo hay que darlo de alta en **tres** sitios, y olvidarse
 * de uno no rompe nada de forma visible — simplemente ese aviso no llega.
 *
 * Ya pasó: el transporte de navegador registra los tipos a mano y se quedaron
 * fuera cuatro (`chat:message`, `dm:message` y los dos de voz), cosa que está
 * documentada en `docs/notifications.md`. Esta prueba existe para que
 * `meeting:reminder` no sea el quinto.
 *
 * La lista del transporte se comprueba leyendo el fuente porque no se exporta;
 * es el mismo recurso que usa `TestLoadEnvNeverLogsAValue` en el backend, y es
 * preferible a exportar una constante sólo para poder mirarla.
 */

describe("dar de alta el evento de una reunión", () => {
  // 1) La campana: sin esto suena la tarjeta pero no queda constancia, y quien
  // no estaba delante no se entera nunca de que hubo reunión.
  it("deja fila en la campana", () => {
    expect(tocaLaCampana("meeting:reminder")).toBe(true);
  });

  it("y no cambia lo que ya dejaba o no dejaba", () => {
    expect(tocaLaCampana("chat:message")).toBe(true);
    // La llamada no deja fila a propósito: tiene tarjeta y caduca en veinte
    // segundos, así que una fila sería un aviso de algo que ya no se puede
    // contestar.
    expect(tocaLaCampana("voice.ring")).toBe(false);
    expect(tocaLaCampana("cualquier:cosa")).toBe(false);
  });

  // 2) El switch que reparte: sin el `case`, el evento cae en el `default` y se
  // descarta en silencio.
  it("el repartidor lo atiende", () => {
    const fuente = readFileSync(
      join(process.cwd(), "src/hooks/use-report-events.ts"),
      "utf-8",
    );
    expect(fuente).toContain('case "meeting:reminder":');
  });

  // 3) El transporte de navegador, que es el que se olvida.
  it("y el transporte de navegador lo escucha", () => {
    const fuente = readFileSync(
      join(process.cwd(), "src/hooks/use-report-events.ts"),
      "utf-8",
    );
    // La lista literal que se le pasa a `es.addEventListener`, no cualquier
    // aparición del nombre en el fichero.
    const lista = fuente.slice(fuente.indexOf("for (const kind of ["));
    const cierre = lista.indexOf("]");
    expect(lista.slice(0, cierre)).toContain('"meeting:reminder"');
  });
});
