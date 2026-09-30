import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Los eventos de un deploy llegan al store.
 *
 * El agente cuenta por dónde va y el backend lo publica como `deploy:status` y
 * `deploy:log`. Sin estas dos ramas, el diálogo se quedaría en «en cola» hasta
 * cerrarlo y abrirlo. Se lee el fuente, como las demás pruebas de este hook.
 */
const fuente = () => readFileSync(join(process.cwd(), "src/hooks/use-report-events.ts"), "utf-8");

describe("los eventos de un deploy", () => {
  it("el estado va al historial", () => {
    expect(fuente()).toMatch(/case "deploy:status":\s*useDeploymentsStore\.getState\(\)\.onStatus\(/);
  });
  it("y las líneas, al log", () => {
    expect(fuente()).toMatch(/case "deploy:log":\s*useDeploymentsStore\.getState\(\)\.onLog\(/);
  });
});
