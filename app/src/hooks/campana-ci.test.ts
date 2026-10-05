import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { tocaLaCampana } from "./use-report-events";

/**
 * La actividad de CI y la campana (R9).
 *
 * Un run manda tres eventos por intento y un deploy cuatro o cinco; la fila de
 * la campana sólo la deja el último. Releer la bandeja en cada uno sería
 * pedirla tres veces por run para no encontrar nada nuevo. Lo que se fija: que
 * sólo el terminal la toca, y que lo que no se puede leer no la toca.
 */
describe("qué toca la campana en la actividad de CI", () => {
  it("un run sólo cuando termina", () => {
    expect(tocaLaCampana("ci:run", JSON.stringify({ status: "requested" }))).toBe(false);
    expect(tocaLaCampana("ci:run", JSON.stringify({ status: "in_progress" }))).toBe(false);
    expect(tocaLaCampana("ci:run", JSON.stringify({ status: "completed", conclusion: "failure" }))).toBe(true);
  });

  it("un deploy sólo cuando acaba, bien o mal", () => {
    expect(tocaLaCampana("deploy:status", JSON.stringify({ status: "queued" }))).toBe(false);
    expect(tocaLaCampana("deploy:status", JSON.stringify({ status: "running" }))).toBe(false);
    expect(tocaLaCampana("deploy:status", JSON.stringify({ status: "succeeded" }))).toBe(true);
    expect(tocaLaCampana("deploy:status", JSON.stringify({ status: "failed" }))).toBe(true);
    // El log no es noticia.
    expect(tocaLaCampana("deploy:log", JSON.stringify({ lines: ["x"] }))).toBe(false);
  });

  it("sin datos, o con datos ilegibles, no la toca; y los de siempre siguen igual", () => {
    expect(tocaLaCampana("ci:run")).toBe(false);
    expect(tocaLaCampana("ci:run", "{no es json")).toBe(false);
    expect(tocaLaCampana("task:comment")).toBe(true);
    expect(tocaLaCampana("task:comment", "{no es json")).toBe(true);
  });
});

// Como las demás pruebas de este hook: se lee el fuente, porque montar el
// stream entero para ver una rama del conmutador es más ruido que prueba.
const fuente = () => readFileSync(join(process.cwd(), "src/hooks/use-report-events.ts"), "utf-8");

describe("los eventos de la actividad llegan a su store", () => {
  it("un run va a la actividad", () => {
    expect(fuente()).toMatch(/case "ci:run":\s*useActivityStore\.getState\(\)\.onRun\(/);
  });
  it("y un deploy, además de al historial, a la actividad", () => {
    expect(fuente()).toMatch(/useActivityStore\.getState\(\)\.onDeployStatus\(dep\)/);
  });
  it("y el navegador se suscribe a los tres", () => {
    const src = fuente();
    for (const kind of ['"ci:run"', '"deploy:status"', '"deploy:log"', '"chat:message"', '"dm:message"']) {
      expect(src.indexOf(kind, src.indexOf("es.addEventListener") - 900)).toBeGreaterThan(0);
    }
  });
});
