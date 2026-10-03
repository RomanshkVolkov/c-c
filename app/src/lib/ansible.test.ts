import { describe, expect, it } from "vitest";
import { appendBounded, finalStatus, logTail, playRecap, stripAnsi } from "./ansible";

/** Lo que se guarda en cac de una ejecución: el resumen y la cola, sin color. */
describe("lo que se guarda de un playbook", () => {
  const out = [
    "PLAY [tds] ****",
    "\x1b[0;32mok: [tds-rh]\x1b[0m",
    "",
    "PLAY RECAP *********",
    "\x1b[0;33mtds-rh\x1b[0m : ok=12 changed=1 unreachable=0 failed=0",
    "",
  ];

  it("el resumen es el PLAY RECAP del final, sin color ni líneas vacías", () => {
    expect(playRecap(out)).toBe("PLAY RECAP *********\ntds-rh : ok=12 changed=1 unreachable=0 failed=0");
    expect(playRecap(["sin recap"])).toBe("");
  });

  it("con dos plays, el último resumen", () => {
    expect(playRecap(["PLAY RECAP", "a : ok=1", "PLAY RECAP", "b : ok=2"])).toBe("PLAY RECAP\nb : ok=2");
  });

  it("la cola son las últimas líneas, sin color", () => {
    const many = Array.from({ length: 300 }, (_, i) => `\x1b[0;32mlínea ${i}\x1b[0m`);
    const tail = logTail(many).split("\n");
    expect(tail).toHaveLength(200);
    expect(tail[0]).toBe("línea 100");
    expect(tail[199]).toBe("línea 299");
    expect(stripAnsi("\x1b[1;31mx\x1b[0m")).toBe("x");
  });

  it("cómo acabó: parado gana; si no, el código", () => {
    expect(finalStatus(0, false)).toBe("succeeded");
    expect(finalStatus(2, false)).toBe("failed");
    expect(finalStatus(null, false)).toBe("failed");
    expect(finalStatus(0, true)).toBe("cancelled");
  });

  it("la salida en memoria no pasa del tope y guarda las últimas", () => {
    const got = appendBounded(["a", "b"], ["c", "d"], 3);
    expect(got).toEqual(["b", "c", "d"]);
  });
});
