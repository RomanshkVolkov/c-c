import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { tocaLaCampana } from "@/hooks/use-report-events";

/**
 * El aviso del vigilante de la telemetría, dado de alta en los tres sitios que
 * pide un evento nuevo (ver `meeting-evento.test.ts`): sin uno de ellos el
 * aviso no llega y nada se rompe de forma visible.
 */
const fuente = () => readFileSync(join(process.cwd(), "src/hooks/use-report-events.ts"), "utf-8");

describe("dar de alta el aviso del vigilante", () => {
  it("relee la campana: el servidor ya escribió la fila", () => {
    expect(tocaLaCampana("telemetry:alert")).toBe(true);
  });

  it("el repartidor lo atiende, y respeta el interruptor de la campana", () => {
    const f = fuente();
    const rama = f.slice(f.indexOf('case "telemetry:alert":'), f.indexOf('case "meeting:reminder":'));
    expect(rama).toContain("notify(");
    expect(rama).toContain("telemetryQuiet");
  });

  it("y el transporte de navegador lo escucha", () => {
    const lista = fuente().slice(fuente().indexOf("for (const kind of ["));
    expect(lista.slice(0, lista.indexOf("]"))).toContain('"telemetry:alert"');
  });

  it("cada clave que manda el servidor tiene su frase", () => {
    const f = fuente();
    for (const k of ["telemetry.silent", "telemetry.back", "telemetry.unhealthy", "telemetry.healthy"]) {
      expect(f).toContain(`"${k}": "notifications:${k}"`);
    }
  });
});
