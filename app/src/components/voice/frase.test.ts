import { describe, expect, it } from "vitest";
import { quienHabla } from "./frase";

describe("quién está hablando, en castellano de verdad", () => {
  it("una persona lleva verbo en singular", () => {
    // El fallo que esto evita es el clásico «1 people are talking».
    expect(quienHabla(["Marta A."])).toBe("Marta A. is");
  });

  it("dos personas se unen con «and», sin coma", () => {
    expect(quienHabla(["Marta A.", "Luis R."])).toBe("Marta A. and Luis R. are");
  });

  it("de tres en adelante, comas y un «and» al final", () => {
    expect(quienHabla(["Marta A.", "Luis R.", "Elena Ruiz"])).toBe(
      "Marta A., Luis R. and Elena Ruiz are",
    );
  });

  it("con nadie no dice nada, en vez de dejar un verbo suelto", () => {
    expect(quienHabla([])).toBe("");
  });
});
