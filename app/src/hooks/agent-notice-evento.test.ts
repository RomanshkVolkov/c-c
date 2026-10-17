import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { tocaLaCampana } from "@/hooks/use-report-events";

/**
 * El aviso de un agente a la persona de su token (#153), dado de alta en los
 * tres sitios que pide un evento nuevo (ver `meeting-evento.test.ts`): sin uno
 * de ellos el aviso no llega y nada se rompe de forma visible.
 * Mutantes: sacarlo de la lista de los que releen la campana; no atenderlo en
 * el repartidor; no callarlo con «trabajo»; olvidarlo en el transporte del
 * navegador.
 */
const fuente = () => readFileSync(join(process.cwd(), "src/hooks/use-report-events.ts"), "utf-8");

describe("dar de alta el aviso de un agente", () => {
  it("relee la campana: el servidor ya escribió la fila", () => {
    expect(tocaLaCampana("agent:notice")).toBe(true);
  });

  it("el repartidor lo atiende, y se calla con el interruptor del trabajo", () => {
    const f = fuente();
    const rama = f.slice(f.indexOf('case "agent:notice":'), f.indexOf('case "meeting:reminder":'));
    expect(rama).toContain('notify("agent:notice"');
    expect(rama).toContain("workQuiet");
  });

  it("y el transporte de navegador lo escucha", () => {
    const lista = fuente().slice(fuente().indexOf("for (const kind of ["));
    expect(lista.slice(0, lista.indexOf("]"))).toContain('"agent:notice"');
  });
});
