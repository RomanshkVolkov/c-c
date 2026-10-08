import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Los avisos de las llamadas, dados de alta en el transporte del navegador
 * (ver `meeting-evento.test.ts`). En el escritorio Rust reenvía cada trama y da
 * igual; en la web, un tipo que no está en la lista **no llega nunca**, y nada
 * se rompe de forma visible. Así pasó con el timbre: la web no tuvo voz hasta
 * W3, y entonces nadie notó que ningún timbre sonaba en un navegador.
 */
const fuente = () => readFileSync(join(process.cwd(), "src/hooks/use-report-events.ts"), "utf-8");

describe("los avisos de las llamadas en la web", () => {
  it.each(["voice.ring", "voice.ring.cancel", "call:knock", "call:status"])(
    "el transporte de navegador escucha %s",
    (kind) => {
      const lista = fuente().slice(fuente().indexOf("for (const kind of ["));
      expect(lista.slice(0, lista.indexOf("]"))).toContain(`"${kind}"`);
    },
  );

  // Alguien pidiendo entrar no es asunto de toda la organización: se avisa a
  // quien está en esa reunión y a quien la abrió.
  it("la sala de espera avisa sólo a quien le toca", () => {
    const f = fuente();
    const rama = f.slice(f.indexOf('case "call:knock":'), f.indexOf('case "voice.ring.cancel":'));
    expect(rama).toContain("onKnock(");
    expect(rama).toMatch(/aqui \|\| mia/);
  });
});
