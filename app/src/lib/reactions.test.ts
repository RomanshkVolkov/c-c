import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { applyReaction, REACTION_EMOJIS, type Reaction } from "./reactions";

/**
 * La cuenta optimista de una reacción, y el juego de emojis.
 *
 * El juego tiene que ser **el mismo que acepta el servidor**: uno de más aquí
 * es un botón que siempre falla con un 400; uno de menos, un emoji que llega
 * de otra pantalla y no se puede poner desde esta. Se lee el fichero de Go.
 * Mutantes: añadir o quitar un emoji; no marcar `mine`; contar doble el mío;
 * no borrar el que queda a cero; quitar un nombre que no es el mío.
 */
describe("el juego de emojis", () => {
  it("es el mismo, y en el mismo orden, que el del servidor", () => {
    const go = readFileSync(join(process.cwd(), "../backend/internal/core/domain/reaction.go"), "utf-8");
    const linea = go.split("\n").find((l) => l.startsWith("var ReactionEmojis"))!;
    const servidor = [...linea.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect([...REACTION_EMOJIS]).toEqual(servidor);
  });
});

const r = (emoji: string, names: string[], mine = false): Reaction => ({
  emoji,
  count: names.length,
  mine,
  names,
});

describe("poner o quitar la mía, sin esperar al servidor", () => {
  it("una nueva va al final, mía y con mi nombre", () => {
    expect(applyReaction([r("👍", ["Bea"])], "🎉", true, "Ana")).toEqual([
      r("👍", ["Bea"]),
      r("🎉", ["Ana"], true),
    ]);
    expect(applyReaction(undefined, "👍", true, "Ana")).toEqual([r("👍", ["Ana"], true)]);
  });

  it("sumarme a la de otro la marca mía y suma uno", () => {
    expect(applyReaction([r("👍", ["Bea"])], "👍", true, "Ana")).toEqual([r("👍", ["Bea", "Ana"], true)]);
  });

  it("poner la que ya es mía no cuenta doble", () => {
    const antes = [r("👍", ["Ana"], true)];
    expect(applyReaction(antes, "👍", true, "Ana")).toBe(antes);
  });

  it("quitar la mía resta uno, y si se queda a cero desaparece", () => {
    expect(applyReaction([r("👍", ["Bea", "Ana"], true)], "👍", false, "Ana")).toEqual([r("👍", ["Bea"])]);
    expect(applyReaction([r("👍", ["Ana"], true), r("🎉", ["Bea"])], "👍", false, "Ana")).toEqual([
      r("🎉", ["Bea"]),
    ]);
  });

  it("quitar una que no es mía no toca nada", () => {
    const antes = [r("👍", ["Bea"])];
    expect(applyReaction(antes, "👍", false, "Ana")).toBe(antes);
  });

  it("si otra persona se llama como yo, se va un solo nombre", () => {
    expect(applyReaction([r("👍", ["Ana", "Bea", "Ana"], true)], "👍", false, "Ana")).toEqual([
      r("👍", ["Ana", "Bea"]),
    ]);
  });
});
