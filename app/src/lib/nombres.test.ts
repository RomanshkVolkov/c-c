import { describe, expect, it } from "vitest";

import { inicialesDe, nombreDe } from "@/lib/nombres";

/**
 * El nombre en pantalla, y el respaldo cuando no lo hay.
 *
 * Nadie está obligado a poner su nombre, así que la mitad de esto es qué pasa
 * cuando falta. Vive en un solo sitio justamente por eso: repartir el `??` por
 * los dieciocho sitios que pintan gente garantiza que el diecinueve enseñe un
 * hueco donde debería ir una persona.
 */
describe("cómo se llama alguien en pantalla", () => {
  it("el nombre cuando lo hay", () => {
    expect(nombreDe({ name: "Romanshk Volkov", username: "rvolkov" })).toBe("Romanshk Volkov");
  });

  // Los tres modos en que «no hay nombre» llega desde el servidor: ausente,
  // nulo, o una cadena que el `omitempty` de Go no filtró por traer espacios.
  it("y el usuario cuando no", () => {
    expect(nombreDe({ username: "rvolkov" })).toBe("rvolkov");
    expect(nombreDe({ name: null, username: "rvolkov" })).toBe("rvolkov");
    expect(nombreDe({ name: "   ", username: "rvolkov" })).toBe("rvolkov");
  });

  // Un avatar con un hueco dentro es peor que uno con dos letras raras.
  it("las iniciales nunca salen vacías", () => {
    expect(inicialesDe({ name: "  ", username: "ana" })).toBe("AN");
    expect(inicialesDe({ name: "Bea Ruiz", username: "bruiz" })).toBe("BE");
  });
});
